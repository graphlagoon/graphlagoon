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


def query_scope_problem(sql: str, context) -> Optional[str]:
    """None when ``sql`` reads only the virtual tables and the context's
    authorized tables (edge, node and every listed enrichment table still
    inside the deployment's sources)."""
    settings = get_settings()
    # Dummy CTEs so the virtual names are skipped like any query-local name.
    refs = extract_table_refs(
        f"WITH graph_edges AS (SELECT 1), graph_nodes AS (SELECT 1) {sql}"
    )
    if refs is None:
        return "the query could not be parsed, so the tables it reads cannot be verified."
    allowed = context_tables(
        context, settings.default_catalog, settings.default_schema, current_source_scope()
    )
    outside = {
        normalize_ref(r, settings.default_catalog, settings.default_schema) for r in refs
    } - allowed
    if outside:
        listed = ", ".join(sorted(".".join(t) for t in outside))
        return (
            f"it reads {listed}, which is not an authorized table of this context. "
            "Add it to the enrichment tables first (it must be an allowed source)."
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
