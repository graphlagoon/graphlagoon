"""Enrichment from a context's authorized tables (investigations F2.1, 03 §2.1).

A context lists tables (``enrichment_tables``); being listed authorizes a table.
Only a table inside the deployment's ``SourceScope`` (the catalog.schema pairs
allowed for graphs plus ``enrichment_sources``) may be listed, checked on save
and again on every lookup and query run.
An entry may declare a **lookup** keyed by a node value: it reads only the
declared columns for a batch of keys (identifiers quoted, keys as named
parameters, key and row counts capped). An entry may also declare an
enrichment **query**: the author's SELECT over the virtual tables
``graph_edges`` / ``graph_nodes`` (the loaded graph, sent as JSON parameters)
and the authorized tables, returning ``edge_id`` (or ``node_id`` when its target
is nodes) plus the new properties.
"""

from __future__ import annotations

import json
import re
import time
from types import SimpleNamespace
from typing import Any, Literal, Optional

from graphlagoon.config import get_settings
from graphlagoon.services.sql_identifiers import (
    qualified_from_dotted,
    quote_identifier,
    validate_identifier_part,
)
from graphlagoon.services.sql_scope import (
    SourceScope,
    context_tables,
    current_source_scope,
    extract_table_refs,
    normalize_ref,
    normalize_table_name,
)

MAX_KEY_LENGTH = 200
# Edge enrichment batches: ids and property values longer than this are refused
# or dropped, a property map keeps this many keys, and the JSON is capped.
MAX_RUN_VALUE_LENGTH = 1000
MAX_RUN_PROPS = 50
MAX_RUN_BATCH_BYTES = 1024 * 1024
VIRTUAL_TABLES = ("graph_edges", "graph_nodes")
_EDGES_PARAM = "gl_enrichment_edges"
_NODES_PARAM = "gl_enrichment_nodes"
_VIRTUAL_CTES = (
    "graph_edges AS (SELECT e.edge_id, e.src, e.dst, e.relationship_type, e.props "
    f"FROM (SELECT explode(from_json(:{_EDGES_PARAM}, "
    "'array<struct<edge_id:string,src:string,dst:string,relationship_type:string,"
    "props:map<string,string>>>')) AS e)), "
    "graph_nodes AS (SELECT n.node_id, n.node_type, n.props "
    f"FROM (SELECT explode(from_json(:{_NODES_PARAM}, "
    "'array<struct<node_id:string,node_type:string,props:map<string,string>>>')) AS n))"
)


class EnrichmentError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def find_table(
    context, name: str, needs: Optional[Literal["lookup", "query"]] = None
) -> dict:
    for spec in getattr(context, "enrichment_tables", None) or []:
        if spec.get("name") != name:
            continue
        if needs == "lookup" and not spec.get("key_column"):
            raise EnrichmentError(
                400, "ENRICHMENT_NOT_LOOKUP", f"'{name}' declares no lookup by node key"
            )
        if needs == "query" and not spec.get("query"):
            raise EnrichmentError(
                400, "ENRICHMENT_NOT_QUERY", f"'{name}' declares no enrichment query"
            )
        return spec
    raise EnrichmentError(
        404, "ENRICHMENT_TABLE_NOT_FOUND", f"No enrichment table '{name}' in this context"
    )


def changed_tables(new: list[dict], old: Optional[list[dict]]) -> list[dict]:
    """Entries that are new or differ from the stored ones (removals need nothing)."""
    from graphlagoon.models.schemas import EnrichmentTable

    stored = []
    for t in old or []:
        try:
            stored.append(EnrichmentTable(**t).model_dump())
        except ValueError:
            pass  # an invalid stored entry vouches for nothing
    return [t for t in new if t not in stored]


def source_problem(table: str, context, sources: Optional[SourceScope] = None) -> Optional[str]:
    """Why ``table`` may not be an enrichment table of ``context``, or None.
    Allowed: the context's own edge/node table, or a table inside the
    deployment's sources (graph catalog.schema pairs + ``enrichment_sources``)."""
    settings = get_settings()
    sources = sources or current_source_scope()
    ref = normalize_table_name(table, settings.default_catalog, settings.default_schema)
    if ref is None:
        return f"'{table}' is not a valid table name."
    own = context_tables(
        SimpleNamespace(
            edge_table_name=getattr(context, "edge_table_name", None),
            node_table_name=getattr(context, "node_table_name", None),
        ),
        settings.default_catalog,
        settings.default_schema,
    )
    if ref in own or sources.allows(ref):
        return None
    return (
        f"{'.'.join(ref)} is not allowed as an enrichment source. Allowed: "
        f"{sources.describe()}. An administrator adds schemas or tables with "
        "GRAPH_LAGOON_ENRICHMENT_SOURCES."
    )


def scope_problem(
    tables: list[dict], context, all_tables: Optional[list[dict]] = None
) -> Optional[str]:
    """Why an author may not attach these tables, or None. Each table must be a
    source the deployment allows (``source_problem``); an entry's query may
    read only the virtual tables, the context's own tables and the tables of
    ``all_tables`` (the whole new list)."""
    sources = current_source_scope()
    tables = [t for t in tables if t.get("table")]  # a provider entry has no table to scope
    for spec in tables:
        problem = source_problem(spec["table"], context, sources)
        if problem:
            return problem
    authorized = SimpleNamespace(
        edge_table_name=getattr(context, "edge_table_name", None),
        node_table_name=getattr(context, "node_table_name", None),
        enrichment_tables=all_tables if all_tables is not None else tables,
    )
    for spec in tables:
        if spec.get("query"):
            problem = query_scope_problem(spec["query"]["sql"], authorized)
            if problem:
                return f"Query '{spec['name']}': {problem}"
    return None


def _unauthorized_tables(sql: str, context) -> Optional[set]:
    """The tables ``sql`` reads that ``context`` does not authorize (None: unparseable)."""
    settings = get_settings()
    # Dummy CTEs so the virtual names are skipped like any query-local name.
    refs = extract_table_refs(
        f"WITH graph_edges AS (SELECT 1), graph_nodes AS (SELECT 1) {sql}"
    )
    if refs is None:
        return None
    allowed = context_tables(
        context, settings.default_catalog, settings.default_schema, current_source_scope()
    )
    return {
        normalize_ref(r, settings.default_catalog, settings.default_schema) for r in refs
    } - allowed


def query_scope_problem(sql: str, context) -> Optional[str]:
    """None when ``sql`` reads only the virtual tables and the context's
    authorized tables (edge, node and every listed enrichment table still
    inside the deployment's sources)."""
    outside = _unauthorized_tables(sql, context)
    if outside is None:
        return "the query could not be parsed, so the tables it reads cannot be verified."
    if outside:
        listed = ", ".join(sorted(".".join(t) for t in outside))
        return (
            f"it reads {listed}, which is not an authorized table of this context. "
            "Add it to the enrichment tables first (it must be an allowed source)."
        )
    return None


def orphan_problem(new: list[dict], stored: Optional[list[dict]], context) -> Optional[str]:
    """Why this save would break a query it keeps, or None: a query that read
    only authorized tables before and reads a table this save removes. A query
    already broken (for example by a settings change) does not block the save."""

    def with_list(tables):
        return SimpleNamespace(
            edge_table_name=getattr(context, "edge_table_name", None),
            node_table_name=getattr(context, "node_table_name", None),
            enrichment_tables=tables or [],
        )

    before, after = with_list(stored), with_list(new)
    for spec in new:
        sql = (spec.get("query") or {}).get("sql")
        if not sql:
            continue
        lost = _unauthorized_tables(sql, after)
        if not lost or _unauthorized_tables(sql, before) != set():
            continue
        listed = ", ".join(sorted(".".join(t) for t in lost))
        return (
            f"The query '{spec.get('label') or spec['name']}' reads {listed}, which this "
            "change removes from the enrichment tables. Remove that query too, or keep the table."
        )
    return None


def build_query(spec: dict, keys: list[str], row_limit: int) -> tuple[str, list[dict]]:
    """``SELECT <key>, <columns> FROM <table> WHERE <key> IN (:k0, …) LIMIT n``."""
    key = quote_identifier(validate_identifier_part(spec["key_column"]))
    columns = [c for c in spec["columns"] if c != spec["key_column"]]
    selected = ", ".join(
        [key, *(quote_identifier(validate_identifier_part(c)) for c in columns)]
    )
    placeholders = ", ".join(f":k{i}" for i in range(len(keys)))
    sql = (
        f"SELECT {selected} FROM {qualified_from_dotted(spec['table'])} "
        f"WHERE {key} IN ({placeholders}) LIMIT {int(row_limit)}"
    )
    params = [{"name": f"k{i}", "value": k, "type": "STRING"} for i, k in enumerate(keys)]
    return sql, params


def clean_keys(keys: list[Any]) -> list[str]:
    settings = get_settings()
    cleaned: list[str] = []
    for k in keys:
        if not isinstance(k, (str, int)) or isinstance(k, bool):
            raise EnrichmentError(400, "INVALID_KEY", "Keys must be strings or integers")
        value = str(k).strip()
        if not value or len(value) > MAX_KEY_LENGTH:
            raise EnrichmentError(
                400, "INVALID_KEY", f"Keys must be 1 to {MAX_KEY_LENGTH} characters"
            )
        if value not in cleaned:
            cleaned.append(value)
    if not cleaned:
        raise EnrichmentError(400, "INVALID_KEY", "Give at least one key")
    if len(cleaned) > settings.enrichment_max_keys:
        raise EnrichmentError(
            400,
            "TOO_MANY_KEYS",
            f"At most {settings.enrichment_max_keys} keys per lookup",
        )
    return cleaned


async def lookup(warehouse, context, name: str, keys: list[Any]) -> dict:
    """``{name, key_column, columns, cardinality, rows: {key: [row]}, truncated}``;
    each row holds only the declared ``columns``."""
    spec = find_table(context, name, needs="lookup")
    # Re-proved on every lookup: the allowed sources may have changed since saving.
    problem = source_problem(spec["table"], context)
    if problem:
        raise EnrichmentError(403, "ENRICHMENT_SCOPE_DENIED", problem)
    cleaned = clean_keys(keys)
    max_rows = get_settings().enrichment_max_rows
    sql, params = build_query(spec, cleaned, max_rows + 1)
    response = await warehouse.execute_statement(sql, parameters=params)
    if response.status.state != "SUCCEEDED":
        message = response.status.error.message if response.status.error else None
        raise EnrichmentError(
            502, "ENRICHMENT_QUERY_FAILED", message or "The enrichment query failed"
        )
    names = [c.name for c in response.manifest.schema.columns] if response.manifest else []
    data = (response.result.data_array if response.result else None) or []
    truncated = len(data) > max_rows
    rows: dict[str, list[dict]] = {}
    for raw in data[:max_rows]:
        record = dict(zip(names, raw))
        key = record.get(spec["key_column"])
        row = {c: record.get(c) for c in spec["columns"]}
        rows.setdefault(str(key), []).append(row)
    return {
        "name": spec["name"],
        "label": spec.get("label"),
        "key_column": spec["key_column"],
        "columns": spec["columns"],
        "cardinality": spec.get("cardinality", "one"),
        "rows": rows,
        "truncated": truncated,
    }


# --- Edge enrichment queries ---------------------------------------------------


_LEADING_COMMENTS = re.compile(r"^(\s*(--[^\n]*(\n|$)|/\*.*?\*/))*\s*", re.DOTALL)
_WITH = re.compile(r"^WITH\s+(RECURSIVE\s+)?", re.IGNORECASE)


def splice_virtual_ctes(author_sql: str, ctes: str = _VIRTUAL_CTES) -> str:
    """The author's statement with ``ctes`` first in its WITH clause. Text
    splicing, like ``apply_cte_prefilter``: regenerating the statement through
    sqlglot would rewrite Spark constructs."""
    body = _LEADING_COMMENTS.sub("", author_sql, count=1).strip().rstrip(";").strip()
    match = _WITH.match(body)
    if match:
        return f"{match.group(0)}{ctes}, {body[match.end():]}"
    return f"WITH {ctes} {body}"


def _cell(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text if len(text) <= MAX_RUN_VALUE_LENGTH else None


def _props(properties: Optional[dict]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in (properties or {}).items():
        if len(out) >= MAX_RUN_PROPS:
            break
        cell = _cell(value)
        if cell is not None:
            out[str(key)] = cell
    return out


def _id(value: str, what: str) -> str:
    if len(value) > MAX_RUN_VALUE_LENGTH:
        raise EnrichmentError(
            400, "INVALID_KEY", f"{what} ids must be at most {MAX_RUN_VALUE_LENGTH} characters"
        )
    return value


def _json_param(name: str, value: list) -> dict:
    # \u0027 keeps a quote out of the text, so no driver or emulator escaping can bite.
    text = json.dumps(value, ensure_ascii=False).replace("'", "\\u0027")
    return {"name": name, "value": text, "type": "STRING"}


def build_run_statement(spec: dict, edges: list, nodes: list) -> tuple[str, list[dict]]:
    """The spliced statement and its two JSON parameters for one batch."""
    with_node_props = bool(spec["query"].get("node_props"))
    edge_rows = [
        {
            "edge_id": _id(e.edge_id, "Edge"),
            "src": _id(e.src, "Node"),
            "dst": _id(e.dst, "Node"),
            "relationship_type": e.relationship_type,
            "props": _props(e.properties),
        }
        for e in edges
    ]
    node_rows = [
        {
            "node_id": _id(n.node_id, "Node"),
            "node_type": n.node_type,
            "props": _props(n.properties) if with_node_props else {},
        }
        for n in nodes
    ]
    params = [_json_param(_EDGES_PARAM, edge_rows), _json_param(_NODES_PARAM, node_rows)]
    if sum(len(p["value"].encode()) for p in params) > MAX_RUN_BATCH_BYTES:
        raise EnrichmentError(
            400, "BATCH_TOO_LARGE", "The edges and nodes sent are too large; send fewer at a time"
        )
    return splice_virtual_ctes(spec["query"]["sql"]), params


async def run_query(warehouse, context, name: str, edges: list, nodes: list) -> dict:
    """``{name, label, target, columns, rows: {id: {col: value}}, truncated, query_ms}``:
    the first row per edge (target edges) or node (target nodes) that was sent; ids not
    sent are dropped."""
    spec = find_table(context, name, needs="query")
    settings = get_settings()
    target = spec["query"].get("target", "edges")
    key, targets = ("node_id", nodes) if target == "nodes" else ("edge_id", edges)
    noun = "nodes" if target == "nodes" else "edges"
    if not targets:
        raise EnrichmentError(400, "INVALID_KEY", f"Send at least one of the {noun} to enrich")
    if len(targets) > settings.enrichment_max_keys:
        raise EnrichmentError(
            400, "TOO_MANY_KEYS", f"At most {settings.enrichment_max_keys} {noun} per run"
        )
    # Re-proved on every run: the allowed sources or the list may have changed since saving.
    problem = source_problem(spec["table"], context) or query_scope_problem(
        spec["query"]["sql"], context
    )
    if problem:
        raise EnrichmentError(403, "ENRICHMENT_SCOPE_DENIED", problem)
    sql, params = build_run_statement(spec, edges, nodes)
    t0 = time.perf_counter()
    try:
        response = await warehouse.execute_statement(sql, parameters=params)
    except Exception as e:  # never leak the statement as a bare 500
        raise EnrichmentError(
            502, "ENRICHMENT_QUERY_FAILED", f"The enrichment query failed: {type(e).__name__}"
        ) from e
    query_ms = round((time.perf_counter() - t0) * 1000, 2)
    if response.status.state != "SUCCEEDED":
        message = response.status.error.message if response.status.error else None
        raise EnrichmentError(
            502, "ENRICHMENT_QUERY_FAILED", message or "The enrichment query failed"
        )
    names = [c.name for c in response.manifest.schema.columns] if response.manifest else []
    if key not in names:
        raise EnrichmentError(
            400,
            "ENRICHMENT_RESULT_NO_KEY",
            f"An enrichment query on {noun} must return a {key} column",
        )
    columns = [c for c in names if c != key]
    data = (response.result.data_array if response.result else None) or []
    max_rows = settings.enrichment_max_rows
    sent = {getattr(t, key) for t in targets}
    rows: dict[str, dict] = {}
    for raw in data[:max_rows]:
        record = dict(zip(names, raw))
        ident = record.get(key)
        if ident is None or str(ident) not in sent or str(ident) in rows:
            continue
        rows[str(ident)] = {c: record.get(c) for c in columns}
    return {
        "name": spec["name"],
        "label": spec.get("label"),
        "target": target,
        "columns": columns,
        "rows": rows,
        "truncated": len(data) > max_rows,
        "query_ms": query_ms,
    }


# --- Enrichment by a registered provider --------------------------------------


def _params_problem(provider, ref: dict, code: str) -> Optional[EnrichmentError]:
    """Why an entry's ``params`` / ``runtime_params`` do not fit what ``provider`` declares."""
    from graphlagoon.services.precomputed.params import ParamError, coerce_values

    declared = {p.name for p in provider.params}
    runtime = ref.get("runtime_params") or []
    unknown = next((n for n in runtime if n not in declared), None)
    if unknown is not None:
        return EnrichmentError(
            400, code, f"The provider '{provider.name}' declares no parameter '{unknown}'"
        )
    # A required parameter left to the run is filled then; every other one must fit now.
    specs = [p for p in provider.params if not (p.required and p.name in runtime
                                                and p.name not in (ref.get("params") or {}))]
    try:
        coerce_values(specs, ref.get("params") or {})
    except ParamError as e:
        return EnrichmentError(400, code, e.message)
    return None


def table_source_problem(spec: dict, context=None) -> Optional[EnrichmentError]:
    """Why a table-source entry cannot be used here, or None: its table provider is
    not registered in this deployment, is not for this context (``context`` given),
    or the entry's parameters do not fit what it declares."""
    from graphlagoon.services.table_providers import get_table_provider

    ref = spec.get("table_provider") or {}
    provider = get_table_provider(ref.get("name", ""))
    if provider is None:
        return EnrichmentError(
            400,
            "TABLE_PROVIDER_NOT_REGISTERED",
            f"No table provider '{ref.get('name')}' is registered on this server",
        )
    if context is not None and provider.applies_to is not None and not provider.applies_to(context):
        return EnrichmentError(
            403,
            "TABLE_PROVIDER_NOT_ALLOWED",
            f"The provider '{provider.name}' is not available to this context",
        )
    return _params_problem(provider, ref, "TABLE_SOURCE_PARAM_INVALID")


def provider_problem(spec: dict, context=None) -> Optional[EnrichmentError]:
    """Why a provider entry cannot run here, or None: its provider is not registered
    in this deployment, does not enrich the entry's target, is not for this context
    (``context`` given), or the entry's parameters do not fit what it declares. A
    table-source entry is judged by ``table_source_problem``."""
    from graphlagoon.services.enrichment_providers import get_enrichment_provider

    if spec.get("table_provider"):
        return table_source_problem(spec, context)
    ref = spec.get("provider") or {}
    provider = get_enrichment_provider(ref.get("name", ""))
    if provider is None:
        return EnrichmentError(
            400,
            "ENRICHMENT_PROVIDER_NOT_REGISTERED",
            f"No enrichment provider '{ref.get('name')}' is registered on this server",
        )
    target = ref.get("target", "edges")
    if target not in provider.targets:
        return EnrichmentError(
            400,
            "ENRICHMENT_PROVIDER_TARGET",
            f"The provider '{provider.name}' does not enrich {target}",
        )
    if context is not None and provider.applies_to is not None and not provider.applies_to(context):
        return EnrichmentError(
            403,
            "ENRICHMENT_PROVIDER_NOT_ALLOWED",
            f"The provider '{provider.name}' is not available to this context",
        )
    return _params_problem(provider, ref, "ENRICHMENT_PARAM_INVALID")


def resolve_provider_params(provider, ref: dict, given: Optional[dict]) -> dict:
    """The values one run uses: the run's own (only the names the entry's author
    listed in ``runtime_params``), over the entry's, over the declared defaults."""
    from graphlagoon.services.precomputed.params import ParamError, coerce_values

    given = {k: v for k, v in (given or {}).items() if v is not None and v != ""}
    allowed = set(ref.get("runtime_params") or [])
    locked = next((k for k in given if k not in allowed), None)
    if locked is not None:
        raise EnrichmentError(
            400,
            "ENRICHMENT_PARAM_INVALID",
            f"'{locked}' cannot be changed when running this enrichment"
            + (f"; a run may set: {', '.join(sorted(allowed))}" if allowed else ""),
        )
    try:
        return coerce_values(provider.params, {**(ref.get("params") or {}), **given})
    except ParamError as e:
        raise EnrichmentError(400, "ENRICHMENT_PARAM_INVALID", e.message)


def _scalar(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


async def run_provider(
    context, name: str, edges: list, nodes: list, user_email: Optional[str],
    params: Optional[dict] = None, user_token: Optional[str] = None,
) -> dict:
    """Same result as ``run_query``, computed by the entry's registered provider,
    plus the ``params`` it ran with."""
    import asyncio
    import logging

    from graphlagoon.services.enrichment_providers import (
        EnrichmentProviderError,
        EnrichmentProviderRequest,
        column_names,
        get_enrichment_provider,
    )

    log = logging.getLogger(__name__)
    spec = find_table(context, name)
    problem = provider_problem(spec, context)
    if problem:
        raise problem
    ref = spec["provider"]
    provider = get_enrichment_provider(ref["name"])
    resolved = resolve_provider_params(provider, ref, params)
    settings = get_settings()
    target = ref.get("target", "edges")
    key, targets = ("node_id", nodes) if target == "nodes" else ("edge_id", edges)
    noun = "nodes" if target == "nodes" else "edges"
    if not targets:
        raise EnrichmentError(400, "INVALID_KEY", f"Send at least one of the {noun} to enrich")
    if len(targets) > settings.enrichment_max_keys:
        raise EnrichmentError(
            400, "TOO_MANY_KEYS", f"At most {settings.enrichment_max_keys} {noun} per run"
        )
    request = EnrichmentProviderRequest(
        context_id=context.id,
        user_email=user_email,
        target=target,
        edges=[
            {
                "edge_id": e.edge_id,
                "src": e.src,
                "dst": e.dst,
                "relationship_type": e.relationship_type,
                "properties": (e.properties or {}) if ref.get("edge_props") else {},
            }
            for e in edges
        ],
        nodes=[
            {
                "node_id": n.node_id,
                "node_type": n.node_type,
                "properties": (n.properties or {}) if ref.get("node_props") else {},
            }
            for n in nodes
        ],
        params=resolved,
        user_token=user_token,
    )
    async def call():
        try:
            return await provider.enrich(request)
        except TimeoutError as e:  # the provider's own timeout is a failure, not ours
            raise RuntimeError("the provider raised TimeoutError") from e

    t0 = time.perf_counter()
    try:
        answer = await asyncio.wait_for(call(), provider.timeout_seconds)
    except asyncio.TimeoutError:
        raise EnrichmentError(
            504,
            "ENRICHMENT_PROVIDER_TIMEOUT",
            f"The provider took longer than {provider.timeout_seconds:g}s",
        )
    except EnrichmentProviderError as e:
        raise EnrichmentError(502, "ENRICHMENT_PROVIDER_FAILED", str(e) or "The provider failed")
    except Exception:  # never leak the provider's internals
        log.exception("Enrichment provider '%s' failed", provider.name)
        raise EnrichmentError(502, "ENRICHMENT_PROVIDER_FAILED", "The provider failed")
    if not isinstance(answer, dict):
        log.error(
            "Enrichment provider '%s' returned %s, not a dict", provider.name, type(answer).__name__
        )
        raise EnrichmentError(502, "ENRICHMENT_PROVIDER_FAILED", "The provider failed")
    query_ms = round((time.perf_counter() - t0) * 1000, 2)
    sent = {getattr(t, key) for t in targets}
    declared = set(column_names(provider.columns))
    undeclared: set[str] = set()
    rows: dict[str, dict] = {}
    columns: list[str] = []
    kept = 0
    for ident, row in answer.items():
        if str(ident) not in sent or not isinstance(row, dict):
            continue
        kept += 1
        if kept > settings.enrichment_max_rows:
            break
        cells = {str(c): _scalar(v) for c, v in row.items()}
        if declared:
            undeclared.update(c for c in cells if c not in declared)
            cells = {c: v for c, v in cells.items() if c in declared}
        rows[str(ident)] = cells
        columns.extend(c for c in cells if c not in columns)
    if undeclared:
        log.warning(
            "Enrichment provider '%s' returned undeclared columns, dropped: %s",
            provider.name, ", ".join(sorted(undeclared)),
        )
    return {
        "name": spec["name"],
        "label": spec.get("label"),
        "target": target,
        "columns": columns,
        "rows": rows,
        "truncated": kept > settings.enrichment_max_rows,
        "query_ms": query_ms,
        "params": resolved,
    }


# --- What an agent reads and runs ----------------------------------------------

# An agent run walks the whole exploration in batches; this caps the warehouse or
# provider calls of one tool call (the rest is reported as ``truncated``).
MAX_GRAPH_RUN_BATCHES = 20
# ...and this, the time: past it the run stops and reports ``truncated`` too.
MAX_GRAPH_RUN_SECONDS = 120.0


def column_payload(columns) -> list[dict]:
    """A provider's declared columns as an agent reads them: name and, when its
    author said so, type, description and unit."""
    from graphlagoon.services.enrichment_providers import column_specs

    return [
        {k: v for k, v in (("name", c.name), ("type", c.type), ("description", c.description), ("unit", c.unit)) if v}
        for c in column_specs(columns)
    ]


def describe_tables(context) -> list[dict]:
    """Each enrichment of ``context`` as an agent needs it to choose one: what it is,
    the author's description (a provider's registered one when the entry has none),
    its lookup and/or run settings, and whether its provider is registered here."""
    from graphlagoon.services.enrichment_providers import get_enrichment_provider

    out = []
    for spec in getattr(context, "enrichment_tables", None) or []:
        description = (spec.get("description") or "").strip()
        lookup = run = None
        if spec.get("key_column"):
            lookup = {
                "key_column": spec["key_column"],
                "match_node_types": spec.get("match_node_types") or [],
                "match_source": spec.get("match_source", "node_id"),
                "columns": spec.get("columns") or [],
                "cardinality": spec.get("cardinality", "one"),
                "promote": spec.get("promote"),
            }
        ref = spec.get("provider") or spec.get("query")
        if ref:
            run = {
                "kind": "provider" if spec.get("provider") else "query",
                "target": ref.get("target", "edges"),
                "mode": ref.get("run", "manual"),
                "overwrite": bool(ref.get("overwrite")),
                "node_props": bool(ref.get("node_props")),
            }
            if spec.get("provider"):
                provider = get_enrichment_provider(ref.get("name", ""))
                run["provider"] = {
                    "name": ref.get("name"),
                    "label": (provider.label or provider.name) if provider else ref.get("name"),
                    "registered": provider is not None,
                }
                run["edge_props"] = bool(ref.get("edge_props"))
                # The properties it writes, when its author declared them.
                run["columns"] = column_payload(provider.columns) if provider else []
                fixed, runtime = ref.get("params") or {}, set(ref.get("runtime_params") or [])
                run["params"] = [
                    {
                        **p.ui_payload(),
                        "value": fixed.get(p.name, p.default),
                        "overridable": p.name in runtime,
                    }
                    for p in (provider.params if provider else [])
                ]
                if not description and provider:
                    description = provider.description
            else:
                run["sql"] = ref.get("sql")
        table_source = None
        if spec.get("table_provider"):
            from graphlagoon.services.table_providers import get_table_provider

            source_ref = spec["table_provider"]
            table_provider = get_table_provider(source_ref.get("name", ""))
            fixed, runtime = source_ref.get("params") or {}, set(source_ref.get("runtime_params") or [])
            table_source = {
                "provider": {
                    "name": source_ref.get("name"),
                    "label": (table_provider.label or table_provider.name) if table_provider else source_ref.get("name"),
                    "registered": table_provider is not None,
                },
                # What kind of item it is about, when asked from a right-click.
                "targets": list(table_provider.targets) if table_provider else [],
                "columns": column_payload(table_provider.columns) if table_provider else [],
                "params": [
                    {**p.ui_payload(), "value": fixed.get(p.name, p.default), "overridable": p.name in runtime}
                    for p in (table_provider.params if table_provider else [])
                ],
            }
            if not description and table_provider:
                description = table_provider.description
        out.append(
            {
                "name": spec.get("name"),
                "label": spec.get("label"),
                "description": description or None,
                "table": spec.get("table"),
                "lookup": lookup,
                "run": run,
                "table_source": table_source,
            }
        )
    return out


async def run_over_graph(
    warehouse, context, name: str, nodes: list, edges: list, user_email: Optional[str],
    only: Optional[set] = None, params: Optional[dict] = None,
) -> dict:
    """Enrichment ``name`` (a query or a provider) over a whole graph, in batches of
    ``enrichment_max_keys`` shaped as the page sends them: target nodes with the edges
    that touch them, or target edges with their endpoint nodes. ``only`` narrows the
    targets to those ids; ``params`` are a provider run's own values. Same result as
    one run, plus ``targets`` and ``batches``. A batch that fails after another
    succeeded does not lose that one: the result then carries ``error``."""
    spec = find_table(context, name)
    ref = spec.get("provider") or spec.get("query")
    if not ref:
        raise EnrichmentError(
            400, "ENRICHMENT_NOT_QUERY", f"'{name}' declares no enrichment query or provider"
        )
    if params and not spec.get("provider"):
        raise EnrichmentError(
            400, "ENRICHMENT_PARAM_INVALID", f"'{name}' is a SQL query: it takes no parameters"
        )
    target = ref.get("target", "edges")
    size = get_settings().enrichment_max_keys
    if target == "nodes":
        targets = [n for n in nodes if only is None or n.node_id in only]
    else:
        targets = [e for e in edges if only is None or e.edge_id in only]
    if not targets:
        noun = "nodes" if target == "nodes" else "edges"
        raise EnrichmentError(400, "INVALID_KEY", f"No {noun} for '{name}' to enrich")
    by_id = {n.node_id: n for n in nodes}
    merged: dict = {
        "name": spec["name"], "label": spec.get("label"), "target": target, "columns": [],
        "rows": {}, "truncated": False, "query_ms": 0.0, "targets": len(targets), "batches": 0,
        "params": None, "error": None,
    }
    started = time.perf_counter()
    for start in range(0, len(targets), size):
        if (
            merged["batches"] >= MAX_GRAPH_RUN_BATCHES
            or time.perf_counter() - started > MAX_GRAPH_RUN_SECONDS
        ):
            merged["truncated"] = True
            break
        batch = targets[start : start + size]
        if target == "nodes":
            ids = {n.node_id for n in batch}
            batch_nodes, batch_edges = batch, [e for e in edges if e.src in ids or e.dst in ids]
        else:
            ends = {i for e in batch for i in (e.src, e.dst)}
            batch_nodes, batch_edges = [by_id[i] for i in ends if i in by_id], batch
        try:
            if spec.get("provider"):
                result = await run_provider(
                    context, name, batch_edges, batch_nodes, user_email, params
                )
            else:
                result = await run_query(warehouse, context, name, batch_edges, batch_nodes)
        except EnrichmentError as e:
            if not merged["batches"]:
                raise
            merged["error"] = {"code": e.code, "message": e.message}
            merged["truncated"] = True
            break
        merged["batches"] += 1
        merged["rows"].update(result["rows"])
        merged["columns"].extend(c for c in result["columns"] if c not in merged["columns"])
        merged["truncated"] = merged["truncated"] or result["truncated"]
        merged["query_ms"] = round(merged["query_ms"] + (result.get("query_ms") or 0), 2)
        merged["params"] = result.get("params")
    return merged
