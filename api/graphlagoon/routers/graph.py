from __future__ import annotations

from fastapi import APIRouter, HTTPException, Depends, Request, Response
from uuid import UUID
from typing import Optional

from graphlagoon.db.database import is_database_available, get_session_maker
from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.models.schemas import (
    DatasetsResponse,
    GraphResponse,
    SubgraphRequest,
    NodeBatchRequest,
    NodeBatchResponse,
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
    SchemaDriftResponse,
    SchemaDriftTable,
    SchemaDriftFinding,
    SchemaDriftProposal,
)
from graphlagoon.services.warehouse import get_warehouse_client, WarehouseClient
from graphlagoon.services.graph_operations import (
    merge_column_config,
    QueryExecutionError,
)
from graphlagoon.services.datasource import (
    DatasourceNotConfiguredError,
    GraphExecutionFailure,
    PreparedGraphQuery,
    get_datasource,
    get_datasource_for_context,
    require_capability,
)

# Re-exported for callers (and tests) that reach for the SQL query builders by
# their historical home; they now live with the SQL warehouse datasource.
from graphlagoon.services.datasource.sql_warehouse import (  # noqa: F401
    build_edge_named_struct,
    resolve_node_columns,
)
from graphlagoon.services.warehouse_errors import query_execution_http_error

# `get_context_with_access` moved to utils/context_access.py when precomputed graphs
# needed it too. Re-exported here for callers that import it from this module.
from graphlagoon.utils.context_access import get_context_with_access  # noqa: F401
from graphlagoon.services.async_job import create_job, get_job, start_job, cancel_job
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.config import get_settings

router = APIRouter(prefix="/api", tags=["graph"])


def get_warehouse() -> WarehouseClient:
    return get_warehouse_client()


def resolve_datasource_or_400(context):
    """Resolve a context's datasource, translating "gone" into a clear 400.

    A context can outlive its backend: a REST connection removed from the
    parent app's config, or a Neptune endpoint unset since the context was
    created. Every query endpoint resolves through here so those orphans fail
    with DATASOURCE_NOT_CONFIGURED instead of a 500.
    """
    try:
        return get_datasource_for_context(context)
    except DatasourceNotConfiguredError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "DATASOURCE_NOT_CONFIGURED",
                    "message": str(e),
                    "details": {
                        "datasource_type": getattr(context, "datasource_type", None),
                        "datasource_name": getattr(context, "datasource_name", None),
                    },
                }
            },
        )


def execution_failure_http_error(
    error: GraphExecutionFailure, extra_details: Optional[dict] = None
) -> HTTPException:
    """Turn an unexpected backend failure into the standard 400 envelope.

    Companion to ``query_execution_http_error`` (which handles failures the
    backend reported about the query itself). The statement and the original
    traceback are carried on the exception, captured where the failure happened.
    """
    details: dict = {
        "query": error.statement,
        "exception_type": error.exception_type,
        "traceback": error.traceback_lines,
    }
    if extra_details:
        details.update(extra_details)
    return HTTPException(
        status_code=400,
        detail={
            "error": {
                "code": "QUERY_EXECUTION_ERROR",
                "message": error.message,
                "details": details,
            }
        },
    )


@router.get("/datasets", response_model=DatasetsResponse)
async def list_datasets(
    request: Request, warehouse: WarehouseClient = Depends(get_warehouse)
):
    """List available datasets from sql-warehouse."""
    get_current_user(request)  # Ensure authenticated
    return await warehouse.list_datasets()


@router.get(
    "/graph-contexts/{context_id}/schema-drift", response_model=SchemaDriftResponse
)
async def get_schema_drift(
    context_id: UUID,
    request: Request,
    check_types: bool = False,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """Diff a context's stored schema snapshot against the live warehouse tables.

    Read-only — never fails on drift itself; an unreachable table surfaces as a
    ``TABLE_NOT_FOUND`` finding with HTTP 200, not an error response. Column
    checks (``DESCRIBE``) always run; type checks (``SELECT DISTINCT``, a full
    table scan) only run when ``check_types=true``.

    The ``proposed`` snapshot in the response can be echoed back verbatim through
    ``PUT /graph-contexts/{id}`` to apply the resync — this endpoint never writes.

    Warehouse-only: drift is the gap between a context's stored table snapshot
    and the live tables. A schemaless graph database has neither, so those
    contexts reject this outright rather than reporting a vacuous "no drift".
    """
    from datetime import datetime, timezone
    from graphlagoon.services.schema_drift import (
        compute_drift,
        parse_qualified_table,
    )

    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    require_capability(
        resolve_datasource_or_400(context), "supports_schema_drift", "Schema drift"
    )

    async def describe(table_name: str) -> tuple[bool, list]:
        parsed = parse_qualified_table(table_name)
        if parsed is None:
            return False, []
        catalog, database, table = parsed
        try:
            table_schema = await warehouse.get_table_schema(table, database, catalog)
        except Exception:
            return False, []
        if not table_schema.columns:
            return False, []
        return True, table_schema.columns

    node_reachable, node_columns = await describe(context.node_table_name)
    edge_reachable, edge_columns = await describe(context.edge_table_name)

    discovered_node_types = None
    discovered_relationship_types = None
    if check_types:
        try:
            from graphlagoon.models.schemas import ColumnConfig

            column_config = ColumnConfig(**merge_column_config(context))
            discovery = await warehouse.discover_schema(
                edge_table=context.edge_table_name,
                node_table=context.node_table_name,
                columns=column_config,
            )
            discovered_node_types = discovery.node_types
            discovered_relationship_types = discovery.relationship_types
        except Exception:
            # Type discovery is best-effort on top of the column diff — a failed
            # discovery must not hide the (more actionable) column-level findings.
            discovered_node_types = None
            discovered_relationship_types = None

    result = compute_drift(
        context,
        node_reachable,
        node_columns,
        edge_reachable,
        edge_columns,
        discovered_node_types=discovered_node_types,
        discovered_relationship_types=discovered_relationship_types,
    )

    return SchemaDriftResponse(
        context_id=context_id,
        checked_at=datetime.now(timezone.utc),
        status=result["status"],
        types_checked=check_types
        and (
            discovered_node_types is not None
            or discovered_relationship_types is not None
        ),
        counts=result["counts"],
        # Nodeless context: the virtual node table is always "reachable" —
        # there is nothing to describe and nothing that can drift.
        node_table=SchemaDriftTable(
            table_name=context.node_table_name,
            reachable=(
                True if context.node_table_name is None else node_reachable
            ),
            columns=node_columns,
        ),
        edge_table=SchemaDriftTable(
            table_name=context.edge_table_name,
            reachable=edge_reachable,
            columns=edge_columns,
        ),
        findings=[SchemaDriftFinding(**f.to_dict()) for f in result["findings"]],
        proposed=SchemaDriftProposal(
            node_properties=result["proposed_node_properties"],
            edge_properties=result["proposed_edge_properties"],
            node_types=result["proposed_node_types"],
            relationship_types=result["proposed_relationship_types"],
        ),
    )


@router.post("/graph-contexts/{context_id}/subgraph", response_model=GraphResponse)
async def get_subgraph(
    context_id: UUID,
    data: SubgraphRequest,
    request: Request,
):
    """Get a subgraph for a graph context."""
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)

    try:
        return await datasource.get_subgraph(context, data)
    except QueryExecutionError as e:
        raise query_execution_http_error(e, context_id)
    except GraphExecutionFailure as e:
        raise execution_failure_http_error(e)


@router.post(
    "/graph-contexts/{context_id}/nodes/batch", response_model=NodeBatchResponse
)
async def get_nodes_batch(
    context_id: UUID,
    data: NodeBatchRequest,
    request: Request,
):
    """Fetch properties for a known set of node ids.

    Backs progressive loading: the client renders a graph returned with
    ``nodes_mode='types'`` immediately, then fills in properties in background
    batches through this endpoint.

    The projection comes from the context's configured ``node_properties``. An
    optional ``columns`` list may NARROW it further (unknown names are dropped),
    which matters on wide tables: fetching all 100 columns for every node costs
    more than the single request progressive loading replaced.
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)

    # Dedupe while preserving order: the join is 1:1 on a unique node id, so
    # repeated ids would only bloat the inlined VALUES list.
    seen: set[str] = set()
    node_ids = [
        nid for nid in data.node_ids if nid and not (nid in seen or seen.add(nid))
    ]
    if not node_ids:
        return NodeBatchResponse(nodes=[])

    try:
        nodes, query_ms = await datasource.fetch_nodes(context, node_ids, data.columns)
    except QueryExecutionError as e:
        raise query_execution_http_error(e, context_id)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "QUERY_EXECUTION_ERROR",
                    "message": f"{type(e).__name__}: {e}",
                    "details": {"exception_type": type(e).__name__},
                }
            },
        )

    return NodeBatchResponse(
        nodes=nodes,
        metadata=QueryMetadata(
            node_query_ms=round(query_ms, 2),
            node_count=len(nodes),
        ),
    )


@router.post("/graph-contexts/{context_id}/expand", response_model=GraphResponse)
async def expand_from_node(
    context_id: UUID,
    data: ExpandRequest,
    request: Request,
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
    datasource = resolve_datasource_or_400(context)

    try:
        return await datasource.expand(context, data)
    except QueryExecutionError as e:
        raise query_execution_http_error(e, context_id)
    except GraphExecutionFailure as e:
        raise execution_failure_http_error(e)


@router.post("/graph-contexts/{context_id}/query", response_model=GraphResponse)
async def execute_graph_query(
    context_id: UUID,
    data: GraphQueryRequest,
    request: Request,
):
    """
    Execute a graph query (SQL) and return matching nodes/edges.

    The query should use tables in catalog.schema.table format.
    Use the context's edge_table_name and node_table_name for queries.

    Example queries:
    - SELECT * FROM dev_catalog.graphs.edges_test WHERE relationship_type = 'KNOWS'
    - SELECT * FROM dev_catalog.graphs.edges_test e JOIN dev_catalog.graphs.nodes_test n ON e.src = n.node_id

    SQL-backed contexts only — a native graph database has no SQL surface.
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)
    require_capability(datasource, "supports_sql", "Raw SQL graph queries")

    prepared = datasource.prepare_sql(context, data)

    try:
        return await datasource.execute_prepared(
            context,
            prepared,
            use_external_links=data.use_external_links,
        )
    except QueryExecutionError as e:
        raise query_execution_http_error(e, context_id)
    except GraphExecutionFailure as e:
        raise execution_failure_http_error(e)


@router.post("/graph-contexts/{context_id}/cypher", response_model=CypherQueryResponse)
async def execute_cypher_query(
    context_id: UUID,
    data: CypherQueryRequest,
    request: Request,
):
    """
    Execute an OpenCypher query and return matching nodes/edges.

    On a SQL warehouse the query is transpiled to Spark SQL by gsql2rsql; on a
    native graph database it runs as-is and ``transpiled_sql`` comes back null.

    Example queries:
    - MATCH (n:Person) RETURN n
    - MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)

    prepared = datasource.prepare_cypher(context, data)
    transpiled_sql = prepared.transpiled_sql
    extra_details = {"transpiled_sql": transpiled_sql} if transpiled_sql else None

    try:
        result = await datasource.execute_prepared(
            context,
            prepared,
            use_external_links=data.use_external_links,
        )
    except QueryExecutionError as e:
        raise query_execution_http_error(e, context_id, extra_details=extra_details)
    except GraphExecutionFailure as e:
        raise execution_failure_http_error(e, extra_details=extra_details)

    metadata = _merge_transpilation_timing(result.metadata, prepared.transpilation_ms)

    return CypherQueryResponse(
        nodes=result.nodes,
        edges=result.edges,
        truncated=result.truncated,
        total_count=result.total_count,
        transpiled_sql=transpiled_sql,
        metadata=metadata,
    )


def _merge_transpilation_timing(metadata, transpilation_ms):
    """Fold transpilation time into a result's metadata.

    Backends that do not transpile (native Cypher) report None and the metadata
    is returned untouched, so ``transpilation_ms`` stays absent rather than
    showing a misleading zero.
    """
    if transpilation_ms is None:
        return metadata

    if metadata is None:
        return QueryMetadata(
            transpilation_ms=round(transpilation_ms, 2),
            total_ms=round(transpilation_ms, 2),
        )

    metadata.transpilation_ms = round(transpilation_ms, 2)
    if metadata.total_ms is not None:
        metadata.total_ms = round(metadata.total_ms + transpilation_ms, 2)
    return metadata


@router.post(
    "/graph-contexts/{context_id}/query/table",
    response_model=TableQueryResponse,
)
async def execute_table_query(
    context_id: UUID,
    data: TableQueryRequest,
    request: Request,
):
    """
    Run a generic query and return raw tabular rows (columns + rows).

    Unlike ``/cypher``, the query is NOT required to return edges — any
    projection is allowed (e.g. ``MATCH (n:Person) RETURN n.name, count(*)``).
    In ``cypher`` mode a SQL backend transpiles the query first; ``sql`` mode
    runs it directly and is rejected outright by non-SQL backends. Both modes
    are restricted to read-only statements.
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)

    if data.mode == "sql":
        require_capability(datasource, "supports_sql", "SQL console queries")

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

    try:
        return await datasource.submit_table_query(context, data)
    except QueryExecutionError as e:
        raise query_execution_http_error(e, context_id, fallback_query=data.query)


@router.get(
    "/graph-contexts/{context_id}/query/table/{statement_id}",
    response_model=TableQueryStatusResponse,
)
async def get_table_query_status(
    context_id: UUID,
    statement_id: str,
    request: Request,
    row_limit: int = 1000,
):
    """
    Poll an in-flight table query submitted via ``POST .../query/table``.

    Returns ``status="running"`` while the backend is still executing, or
    ``status="succeeded"`` with the raw rows once complete. A CANCELED statement
    returns ``status="canceled"``; a FAILED one raises HTTP 400.
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)

    try:
        return await datasource.get_table_query_status(context, statement_id, row_limit)
    except QueryExecutionError as e:
        raise query_execution_http_error(e, context_id)


@router.post(
    "/graph-contexts/{context_id}/query/table/{statement_id}/cancel",
    status_code=204,
)
async def cancel_table_query(
    context_id: UUID,
    statement_id: str,
    request: Request,
):
    """
    Cancel an in-flight table query, releasing the backend's compute.

    Best-effort and idempotent: cancelling an already-finished statement is a
    no-op.
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)

    await datasource.cancel_statement(statement_id)
    return Response(status_code=204)


# ── Cancellable graph query jobs (progress + cancel in the graph overlay) ──
#
# The blocking /query and /cypher endpoints above stay as-is. These async
# variants submit the same work as a background job (services/async_job.py) so
# the frontend can show live chunk-download progress and a Cancel button in the
# graph overlay, reusing the same submit→poll→cancel shape as the table path.


def _start_graph_job(
    datasource, context, prepared: PreparedGraphQuery, use_external_links: bool
):
    """Register + start a background graph-query job. Returns (job_id, record).

    The job wires on_submit (captures backend statement ids for cancel),
    progress_callback (chunk progress) and on_partial (renderable intermediate
    result) into whichever datasource is executing.
    """
    job_id, record = create_job()

    def on_submit(sid: str) -> None:
        record["statement_ids"].append(sid)

    def on_progress(phase: str, done: int, total: int) -> None:
        record["progress"] = {
            "phase": phase,
            "chunks_done": done,
            "chunks_total": total,
        }

    def on_partial(response) -> None:
        """Publish a renderable intermediate result for the poller to apply."""
        record["partial"] = response
        record["partial_seq"] += 1

    start_job(
        record,
        lambda: datasource.execute_prepared(
            context,
            prepared,
            use_external_links=use_external_links,
            on_submit=on_submit,
            progress_callback=on_progress,
            on_partial=on_partial,
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
):
    """Submit a SQL graph query as a cancellable, progress-reporting job."""
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)
    require_capability(datasource, "supports_sql", "Raw SQL graph queries")

    prepared = datasource.prepare_sql(context, data)
    job_id, _ = _start_graph_job(datasource, context, prepared, data.use_external_links)
    return GraphJobSubmitResponse(status="running", job_id=job_id)


@router.post(
    "/graph-contexts/{context_id}/cypher/async",
    response_model=GraphJobSubmitResponse,
)
async def execute_cypher_query_async(
    context_id: UUID,
    data: CypherQueryRequest,
    request: Request,
):
    """Submit an OpenCypher graph query as a cancellable, progress job."""
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)

    prepared = datasource.prepare_cypher(context, data)
    job_id, record = _start_graph_job(
        datasource, context, prepared, data.use_external_links
    )
    record["transpiled_sql"] = prepared.transpiled_sql
    record["transpilation_ms"] = prepared.transpilation_ms
    return GraphJobSubmitResponse(
        status="running", job_id=job_id, transpiled_sql=prepared.transpiled_sql
    )


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
        # Carry any published partial so the client can draw the graph while
        # the job is still fetching properties. `partial_seq` lets the poller
        # tell a new partial from one it has already applied.
        return GraphJobStatusResponse(
            status="running",
            job_id=job_id,
            progress=progress_model,
            partial=record.get("partial"),
            partial_seq=record.get("partial_seq", 0),
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
):
    """Cancel an in-flight graph query job: stops API-side processing/download
    and best-effort cancels the underlying backend statement(s)."""
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)

    await cancel_job(job_id, resolve_datasource_or_400(context))
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

    Returns only the transpiled SQL for review before execution. Warehouse-only:
    a backend that speaks Cypher natively has no SQL to show.
    """
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    datasource = resolve_datasource_or_400(context)
    require_capability(datasource, "supports_transpile", "Cypher transpilation")

    return CypherTranspileResponse(
        transpiled_sql=datasource.transpile_only(context, data)
    )


@router.post("/schema-discovery", response_model=SchemaDiscoveryResponse)
async def schema_discovery(
    data: SchemaDiscoveryRequest,
    request: Request,
):
    """
    Discover the node types and relationship types a datasource exposes.

    Used when creating a GraphContext to populate the available types. A SQL
    warehouse runs ``SELECT DISTINCT`` over the two tables; a native graph
    database reads its own label catalog.
    """
    get_current_user(request)  # Ensure authenticated
    try:
        return await get_datasource(
            data.datasource_type, data.datasource_name
        ).discover_types(data)
    except HTTPException:
        # Already the shared envelope (unsupported operation, not configured).
        raise
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
