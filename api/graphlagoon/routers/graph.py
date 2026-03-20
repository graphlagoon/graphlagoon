from __future__ import annotations

from fastapi import APIRouter, HTTPException, Depends, Request
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
)
from graphlagoon.services.cypher import transpile_cypher_to_sql, validate_cypher_query
from graphlagoon.services.warehouse import get_warehouse_client, WarehouseClient
from graphlagoon.services.graph_operations import (
    execute_graph_query_with_nodes,
    QueryExecutionError,
)
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
    - Owns the context, OR
    - Has a context-level share (GraphContextShare), OR
    - Has an exploration-level share (ExplorationShare) for any exploration in this context
    """
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

            if context.owner_email == user_email:
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

        if context.owner_email == user_email:
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

    # Build SQL query with NAMED_STRUCT for edge data
    query = f"""
        SELECT NAMED_STRUCT(
            'edge_id', `{column_config.edge_id_col}`,
            'src', `{column_config.src_col}`,
            'dst', `{column_config.dst_col}`,
            'relationship_type', `{rel_type_col}`
        ) AS r
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
    edge_id_col = column_config.edge_id_col

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
            SELECT NAMED_STRUCT(
                'edge_id', e.`{edge_id_col}`,
                'src', e.`{src_col}`,
                'dst', e.`{dst_col}`,
                'relationship_type', e.`{rel_type_col}`
            ) AS r
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
            SELECT NAMED_STRUCT(
                'edge_id', e.`{edge_id_col}`,
                'src', e.`{src_col}`,
                'dst', e.`{dst_col}`,
                'relationship_type', e.`{rel_type_col}`
            ) AS r
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
    sql = transpile_cypher_to_sql(
        data.query,
        context,
        vlp_rendering_mode=data.vlp_rendering_mode,
        materialization_strategy=data.materialization_strategy,
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

    sql = transpile_cypher_to_sql(
        data.query,
        context,
        vlp_rendering_mode=data.vlp_rendering_mode,
        materialization_strategy=data.materialization_strategy,
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
