"""Saved queries of a case (05 §1): ``run`` executes a ``query`` item against
its context through the same datasource path as the Query Console
(``routers/graph.py``: resolve datasource, scope check, submit/poll for a
table, prepare + execute for a graph) and stores the result as a new version
with its ``run`` metadata (statement id, duration, rows, parameters, author).
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException

from graphlagoon.services import case_items
from graphlagoon.services.cases import InvestigationError, _session, author_fields, ensure_not_decided, load_case

_PARAM = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)")


def _sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple, set)):
        return ", ".join(_sql_literal(v) for v in value)
    return "'" + str(value).replace("'", "''") + "'"


def substitute(text: str, declared: list[dict], given: dict) -> tuple[str, dict]:
    """``:name`` → the value given (or the parameter's default), validated like
    a query template's parameters (required, select options). Values are
    spliced as SQL/Cypher literals; lists become ``'a', 'b'`` for ``IN (:ids)``.
    Returns the text and the parameters actually used."""
    by_id = {p["id"]: p for p in declared}
    used: dict = {}
    for name in sorted(set(_PARAM.findall(text))):
        spec = by_id.get(name)
        value = given.get(name, spec.get("default") if spec else None)
        if value in (None, "", []):
            if spec is None or spec.get("required", True):
                raise InvestigationError(422, "QUERY_PARAMETER_MISSING", f"Parameter :{name} has no value")
            value = None
        if spec and spec.get("type") == "select" and spec.get("options") and value not in spec["options"]:
            raise InvestigationError(
                422, "QUERY_PARAMETER_INVALID", f":{name} must be one of {spec['options']}"
            )
        used[name] = value
    unknown = sorted(set(given) - set(used))
    if unknown:
        raise InvestigationError(422, "QUERY_PARAMETER_UNKNOWN", f"The query has no parameter {unknown}")
    text = _PARAM.sub(lambda m: _sql_literal(used[m[1]]), text)
    return text, used


def _http_to_case_error(exc: HTTPException) -> InvestigationError:
    detail = exc.detail if isinstance(exc.detail, dict) else {}
    error = detail.get("error", {}) if isinstance(detail, dict) else {}
    return InvestigationError(
        exc.status_code, error.get("code", "QUERY_FAILED"), error.get("message", str(exc.detail))
    )


async def _poll_table(datasource, context, response, row_limit: int):
    """Waits for a submitted table query like the console does (poll + interval)."""
    from graphlagoon.config import get_settings

    settings = get_settings()
    deadline = time.monotonic() + settings.warehouse_max_poll_time
    while response.status == "running":
        if time.monotonic() > deadline:
            raise InvestigationError(504, "QUERY_TIMEOUT", "The query did not finish in time")
        await asyncio.sleep(settings.warehouse_poll_interval)
        response = await datasource.get_table_query_status(context, response.statement_id, row_limit)
        if response.status == "canceled":
            raise InvestigationError(409, "QUERY_CANCELED", "The query was canceled")
    return response


async def run_query(
    investigation_id: UUID, user_email: str, item_id: UUID, parameters: dict, row_limit: int = 1000
) -> dict:
    """Runs the item's query and stores the result as a new version; returns the item."""
    from graphlagoon.models.schemas import CypherQueryRequest, GraphQueryRequest, TableQueryRequest
    from graphlagoon.routers.graph import enforce_query_scope, resolve_datasource_or_400
    from graphlagoon.services.datasource.base import GraphExecutionFailure, require_capability
    from graphlagoon.services.graph_operations import QueryExecutionError
    from graphlagoon.utils.context_access import get_context_with_access

    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        item = await case_items.item_row(session, investigation_id, item_id)
    if item.kind != "query" or not item.query:
        raise InvestigationError(422, "NOT_A_QUERY", "Only query items run")
    if item.context_id is None:
        raise InvestigationError(422, "QUERY_CONTEXT_MISSING", "The query needs a graph context to run against")
    spec = item.query
    text, used = substitute(spec["text"], spec.get("parameters") or [], parameters or {})
    started = datetime.now()
    t0 = time.perf_counter()
    try:
        context = await get_context_with_access(item.context_id, user_email)
        datasource = resolve_datasource_or_400(context)
        if spec.get("output") == "graph":
            if spec["language"] == "cypher":
                prepared = datasource.prepare_cypher(context, CypherQueryRequest(query=text))
            else:
                require_capability(datasource, "supports_sql", "Raw SQL graph queries")
                prepared = datasource.prepare_sql(context, GraphQueryRequest(query=text))
            await enforce_query_scope(context, user_email, prepared.statement, None, datasource)
            graph = await datasource.execute_prepared(context, prepared)
            content = {
                "nodes": [n.model_dump() for n in graph.nodes],
                "edges": [e.model_dump() for e in graph.edges],
                "truncated": graph.truncated,
                "transpiled_sql": prepared.transpiled_sql,
            }
            statement_id, row_count = None, len(graph.edges)
        else:
            if spec["language"] == "sql":
                require_capability(datasource, "supports_sql", "SQL console queries")
            await enforce_query_scope(
                context, user_email, text if spec["language"] == "sql" else None, None, datasource
            )
            request = TableQueryRequest(query=text, mode=spec["language"], row_limit=row_limit)
            response = await _poll_table(
                datasource, context, await datasource.submit_table_query(context, request), row_limit
            )
            content = {
                "columns": response.columns,
                "rows": response.rows,
                "row_count": response.row_count,
                "truncated": response.truncated,
                "transpiled_sql": getattr(response, "transpiled_sql", None),
            }
            statement_id, row_count = response.statement_id, response.row_count
    except HTTPException as exc:
        raise _http_to_case_error(exc) from exc
    except QueryExecutionError as exc:
        raise InvestigationError(400, getattr(exc, "code", None) or "QUERY_FAILED", str(exc)) from exc
    except GraphExecutionFailure as exc:
        raise InvestigationError(400, "QUERY_FAILED", exc.message) from exc
    run = {
        "statement_id": statement_id,
        "started_at": started.isoformat(),
        "duration_ms": round((time.perf_counter() - t0) * 1000, 1),
        "row_count": row_count,
        "params": used,
        "run_by": user_email,
        "author_kind": author_fields(user_email)["author_kind"],
        "output": spec.get("output", "table"),
    }
    data = json.dumps(content, ensure_ascii=False, default=str).encode("utf-8")
    return await case_items.add_version(investigation_id, user_email, item_id, data, "application/json", run=run)
