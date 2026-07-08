"""
Graph operations service.

This module contains the graph processing logic that was previously in sql-warehouse.
It processes raw DataFrame results from the warehouse and constructs GraphResponse objects.
"""

import json
import time
from typing import Optional, Any

from graphlagoon.models.schemas import (
    Node,
    Edge,
    GraphResponse,
    QueryMetadata,
    ColumnConfig,
)


class QueryExecutionError(Exception):
    """Raised when a SQL query execution fails.

    This error is meant to be caught by endpoints and returned as a
    structured error response (not a 500 error).
    """

    def __init__(self, message: str, query: Optional[str] = None):
        self.message = message
        self.query = query
        super().__init__(message)


def _get_edge_id(
    row_dict: dict,
    edge_id_col: Optional[str],
    src_col: str,
    dst_col: str,
    rel_type_col: str,
) -> str:
    """Get edge_id from row, or generate composite key if edge_id_col is None."""
    if edge_id_col and edge_id_col in row_dict:
        return row_dict[edge_id_col]
    # Generate composite key: {src}@{relationship_type}@{dst}
    return f"{row_dict[src_col]}@{row_dict[rel_type_col]}@{row_dict[dst_col]}"


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

            # Build edge
            edge = Edge(
                edge_id=edge_id,
                src=src_id or "",
                dst=dst_id or "",
                relationship_type=item.get(rel_type_col, ""),
                properties=properties if properties else None,
            )
            edges.append(edge)

    return GraphResponse(
        nodes=[],  # Nodes will be populated by a separate query
        edges=edges,
        truncated=False,
        total_count=len(edges),
    ), node_ids


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
            node_type=row_dict.get(node_type_col, "") or "",
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
    except Exception as e:
        raise RuntimeError(
            f"Failed to process edge query result "
            f"(columns={columns}, row_count={len(rows)}, "
            f"first_row={rows[0] if rows else 'N/A'}): {e}"
        ) from e
    edge_processing_ms = (time.perf_counter() - t0) * 1000

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

    # Build node query using actual table name.
    #
    # We fetch node attributes for the ids collected from the edge result.
    # A JOIN against an inline VALUES relation is materially faster than a
    # `WHERE node_id IN (<literal list>)` for large id sets, because the
    # warehouse planner turns it into a hash join over a LocalRelation instead
    # of evaluating a huge IN predicate (~40% faster at 20k ids on local
    # Spark; the gap tends to widen on Databricks where large IN lists are
    # costly to compile). `SELECT n.*` keeps the exact same columns as the
    # previous `SELECT *`, so process_nodes_result is unchanged. node_ids is a
    # set (deduped) and node_id is unique, so the join stays 1:1.
    from graphlagoon.services.sql_validation import sanitize_string_literal

    node_id_col = column_config.node_id_col
    node_values_str = ", ".join([f"('{sanitize_string_literal(n)}')" for n in node_ids])
    node_query = f"""
        SELECT n.*
        FROM {node_table} n
        JOIN (VALUES {node_values_str}) AS _node_ids(_id)
          ON n.`{node_id_col}` = _node_ids._id
    """

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
            f"node_count={len(node_ids)}): {e}"
        ) from e
    node_query_ms = (time.perf_counter() - t0) * 1000

    # Parse and process nodes
    t0 = time.perf_counter()
    node_columns, node_rows = _parse_statement_result(node_result, query=node_query)
    try:
        nodes = process_nodes_result(node_columns, node_rows, column_config)
    except Exception as e:
        raise RuntimeError(
            f"Failed to process node query result "
            f"(columns={node_columns}, row_count={len(node_rows)}, "
            f"first_row={node_rows[0] if node_rows else 'N/A'}): {e}"
        ) from e
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
