from __future__ import annotations

from fastapi import APIRouter, HTTPException, Depends, Request, Response
from uuid import UUID
from typing import TYPE_CHECKING, Union

if TYPE_CHECKING:
    from graphlagoon.db.models import GraphContext

from graphlagoon.db.database import is_database_available, get_session_maker
from graphlagoon.db.memory_store import get_memory_store, MemoryGraphContext
from graphlagoon.models.schemas import (
    DatasetsResponse,
    GraphResponse,
    SubgraphRequest,
    ExpandRequest,
    RandomGraphRequest,
    RandomGraphResponse,
    GraphQueryRequest,
    SchemaDiscoveryRequest,
    SchemaDiscoveryResponse,
    CypherQueryRequest,
    CypherQueryResponse,
    CypherTranspileRequest,
    CypherTranspileResponse,
    TableQueryRequest,
    TableQueryResponse,
    TableQueryStatusResponse,
    GraphJobProgress,
    GraphJobSubmitResponse,
    GraphJobStatusResponse,
    QueryMetadata,
)
from graphlagoon.services.cypher import transpile_cypher_to_sql, validate_cypher_query
from graphlagoon.services.warehouse import get_warehouse_client, WarehouseClient
from graphlagoon.services.graph_operations import (
    execute_graph_query_with_nodes,
    parse_tabular_result,
    QueryExecutionError,
)
from graphlagoon.services.async_job import create_job, get_job, start_job, cancel_job
from graphlagoon.services.sql_validation import (
    validate_sql_query,
    sanitize_string_literal,
)
from graphlagoon.services.cte_prefilter import (
    validate_cte_prefilter,
    apply_cte_prefilter,
)
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.config import get_settings

router = APIRouter(prefix="/api", tags=["graph"])


def get_warehouse() -> WarehouseClient:
    return get_warehouse_client()


async def get_context_with_access(
    context_id: UUID, user_email: str
) -> Union["GraphContext", MemoryGraphContext]:
    """Get graph context and verify access.

    Access is granted if the user:
    - Is a superuser (GRAPH_LAGOON_SUPERUSER_EMAILS), OR
    - Owns the context, OR
    - Has a context-level share (GraphContextShare), OR
    - Has an exploration-level share (ExplorationShare) for any exploration in this context
    """
    from graphlagoon.utils.authz import is_superuser
    from graphlagoon.utils.sharing import user_has_share_access, extract_domain

    not_found_error = HTTPException(
        status_code=404,
        detail={
            "error": {
                "code": "GRAPH_CONTEXT_NOT_FOUND",
                "message": f"Graph context with id '{context_id}' not found",
                "details": {},
            }
        },
    )
    forbidden_error = HTTPException(
        status_code=403,
        detail={
            "error": {
                "code": "FORBIDDEN",
                "message": "You don't have access to this graph context",
                "details": {},
            }
        },
    )

    if is_database_available():
        from sqlalchemy import select, or_
        from sqlalchemy.orm import selectinload
        from graphlagoon.db.models import GraphContext, Exploration, ExplorationShare

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(GraphContext)
                .options(selectinload(GraphContext.shares))
                .where(GraphContext.id == context_id)
            )
            context = result.scalar_one_or_none()

            if context is None:
                raise not_found_error

            if context.owner_email == user_email or is_superuser(user_email):
                return context

            if user_has_share_access(user_email, context.shares):
                return context

            # Check exploration-level shares
            user_domain = extract_domain(user_email)
            share_conditions = [ExplorationShare.shared_with_email == user_email]
            if user_domain:
                share_conditions.append(
                    ExplorationShare.shared_with_email == f"*@{user_domain}"
                )

            exp_share_result = await session.execute(
                select(ExplorationShare.id)
                .join(Exploration, ExplorationShare.exploration_id == Exploration.id)
                .where(
                    Exploration.graph_context_id == context_id,
                    or_(*share_conditions),
                )
                .limit(1)
            )
            if exp_share_result.scalar_one_or_none() is not None:
                return context

            raise forbidden_error
    else:
        store = get_memory_store()
        context = store.get_graph_context(context_id)

        if context is None:
            raise not_found_error

        if context.owner_email == user_email or is_superuser(user_email):
            return context

        if user_has_share_access(user_email, context.shares):
            return context

        # Check exploration-level shares
        for exp in store.explorations.values():
            if exp.graph_context_id == context_id and user_has_share_access(
                user_email, exp.shares
            ):
                return context

        raise forbidden_error


@router.get("/datasets", response_model=DatasetsResponse)
async def list_datasets(
    request: Request, warehouse: WarehouseClient = Depends(get_warehouse)
):
    """List available datasets from sql-warehouse."""
    get_current_user(request)  # Ensure authenticated
    return await warehouse.list_datasets()


def merge_column_config(context) -> dict:
    """Merge edge_structure and node_structure from context into a single ColumnConfig."""
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


def build_edge_named_struct(column_config, table_alias: str = "") -> str:
    """Build a NAMED_STRUCT projection for an edge row.

    The struct is keyed by the context's OWN column names (edge_id_col,
    src_col, dst_col, relationship_type_col) — NOT the normalized
    'src'/'dst'/'relationship_type' aliases. This matters because
    ``process_graph_query_result`` reads the struct back through the same
    ``ColumnConfig`` (``item.get(column_config.src_col)`` etc.). If the struct
    were keyed by the normalized names while the context uses a custom schema
    (e.g. ``source_node_id``/``target_node_id``/``edge_type``), every lookup
    would miss, producing edges with empty src/dst, no node ids to fetch (empty
    graph), and a blank edge-type dropdown. Keying by the context's column names
    keeps subgraph/expand consistent with the transpiled cypher path for ANY
    schema. An empty ``edge_id_col`` (context with no edge id column) is
    omitted from the struct; ``_get_edge_id`` generates composite ids instead.

    Args:
        column_config: The merged :class:`ColumnConfig` for the context.
        table_alias: Optional table alias to qualify each column (e.g. ``"e"``
            for the expand queries). Empty for the unqualified subgraph query.
    """
    prefix = f"{table_alias}." if table_alias else ""
    cols = [
        c
        for c in (
            column_config.edge_id_col,
            column_config.src_col,
            column_config.dst_col,
            column_config.relationship_type_col,
        )
        if c
    ]
    fields = ", ".join(f"'{col}', {prefix}`{col}`" for col in cols)
    return f"NAMED_STRUCT({fields})"


@router.post("/graph-contexts/{context_id}/subgraph", response_model=GraphResponse)
async def get_subgraph(
    context_id: UUID,
    data: SubgraphRequest,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """Get a subgraph for a graph context."""
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)

    # Merge column config from context
    column_config_dict = merge_column_config(context)
    from graphlagoon.models.schemas import ColumnConfig

    column_config = ColumnConfig(**column_config_dict)

    # Build edge filter conditions
    rel_type_col = column_config.relationship_type_col
    edge_conditions = []
    if data.edge_types:
        types_str = ", ".join(
            [f"'{sanitize_string_literal(t)}'" for t in data.edge_types]
        )
        edge_conditions.append(f"`{rel_type_col}` IN ({types_str})")

    where_clause = f"WHERE {' AND '.join(edge_conditions)}" if edge_conditions else ""
    order_clause = "ORDER BY RAND()" if not edge_conditions else ""

    # Build SQL query with NAMED_STRUCT for edge data. The struct is keyed by
    # the context's own column names so the result maps correctly for any schema
    # (see build_edge_named_struct).
    query = f"""
        SELECT {build_edge_named_struct(column_config)} AS r
        FROM {context.edge_table_name}
        {where_clause}
        {order_clause}
        LIMIT {data.edge_limit}
    """

    try:
        return await execute_graph_query_with_nodes(
            warehouse_client=warehouse,
            node_table=context.node_table_name,
            query=query,
            limit=data.edge_limit,
            column_config=column_config,
        )
    except QueryExecutionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": e.message,
                    "details": {"query": e.query} if e.query else {},
                }
            },
        )
    except Exception as e:
        import traceback

        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": f"{type(e).__name__}: {e}",
                    "details": {
                        "query": query,
                        "exception_type": type(e).__name__,
                        "traceback": traceback.format_exc().split("\n"),
                    },
                }
            },
        )


@router.post("/graph-contexts/{context_id}/expand", response_model=GraphResponse)
async def expand_from_node(
    context_id: UUID,
    data: ExpandRequest,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """BFS expansion from a node.

    Expands from a starting node following edges up to the specified depth.
    Supports both directed (follows edge direction) and undirected (both directions).

    Args:
        data.node_id: Starting node ID
        data.depth: Expansion depth (1-2)
        data.edge_limit: Max edges to return (4-1000)
        data.directed: If True, only follow edge direction (src->dst)
        data.edge_types: Filter by edge types (empty = all types)
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)

    # Merge column config from context
    column_config_dict = merge_column_config(context)
    from graphlagoon.models.schemas import ColumnConfig

    column_config = ColumnConfig(**column_config_dict)

    node_id_col = column_config.node_id_col
    src_col = column_config.src_col
    dst_col = column_config.dst_col
    rel_type_col = column_config.relationship_type_col

    # Build edge type filter
    edge_type_filter = ""
    if data.edge_types:
        types_str = ", ".join(
            [f"'{sanitize_string_literal(t)}'" for t in data.edge_types]
        )
        edge_type_filter = f"AND `{rel_type_col}` IN ({types_str})"

    edge_table = context.edge_table_name
    node_table = context.node_table_name
    safe_node_id = sanitize_string_literal(data.node_id)

    # Final edge type filter for the result
    final_edge_filter = ""
    if data.edge_types:
        types_str = ", ".join(
            [f"'{sanitize_string_literal(t)}'" for t in data.edge_types]
        )
        final_edge_filter = f"AND e.`{rel_type_col}` IN ({types_str})"

    if data.depth == 1:
        # Depth 1: simple query without recursion
        if data.directed:
            neighbor_query = f"""
                SELECT DISTINCT e.`{dst_col}` AS node_id
                FROM {edge_table} e
                WHERE e.`{src_col}` = '{safe_node_id}'
                    {edge_type_filter}
            """
        else:
            neighbor_query = f"""
                SELECT DISTINCT
                    CASE
                        WHEN e.`{src_col}` = '{safe_node_id}' THEN e.`{dst_col}`
                        ELSE e.`{src_col}`
                    END AS node_id
                FROM {edge_table} e
                WHERE (e.`{src_col}` = '{safe_node_id}'
                    OR e.`{dst_col}` = '{safe_node_id}')
                    {edge_type_filter}
            """

        query = f"""
            WITH visited_nodes AS (
                SELECT '{safe_node_id}' AS node_id
                UNION
                {neighbor_query}
            )
            SELECT {build_edge_named_struct(column_config, "e")} AS r
            FROM {edge_table} e
            WHERE e.`{src_col}` IN (SELECT node_id FROM visited_nodes)
              AND e.`{dst_col}` IN (SELECT node_id FROM visited_nodes)
              {final_edge_filter}
            LIMIT {data.edge_limit}
        """
    else:
        # Depth > 1: recursive CTE for multi-hop BFS
        if data.directed:
            recursive_join = f"""
                SELECT
                    e.`{dst_col}` AS node_id,
                    n.depth + 1 AS depth,
                    CONCAT(n.path, ARRAY(e.`{dst_col}`)) AS path
                FROM neighbors n
                JOIN {edge_table} e ON e.`{src_col}` = n.node_id
                WHERE n.depth < {data.depth}
                    AND NOT array_contains(n.path, e.`{dst_col}`)
                    {edge_type_filter}
            """
        else:
            recursive_join = f"""
                SELECT
                    CASE
                        WHEN e.`{src_col}` = n.node_id THEN e.`{dst_col}`
                        ELSE e.`{src_col}`
                    END AS node_id,
                    n.depth + 1 AS depth,
                    CONCAT(n.path, ARRAY(
                        CASE
                            WHEN e.`{src_col}` = n.node_id THEN e.`{dst_col}`
                            ELSE e.`{src_col}`
                        END
                    )) AS path
                FROM neighbors n
                JOIN {edge_table} e ON (e.`{src_col}` = n.node_id OR e.`{dst_col}` = n.node_id)
                WHERE n.depth < {data.depth}
                    AND NOT array_contains(n.path,
                        CASE
                            WHEN e.`{src_col}` = n.node_id THEN e.`{dst_col}`
                            ELSE e.`{src_col}`
                        END
                    )
                    {edge_type_filter}
            """

        query = f"""
            WITH RECURSIVE neighbors AS (
                SELECT
                    `{node_id_col}` AS node_id,
                    0 AS depth,
                    ARRAY(`{node_id_col}`) AS path
                FROM {node_table}
                WHERE `{node_id_col}` = '{safe_node_id}'

                UNION ALL

                {recursive_join}
            ),
            visited_nodes AS (
                SELECT DISTINCT node_id FROM neighbors
            )
            SELECT {build_edge_named_struct(column_config, "e")} AS r
            FROM {edge_table} e
            WHERE e.`{src_col}` IN (SELECT node_id FROM visited_nodes)
              AND e.`{dst_col}` IN (SELECT node_id FROM visited_nodes)
              {final_edge_filter}
            LIMIT {data.edge_limit}
        """

    try:
        return await execute_graph_query_with_nodes(
            warehouse_client=warehouse,
            node_table=context.node_table_name,
            query=query,
            limit=data.edge_limit,
            column_config=column_config,
        )
    except QueryExecutionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": e.message,
                    "details": {"query": e.query} if e.query else {},
                }
            },
        )
    except Exception as e:
        import traceback

        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": f"{type(e).__name__}: {e}",
                    "details": {
                        "query": query,
                        "exception_type": type(e).__name__,
                        "traceback": traceback.format_exc().split("\n"),
                    },
                }
            },
        )


@router.post("/graph-contexts/{context_id}/query", response_model=GraphResponse)
async def execute_graph_query(
    context_id: UUID,
    data: GraphQueryRequest,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """
    Execute a graph query (SQL) and return matching nodes/edges.

    The query should use tables in catalog.schema.table format.
    Use the context's edge_table_name and node_table_name for queries.

    Example queries:
    - SELECT * FROM dev_catalog.graphs.edges_test WHERE relationship_type = 'KNOWS'
    - SELECT * FROM dev_catalog.graphs.edges_test e JOIN dev_catalog.graphs.nodes_test n ON e.src = n.node_id
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)

    # Validate the SQL query (deny list: only SELECT allowed)
    # Skip validation for SQL script blocks (BEGIN...END) from procedural BFS
    query_stripped = data.query.strip()
    is_script = query_stripped.upper().startswith(
        "BEGIN"
    ) and query_stripped.upper().endswith("END")
    if not is_script:
        is_valid, error_msg = validate_sql_query(data.query)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "INVALID_SQL_QUERY",
                        "message": error_msg,
                        "details": {},
                    }
                },
            )

    # Apply CTE pre-filter if provided
    final_query = data.query
    if data.cte_prefilter:
        is_valid, error_msg = validate_cte_prefilter(data.cte_prefilter)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "INVALID_CTE_PREFILTER",
                        "message": error_msg,
                        "details": {},
                    }
                },
            )
        final_query = apply_cte_prefilter(
            data.query,
            data.cte_prefilter,
            context.edge_table_name,
            context.node_table_name,
        )
        # Re-validate after CTE is applied (skip for script blocks)
        if not is_script:
            is_valid, error_msg = validate_sql_query(final_query)
            if not is_valid:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": {
                            "code": "INVALID_SQL_QUERY",
                            "message": f"SQL with CTE failed validation: {error_msg}",
                            "details": {},
                        }
                    },
                )

    # Build column config from context
    column_config_dict = merge_column_config(context)
    from graphlagoon.models.schemas import ColumnConfig

    column_config = ColumnConfig(**column_config_dict)

    # Execute query and process results locally
    # Note: limit is determined by the query itself (LIMIT clause), not a parameter
    try:
        return await execute_graph_query_with_nodes(
            warehouse_client=warehouse,
            node_table=context.node_table_name,
            query=final_query,
            limit=None,
            column_config=column_config,
            use_external_links=data.use_external_links,
        )
    except QueryExecutionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": e.message,
                    "details": {"query": e.query} if e.query else {},
                }
            },
        )
    except Exception as e:
        import traceback

        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": f"{type(e).__name__}: {e}",
                    "details": {
                        "query": final_query,
                        "exception_type": type(e).__name__,
                        "traceback": traceback.format_exc().split("\n"),
                    },
                }
            },
        )


@router.post("/graph-contexts/{context_id}/cypher", response_model=CypherQueryResponse)
async def execute_cypher_query(
    context_id: UUID,
    data: CypherQueryRequest,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """
    Execute an OpenCypher query by transpiling it to SQL.

    Uses gsql2rsql to convert OpenCypher syntax to Spark SQL,
    then executes the query and returns the results.

    Example queries:
    - MATCH (n:Person) RETURN n
    - MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)

    # Validate query structure
    is_valid, error_msg = validate_cypher_query(data.query)
    if not is_valid:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_CYPHER_QUERY",
                    "message": error_msg,
                    "details": {},
                }
            },
        )

    # Transpile OpenCypher to SQL
    import time

    t_transpile_start = time.perf_counter()
    try:
        sql = transpile_cypher_to_sql(
            data.query,
            context,
            vlp_rendering_mode=data.vlp_rendering_mode,
            materialization_strategy=data.materialization_strategy,
            procedural_optimizations=data.procedural_optimizations,
        )
    except ValueError as e:
        # Inconsistent procedural optimization flags (e.g. mutually
        # exclusive undirected strategies) surface as a clean 400.
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_TRANSPILE_OPTIONS",
                    "message": str(e),
                    "details": {},
                }
            },
        )
    transpilation_ms = (time.perf_counter() - t_transpile_start) * 1000

    # Apply CTE pre-filter if provided
    if data.cte_prefilter:
        is_valid, error_msg = validate_cte_prefilter(data.cte_prefilter)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "INVALID_CTE_PREFILTER",
                        "message": error_msg,
                        "details": {},
                    }
                },
            )
        sql = apply_cte_prefilter(
            sql,
            data.cte_prefilter,
            context.edge_table_name,
            context.node_table_name,
        )

    # Defense-in-depth: validate the transpiled SQL
    # Skip validation for SQL script blocks (BEGIN...END) from procedural BFS
    sql_stripped = sql.strip()
    is_script = sql_stripped.upper().startswith(
        "BEGIN"
    ) and sql_stripped.upper().endswith("END")
    if not is_script:
        is_valid, error_msg = validate_sql_query(sql)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "INVALID_TRANSPILED_SQL",
                        "message": f"Transpiled SQL failed validation: {error_msg}",
                        "details": {"transpiled_sql": sql},
                    }
                },
            )

    # Build column config from context
    column_config_dict = merge_column_config(context)
    from graphlagoon.models.schemas import ColumnConfig

    column_config = ColumnConfig(**column_config_dict)

    # Execute the transpiled SQL using local processing
    # Note: limit is determined by the Cypher query itself (LIMIT clause), not a parameter
    try:
        result = await execute_graph_query_with_nodes(
            warehouse_client=warehouse,
            node_table=context.node_table_name,
            query=sql,
            limit=None,
            column_config=column_config,
            use_external_links=data.use_external_links,
        )
    except QueryExecutionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": e.message,
                    "details": {"query": e.query, "transpiled_sql": sql}
                    if e.query
                    else {"transpiled_sql": sql},
                }
            },
        )
    except Exception as e:
        import traceback

        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": f"{type(e).__name__}: {e}",
                    "details": {
                        "query": sql,
                        "transpiled_sql": sql,
                        "exception_type": type(e).__name__,
                        "traceback": traceback.format_exc().split("\n"),
                    },
                }
            },
        )

    # Merge transpilation timing into the metadata from execute_graph_query_with_nodes
    metadata = result.metadata
    if metadata:
        metadata.transpilation_ms = round(transpilation_ms, 2)
        # Recalculate total to include transpilation
        if metadata.total_ms is not None:
            metadata.total_ms = round(metadata.total_ms + transpilation_ms, 2)
    else:
        from graphlagoon.models.schemas import QueryMetadata

        metadata = QueryMetadata(
            transpilation_ms=round(transpilation_ms, 2),
            total_ms=round(transpilation_ms, 2),
        )

    return CypherQueryResponse(
        nodes=result.nodes,
        edges=result.edges,
        truncated=result.truncated,
        total_count=result.total_count,
        transpiled_sql=sql,
        metadata=metadata,
    )


def _manifest_counts(response) -> tuple[Union[int, None], Union[int, None]]:
    """Extract (total_chunk_count, total_row_count) from a warehouse response's
    manifest, if present — used to report result-set shape to the client."""
    manifest = getattr(response, "manifest", None)
    if manifest is None:
        return None, None
    return (
        getattr(manifest, "total_chunk_count", None),
        getattr(manifest, "total_row_count", None),
    )


@router.post(
    "/graph-contexts/{context_id}/query/table",
    response_model=TableQueryResponse,
)
async def execute_table_query(
    context_id: UUID,
    data: TableQueryRequest,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """
    Run a generic query and return raw tabular rows (columns + rows).

    Unlike ``/cypher``, the query is NOT required to return edges — any
    projection is allowed (e.g. ``MATCH (n:Person) RETURN n.name, count(*)``).
    In ``cypher`` mode the query is transpiled to Spark SQL; in ``sql`` mode it
    runs directly. Both modes are restricted to read-only SELECT statements.
    """
    import time

    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)

    if not data.query or not data.query.strip():
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "EMPTY_QUERY",
                    "message": "Query must not be empty",
                    "details": {},
                }
            },
        )

    transpiled_sql: str | None = None
    transpilation_ms: float | None = None

    if data.mode == "cypher":
        # Transpile OpenCypher to SQL. We deliberately skip the
        # validate_cypher_query "RETURN r" gate — arbitrary projections are the
        # whole point of this endpoint. The transpiler rejects invalid Cypher,
        # and validate_sql_query below is the read-only security boundary.
        t_transpile_start = time.perf_counter()
        try:
            sql = transpile_cypher_to_sql(
                data.query,
                context,
                vlp_rendering_mode=data.vlp_rendering_mode,
                materialization_strategy=data.materialization_strategy,
                procedural_optimizations=data.procedural_optimizations,
            )
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "CYPHER_TRANSPILE_ERROR",
                        "message": f"{type(e).__name__}: {e}",
                        "details": {"query": data.query},
                    }
                },
            )
        transpilation_ms = (time.perf_counter() - t_transpile_start) * 1000

        # Apply CTE pre-filter if provided
        if data.cte_prefilter:
            is_valid, error_msg = validate_cte_prefilter(data.cte_prefilter)
            if not is_valid:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": {
                            "code": "INVALID_CTE_PREFILTER",
                            "message": error_msg,
                            "details": {},
                        }
                    },
                )
            sql = apply_cte_prefilter(
                sql,
                data.cte_prefilter,
                context.edge_table_name,
                context.node_table_name,
            )
        transpiled_sql = sql
    else:
        sql = data.query

    # Security boundary: read-only SELECT only (both modes).
    is_valid, error_msg = validate_sql_query(sql)
    if not is_valid:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_SQL_QUERY",
                    "message": error_msg,
                    "details": (
                        {"query": sql}
                        if data.mode == "sql"
                        else {"transpiled_sql": sql}
                    ),
                }
            },
        )

    # Submit for the cancellable poll flow. The statement runs with a short
    # wait_timeout: if it finishes in time we return the rows inline on this
    # first call (fast path, identical to the previous behaviour); otherwise we
    # return status="running" + statement_id so the client can poll and cancel.
    t_exec_start = time.perf_counter()
    try:
        response = await warehouse.submit_statement(
            statement=sql,
            row_limit=data.row_limit,
        )
    except QueryExecutionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": e.message,
                    "details": {"query": e.query or sql},
                }
            },
        )

    state = response.status.state

    if state in ("PENDING", "RUNNING"):
        # Still executing — hand the statement_id back for polling/cancel.
        metadata = QueryMetadata(
            transpilation_ms=(
                round(transpilation_ms, 2) if transpilation_ms is not None else None
            ),
            total_ms=None,
        )
        return TableQueryResponse(
            status="running",
            statement_id=response.statement_id,
            transpiled_sql=transpiled_sql,
            metadata=metadata,
        )

    # Terminal state — SUCCEEDED returns rows; anything else is an error.
    try:
        columns, rows, truncated = parse_tabular_result(
            response, query=sql, row_limit=data.row_limit
        )
    except QueryExecutionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": e.message,
                    "details": {"query": e.query or sql},
                }
            },
        )

    execution_ms = (time.perf_counter() - t_exec_start) * 1000
    total_ms = execution_ms + (transpilation_ms or 0.0)
    metadata = QueryMetadata(
        transpilation_ms=(
            round(transpilation_ms, 2) if transpilation_ms is not None else None
        ),
        total_ms=round(total_ms, 2),
    )

    chunk_count, total_row_count = _manifest_counts(response)
    return TableQueryResponse(
        status="succeeded",
        statement_id=response.statement_id,
        columns=columns,
        rows=rows,
        row_count=len(rows),
        truncated=truncated,
        total_chunk_count=chunk_count,
        total_row_count=total_row_count,
        transpiled_sql=transpiled_sql,
        metadata=metadata,
    )


@router.get(
    "/graph-contexts/{context_id}/query/table/{statement_id}",
    response_model=TableQueryStatusResponse,
)
async def get_table_query_status(
    context_id: UUID,
    statement_id: str,
    request: Request,
    row_limit: int = 1000,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """
    Poll an in-flight table query submitted via ``POST .../query/table``.

    Returns ``status="running"`` while the warehouse is still executing, or
    ``status="succeeded"`` with the raw rows once complete. A CANCELED statement
    returns ``status="canceled"``; a FAILED one raises HTTP 400.
    """
    user_email = get_current_user(request)
    await get_context_with_access(context_id, user_email)

    response = await warehouse.get_statement(statement_id)
    state = response.status.state

    if state in ("PENDING", "RUNNING"):
        return TableQueryStatusResponse(status="running", statement_id=statement_id)

    if state in ("CANCELED", "CLOSED"):
        return TableQueryStatusResponse(status="canceled", statement_id=statement_id)

    try:
        columns, rows, truncated = parse_tabular_result(
            response, query=None, row_limit=row_limit
        )
    except QueryExecutionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": e.message,
                    "details": {"query": e.query},
                }
            },
        )

    chunk_count, total_row_count = _manifest_counts(response)
    return TableQueryStatusResponse(
        status="succeeded",
        statement_id=statement_id,
        columns=columns,
        rows=rows,
        row_count=len(rows),
        truncated=truncated,
        total_chunk_count=chunk_count,
        total_row_count=total_row_count,
    )


@router.post(
    "/graph-contexts/{context_id}/query/table/{statement_id}/cancel",
    status_code=204,
)
async def cancel_table_query(
    context_id: UUID,
    statement_id: str,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """
    Cancel an in-flight table query, releasing the warehouse compute.

    Best-effort and idempotent: cancelling an already-finished statement is a
    no-op. Targets Databricks' ``POST /statements/{id}/cancel`` endpoint.
    """
    user_email = get_current_user(request)
    await get_context_with_access(context_id, user_email)

    await warehouse.cancel_statement(statement_id)
    return Response(status_code=204)


# ── Cancellable graph query jobs (progress + cancel in the graph overlay) ──
#
# The blocking /query and /cypher endpoints above stay as-is. These async
# variants submit the same work as a background job (services/async_job.py) so
# the frontend can show live chunk-download progress and a Cancel button in the
# graph overlay, reusing the same submit→poll→cancel shape as the table path.


def _prepare_graph_sql(context, data: GraphQueryRequest) -> str:
    """Validate + apply CTE prefilter for a SQL graph query (raises 400)."""
    query_stripped = data.query.strip()
    is_script = query_stripped.upper().startswith(
        "BEGIN"
    ) and query_stripped.upper().endswith("END")
    if not is_script:
        is_valid, error_msg = validate_sql_query(data.query)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "INVALID_SQL_QUERY",
                        "message": error_msg,
                        "details": {},
                    }
                },
            )

    final_query = data.query
    if data.cte_prefilter:
        is_valid, error_msg = validate_cte_prefilter(data.cte_prefilter)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "INVALID_CTE_PREFILTER",
                        "message": error_msg,
                        "details": {},
                    }
                },
            )
        final_query = apply_cte_prefilter(
            data.query,
            data.cte_prefilter,
            context.edge_table_name,
            context.node_table_name,
        )
        if not is_script:
            is_valid, error_msg = validate_sql_query(final_query)
            if not is_valid:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": {
                            "code": "INVALID_SQL_QUERY",
                            "message": f"SQL with CTE failed validation: {error_msg}",
                            "details": {},
                        }
                    },
                )
    return final_query


def _prepare_cypher_sql(context, data: CypherQueryRequest) -> tuple[str, float]:
    """Transpile + validate a cypher query. Returns (sql, transpilation_ms).
    Raises 400 on invalid cypher / transpiled SQL."""
    import time

    is_valid, error_msg = validate_cypher_query(data.query)
    if not is_valid:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_CYPHER_QUERY",
                    "message": error_msg,
                    "details": {},
                }
            },
        )

    t0 = time.perf_counter()
    try:
        sql = transpile_cypher_to_sql(
            data.query,
            context,
            vlp_rendering_mode=data.vlp_rendering_mode,
            materialization_strategy=data.materialization_strategy,
            procedural_optimizations=data.procedural_optimizations,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_TRANSPILE_OPTIONS",
                    "message": str(e),
                    "details": {},
                }
            },
        )
    transpilation_ms = (time.perf_counter() - t0) * 1000

    if data.cte_prefilter:
        is_valid, error_msg = validate_cte_prefilter(data.cte_prefilter)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "INVALID_CTE_PREFILTER",
                        "message": error_msg,
                        "details": {},
                    }
                },
            )
        sql = apply_cte_prefilter(
            sql,
            data.cte_prefilter,
            context.edge_table_name,
            context.node_table_name,
        )

    sql_stripped = sql.strip()
    is_script = sql_stripped.upper().startswith(
        "BEGIN"
    ) and sql_stripped.upper().endswith("END")
    if not is_script:
        is_valid, error_msg = validate_sql_query(sql)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "INVALID_TRANSPILED_SQL",
                        "message": f"Transpiled SQL failed validation: {error_msg}",
                        "details": {"transpiled_sql": sql},
                    }
                },
            )
    return sql, transpilation_ms


def _start_graph_job(context, warehouse, sql: str, use_external_links: bool):
    """Register + start a background graph-query job. Returns (job_id, record).
    The job wires on_submit (captures warehouse statement_ids for cancel) and
    progress_callback (records chunk progress) into the shared executor."""
    from graphlagoon.models.schemas import ColumnConfig

    column_config = ColumnConfig(**merge_column_config(context))
    job_id, record = create_job()

    def on_submit(sid: str) -> None:
        record["statement_ids"].append(sid)

    def on_progress(phase: str, done: int, total: int) -> None:
        record["progress"] = {
            "phase": phase,
            "chunks_done": done,
            "chunks_total": total,
        }

    start_job(
        record,
        lambda: execute_graph_query_with_nodes(
            warehouse_client=warehouse,
            node_table=context.node_table_name,
            query=sql,
            limit=None,
            column_config=column_config,
            use_external_links=use_external_links,
            on_submit=on_submit,
            progress_callback=on_progress,
        ),
    )
    return job_id, record


@router.post(
    "/graph-contexts/{context_id}/query/async",
    response_model=GraphJobSubmitResponse,
)
async def execute_graph_query_async(
    context_id: UUID,
    data: GraphQueryRequest,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """Submit a SQL graph query as a cancellable, progress-reporting job."""
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    final_query = _prepare_graph_sql(context, data)
    job_id, _ = _start_graph_job(
        context, warehouse, final_query, data.use_external_links
    )
    return GraphJobSubmitResponse(status="running", job_id=job_id)


@router.post(
    "/graph-contexts/{context_id}/cypher/async",
    response_model=GraphJobSubmitResponse,
)
async def execute_cypher_query_async(
    context_id: UUID,
    data: CypherQueryRequest,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """Submit an OpenCypher graph query as a cancellable, progress job."""
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    sql, transpilation_ms = _prepare_cypher_sql(context, data)
    job_id, record = _start_graph_job(context, warehouse, sql, data.use_external_links)
    record["transpiled_sql"] = sql
    record["transpilation_ms"] = transpilation_ms
    return GraphJobSubmitResponse(status="running", job_id=job_id, transpiled_sql=sql)


@router.get(
    "/graph-contexts/{context_id}/query/job/{job_id}",
    response_model=GraphJobStatusResponse,
)
async def get_graph_query_job(
    context_id: UUID,
    job_id: str,
    request: Request,
):
    """Poll a cancellable graph query job: running (+chunk progress),
    succeeded (+graph result), or canceled. Failed jobs raise HTTP 400."""
    user_email = get_current_user(request)
    await get_context_with_access(context_id, user_email)

    record = get_job(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Job not found")

    state = record["state"]
    progress = record.get("progress")
    progress_model = GraphJobProgress(**progress) if progress else None

    if state == "running":
        return GraphJobStatusResponse(
            status="running", job_id=job_id, progress=progress_model
        )
    if state == "canceled":
        return GraphJobStatusResponse(status="canceled", job_id=job_id)
    if state == "failed":
        err = record.get("error") or {}
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": err.get("code", "QUERY_EXECUTION_ERROR"),
                    "message": err.get("message", "Query failed"),
                    "details": err.get("details", {}),
                }
            },
        )

    # succeeded — merge cypher transpilation timing into the result metadata.
    result: GraphResponse = record["result"]
    transpiled_sql = record.get("transpiled_sql")
    transpilation_ms = record.get("transpilation_ms")
    if transpiled_sql and result.metadata is not None and transpilation_ms:
        result.metadata.transpilation_ms = round(transpilation_ms, 2)
        if result.metadata.total_ms is not None:
            result.metadata.total_ms = round(
                result.metadata.total_ms + transpilation_ms, 2
            )
    return GraphJobStatusResponse(
        status="succeeded",
        job_id=job_id,
        progress=progress_model,
        result=result,
        transpiled_sql=transpiled_sql,
    )


@router.post(
    "/graph-contexts/{context_id}/query/job/{job_id}/cancel",
    status_code=204,
)
async def cancel_graph_query_job(
    context_id: UUID,
    job_id: str,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """Cancel an in-flight graph query job: stops API-side processing/download
    and best-effort cancels the underlying warehouse statement(s)."""
    user_email = get_current_user(request)
    await get_context_with_access(context_id, user_email)

    await cancel_job(job_id, warehouse)
    return Response(status_code=204)


@router.post(
    "/graph-contexts/{context_id}/cypher/transpile",
    response_model=CypherTranspileResponse,
)
async def transpile_cypher_query(
    context_id: UUID,
    data: CypherTranspileRequest,
    request: Request,
):
    """
    Transpile an OpenCypher query to SQL without executing it.

    Returns only the transpiled SQL for review before execution.
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)

    # Validate query structure
    is_valid, error_msg = validate_cypher_query(data.query)
    if not is_valid:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_CYPHER_QUERY",
                    "message": error_msg,
                    "details": {},
                }
            },
        )

    try:
        sql = transpile_cypher_to_sql(
            data.query,
            context,
            vlp_rendering_mode=data.vlp_rendering_mode,
            materialization_strategy=data.materialization_strategy,
            procedural_optimizations=data.procedural_optimizations,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_TRANSPILE_OPTIONS",
                    "message": str(e),
                    "details": {},
                }
            },
        )

    # Apply CTE pre-filter if provided
    if data.cte_prefilter:
        is_valid, error_msg = validate_cte_prefilter(data.cte_prefilter)
        if not is_valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "code": "INVALID_CTE_PREFILTER",
                        "message": error_msg,
                        "details": {},
                    }
                },
            )
        sql = apply_cte_prefilter(
            sql,
            data.cte_prefilter,
            context.edge_table_name,
            context.node_table_name,
        )

    return CypherTranspileResponse(transpiled_sql=sql)


@router.post("/schema-discovery", response_model=SchemaDiscoveryResponse)
async def schema_discovery(
    data: SchemaDiscoveryRequest,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """
    Discover distinct node_types and relationship_types from tables.

    Used when creating a GraphContext to populate the available types.
    """
    get_current_user(request)  # Ensure authenticated
    try:
        return await warehouse.discover_schema(
            edge_table=data.edge_table,
            node_table=data.node_table,
            columns=data.columns,
        )
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "SCHEMA_DISCOVERY_FAILED",
                    "message": str(e),
                    "details": {},
                }
            },
        )


@router.post("/dev/random-graph", response_model=RandomGraphResponse)
async def create_random_graph(
    data: RandomGraphRequest,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """Generate a random graph (dev mode only)."""
    if not get_settings().dev_mode:
        raise HTTPException(
            status_code=403,
            detail={
                "error": {
                    "code": "FORBIDDEN",
                    "message": "Random graph generation is only available in dev mode",
                    "details": {},
                }
            },
        )

    get_current_user(request)  # Ensure authenticated
    try:
        return await warehouse.create_random_graph(data)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {"code": "GENERATION_FAILED", "message": str(e), "details": {}}
            },
        )


@router.delete("/dev/clear-all")
async def clear_all_data(
    request: Request, warehouse: WarehouseClient = Depends(get_warehouse)
):
    """Clear all data (dev mode only). Clears storage and parquet files."""
    if not get_settings().dev_mode:
        raise HTTPException(
            status_code=403,
            detail={
                "error": {
                    "code": "FORBIDDEN",
                    "message": "Clear all data is only available in dev mode",
                    "details": {},
                }
            },
        )

    get_current_user(request)  # Ensure authenticated

    if is_database_available():
        from sqlalchemy import text

        session_maker = get_session_maker()
        async with session_maker() as session:
            # Use TRUNCATE CASCADE to efficiently clear all tables
            tables_to_truncate = [
                "usage_logs",
                "exploration_shares",
                "explorations",
                "graph_context_shares",
                "graph_contexts",
                "users",
            ]

            for table in tables_to_truncate:
                await session.execute(text(f"TRUNCATE TABLE {table} CASCADE"))
            await session.commit()
    else:
        # Clear in-memory store
        store = get_memory_store()
        store.clear_all()

    # Clear parquet files in warehouse
    await warehouse.clear_all_tables()

    return {"status": "cleared", "message": "All data cleared"}
