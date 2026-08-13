"""Amazon Neptune datasource — openCypher, passthrough, no tables.

The counterpart to ``sql_warehouse.py``. Where that one transpiles Cypher into
SQL over an edge table and a node table, this one sends the user's Cypher to
Neptune as-is and maps the returned nodes/relationships straight onto the
normalized graph shapes. A context here defines no tables, no structural
columns and no property columns — there is nothing to configure because the
database already knows its own shape.

Canned operations (subgraph, expand, node fetch) are expressed as generated,
parameterized openCypher instead of generated SQL.
"""

from __future__ import annotations

import logging
import time
from typing import Any, ClassVar, Optional

from graphlagoon.models.schemas import (
    CypherQueryRequest,
    ExpandRequest,
    GraphResponse,
    Node,
    QueryMetadata,
    SchemaDiscoveryResponse,
    SubgraphRequest,
    TableQueryRequest,
    TableQueryResponse,
    TableQueryStatusResponse,
)
from graphlagoon.services.datasource.base import (
    DatasourceCapabilities,
    GraphDatasource,
    GraphExecutionFailure,
    PreparedGraphQuery,
    invalid_request,
    require_capability,
)
from graphlagoon.services.datasource.neptune.client import (
    NeptuneClient,
    NeptuneQueryError,
)
from graphlagoon.services.datasource.neptune.mapping import (
    extract_cypher_limit,
    flatten_tabular,
    map_graph_results,
)
from graphlagoon.services.datasource.neptune.validation import (
    quote_label,
    validate_graph_cypher,
    validate_readonly_opencypher,
)
from graphlagoon.services.graph_operations import QueryExecutionError

logger = logging.getLogger(__name__)

# Cypher cannot parameterize LIMIT, so generated limits are interpolated after
# an int() coercion. Every call site takes its value from a schema-validated
# integer field, never from free text.
_FETCH_NODES_BY_ID = "MATCH (n) WHERE id(n) IN $ids RETURN n"


def _invalid_cypher(message: str):
    """Bad Cypher is a request error, not an execution failure."""
    return invalid_request("INVALID_CYPHER_QUERY", message)


class NeptuneDatasource(GraphDatasource):
    """Query a native property graph through Neptune's openCypher endpoint."""

    type_name: ClassVar[str] = "neptune"
    # Everything here is warehouse machinery: SQL, transpilation, CTE
    # pre-filters, table-schema drift, catalog browsing, chunked external
    # links, and the deferred-property scheme that exists because a wide node
    # table is expensive to project. Neptune returns whole property maps in one
    # pass, so none of it applies.
    capabilities: ClassVar[DatasourceCapabilities] = DatasourceCapabilities()

    def __init__(
        self,
        client: NeptuneClient,
        *,
        discovery_sample_limit: int = 10000,
    ):
        self._client = client
        self._discovery_sample_limit = discovery_sample_limit

    @classmethod
    def from_settings(cls, settings) -> "NeptuneDatasource":
        return cls(
            NeptuneClient(
                settings.neptune_base_url,
                use_iam=settings.neptune_use_iam,
                region=settings.neptune_region,
                verify_tls=settings.neptune_tls_verify,
                timeout=settings.neptune_http_timeout,
            ),
            discovery_sample_limit=settings.neptune_discovery_sample_limit,
        )

    async def close(self) -> None:
        await self._client.close()

    # ── Execution ────────────────────────────────────────────────────────

    async def _run(
        self, query: str, parameters: Optional[dict] = None
    ) -> tuple[list[dict], float]:
        """Execute openCypher, returning (rows, elapsed_ms).

        Neptune's own error codes are translated into the shared envelope here,
        with an explicit ``code`` so the Spark-oriented classifier never sees
        them — a Neptune context can therefore never be told its "context
        schema is stale", a diagnosis that would make no sense for it.
        """
        t0 = time.perf_counter()
        try:
            rows = await self._client.execute_opencypher(query, parameters)
        except NeptuneQueryError as e:
            code = (
                "INVALID_CYPHER_QUERY"
                if e.is_malformed_query
                else "QUERY_EXECUTION_ERROR"
            )
            raise QueryExecutionError(e.message, query=query, code=code)
        except Exception as e:
            raise GraphExecutionFailure(e, statement=query)
        return rows, (time.perf_counter() - t0) * 1000

    async def _to_graph(
        self, rows: list[dict], *, query: str, query_ms: float, limit: Optional[int]
    ) -> GraphResponse:
        """Turn raw result rows into a graph, resolving dangling endpoints.

        A query projecting only relationships (``MATCH ()-[r]->() RETURN r``)
        names endpoints it never returned. One follow-up lookup fills them in —
        the direct analogue of the warehouse path's second, node-fetching query.
        """
        t0 = time.perf_counter()
        nodes, edges, dangling = map_graph_results(rows)
        processing_ms = (time.perf_counter() - t0) * 1000

        node_query_ms = 0.0
        if dangling:
            extra_rows, node_query_ms = await self._run(
                _FETCH_NODES_BY_ID, {"ids": sorted(dangling)}
            )
            resolved, _, _ = map_graph_results(extra_rows)
            for node_id, node in resolved.items():
                nodes.setdefault(node_id, node)

        effective_limit = limit if limit is not None else extract_cypher_limit(query)
        truncated = effective_limit is not None and len(rows) >= effective_limit

        return GraphResponse(
            nodes=list(nodes.values()),
            edges=list(edges.values()),
            truncated=truncated,
            total_count=len(edges),
            metadata=QueryMetadata(
                edge_query_ms=round(query_ms, 2),
                edge_processing_ms=round(processing_ms, 2),
                node_query_ms=round(node_query_ms, 2),
                total_ms=round(query_ms + processing_ms + node_query_ms, 2),
                node_count=len(nodes),
                edge_count=len(edges),
            ),
        )

    # ── Query preparation ────────────────────────────────────────────────

    def prepare_cypher(self, context, data: CypherQueryRequest) -> PreparedGraphQuery:
        """Validate the query. Nothing is transpiled — Neptune speaks Cypher."""
        if getattr(data, "cte_prefilter", None):
            require_capability(self, "supports_cte_prefilter", "CTE pre-filters")

        is_valid, error_msg = validate_graph_cypher(data.query)
        if not is_valid:
            raise _invalid_cypher(error_msg)

        is_valid, error_msg = validate_readonly_opencypher(data.query)
        if not is_valid:
            raise _invalid_cypher(error_msg)

        # transpiled_sql stays None: there is no SQL, and reporting an empty
        # string would make the frontend offer a "review SQL" step for nothing.
        return PreparedGraphQuery(statement=data.query)

    async def execute_prepared(
        self,
        context,
        prepared: PreparedGraphQuery,
        *,
        use_external_links: bool = False,
        nodes_mode: str = "full",
        on_submit=None,
        progress_callback=None,
        on_partial=None,
    ) -> GraphResponse:
        # use_external_links / nodes_mode / progress / partials are warehouse
        # concepts: Neptune returns one JSON body with full property maps, so
        # there are no chunks to report and nothing to defer.
        rows, query_ms = await self._run(prepared.statement)
        return await self._to_graph(
            rows, query=prepared.statement, query_ms=query_ms, limit=None
        )

    # ── Canned graph operations ──────────────────────────────────────────

    async def get_subgraph(self, context, data: SubgraphRequest) -> GraphResponse:
        """Sample the graph.

        Unlike the warehouse path there is no ``ORDER BY RAND()`` equivalent in
        openCypher, so the sample is whatever Neptune scans first — stable
        across calls rather than random.
        """
        limit = int(data.edge_limit)
        parameters: dict[str, Any] = {}

        if data.edge_types:
            where = "WHERE type(r) IN $types"
            parameters["types"] = list(data.edge_types)
        else:
            where = ""

        query = f"MATCH (a)-[r]->(b) {where} RETURN a, r, b LIMIT {limit}"
        rows, query_ms = await self._run(query, parameters or None)
        return await self._to_graph(rows, query=query, query_ms=query_ms, limit=limit)

    async def expand(self, context, data: ExpandRequest) -> GraphResponse:
        """BFS expansion as a variable-length path query."""
        depth = int(data.depth)
        limit = int(data.edge_limit)

        # Relationship types live inside the pattern, where parameters are not
        # allowed, so they are backtick-quoted and interpolated.
        type_filter = ""
        if data.edge_types:
            type_filter = ":" + "|".join(quote_label(t) for t in data.edge_types)

        arrow = "->" if data.directed else "-"
        pattern = f"-[r{type_filter}*1..{depth}]{arrow}"

        query = (
            f"MATCH p = (s){pattern}(m) WHERE id(s) = $node_id RETURN p LIMIT {limit}"
        )
        rows, query_ms = await self._run(query, {"node_id": data.node_id})
        return await self._to_graph(rows, query=query, query_ms=query_ms, limit=limit)

    async def fetch_nodes(
        self,
        context,
        node_ids: list[str],
        columns: Optional[list[str]] = None,
    ) -> tuple[list[Node], float]:
        """Fetch nodes by id.

        ``columns`` is ignored: it exists to narrow a wide SQL projection, but
        Neptune returns each node's whole property map regardless, so there is
        nothing to save by filtering here.
        """
        rows, query_ms = await self._run(_FETCH_NODES_BY_ID, {"ids": list(node_ids)})
        nodes, _, _ = map_graph_results(rows)
        return list(nodes.values()), query_ms

    # ── Tabular / console mode ───────────────────────────────────────────

    async def submit_table_query(
        self, context, data: TableQueryRequest
    ) -> TableQueryResponse:
        """Run an arbitrary projection and return raw columns/rows.

        Always completes inline. Neptune's HTTP API gives out no query id at
        submit time, so there is no statement to poll or cancel — the client's
        existing fast path for an inline ``succeeded`` handles this unchanged.
        """
        if data.mode != "cypher":
            require_capability(self, "supports_sql", "SQL console queries")

        is_valid, error_msg = validate_readonly_opencypher(data.query)
        if not is_valid:
            raise _invalid_cypher(error_msg)

        rows, query_ms = await self._run(data.query)
        columns, table_rows, truncated = flatten_tabular(rows, data.row_limit)

        return TableQueryResponse(
            status="succeeded",
            statement_id=None,
            columns=columns,
            rows=table_rows,
            row_count=len(table_rows),
            truncated=truncated,
            total_row_count=len(rows),
            transpiled_sql=None,
            metadata=QueryMetadata(total_ms=round(query_ms, 2)),
        )

    async def get_table_query_status(
        self, context, statement_id: str, row_limit: int
    ) -> TableQueryStatusResponse:
        """Unreachable in practice — table queries never return a statement id."""
        return TableQueryStatusResponse(status="canceled", statement_id=statement_id)

    async def cancel_statement(self, statement_id: str) -> None:
        """Best-effort cancel by Neptune queryId.

        Only reachable if a caller already has an id from ``/openCypher/status``;
        the normal cancellation path for this backend is the API-side asyncio
        task cancellation in ``async_job``, which drops the HTTP request.
        """
        try:
            await self._client.cancel_query(statement_id)
        except Exception as e:  # noqa: BLE001 — best effort, like the warehouse
            logger.warning(f"neptune cancel_query({statement_id}) failed: {e}")

    # ── Discovery ────────────────────────────────────────────────────────

    async def discover_types(self, request: Any) -> SchemaDiscoveryResponse:
        """Discover node labels and relationship types.

        Prefers the cluster's summary API: it is exact, costs nothing, and needs
        no scan. Clusters with DFE statistics disabled return no summary, so we
        fall back to bounded sampling — which can miss a rare label but always
        works.
        """
        summary = await self._client.get_summary()
        if summary:
            node_labels = summary.get("nodeLabels") or []
            edge_labels = summary.get("edgeLabels") or []
            if node_labels or edge_labels:
                return SchemaDiscoveryResponse(
                    node_types=sorted(str(label) for label in node_labels),
                    relationship_types=sorted(str(label) for label in edge_labels),
                )

        sample = int(self._discovery_sample_limit)
        node_types: list[str] = []
        relationship_types: list[str] = []

        # Each side is independent: a graph with nodes but no edges yet should
        # still get its labels, so one failure must not lose the other's result.
        try:
            rows, _ = await self._run(
                f"MATCH (n) WITH n LIMIT {sample} "
                f"UNWIND labels(n) AS label RETURN DISTINCT label"
            )
            node_types = sorted({str(row["label"]) for row in rows if row.get("label")})
        except Exception as e:  # noqa: BLE001
            logger.warning(f"neptune node label discovery failed: {e}")

        try:
            rows, _ = await self._run(
                f"MATCH ()-[r]->() WITH r LIMIT {sample} "
                f"RETURN DISTINCT type(r) AS label"
            )
            relationship_types = sorted(
                {str(row["label"]) for row in rows if row.get("label")}
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"neptune relationship type discovery failed: {e}")

        return SchemaDiscoveryResponse(
            node_types=node_types,
            relationship_types=relationship_types,
        )
