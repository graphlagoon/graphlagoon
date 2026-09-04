"""
Graph operations service.

This module contains the graph processing logic that was previously in sql-warehouse.
It processes raw DataFrame results from the warehouse and constructs GraphResponse objects.
"""

import json
import logging
import time
from typing import Optional, Any

from graphlagoon.models.schemas import (
    Node,
    Edge,
    GraphResponse,
    QueryMetadata,
    ColumnConfig,
)
from graphlagoon.services.sql_identifiers import quote_identifier
from graphlagoon.services.sql_validation import extract_query_limit
from graphlagoon.services.warehouse_errors import (
    classify_query_error,
    STALE_SCHEMA_CODE,
)

logger = logging.getLogger(__name__)


class QueryExecutionError(Exception):
    """Raised when a SQL query execution fails.

    This error is meant to be caught by endpoints and returned as a
    structured error response (not a 500 error).
    """

    def __init__(
        self, message: str, query: Optional[str] = None, code: Optional[str] = None
    ):
        self.message = message
        self.query = query
        # Classified once here so every raise site (the warehouse failure path
        # below, and the "empty graph" guard in process_graph_query_result) gets
        # the same STALE_CONTEXT_SCHEMA / QUERY_EXECUTION_ERROR code without
        # each caller re-deriving it. `code` overrides the classifier when a
        # caller already knows better (e.g. the empty-graph guard's own message).
        self.code = code or classify_query_error(message)[0]
        super().__init__(message)


# Constant types for tables that have no type column (node_type_col="" /
# relationship_type_col="") and for the derived virtual node table of a
# nodeless (triple-store-only) context. Injected at the read boundary — the
# empty column name itself stays stored verbatim, meaning "absent".
DEFAULT_NODE_TYPE = "Node"
DEFAULT_RELATIONSHIP_TYPE = "RELATED_TO"


def merge_column_config(context) -> dict:
    """Merge edge_structure and node_structure from context into a single ColumnConfig.

    An empty string for a type column is semantic ("this table has no such
    column") and is returned verbatim — never defaulted away.
    """
    edge_struct = context.edge_structure or {}
    node_struct = context.node_structure or {}
    return {
        "edge_id_col": edge_struct.get("edge_id_col", "edge_id"),
        "src_col": edge_struct.get("src_col", "src"),
        "dst_col": edge_struct.get("dst_col", "dst"),
        "relationship_type_col": edge_struct.get(
            "relationship_type_col", "relationship_type"
        ),
        "node_id_col": node_struct.get("node_id_col", "node_id"),
        "node_type_col": node_struct.get("node_type_col", "node_type"),
    }


def derived_node_table_sql(edge_table: str, column_config: ColumnConfig) -> str:
    """Virtual node table for contexts that have no physical node table.

    A triple-store-only context knows its nodes only as edge endpoints, so the
    node "table" is derived on the fly: the deduplicated union of src and dst,
    with a constant ``'Node'`` type (a triple store carries no node typing).
    Returned WITHOUT a trailing alias — every call site appends its own
    (``FROM {node_table} n``), the same contract as a physical table name.

    Each use scans the edge table twice (one UNION arm per endpoint column);
    acceptable for the target datasets — users with very large triple stores
    should materialize a nodes view and point the context at it instead.

    When the context also has no node type column (``node_type_col=""``) the
    fragment is a single id column — a ``'Node' AS <alias>`` column would be
    misfiled as a node *property* by process_nodes_result (the empty name is
    not in its structural set). The constant type is injected at the read
    boundary instead (DEFAULT_NODE_TYPE).
    """
    node_id = _quote_identifier(column_config.node_id_col)
    src = _quote_identifier(column_config.src_col)
    dst = _quote_identifier(column_config.dst_col)
    if column_config.node_type_col:
        node_type = _quote_identifier(column_config.node_type_col)
        projection = f"node_id AS {node_id}, '{DEFAULT_NODE_TYPE}' AS {node_type}"
    else:
        projection = f"node_id AS {node_id}"
    return (
        f"(SELECT {projection} FROM ("
        f"SELECT {src} AS node_id FROM {edge_table} "
        f"UNION "
        f"SELECT {dst} AS node_id FROM {edge_table}))"
    )


def resolve_node_table(context) -> str:
    """The context's physical node table name, or the derived fragment when absent."""
    if getattr(context, "node_table_name", None):
        return context.node_table_name
    config = ColumnConfig(**merge_column_config(context))
    return derived_node_table_sql(context.edge_table_name, config)


def _get_edge_id(
    row_dict: dict,
    edge_id_col: Optional[str],
    src_col: str,
    dst_col: str,
    rel_type_col: str,
) -> str:
    """Get edge_id from row, or generate composite key if edge_id_col is None.

    With an absent relationship type column (``rel_type_col=""``) the
    composite is ``src@@dst`` — deliberately NOT the constant type: both the
    subgraph/expand path and the transpiled-Cypher path omit the column from
    their structs, so the two produce identical ids and dedup stays
    consistent. Edge ids are opaque to the frontend.
    """
    if edge_id_col and edge_id_col in row_dict:
        return row_dict[edge_id_col]
    # Generate composite key: {src}@{relationship_type}@{dst}. `.get()`, not direct
    # indexing: src_col/dst_col can be absent from the row when the context's
    # structural columns no longer match the query result (a stale/renamed
    # column) — that case must reach the guard in process_graph_query_result as a
    # classified error, not crash here with an unhandled KeyError (500).
    return (
        f"{row_dict.get(src_col, '')}@{row_dict.get(rel_type_col, '')}"
        f"@{row_dict.get(dst_col, '')}"
    )


def _parse_statement_result(
    result, query: Optional[str] = None
) -> tuple[list[str], list[list[Any]]]:
    """Parse StatementResponse into columns and rows.

    Converts the Databricks-style response back to the format expected by
    the processing functions.

    Raises:
        QueryExecutionError: If the query execution failed.
    """
    if result.status.state != "SUCCEEDED":
        error_msg = (
            result.status.error.message if result.status.error else "Unknown error"
        )
        raise QueryExecutionError(error_msg, query=query)

    if not result.manifest or not result.result:
        return [], []

    columns = [col.name for col in result.manifest.schema.columns]
    rows = result.result.data_array or []

    return columns, rows


async def execute_tabular_query(
    warehouse_client,
    query: str,
    row_limit: int = 1000,
) -> tuple[list[str], list[list[Any]], bool]:
    """Execute a SQL query and return raw tabular rows.

    Unlike execute_graph_query_with_nodes, this does NOT transform the result
    into nodes/edges — it returns the columns and rows as-is for display in a
    generic results table. The query must be a read-only SELECT (validate with
    validate_sql_query before calling).

    Args:
        warehouse_client: The warehouse HTTP client
        query: The SQL query to execute (catalog.schema.table format)
        row_limit: Maximum number of rows to return (also drives truncation)

    Returns:
        (columns, rows, truncated) — truncated is True when the returned row
        count reached the row_limit cap.

    Raises:
        QueryExecutionError: If the query execution failed.
    """
    result = await warehouse_client.execute_statement(
        statement=query,
        row_limit=row_limit,
    )
    columns, rows = _parse_statement_result(result, query=query)
    truncated = len(rows) >= row_limit
    return columns, rows, truncated


def parse_tabular_result(
    result, query: Optional[str] = None, row_limit: int = 1000
) -> tuple[list[str], list[list[Any]], bool]:
    """Parse a SUCCEEDED StatementResponse into (columns, rows, truncated).

    Shared by the cancellable table-query flow: both the submit fast path and
    the poll path receive a StatementResponse and need the same raw-row shape
    as :func:`execute_tabular_query`.

    Raises:
        QueryExecutionError: If the statement did not SUCCEED.
    """
    columns, rows = _parse_statement_result(result, query=query)
    truncated = len(rows) >= row_limit
    return columns, rows, truncated


def _parse_row_value(value: Optional[str]) -> Any:
    """Parse string value from Databricks format back to appropriate type.

    The statements API returns all values as strings. NAMED_STRUCT results
    are serialized as JSON by sql-warehouse.
    """
    if value is None:
        return None

    # Try to parse as JSON (for NAMED_STRUCT results serialized as JSON)
    if value.startswith("{") or value.startswith("["):
        try:
            return json.loads(value)
        except Exception:
            pass

    return value


def process_graph_query_result(
    columns: list[str], rows: list[list[Any]], column_config: ColumnConfig
) -> tuple[GraphResponse, set[str]]:
    """
    Process raw query result from sql-warehouse into GraphResponse.

    The query result is expected to have a column 'r' containing the edge data
    as a dict (from NAMED_STRUCT). We extract node IDs from src/dst and query
    the nodes table separately.

    Args:
        columns: Column names from the query result
        rows: Raw row data from the query result
        column_config: Column configuration for edge/node tables

    Returns:
        Tuple of (GraphResponse with edges only, set of node IDs to fetch)
    """
    if not rows:
        return GraphResponse(nodes=[], edges=[], truncated=False), set()

    # Get column config
    edge_id_col = column_config.edge_id_col
    src_col = column_config.src_col
    dst_col = column_config.dst_col
    rel_type_col = column_config.relationship_type_col

    # Structure columns that should not be included in properties
    edge_structure_cols = {edge_id_col, src_col, dst_col, rel_type_col}

    # Find the 'r' column index (NAMED_STRUCT result)
    r_idx = None
    for i, col in enumerate(columns):
        if col == "r":
            r_idx = i
            break

    if r_idx is None:
        # No 'r' column - return empty response
        return GraphResponse(nodes=[], edges=[], truncated=False), set()

    # Process edges from the 'r' column
    edges = []
    node_ids = set()
    seen_edge_ids: set[str] = set()
    # Counts feeding the stale-structural-column guard below: `missing_key_count`
    # tracks rows where src_col/dst_col are ABSENT AS KEYS — distinct from
    # present-but-NULL, which is legitimate data. A renamed src_col/dst_col makes
    # every item miss the key, which otherwise builds a full edge list with
    # src="", dst="" and an empty node_ids set: an HTTP 200, empty canvas, and no
    # error anywhere.
    processed_count = 0
    missing_key_count = 0
    sample_keys: Optional[list[str]] = None
    for row in rows:
        r_data = row[r_idx]

        # Handle string serialized format from statements API
        if isinstance(r_data, str):
            r_data = _parse_row_value(r_data)

        items_to_process = []
        if isinstance(r_data, list):
            items_to_process = r_data
        elif isinstance(r_data, dict):
            items_to_process = [r_data]
        else:
            continue  # Skip invalid format
        for item in items_to_process:
            if not isinstance(item, dict):
                continue  # Skip invalid format
            processed_count += 1
            if sample_keys is None:
                sample_keys = sorted(item.keys())
            if src_col not in item or dst_col not in item:
                missing_key_count += 1
            edge_id = _get_edge_id(item, edge_id_col, src_col, dst_col, rel_type_col)

            # Skip duplicate edges
            if edge_id in seen_edge_ids:
                continue
            seen_edge_ids.add(edge_id)

            src_id = item.get(src_col)
            dst_id = item.get(dst_col)

            if src_id:
                node_ids.add(src_id)
            if dst_id:
                node_ids.add(dst_id)

            # Extract properties (all columns except structure columns)
            properties = {}
            for col, value in item.items():
                if col not in edge_structure_cols and value is not None:
                    # Parse string values that might be JSON
                    if isinstance(value, str):
                        value = _parse_row_value(value)
                    properties[col] = value

            # Build edge. An absent relationship type column (rel_type_col="")
            # means every edge carries the constant type; a configured column
            # with NULLs still yields "".
            edge = Edge(
                edge_id=edge_id,
                src=src_id or "",
                dst=dst_id or "",
                relationship_type=(
                    item.get(rel_type_col, "")
                    if rel_type_col
                    else DEFAULT_RELATIONSHIP_TYPE
                ),
                properties=properties if properties else None,
            )
            edges.append(edge)

    if processed_count > 0 and missing_key_count == processed_count:
        # This message doesn't itself contain a Spark marker classify_query_error
        # would recognize, so the code is set explicitly rather than left to the
        # classifier — this IS a stale-schema failure by construction.
        raise QueryExecutionError(
            f"Every edge row is missing the configured columns `{src_col}`/"
            f"`{dst_col}` — the context's structural columns may no longer "
            f"match this query result. Columns present in the result: "
            f"{sample_keys}.",
            code=STALE_SCHEMA_CODE,
        )

    return (
        GraphResponse(
            nodes=[],  # Nodes will be populated by a separate query
            edges=edges,
            # Both are set by the caller, which is the only place that knows the
            # requested limit (see execute_graph_query_with_nodes).
            truncated=False,
            total_count=len(edges),
        ),
        node_ids,
    )


def _stringify_scalar(value: Any) -> Any:
    """Render a struct-field scalar the way the statements API renders columns.

    Top-level column values arrive as strings (the warehouse applies ``str()``
    to every scalar), but values nested inside a NAMED_STRUCT survive JSON
    decoding as real numbers and booleans. Without this, the same property is a
    float on the harvested path and a string on the node-query path.

    Containers are left alone: nested structs/arrays are already dicts/lists on
    both paths, since ``_parse_row_value`` JSON-decodes them.

    Verified against the local warehouse: ``SELECT true, 1.5`` returns
    ``['True', '1.5']`` — plain Python ``str()``, including the capitalised
    boolean — while the same values inside a NAMED_STRUCT come back as JSON
    ``true``/``1.5``.
    """
    if isinstance(value, (bool, int, float)):
        return str(value)
    return value


def harvest_nodes_from_result(
    columns: list[str],
    rows: list[list[Any]],
    column_config: ColumnConfig,
) -> dict[str, Node]:
    """Collect nodes already present in a query result, keyed by node id.

    A transpiled Cypher query that returns node variables (``RETURN a, b``)
    renders them as NAMED_STRUCTs keyed by the context's own column names — the
    same names ``process_nodes_result`` reads. Those structs carry everything a
    Node needs, so re-fetching the same rows in the follow-up node query is a
    wholly redundant warehouse round-trip.

    Only structs that actually carry the node id column are harvested; anything
    else (the edge ``r`` column, scalar projections, aggregates) is ignored, so
    a query that returns no node variables simply yields nothing and the normal
    node fetch runs unchanged.
    """
    node_id_col = column_config.node_id_col
    node_type_col = column_config.node_type_col
    structure_cols = {node_id_col, node_type_col}

    harvested: dict[str, Node] = {}
    for row in rows:
        for i, col in enumerate(columns):
            # The edge column is handled by process_graph_query_result.
            if col == "r" or i >= len(row):
                continue

            value = row[i]
            if isinstance(value, str):
                value = _parse_row_value(value)

            # A node variable may be returned bare or inside collect().
            items = value if isinstance(value, list) else [value]
            for item in items:
                if not isinstance(item, dict):
                    continue
                node_id = item.get(node_id_col)
                if not node_id:
                    continue

                properties = {}
                for prop_col, prop_value in item.items():
                    if prop_col in structure_cols or prop_value is None:
                        continue
                    if isinstance(prop_value, str):
                        prop_value = _parse_row_value(prop_value)
                    else:
                        # Struct fields arrive already typed (JSON numbers,
                        # booleans), while the node-query path gets everything
                        # as strings from the statements API. Normalise to the
                        # string form so a property does not change type
                        # depending on which path produced the node — property
                        # filters and sorting on the client compare raw values.
                        prop_value = _stringify_scalar(prop_value)
                    properties[prop_col] = prop_value

                existing = harvested.get(node_id)
                # Prefer the richest struct: the same node can appear in several
                # projections, some carrying only the id.
                if existing is not None and len(existing.properties or {}) >= len(
                    properties
                ):
                    continue

                harvested[node_id] = Node(
                    node_id=node_id,
                    # Absent type column ⇒ constant type (typeless table).
                    node_type=(
                        item.get(node_type_col, "") or ""
                        if node_type_col
                        else DEFAULT_NODE_TYPE
                    ),
                    properties=properties if properties else None,
                )

    return harvested


# Column names reach the query builder from stored context configuration, not
# from request bodies, but quoting keeps names with spaces/reserved words
# working and closes the injection path if a context is ever attacker-shaped.
_quote_identifier = quote_identifier


def build_node_projection(
    column_config: ColumnConfig,
    node_columns: Optional[list[str]] = None,
) -> str:
    """Build the SELECT list for the node query.

    Returns ``n.*`` when no explicit projection is requested, preserving the
    historical behaviour for contexts that have no configured properties.

    When ``node_columns`` is given, only the structural columns plus those
    properties are selected. Node ``properties`` are by far the largest part of
    a graph payload and are not needed to render — narrowing the projection cuts
    scan cost, wire size and the client's reactive-wrap cost in one step.

    Duplicates (a property column that is also structural, or listed twice) are
    dropped while preserving order, so the result never selects the same column
    twice.
    """
    if node_columns is None:
        return "n.*"

    ordered: list[str] = []
    seen: set[str] = set()
    for col in (column_config.node_id_col, column_config.node_type_col, *node_columns):
        if col and col not in seen:
            seen.add(col)
            ordered.append(col)

    # An empty/whitespace-only property list still yields the structural
    # columns, which is exactly the "types-only" projection Phase 2 needs.
    return ", ".join(f"n.{_quote_identifier(col)}" for col in ordered)


def build_node_query(
    node_table: str,
    node_ids,
    column_config: ColumnConfig,
    node_columns: Optional[list[str]] = None,
) -> str:
    """Build the SQL that fetches node rows for a set of ids.

    A JOIN against an inline VALUES relation is materially faster than a
    ``WHERE node_id IN (<literal list>)`` for large id sets: the warehouse
    planner turns it into a hash join over a LocalRelation instead of
    evaluating a huge IN predicate (~40% faster at 20k ids on local Spark; the
    gap widens on Databricks, where large IN lists are costly to compile).

    Ids are deduped by the caller and node_id is unique, so the join stays 1:1.
    """
    from graphlagoon.services.sql_validation import sanitize_string_literal

    node_values_str = ", ".join([f"('{sanitize_string_literal(n)}')" for n in node_ids])
    projection = build_node_projection(column_config, node_columns)
    return f"""
        SELECT {projection}
        FROM {node_table} n
        JOIN (VALUES {node_values_str}) AS _node_ids(_id)
          ON n.{_quote_identifier(column_config.node_id_col)} = _node_ids._id
    """


async def fetch_nodes_by_ids(
    warehouse_client,
    node_table: str,
    node_ids,
    column_config: ColumnConfig,
    node_columns: Optional[list[str]] = None,
    use_external_links: bool = False,
    on_submit=None,
) -> tuple[list[Node], float, str]:
    """Fetch node rows for a set of ids.

    Shared by the graph funnel's second phase and the standalone
    ``/nodes/batch`` endpoint that backs progressive loading.

    Returns (nodes, query_ms, query) — the query is returned so callers can
    attach it to error responses.
    """
    query = build_node_query(node_table, node_ids, column_config, node_columns)

    t0 = time.perf_counter()
    if use_external_links:
        result = await warehouse_client.execute_statement_external(
            statement=query,
            on_submit=on_submit,
        )
    else:
        result = await warehouse_client.execute_statement(
            statement=query,
            on_submit=on_submit,
        )
    query_ms = (time.perf_counter() - t0) * 1000

    columns, rows = _parse_statement_result(result, query=query)
    return process_nodes_result(columns, rows, column_config), query_ms, query


def process_nodes_result(
    columns: list[str], rows: list[list[Any]], column_config: ColumnConfig
) -> list[Node]:
    """
    Process raw nodes query result into list of Node objects.

    Args:
        columns: Column names from the query result
        rows: Raw row data from the query result
        column_config: Column configuration

    Returns:
        List of Node objects
    """
    if not rows:
        return []

    node_id_col = column_config.node_id_col
    node_type_col = column_config.node_type_col

    # Structure columns that should not be included in properties
    structure_cols = {node_id_col, node_type_col}

    nodes = []
    for row in rows:
        # Build row dict
        row_dict = {col: row[i] for i, col in enumerate(columns)}

        # Extract properties (all columns except structure columns)
        properties = {}
        for col, value in row_dict.items():
            if col not in structure_cols and value is not None:
                # Parse string values that might be JSON
                if isinstance(value, str):
                    value = _parse_row_value(value)
                properties[col] = value

        node = Node(
            node_id=row_dict.get(node_id_col, "") or "",
            # Absent type column ⇒ constant type (typeless table).
            node_type=(
                row_dict.get(node_type_col, "") or ""
                if node_type_col
                else DEFAULT_NODE_TYPE
            ),
            properties=properties if properties else None,
        )
        nodes.append(node)

    return nodes


async def execute_graph_query_with_nodes(
    warehouse_client,
    node_table: str,
    query: str,
    limit: int | None,
    column_config: ColumnConfig,
    use_external_links: bool = False,
    on_submit=None,
    progress_callback=None,
    node_columns: Optional[list[str]] = None,
    nodes_mode: str = "full",
    on_partial=None,
) -> GraphResponse:
    """
    Execute a graph query and fetch associated nodes.

    Uses the Databricks-compatible /api/2.0/sql/statements endpoint.

    Args:
        warehouse_client: The warehouse HTTP client
        node_table: Node table name (catalog.schema.table format)
        query: The SQL query to execute (should use catalog.schema.table format)
        limit: Query result limit (applied to edge query)
        column_config: Column configuration
        on_submit: Optional callback(statement_id) fired for each submitted
            warehouse statement (edges then nodes) — lets the caller cancel them.
        progress_callback: Optional callback(phase, done, total) fired as chunks
            download; phase is "edges" or "nodes". Only fires on the
            EXTERNAL_LINKS path.
        node_columns: Optional property columns to select on the node query.
            ``None`` keeps the historical ``SELECT n.*``; a list narrows the
            projection to the structural columns plus these (an empty list
            yields structural columns only). See :func:`build_node_projection`.
        nodes_mode: ``"full"`` (default) returns nodes with their properties.
            ``"types"`` returns only the structural columns, so the client can
            render immediately and fetch properties in the background; the
            response is flagged with ``properties_deferred``.
        on_partial: Optional callback(GraphResponse) invoked once with a
            renderable intermediate result — edges plus nodes carrying only
            their structural columns — before the full property fetch runs.
            Lets a polling client draw the graph roughly twice as early
            (measured 8046ms -> ~4115ms on a 100-column table). Ignored when
            ``nodes_mode="types"``, where the main query already is that.

    Returns:
        Complete GraphResponse with nodes and edges
    """
    t_total_start = time.perf_counter()

    def _phase_progress(phase: str):
        if progress_callback is None:
            return None
        return lambda done, total: progress_callback(phase, done, total)

    # Execute the edge query via statements API
    # Query should already use catalog.schema.table format
    # sql-warehouse handles conversion to local Spark format internally
    t0 = time.perf_counter()
    if use_external_links:
        result = await warehouse_client.execute_statement_external(
            statement=query,
            row_limit=limit,
            on_submit=on_submit,
            progress_callback=_phase_progress("edges"),
        )
    else:
        result = await warehouse_client.execute_statement(
            statement=query,
            row_limit=limit,
            on_submit=on_submit,
        )
    edge_query_ms = (time.perf_counter() - t0) * 1000

    columns, rows = _parse_statement_result(result, query=query)

    # Client-side chunk-download telemetry (EXTERNAL_LINKS path only)
    edge_download_ms = getattr(result, "client_download_ms", None)
    edge_chunk_count = getattr(result, "client_chunk_count", None)

    if not rows:
        total_ms = (time.perf_counter() - t_total_start) * 1000
        return GraphResponse(
            nodes=[],
            edges=[],
            truncated=False,
            metadata=QueryMetadata(
                edge_query_ms=round(edge_query_ms, 2),
                total_ms=round(total_ms, 2),
                chunk_download_ms=edge_download_ms,
                chunk_count=edge_chunk_count,
                node_count=0,
                edge_count=0,
            ),
        )

    # Process edges and extract node IDs
    t0 = time.perf_counter()
    try:
        response_partial, node_ids = process_graph_query_result(
            columns, rows, column_config
        )
    except QueryExecutionError:
        # Let a classified failure (e.g. the stale-structural-column guard) reach
        # the router as-is — wrapping it in RuntimeError below would lose its
        # `.code` and turn an actionable 400 into an opaque 500.
        raise
    except Exception as e:
        raise RuntimeError(
            f"Failed to process edge query result "
            f"(columns={columns}, row_count={len(rows)}, "
            f"first_row={rows[0] if rows else 'N/A'}): {e}"
        ) from e
    edge_processing_ms = (time.perf_counter() - t0) * 1000

    # Truncation: the warehouse returned exactly as many rows as the cap
    # allowed, so there are almost certainly more. `/subgraph` and `/expand`
    # pass the cap explicitly; the query endpoints take it from the user's own
    # SQL, so read it back out of the statement.
    #
    # An exact-fit result is reported as truncated too. The alternative — a
    # COUNT(*) to distinguish "exactly N" from "N of many" — would re-run the
    # expensive half of every load to remove a rare false positive.
    #
    # `total_count` reports how many edges this response carries. It
    # deliberately does NOT claim the table total: the edge query is arbitrary
    # user SQL, so counting honestly means running it again wrapped in a COUNT.
    effective_limit = limit if limit is not None else extract_query_limit(query)
    if effective_limit is not None and len(rows) >= effective_limit:
        response_partial.truncated = True
    response_partial.total_count = len(response_partial.edges)

    if not node_ids:
        total_ms = (time.perf_counter() - t_total_start) * 1000
        response_partial.metadata = QueryMetadata(
            edge_query_ms=round(edge_query_ms, 2),
            edge_processing_ms=round(edge_processing_ms, 2),
            total_ms=round(total_ms, 2),
            chunk_download_ms=edge_download_ms,
            chunk_count=edge_chunk_count,
            node_count=0,
            edge_count=len(response_partial.edges),
        )
        return response_partial

    # A transpiled Cypher query that returns node variables already joined the
    # node table and carries the rows in its result. Reuse them instead of
    # fetching the same data again; only the remainder needs a round-trip.
    harvested = harvest_nodes_from_result(columns, rows, column_config)
    missing_ids = node_ids - harvested.keys()

    if not missing_ids:
        total_ms = (time.perf_counter() - t_total_start) * 1000
        nodes = [harvested[nid] for nid in node_ids if nid in harvested]
        return GraphResponse(
            nodes=nodes,
            edges=response_partial.edges,
            truncated=response_partial.truncated,
            total_count=response_partial.total_count,
            # Harvested nodes carry the properties the query already returned;
            # they cost nothing extra, so they are kept even in "types" mode and
            # nothing is left pending.
            properties_deferred=False,
            metadata=QueryMetadata(
                edge_query_ms=round(edge_query_ms, 2),
                edge_processing_ms=round(edge_processing_ms, 2),
                # No node query ran: every node came from the edge result.
                node_query_ms=0.0,
                total_ms=round(total_ms, 2),
                chunk_download_ms=edge_download_ms,
                chunk_count=edge_chunk_count,
                node_count=len(nodes),
                edge_count=len(response_partial.edges),
            ),
        )

    # Two-step delivery for callers that can render an intermediate result:
    # fetch just the structural columns (cheap — measured 1.6s vs 4.4s for the
    # full 98-column projection on a 20k-node graph), publish that so the graph
    # can be drawn, then continue to the full fetch below.
    #
    # Only worth doing when the full projection is actually wider: in "types"
    # mode the single query below already IS the types query.
    if on_partial is not None and nodes_mode != "types":
        try:
            types_nodes, _, _ = await fetch_nodes_by_ids(
                warehouse_client=warehouse_client,
                node_table=node_table,
                node_ids=missing_ids,
                column_config=column_config,
                node_columns=[],
                use_external_links=use_external_links,
                on_submit=on_submit,
            )
            partial_nodes = list(types_nodes)
            if harvested:
                fetched = {n.node_id for n in partial_nodes}
                partial_nodes.extend(
                    n for nid, n in harvested.items() if nid not in fetched
                )
            on_partial(
                GraphResponse(
                    nodes=partial_nodes,
                    edges=response_partial.edges,
                    truncated=response_partial.truncated,
                    total_count=response_partial.total_count,
                    properties_deferred=True,
                )
            )
        except Exception as e:  # noqa: BLE001
            # A failed partial must never fail the job — the full fetch below
            # still produces the complete result.
            logger.warning(f"partial node fetch failed, continuing: {e}")

    # Fetch attributes for the ids collected from the edge result. In "types"
    # mode the projection collapses to the structural columns only, which is
    # what lets the client render before any property has been fetched.
    node_query = build_node_query(
        node_table,
        missing_ids,
        column_config,
        [] if nodes_mode == "types" else node_columns,
    )

    # Execute node query
    t0 = time.perf_counter()
    try:
        if use_external_links:
            node_result = await warehouse_client.execute_statement_external(
                statement=node_query,
                on_submit=on_submit,
                progress_callback=_phase_progress("nodes"),
            )
        else:
            node_result = await warehouse_client.execute_statement(
                statement=node_query,
                on_submit=on_submit,
            )
    except Exception as e:
        raise RuntimeError(
            f"Node query execution failed (node_table={node_table}, "
            f"node_count={len(missing_ids)}): {e}"
        ) from e
    node_query_ms = (time.perf_counter() - t0) * 1000

    # Parse and process nodes. Named distinctly from the `node_columns`
    # PARAMETER (the requested projection) — these are the columns the
    # warehouse actually returned.
    t0 = time.perf_counter()
    result_columns, node_rows = _parse_statement_result(node_result, query=node_query)
    try:
        nodes = process_nodes_result(result_columns, node_rows, column_config)
    except Exception as e:
        raise RuntimeError(
            f"Failed to process node query result "
            f"(columns={result_columns}, row_count={len(node_rows)}, "
            f"first_row={node_rows[0] if node_rows else 'N/A'}): {e}"
        ) from e

    # Merge in nodes that came from the edge result (transpiled Cypher path).
    if harvested:
        fetched_ids = {n.node_id for n in nodes}
        nodes.extend(
            node for node_id, node in harvested.items() if node_id not in fetched_ids
        )
    node_processing_ms = (time.perf_counter() - t0) * 1000

    total_ms = (time.perf_counter() - t_total_start) * 1000

    # Combine chunk-download telemetry from the edge and node queries
    node_download_ms = getattr(node_result, "client_download_ms", None)
    node_chunk_count = getattr(node_result, "client_chunk_count", None)
    download_parts = [v for v in (edge_download_ms, node_download_ms) if v is not None]
    chunk_download_ms = round(sum(download_parts), 2) if download_parts else None
    count_parts = [v for v in (edge_chunk_count, node_chunk_count) if v is not None]
    chunk_count = sum(count_parts) if count_parts else None

    return GraphResponse(
        nodes=nodes,
        edges=response_partial.edges,
        truncated=response_partial.truncated,
        total_count=response_partial.total_count,
        # Only the fetched nodes were stripped of properties; harvested ones
        # kept theirs. Either way the client must enrich, so the flag is set
        # whenever a types-only fetch actually ran.
        properties_deferred=nodes_mode == "types",
        metadata=QueryMetadata(
            edge_query_ms=round(edge_query_ms, 2),
            edge_processing_ms=round(edge_processing_ms, 2),
            node_query_ms=round(node_query_ms, 2),
            node_processing_ms=round(node_processing_ms, 2),
            total_ms=round(total_ms, 2),
            chunk_download_ms=chunk_download_ms,
            chunk_count=chunk_count,
            node_count=len(nodes),
            edge_count=len(response_partial.edges),
        ),
    )
