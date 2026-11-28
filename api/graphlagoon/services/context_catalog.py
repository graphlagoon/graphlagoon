"""A graph context as a data catalog: what an agent (or a person) can discover in it
and read from it, without a graph on screen.

Three things, all read-only and all bounded by the context:

- ``catalog(context)``: its graph tables and how they map to nodes and edges, its
  types and properties, the tables it authorizes, and its *sources* — the lookups,
  enrichment queries, providers and table sources its author declared in
  ``enrichment_tables``.
- ``table_columns(...)``: the warehouse's own metadata (column names, types and
  comments) for tables of the context.
- ``run_query(...)`` / ``query_source(...)``: an ad-hoc read-only query over the
  context's tables (the console's rules), or one declared source asked about some ids.

Nothing here adds reach: every call is one a reader of the context could already make
through the REST routes (the console query, the enrichment run and lookup, a table
source's own route). Metadata is
additive, never a gate: a source or a column with no description is listed all the same.
"""

from __future__ import annotations

from typing import Any, Optional

from graphlagoon.services import enrichment

MAX_DESCRIBED_TABLES = 10
DEFAULT_QUERY_ROWS = 200
MAX_QUERY_ROWS = 5000
HOW_TO_QUERY = (
    "query_context runs one read-only SELECT (or a Cypher query) over the tables listed "
    "under 'tables' with sql_queryable true; aggregate in the query rather than fetching "
    "rows. query_source asks one entry of 'sources' by its name. graph_edges and "
    "graph_nodes, seen in a source's sql, exist only inside that enrichment."
)


class CatalogError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _dump(value: Any) -> Any:
    return value.model_dump() if hasattr(value, "model_dump") else value


def _properties(columns) -> list[dict]:
    out = []
    for column in columns or []:
        c = _dump(column)
        out.append(
            {
                "name": c.get("name"),
                "data_type": c.get("data_type"),
                "description": c.get("description") or None,
            }
        )
    return out


def query_languages(context) -> list[str]:
    """What ``run_query`` accepts for this context ([] when its backend is not reachable)."""
    from fastapi import HTTPException

    from graphlagoon.routers.graph import resolve_datasource_or_400

    try:
        datasource = resolve_datasource_or_400(context)
    except HTTPException:
        return []
    return ["cypher", *(["sql"] if datasource.capabilities.supports_sql else [])]


def tables(context) -> list[dict]:
    """The context's tables: its graph tables and the ones it authorizes, each with
    whether a SQL query may read it now (the allowed sources may have changed)."""
    out, seen = [], set()

    def add(name: Optional[str], role: str, queryable: bool) -> None:
        if name and name not in seen:
            seen.add(name)
            out.append({"table": name, "role": role, "sql_queryable": queryable})

    add(getattr(context, "edge_table_name", None), "edges", True)
    add(getattr(context, "node_table_name", None), "nodes", True)
    for spec in getattr(context, "enrichment_tables", None) or []:
        if spec.get("table"):
            add(spec["table"], "authorized", enrichment.source_problem(spec["table"], context) is None)
    return out


def sources(context) -> list[dict]:
    """The entries of the context that answer a question: a lookup by key, an
    enrichment query or a provider. An entry that only authorizes its table is under
    ``tables``. Each says how ``query_source`` takes it."""
    out = []
    for entry in enrichment.describe_tables(context):
        lookup, run, table_source = entry.get("lookup"), entry.get("run"), entry.get("table_source")
        if not lookup and not run and not table_source:
            continue
        ask: dict[str, Any] = {}
        if table_source:
            opened = [p["name"] for p in table_source["params"] if p["overridable"]]
            ask["table"] = {
                "params": f"set {', '.join(opened)}" if opened else "none to set: the context fixed them all",
                "ids": "optional: one id of the " + " or ".join(table_source["targets"] or ["node"])
                + " it is about, if its description says it reads the item",
                "returns": "columns and rows",
            }
        if lookup:
            source = lookup.get("match_source", "node_id")
            ask["lookup"] = {
                "ids": "values of "
                + ("the node id" if source == "node_id" else f"the node property '{_dump(source).get('name')}'")
                + f" of {', '.join(lookup.get('match_node_types') or []) or 'any'} nodes",
                "returns": "rows per id",
            }
        if run:
            edges = run.get("target") == "edges"
            ask["run"] = {
                "ids": "items [{edge_id, src, dst, relationship_type}]" if edges else "node ids",
                "returns": "one row of values per id",
            }
            if run.get("kind") == "query" and not edges:
                # Asked without a graph, the query's graph_nodes are the ids given and
                # graph_edges is empty: a query that joins the edges matches nothing.
                ask["run"]["note"] = (
                    "graph_nodes holds only the ids you give and graph_edges is empty; "
                    "if the query needs edges, read them with query_context instead"
                )
        out.append({**entry, "how": list(ask), "ask": ask})
    return out


def summary(context) -> dict:
    """One line of ``list_contexts``."""
    return {
        "id": str(context.id),
        "title": context.title,
        "description": context.description or None,
        "tags": list(getattr(context, "tags", None) or []),
        "datasource_type": getattr(context, "datasource_type", None) or "sql_warehouse",
        "node_types": list(context.node_types or []),
        "relationship_types": list(context.relationship_types or []),
        "sources": [s["name"] for s in sources(context)],
    }


def catalog(context) -> dict:
    edge, node = _dump(context.edge_structure) or {}, _dump(context.node_structure) or {}
    return {
        "context": {
            "id": str(context.id),
            "title": context.title,
            # Free text by the context's author: where a type's meaning, a
            # relationship's direction and the data's caveats are said.
            "description": context.description or None,
            "tags": list(getattr(context, "tags", None) or []),
            "datasource_type": getattr(context, "datasource_type", None) or "sql_warehouse",
            "query_languages": query_languages(context),
        },
        "graph": {
            "node_table": getattr(context, "node_table_name", None),
            "edge_table": getattr(context, "edge_table_name", None),
            "node_columns": {"id": node.get("node_id_col"), "type": node.get("node_type_col")},
            "edge_columns": {
                "id": edge.get("edge_id_col"),
                "src": edge.get("src_col"),
                "dst": edge.get("dst_col"),
                "type": edge.get("relationship_type_col"),
            },
            "node_types": list(context.node_types or []),
            "relationship_types": list(context.relationship_types or []),
            "node_properties": _properties(context.node_properties),
            "edge_properties": _properties(context.edge_properties),
            "identity_keys": [_dump(k) for k in getattr(context, "identity_keys", None) or []],
            "edge_semantics": _dump(getattr(context, "edge_semantics", None)) or None,
        },
        "tables": tables(context),
        "sources": sources(context),
        "how_to_query": HOW_TO_QUERY,
    }


async def table_columns(warehouse, context, wanted: list[str]) -> list[dict]:
    """The warehouse's metadata for tables of the context: ``{table, reachable,
    columns: [{name, data_type, nullable, comment}]}``. A table that is not one of the
    context's is refused; one the warehouse cannot describe comes back unreachable."""
    from graphlagoon.services.schema_drift import parse_qualified_table

    listed = tables(context)
    known = {t["table"] for t in listed}
    # An authorized table the allowed sources no longer reach is not described either:
    # its columns are as much the warehouse's as its rows.
    closed = {t["table"] for t in listed if not t["sql_queryable"]}
    if len(wanted) > MAX_DESCRIBED_TABLES:
        raise CatalogError(400, "TOO_MANY_TABLES", f"At most {MAX_DESCRIBED_TABLES} tables per call")
    blocked = [t for t in wanted if t in closed]
    if blocked:
        raise CatalogError(
            403,
            "TABLE_NOT_ALLOWED",
            f"Outside the allowed sources now: {', '.join(blocked)}. Ask an admin, or use the context's other tables",
        )
    outside = [t for t in wanted if t not in known]
    if outside:
        raise CatalogError(
            404,
            "TABLE_NOT_IN_CONTEXT",
            f"Not a table of this context: {', '.join(outside)}. It has: {', '.join(sorted(known)) or 'none'}",
        )
    out = []
    for name in wanted:
        columns: list[dict] = []
        parsed = parse_qualified_table(name)
        if parsed is not None:
            catalog_name, database, table = parsed
            try:
                schema = await warehouse.get_table_schema(table, database, catalog_name)
                columns = [
                    {
                        "name": c.name,
                        "data_type": c.data_type,
                        "nullable": getattr(c, "nullable", None),
                        "comment": getattr(c, "comment", None) or None,
                    }
                    for c in schema.columns
                ]
            except Exception:  # an unreachable table is an answer, not a failure
                columns = []
        out.append({"table": name, "reachable": bool(columns), "columns": columns})
    return out


async def run_query(context, user_email: str, query: str, language: str = "sql",
                    row_limit: int = DEFAULT_QUERY_ROWS) -> dict:
    """One read-only query over the context, waited to its rows: the console's table
    query (same scope check, same read-only validation), for a caller with no page."""
    from fastapi import HTTPException

    from graphlagoon.models.schemas import TableQueryRequest
    from graphlagoon.routers.graph import enforce_query_scope, resolve_datasource_or_400
    from graphlagoon.services.datasource.base import GraphExecutionFailure, require_capability
    from graphlagoon.services.graph_operations import QueryExecutionError
    from graphlagoon.services.menu_action_tables import MenuActionError, _wait

    if language not in ("sql", "cypher"):
        raise CatalogError(400, "INVALID_BODY", 'language is "sql" or "cypher"')
    if not query or not query.strip():
        raise CatalogError(400, "EMPTY_QUERY", "Query must not be empty")
    row_limit = max(1, min(int(row_limit), MAX_QUERY_ROWS))
    try:
        datasource = resolve_datasource_or_400(context)
        if language == "sql":
            require_capability(datasource, "supports_sql", "SQL console queries")
        await enforce_query_scope(context, user_email, query if language == "sql" else None, None, datasource)
        request = TableQueryRequest(
            query=query,
            mode=language,
            row_limit=row_limit,
            # The procedural renderer emits a BEGIN…END script the table path refuses.
            **({"vlp_rendering_mode": "cte"}
               if language == "cypher" and getattr(datasource.capabilities, "supports_transpile", False) else {}),
        )
        response = await _wait(datasource, context, await datasource.submit_table_query(context, request), row_limit)
    except HTTPException as exc:
        detail = exc.detail.get("error", {}) if isinstance(exc.detail, dict) else {}
        raise CatalogError(exc.status_code, detail.get("code", "QUERY_FAILED"),
                           detail.get("message", str(exc.detail))) from exc
    except MenuActionError as exc:
        raise CatalogError(exc.status, exc.code, exc.message) from exc
    except QueryExecutionError as exc:
        raise CatalogError(400, getattr(exc, "code", None) or "QUERY_FAILED",
                           getattr(exc, "message", None) or str(exc)) from exc
    except GraphExecutionFailure as exc:
        raise CatalogError(400, "QUERY_FAILED", exc.message) from exc
    return {
        "language": language,
        "columns": response.columns,
        "rows": response.rows,
        "row_count": response.row_count,
        "row_limit": row_limit,
        "truncated": bool(response.truncated or (getattr(response, "total_row_count", 0) or 0) > response.row_count),
    }


def _source(context, name: str) -> dict:
    declared = sources(context)
    entry = next((s for s in declared if s["name"] == name), None)
    if entry is None:
        names = ", ".join(s["name"] for s in declared) or "none"
        raise CatalogError(
            404, "SOURCE_NOT_DECLARED",
            f"This context declares no source '{name}'. It has: {names} (describe_context lists them)",
        )
    return entry


async def query_source(
    warehouse, context, user_email: str, name: str, ids: Optional[list[str]] = None,
    items: Optional[list[dict]] = None, params: Optional[dict] = None, how: Optional[str] = None,
    row_limit: int = DEFAULT_QUERY_ROWS,
) -> dict:
    """One declared source asked about ``ids`` (or full ``items`` when it needs node
    types, properties or an edge's endpoints), or a table source asked with ``params``.
    Nothing is written anywhere."""
    from graphlagoon.models.schemas import EnrichmentRunEdge, EnrichmentRunNode

    entry = _source(context, name)
    mode = how or entry["how"][0]
    if mode not in entry["how"]:
        raise CatalogError(400, "INVALID_BODY", f"'{name}' is asked with how = {' or '.join(entry['how'])}")
    if mode == "table":
        return await _query_table_source(context, user_email, entry, ids, items, params, row_limit)
    try:
        if mode == "lookup":
            if params:
                raise CatalogError(400, "ENRICHMENT_PARAM_INVALID", "a lookup takes no params")
            keys = [str(i) for i in ids or []] or [str(i.get("node_id")) for i in items or [] if i.get("node_id")]
            if not keys:
                raise CatalogError(400, "INVALID_KEY", f"Give ids: {entry['ask']['lookup']['ids']}")
            result = await enrichment.lookup(warehouse, context, name, keys)
            return {"name": name, "how": "lookup", "label": entry.get("label"), "asked": len(keys), **{
                k: result[k] for k in ("key_column", "columns", "cardinality", "rows", "truncated")}}
        run = entry["run"]
        if run["target"] == "edges":
            if not items or any(not all(i.get(k) for k in ("edge_id", "src", "dst")) for i in items):
                raise CatalogError(
                    400, "INVALID_KEY",
                    f"'{name}' enriches edges: give items [{{edge_id, src, dst, relationship_type}}], not ids",
                )
            edges = [EnrichmentRunEdge(edge_id=str(i["edge_id"]), src=str(i["src"]), dst=str(i["dst"]),
                                       relationship_type=str(i.get("relationship_type") or ""),
                                       properties=i.get("properties") or {}) for i in items]
            nodes = [EnrichmentRunNode(node_id=n) for n in dict.fromkeys(x for e in edges for x in (e.src, e.dst))]
        else:
            given = [{"node_id": i} for i in ids or []] + list(items or [])
            if not given or any(not i.get("node_id") for i in given):
                raise CatalogError(400, "INVALID_KEY", f"'{name}' enriches nodes: give ids (node ids)")
            nodes = [EnrichmentRunNode(node_id=str(i["node_id"]), node_type=str(i.get("node_type") or ""),
                                       properties=i.get("properties") or {}) for i in given]
            edges = []
        result = await enrichment.run_over_graph(warehouse, context, name, nodes, edges, user_email, None, params)
    except enrichment.EnrichmentError as exc:
        raise CatalogError(exc.status, exc.code, exc.message) from exc
    out = {
        "name": name, "how": "run", "label": entry.get("label"), "kind": run["kind"], "target": result["target"],
        "asked": result["targets"], "matched": len(result["rows"]), "columns": result["columns"],
        "rows": result["rows"], "truncated": result["truncated"],
    }
    if result.get("params"):
        out["params"] = result["params"]
    if result.get("error"):
        out.update(partial=True, error=result["error"])
    return out


async def _query_table_source(context, user_email: str, entry: dict, ids, items, params, row_limit: int) -> dict:
    """A table source asked directly. A refusal of the parameters or a failure of the
    provider is an error here (an action's window shows them inline instead)."""
    from graphlagoon.services import menu_action_tables as mat

    given = list(items or []) + [{"id": i} for i in ids or []]
    if len(given) > 1:
        raise CatalogError(400, "INVALID_KEY", f"'{entry['name']}' is about one item at a time: give one id")
    target = None
    if given:
        item = given[0]
        ident = item.get("id") or item.get("node_id") or item.get("edge_id")
        if not ident:
            raise CatalogError(400, "INVALID_KEY", "The item needs an id")
        kind = "edge" if item.get("edge_id") or item.get("src") else "node"
        target = {k: v for k, v in {
            "type": kind, "id": str(ident), "node_type": item.get("node_type"),
            "relationship_type": item.get("relationship_type"), "src": item.get("src"), "dst": item.get("dst"),
        }.items() if v}
    try:
        result = await mat.run_source(
            context, user_email, entry["name"], {k: v for k, v in (params or {}).items()},
            target, max(1, min(int(row_limit), MAX_QUERY_ROWS)),
        )
    except mat.MenuActionError as exc:
        raise CatalogError(exc.status, exc.code, exc.message) from exc
    if result["status"] == "needs_parameters":
        said = "; ".join(f"{k} {v}" for k, v in result["problems"].items())
        raise CatalogError(400, "TABLE_SOURCE_PARAM_INVALID", f"{said} (describe_context lists the parameters)")
    if result["status"] == "failed":
        raise CatalogError(502, result["error"]["code"], result["error"]["message"])
    return {
        "name": entry["name"], "how": "table", "label": entry.get("label"),
        "params": {p["id"]: p["value"] for p in result["parameters"]},
        "columns": result["columns"], "rows": result["rows"], "row_count": result["row_count"],
        "row_limit": result["row_limit"], "truncated": result["truncated"],
    }
