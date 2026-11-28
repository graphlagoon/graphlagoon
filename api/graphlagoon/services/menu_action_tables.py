"""Table actions of the right-click menu.

A context's ``run-query-template`` action with ``resultMode: "table"`` runs its
query template for one clicked node or edge and returns rows instead of
replacing the graph. One path serves every caller: the exploration canvas, a
case canvas (the browser sends the source node id) and agents (MCP
``list_entity_actions`` / ``run_entity_action``), so the scope check, the
read-only validation and the value rule are the same for all of them.

Parameter values: the caller's value first (the browser resolves the action's
bindings with the full label engine, enriched values and metrics included),
else the binding resolved here from the target (plain placeholders only:
``{node_id}``, ``{node_type}``, ``{prop:x}``, ``{edge_id}``, ``{src}``,
``{dst}``, ``{relationship_type}``), else the template default. Templates
splice ``$id`` as text, like the browser does, so a value that could leave a
quoted literal, chain a statement or name another parameter is refused.

A ``run-table-provider`` action is the other table action: instead of a query
template it points at a table source the context declares (an
``enrichment_tables`` entry with ``table_provider``: a provider the deployer
registered in Python, ``services/table_providers.py``). Same route, same
response, same callers; its parameters are the provider's declared ones, typed
and bounded, never spliced. ``run_source`` asks a source with no action.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Optional
from uuid import UUID

TABLE_KIND = "run-query-template"
PROVIDER_KIND = "run-table-provider"
MAX_VALUE_LENGTH = 1000
_UNSAFE = re.compile(r"['\"\\`;$\x00-\x1f]")
_PLACEHOLDER = re.compile(r"\{([^{}]*)\}")
_NODE_BUILTINS = ("node_id", "node_type")
_EDGE_BUILTINS = ("edge_id", "relationship_type", "src", "dst")


class MenuActionError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# -- which actions ------------------------------------------------------------------


def is_provider_action(action: dict) -> bool:
    return isinstance(action, dict) and action.get("kind") == PROVIDER_KIND


def is_table_action(action: dict) -> bool:
    if not isinstance(action, dict) or action.get("enabled", True) is False:
        return False
    return is_provider_action(action) or (
        action.get("kind") == TABLE_KIND and action.get("resultMode") == "table"
    )


def table_actions(context) -> list[dict]:
    return [a for a in (getattr(context, "context_menu_actions", None) or []) if is_table_action(a)]


def find_action(context, action_id: str) -> dict:
    for action in getattr(context, "context_menu_actions", None) or []:
        if isinstance(action, dict) and action.get("id") == action_id:
            if not is_table_action(action):
                raise MenuActionError(
                    400, "MENU_ACTION_NOT_TABLE", f"'{action.get('label') or action_id}' does not show a table"
                )
            return action
    raise MenuActionError(404, "MENU_ACTION_NOT_FOUND", f"No menu action '{action_id}' in this context")


# -- the clicked item ---------------------------------------------------------------


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def item_value(target: dict, name: str) -> Optional[str]:
    """A property or built-in of the target, read like the label engine: the
    raw property first, then the built-ins; None when absent."""
    props = target.get("properties") or {}
    if name in props:
        return _text(props[name])
    builtins = _NODE_BUILTINS if target.get("type", "node") == "node" else _EDGE_BUILTINS
    if name in builtins:
        key = "id" if name in ("node_id", "edge_id") else name
        value = target.get(key)
        return None if value in (None, "") else str(value)
    return None


def matches(action: dict, target: dict) -> bool:
    """The browser's ``menuActionMatcher`` for the facts the server has. A
    condition on a metric cannot be judged here and hides the action."""
    kind = target.get("type", "node")
    match = action.get("match") or {}
    if match.get("target", "node") not in ("both", kind):
        return False
    types = match.get("nodeTypes" if kind == "node" else "relationshipTypes") or []
    own = target.get("node_type" if kind == "node" else "relationship_type")
    if types and own not in types:
        return False
    for condition in match.get("propertyConditions") or []:
        prop = condition.get("property", "")
        if prop.startswith("metric:"):
            return False
        value = item_value(target, prop)
        text = value or ""
        expected = condition.get("value") or ""
        op = condition.get("operator")
        ok = {
            "exists": value is not None,
            "not-empty": text != "",
            "equals": text == expected,
            "not-equals": text != expected,
            "contains": expected != "" and expected in text,
        }.get(op, False)
        if not ok:
            return False
    return True


def resolve_binding(binding: str, target: dict) -> Optional[str]:
    """The binding with its placeholders filled from the target; None when one
    is missing or is not a plain placeholder (modifiers, ``{if:…}``, metrics)."""
    missing = False

    def fill(m: re.Match) -> str:
        nonlocal missing
        token = m[1].strip()
        name = token[5:] if token.startswith("prop:") else token
        if "|" in token or ":" in name or token.startswith(("if:", "metric:")):
            missing = True
            return ""
        value = item_value(target, name)
        if value in (None, ""):
            missing = True
            return ""
        return value

    out = _PLACEHOLDER.sub(fill, binding)
    return None if missing else out


# -- template -----------------------------------------------------------------------


async def load_template(context_id: UUID, template_id: str, user_email: str) -> dict:
    """The action's template as a dict, if the user can see it (shared, or
    their own private one)."""
    from graphlagoon.db.database import get_session_maker, is_database_available
    from graphlagoon.db.memory_store import get_memory_store
    from graphlagoon.utils.authz import is_superuser

    gone = MenuActionError(404, "TEMPLATE_NOT_FOUND", "The action's query template no longer exists")
    try:
        tid = UUID(str(template_id))
    except ValueError:
        raise gone
    if is_database_available():
        from graphlagoon.db.models import QueryTemplate

        async with get_session_maker()() as session:
            template = await session.get(QueryTemplate, tid)
    else:
        template = get_memory_store().get_query_template(tid)
    if template is None or str(template.graph_context_id) != str(context_id):
        raise gone
    if getattr(template, "visibility", "shared") == "private" and template.owner_email != user_email \
            and not is_superuser(user_email):
        raise gone
    return {
        "id": str(template.id),
        "name": template.name,
        "description": template.description,
        "query_type": template.query_type,
        "query": template.query,
        "parameters": [p if isinstance(p, dict) else p.model_dump() for p in template.parameters or []],
        "options": template.options or {},
    }


def bind_parameters(
    template: dict, action: dict, target: dict, given: dict[str, Any], strict: bool = True
) -> tuple[list[dict], dict]:
    """Each declared parameter with its value and where the value came from,
    plus ``problems`` (id → message) for a missing required, a value not among
    a select's options, or an unsafe value. ``strict`` also reports a given id
    the template does not declare (an agent's typo); the browser sends what an
    action binds, which outlives a parameter removed from the template."""
    declared = template["parameters"]
    known = {p["id"] for p in declared}
    problems: dict[str, str] = {
        k: "the template has no such parameter" for k in given if strict and k not in known
    }
    bindings = action.get("paramBindings") or {}
    out = []
    for p in declared:
        pid = p["id"]
        if pid in given and given[pid] is not None:
            value, origin = _text(given[pid]), "given"
        elif bindings.get(pid) and (bound := resolve_binding(bindings[pid], target)):
            value, origin = bound, "binding"
        else:
            value, origin = p.get("default") or "", "default"
        value = value.strip()
        if not value and p.get("required", True):
            problems[pid] = "needs a value"
        elif value and p.get("type") == "select" and p.get("options") and value not in p["options"]:
            problems[pid] = f"must be one of {', '.join(p['options'])}"
        elif len(value) > MAX_VALUE_LENGTH:
            problems[pid] = f"must be at most {MAX_VALUE_LENGTH} characters"
        elif _UNSAFE.search(value):
            problems[pid] = "may not contain quotes, backslashes, backticks, ';', '$' or control characters"
        out.append({
            "id": pid,
            "label": p.get("label") or pid,
            "type": p.get("type", "input"),
            "options": p.get("options"),
            "required": p.get("required", True),
            "description": p.get("description"),
            "binding": bindings.get(pid),
            "value": value,
            "source": origin,
        })
    return out, problems


def substitute(text: str, values: dict[str, str]) -> str:
    """``$id`` → value in one pass, longest id first (``utils/templateSubstitution.ts``)."""
    ids = sorted((k for k in values if k), key=len, reverse=True)
    if not ids or not text:
        return text
    pattern = re.compile(r"\$(?:" + "|".join(re.escape(i) for i in ids) + ")")
    return pattern.sub(lambda m: values[m[0][1:]], text)


# -- run ----------------------------------------------------------------------------


async def run(
    context,
    user_email: str,
    action_id: str,
    target: dict,
    given: Optional[dict[str, Any]] = None,
    row_limit: int = 1000,
    wait: bool = False,
    check_match: bool = True,
    user_token: Optional[str] = None,
) -> dict:
    """Runs the action for ``target``. ``status``: ``needs_parameters`` (nothing
    ran; ``problems`` says why), ``running`` (poll ``statement_id`` on the
    table-query route), ``succeeded`` (rows) or ``failed`` (``error``).
    ``wait`` polls to the end (agents). ``check_match`` refuses an item the
    action does not apply to; the browser already decided that with what only
    it has (metrics, lazily loaded properties), and the match is no security
    boundary: the same reader may run the template from the console."""
    from fastapi import HTTPException

    from graphlagoon.models.schemas import TableQueryRequest
    from graphlagoon.routers.graph import enforce_query_scope, resolve_datasource_or_400
    from graphlagoon.services.datasource.base import require_capability
    from graphlagoon.services.graph_operations import QueryExecutionError

    action = find_action(context, action_id)
    if check_match and not matches(action, target):
        raise MenuActionError(
            400, "MENU_ACTION_NOT_APPLICABLE", f"'{action.get('label')}' does not apply to this {target.get('type', 'node')}"
        )
    if is_provider_action(action):
        return await run_provider(
            context, user_email, action, target, given or {}, row_limit, check_match, user_token
        )
    template = await load_template(context.id, action.get("templateId", ""), user_email)
    parameters, problems = bind_parameters(template, action, target, given or {}, strict=check_match)
    result: dict[str, Any] = {
        "action_id": action["id"],
        "label": action.get("label"),
        "template_id": template["id"],
        "template_name": template["name"],
        "query_type": template["query_type"],
        "parameters": parameters,
        "problems": problems,
        "row_limit": row_limit,
        "status": "needs_parameters",
        "statement_id": None,
        "columns": [],
        "rows": [],
        "row_count": 0,
        "truncated": False,
        "error": None,
        "duration_ms": None,
    }
    if problems:
        return result
    values = {p["id"]: p["value"] for p in parameters}
    query = substitute(template["query"], values)
    language = "cypher" if template["query_type"] == "cypher" else "sql"
    datasource = resolve_datasource_or_400(context)
    caps = datasource.capabilities
    prefilter = (template["options"] or {}).get("cte_prefilter")
    prefilter = substitute(prefilter, values) if prefilter and getattr(caps, "supports_cte_prefilter", False) else None
    if language == "sql":
        require_capability(datasource, "supports_sql", "SQL query templates")
    await enforce_query_scope(context, user_email, query if language == "sql" else None, prefilter, datasource)
    request = TableQueryRequest(
        query=query,
        mode=language,
        cte_prefilter=prefilter,
        row_limit=row_limit,
        # The procedural renderer emits a BEGIN…END script the table path refuses.
        **({"vlp_rendering_mode": "cte"} if language == "cypher" and getattr(caps, "supports_transpile", False) else {}),
    )
    t0 = time.perf_counter()
    try:
        response = await datasource.submit_table_query(context, request)
        if wait:
            response = await _wait(datasource, context, response, row_limit)
    except QueryExecutionError as exc:
        result.update(status="failed", error={"code": getattr(exc, "code", None) or "QUERY_FAILED",
                                              "message": getattr(exc, "message", None) or str(exc)})
        return result
    except HTTPException as exc:
        if exc.status_code != 400:
            raise
        detail = exc.detail.get("error", {}) if isinstance(exc.detail, dict) else {}
        result.update(status="failed", error={"code": detail.get("code", "QUERY_FAILED"),
                                              "message": detail.get("message", str(exc.detail))})
        return result
    result.update(
        status=response.status,
        statement_id=response.statement_id,
        columns=response.columns,
        rows=response.rows,
        row_count=response.row_count,
        # The warehouse may know of more rows than it returned (a byte cap): say so too.
        truncated=bool(response.truncated or (response.total_row_count or 0) > response.row_count),
        duration_ms=round((time.perf_counter() - t0) * 1000, 1),
    )
    return result


# -- a registered table provider ----------------------------------------------------


def _hint(spec) -> str:
    """The declared description plus what the value must be, for whoever fills it."""
    bounds = []
    if spec.type != "str":
        bounds.append(spec.type)
    if spec.min is not None and spec.max is not None:
        bounds.append(f"{spec.min:g} to {spec.max:g}")
    elif spec.min is not None:
        bounds.append(f"at least {spec.min:g}")
    elif spec.max is not None:
        bounds.append(f"at most {spec.max:g}")
    said = (spec.description or "").strip()
    return f"{said} ({', '.join(bounds)})" if said and bounds else said or ", ".join(bounds)


def table_sources(context) -> list[dict]:
    """The context's table-source entries (``enrichment_tables`` with ``table_provider``)."""
    return [t for t in (getattr(context, "enrichment_tables", None) or []) if t.get("table_provider")]


def find_source(context, action: dict) -> dict:
    """The table source an action points at. ``source`` is the entry's name; an
    action written before sources existed names a ``provider`` instead and gets the
    first source of the context that uses it. No declared source, no run: the
    declaration (which takes ``context.create``) is what lets a context use a provider."""
    declared = table_sources(context)
    name = action.get("source")
    if name:
        entry = next((t for t in declared if t.get("name") == name), None)
    else:
        legacy = action.get("provider")
        entry = next((t for t in declared if t["table_provider"].get("name") == legacy), None)
    if entry is None:
        wanted = name or action.get("provider") or ""
        names = ", ".join(t["name"] for t in declared) or "none"
        raise MenuActionError(
            404, "TABLE_SOURCE_NOT_DECLARED",
            f"This context declares no table source '{wanted}' (it has: {names}). Someone with the "
            '"Create graph contexts" permission declares one in the context form.',
        )
    return entry


def find_provider(context, entry: dict, target: Optional[dict] = None):
    """The registered provider of a table source, if it is for this context and (with
    a ``target``) has a table for that kind of item."""
    from graphlagoon.services.table_providers import get_table_provider

    name = entry["table_provider"].get("name") or ""
    provider = get_table_provider(name)
    if provider is None:
        raise MenuActionError(
            400, "TABLE_PROVIDER_NOT_REGISTERED", f"No table provider '{name}' is registered on this server"
        )
    kind = (target or {}).get("type")
    if kind and kind not in provider.targets:
        raise MenuActionError(
            400, "TABLE_PROVIDER_TARGET", f"The provider '{provider.name}' has no table for a {kind}"
        )
    if provider.applies_to is not None and not provider.applies_to(context):
        raise MenuActionError(
            403, "TABLE_PROVIDER_NOT_ALLOWED", f"The provider '{provider.name}' is not available to this context"
        )
    return provider


def bind_provider_parameters(
    provider, entry: dict, action: dict, target: dict, given: dict[str, Any], strict: bool = True
) -> tuple[list[dict], dict, dict]:
    """``bind_parameters`` for a table source: each declared parameter with its value
    and origin, the ``problems``, and the typed values to hand the provider.

    A parameter the source does not open (``runtime_params``) takes the context's
    value and is locked. An open one: the action's fixed value (locked), else the
    caller's, else the action's binding, else the context's value, else the default."""
    from graphlagoon.services.precomputed.params import ParamError, coerce_values

    ref = entry["table_provider"]
    context_values = {k: v for k, v in (ref.get("params") or {}).items() if v is not None and v != ""}
    opened = set(ref.get("runtime_params") or [])
    known = {p.name for p in provider.params}
    problems: dict[str, str] = {
        k: "the provider has no such parameter" for k in given if strict and k not in known
    }
    bindings = action.get("paramBindings") or {}
    fixed = {k: v for k, v in (action.get("params") or {}).items()
             if v is not None and v != "" and k in opened}
    out, values = [], {}
    for spec in provider.params:
        name = spec.name
        asked = _text(given.get(name)).strip()
        fallback = _text(context_values.get(name, spec.default))
        locked = name not in opened or name in fixed
        binding = None
        if name not in opened:
            value, origin = fallback, "default"
            if strict and asked and asked != value.strip():
                problems[name] = "is set by the context and cannot be changed"
        elif name in fixed:
            value, origin = _text(fixed[name]), "default"
            if strict and asked and asked != value.strip():
                problems[name] = "is fixed by the action and cannot be changed"
        else:
            binding = bindings.get(name)
            if asked:
                value, origin = asked, "given"
            elif binding and (bound := resolve_binding(binding, target)):
                value, origin = bound, "binding"
            else:
                value, origin = fallback, "default"
        value = value.strip()
        if not value:
            values[name] = None
            if spec.required:
                problems.setdefault(name, "needs a value")
        elif name not in problems:
            try:
                values[name] = coerce_values([spec], {name: value})[name]
            except ParamError as e:
                problems[name] = e.message
        out.append({
            "id": name,
            "label": name,
            "type": "select" if spec.choices else "input",
            "options": list(spec.choices) if spec.choices else None,
            "required": spec.required,
            "description": _hint(spec) or None,
            "binding": binding,
            "value": value,
            "source": origin,
            "locked": locked,
        })
    return out, problems, values


def _rows(columns: list[str], rows: list, row_limit: int) -> list[list[Optional[str]]]:
    out = []
    for row in rows[:row_limit]:
        cells = [row.get(c) for c in columns] if isinstance(row, dict) else list(row)
        cells = (cells + [None] * len(columns))[: len(columns)]
        out.append([None if c is None else _text(c) for c in cells])
    return out


async def run_source(
    context, user_email: str, name: str, given: Optional[dict[str, Any]] = None,
    target: Optional[dict] = None, row_limit: int = 1000, user_token: Optional[str] = None,
) -> dict:
    """A table source asked directly, by its name in the context, with no action:
    the caller gives the open parameters (and, when the provider reads the clicked
    item, a ``target``). Same result as an action's run."""
    entry = next((t for t in table_sources(context) if t.get("name") == name), None)
    if entry is None:
        names = ", ".join(t["name"] for t in table_sources(context)) or "none"
        raise MenuActionError(
            404, "TABLE_SOURCE_NOT_DECLARED", f"This context declares no table source '{name}' (it has: {names})"
        )
    action = {"id": name, "label": entry.get("label") or name, "source": name}
    return await run_provider(context, user_email, action, target or {}, given or {}, row_limit, True, user_token)


async def run_provider(
    context, user_email: str, action: dict, target: dict, given: dict[str, Any],
    row_limit: int, strict: bool, user_token: Optional[str],
) -> dict:
    """The provider half of ``run``: same result shape, never ``running``."""
    import logging

    from graphlagoon.services.table_providers import (
        TableProviderError,
        TableProviderRequest,
        TableProviderResult,
    )

    entry = find_source(context, action)
    provider = find_provider(context, entry, target)
    parameters, problems, values = bind_provider_parameters(provider, entry, action, target, given, strict)
    result: dict[str, Any] = {
        "action_id": action["id"],
        "label": action.get("label"),
        "template_id": None,
        "template_name": entry.get("label") or provider.label or provider.name,
        "query_type": "provider",
        "parameters": parameters,
        "problems": problems,
        "row_limit": row_limit,
        "status": "needs_parameters",
        "statement_id": None,
        "columns": [],
        "rows": [],
        "row_count": 0,
        "truncated": False,
        "error": None,
        "duration_ms": None,
    }
    if problems:
        return result
    request = TableProviderRequest(
        context_id=context.id, user_email=user_email,
        # The item's properties stay here: a provider gets what the action binds, nothing else.
        target={k: v for k, v in target.items() if k != "properties"},
        params=values, row_limit=row_limit, user_token=user_token,
    )

    async def call():
        try:
            return await provider.run(request)
        except TimeoutError as e:  # the provider's own timeout is a failure, not ours
            raise RuntimeError("the provider raised TimeoutError") from e

    def failed(code: str, message: str) -> dict:
        result.update(status="failed", error={"code": code, "message": message},
                      duration_ms=round((time.perf_counter() - t0) * 1000, 1))
        return result

    t0 = time.perf_counter()
    log = logging.getLogger(__name__)
    try:
        answer = await asyncio.wait_for(call(), provider.timeout_seconds)
    except asyncio.TimeoutError:
        return failed("TABLE_PROVIDER_TIMEOUT", f"The provider took longer than {provider.timeout_seconds:g}s")
    except TableProviderError as e:
        return failed("TABLE_PROVIDER_FAILED", str(e) or "The provider failed")
    except Exception:  # never leak the provider's internals
        log.exception("Table provider '%s' failed", provider.name)
        return failed("TABLE_PROVIDER_FAILED", "The provider failed")
    if not isinstance(answer, TableProviderResult) or not isinstance(answer.rows, list):
        log.error("Table provider '%s' returned %s, not a TableProviderResult",
                  provider.name, type(answer).__name__)
        return failed("TABLE_PROVIDER_FAILED", "The provider failed")
    columns = [str(c) for c in answer.columns]
    rows = _rows(columns, answer.rows, row_limit)
    result.update(
        status="succeeded",
        columns=columns,
        rows=rows,
        row_count=len(rows),
        truncated=bool(answer.truncated or len(answer.rows) > row_limit),
        duration_ms=round((time.perf_counter() - t0) * 1000, 1),
    )
    return result


async def _wait(datasource, context, response, row_limit: int):
    from graphlagoon.config import get_settings

    settings = get_settings()
    deadline = time.monotonic() + settings.warehouse_max_poll_time
    while response.status == "running":
        if time.monotonic() > deadline:
            await datasource.cancel_statement(response.statement_id)
            raise MenuActionError(504, "QUERY_TIMEOUT", "The query did not finish in time")
        await asyncio.sleep(settings.warehouse_poll_interval)
        response = await datasource.get_table_query_status(context, response.statement_id, row_limit)
    if response.status == "canceled":
        raise MenuActionError(409, "QUERY_CANCELED", "The query was canceled")
    return response
