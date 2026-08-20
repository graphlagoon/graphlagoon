"""REST-backed graph datasource — one instance per registered connection.

The third kind of backend, after the SQL warehouse (Cypher transpiled to SQL
over two tables) and Neptune (openCypher passthrough): here the user's query is
opaque text handed to an external REST API exactly as the connection's spec
describes, and the JSON answer is mapped onto the normalized graph.

Everything type-level is off (``DatasourceCapabilities()`` — no SQL, no
transpilation, no catalog, no drift); what varies per *connection* is which
canned operations the spec declared builders for. Those are enforced here with
the same 400 envelope ``require_capability`` produces, so the frontend handles
both kinds of "unsupported" identically.
"""

from __future__ import annotations

import logging
import time
from typing import Any, ClassVar, Optional

import httpx

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
from graphlagoon.services.datasource.rest.mapping import (
    ResponseContractError,
    dangling_endpoint_ids,
    flatten_nodes_tabular,
    placeholder_node,
    to_graph_payload,
)
from graphlagoon.services.datasource.rest.spec import (
    RestConnectionSpec,
    RestRequest,
)
from graphlagoon.services.graph_operations import QueryExecutionError

logger = logging.getLogger(__name__)

# How much of a remote error body to quote back. Enough to diagnose, small
# enough that a misconfigured endpoint returning HTML doesn't flood the UI.
_BODY_SNIPPET_LIMIT = 500


def _unsupported(spec_name: str, operation: str):
    """Per-connection unsupported operation, in the shared 400 envelope.

    ``require_capability`` keys off class-level flags; these flags live on the
    spec instance, so the envelope is built directly with the same code.
    """
    return invalid_request(
        "DATASOURCE_UNSUPPORTED_OPERATION",
        f"REST connection '{spec_name}' does not support {operation}: the "
        f"connection did not declare a handler for it",
        details={"datasource_name": spec_name, "operation": operation},
    )


class RestDatasource(GraphDatasource):
    """Query a graph through a dev-declared REST connection."""

    type_name: ClassVar[str] = "rest"
    capabilities: ClassVar[DatasourceCapabilities] = DatasourceCapabilities()

    def __init__(self, spec: RestConnectionSpec):
        self._spec = spec
        self._client = httpx.AsyncClient(
            base_url=spec.base_url,
            timeout=spec.timeout_seconds,
            verify=spec.verify_tls,
        )

    @property
    def spec(self) -> RestConnectionSpec:
        return self._spec

    async def close(self) -> None:
        await self._client.aclose()

    # ── HTTP ─────────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        headers = dict(self._spec.headers)
        if self._spec.headers_provider is not None:
            headers.update(self._spec.headers_provider())
        return headers

    async def _send(
        self, request: RestRequest, *, statement: Optional[str] = None
    ) -> tuple[Any, float]:
        """Send one request, returning ``(decoded_json, elapsed_ms)``.

        Error taxonomy — who is being told what:
        * timeout / remote 4xx → ``QueryExecutionError`` with a REST_* code:
          the *user's query* (or the remote service) is the problem, shown as
          a normal query error.
        * connect errors / remote 5xx → ``GraphExecutionFailure``: the
          *connection* is the problem — surfaced as an execution failure with
          traceback, the same treatment unexpected Neptune errors get.
        * undecodable body → ``QueryExecutionError(REST_INVALID_RESPONSE)``.
        """
        t0 = time.perf_counter()
        try:
            response = await self._client.request(
                request.method,
                request.path,
                json=request.json_body,
                params=request.params,
                headers=self._headers(),
            )
        except httpx.TimeoutException:
            raise QueryExecutionError(
                f"REST connection '{self._spec.name}' timed out after "
                f"{self._spec.timeout_seconds}s",
                query=statement,
                code="REST_TIMEOUT",
            )
        except Exception as e:
            raise GraphExecutionFailure(e, statement=statement)
        elapsed_ms = (time.perf_counter() - t0) * 1000

        if response.status_code >= 500:
            raise GraphExecutionFailure(
                RuntimeError(
                    f"REST connection '{self._spec.name}' answered "
                    f"{response.status_code}: "
                    f"{response.text[:_BODY_SNIPPET_LIMIT]}"
                ),
                statement=statement,
            )
        if response.status_code >= 400:
            raise QueryExecutionError(
                f"REST connection '{self._spec.name}' rejected the request "
                f"({response.status_code}): "
                f"{response.text[:_BODY_SNIPPET_LIMIT]}",
                query=statement,
                code="REST_REMOTE_ERROR",
            )

        try:
            return response.json(), elapsed_ms
        except ValueError:
            raise QueryExecutionError(
                f"REST connection '{self._spec.name}' returned a non-JSON "
                f"response: {response.text[:_BODY_SNIPPET_LIMIT]}",
                query=statement,
                code="REST_INVALID_RESPONSE",
            )

    def _map_payload(self, payload: Any, *, statement: Optional[str]) -> dict:
        """Apply the spec's response_mapper, if any.

        A mapper crash is a dev bug in the spec, not a bad query — wrapped as
        an execution failure so the traceback survives into the envelope.
        """
        if self._spec.response_mapper is None:
            return payload
        try:
            return self._spec.response_mapper(payload)
        except Exception as e:
            raise GraphExecutionFailure(e, statement=statement)

    def _to_graph_response(
        self,
        payload: Any,
        *,
        statement: Optional[str],
        query_ms: float,
        edge_limit: Optional[int] = None,
    ) -> GraphResponse:
        """Mapped JSON -> GraphResponse, with defensive limit enforcement.

        The remote may ignore the limits we pass it, so truncation is enforced
        here too — the same "trust but verify" the warehouse applies to its
        own row caps. Dangling endpoints get placeholder nodes: an edge is
        only drawable with both ends present.
        """
        t0 = time.perf_counter()
        try:
            nodes, edges = to_graph_payload(
                self._map_payload(payload, statement=statement)
            )
        except ResponseContractError as e:
            raise QueryExecutionError(
                f"REST connection '{self._spec.name}' response did not match "
                f"the expected {{nodes, edges}} shape: {e}",
                query=statement,
                code="REST_INVALID_RESPONSE",
            )

        truncated = False
        if edge_limit is not None and len(edges) > edge_limit:
            edges = dict(list(edges.items())[:edge_limit])
            truncated = True

        for node_id in sorted(dangling_endpoint_ids(nodes, edges)):
            nodes[node_id] = placeholder_node(node_id)

        processing_ms = (time.perf_counter() - t0) * 1000
        return GraphResponse(
            nodes=list(nodes.values()),
            edges=list(edges.values()),
            truncated=truncated,
            total_count=len(edges),
            metadata=QueryMetadata(
                edge_query_ms=round(query_ms, 2),
                edge_processing_ms=round(processing_ms, 2),
                total_ms=round(query_ms + processing_ms, 2),
                node_count=len(nodes),
                edge_count=len(edges),
            ),
        )

    def _build_query_request(
        self, query: str, limits: Optional[dict] = None
    ) -> RestRequest:
        if self._spec.request_builder is not None:
            return self._spec.request_builder(query, None, limits or {})
        return RestRequest(
            path=self._spec.query_path,
            method="POST",
            json_body={
                "query": query,
                "parameters": None,
                "limits": limits or {},
            },
        )

    # ── Query preparation / execution ────────────────────────────────────

    def prepare_cypher(self, context, data: CypherQueryRequest) -> PreparedGraphQuery:
        """Accept any non-empty query.

        The query language belongs to the remote API — there is no grammar to
        validate and no read-only guard to apply. Connections are dev-declared
        and trusted; enforcing safety is the remote service's job (documented
        on the spec).
        """
        if getattr(data, "cte_prefilter", None):
            require_capability(self, "supports_cte_prefilter", "CTE pre-filters")
        if not data.query or not data.query.strip():
            raise invalid_request("EMPTY_QUERY", "Query cannot be empty")
        # transpiled_sql stays None: nothing is transpiled, and reporting an
        # empty string would make the frontend offer a review step for nothing.
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
        # concepts: one JSON body comes back with everything in it.
        request = self._build_query_request(prepared.statement)
        payload, query_ms = await self._send(request, statement=prepared.statement)
        return self._to_graph_response(
            payload, statement=prepared.statement, query_ms=query_ms
        )

    # ── Canned graph operations (spec-gated) ─────────────────────────────

    async def get_subgraph(self, context, data: SubgraphRequest) -> GraphResponse:
        if self._spec.subgraph_builder is None:
            raise _unsupported(self._spec.name, "initial subgraph loading")
        request = self._spec.subgraph_builder(data)
        payload, query_ms = await self._send(request)
        return self._to_graph_response(
            payload,
            statement=None,
            query_ms=query_ms,
            edge_limit=int(data.edge_limit),
        )

    async def expand(self, context, data: ExpandRequest) -> GraphResponse:
        if self._spec.expand_builder is None:
            raise _unsupported(self._spec.name, "expanding from a node")
        request = self._spec.expand_builder(data)
        payload, query_ms = await self._send(request)
        return self._to_graph_response(
            payload,
            statement=None,
            query_ms=query_ms,
            edge_limit=int(data.edge_limit),
        )

    async def fetch_nodes(
        self,
        context,
        node_ids: list[str],
        columns: Optional[list[str]] = None,
    ) -> tuple[list[Node], float]:
        """Fetch nodes by id. ``columns`` narrowing does not apply here."""
        if self._spec.fetch_nodes_builder is None:
            raise _unsupported(self._spec.name, "fetching nodes by id")
        request = self._spec.fetch_nodes_builder(list(node_ids))
        payload, query_ms = await self._send(request)
        try:
            nodes, _ = to_graph_payload(self._map_payload(payload, statement=None))
        except ResponseContractError as e:
            raise QueryExecutionError(
                f"REST connection '{self._spec.name}' response did not match "
                f"the expected {{nodes, edges}} shape: {e}",
                code="REST_INVALID_RESPONSE",
            )
        return list(nodes.values()), query_ms

    # ── Tabular / console mode ───────────────────────────────────────────

    async def submit_table_query(
        self, context, data: TableQueryRequest
    ) -> TableQueryResponse:
        """Run the query and project the resulting nodes as rows.

        Always completes inline (no statement id, so the console's fast path
        for an inline ``succeeded`` handles it and never polls) — the same
        shape Neptune uses. The tabular projection is the node set: one row
        per node, identity columns plus the union of property keys.
        """
        if data.mode != "cypher":
            require_capability(self, "supports_sql", "SQL console queries")
        if not data.query or not data.query.strip():
            raise invalid_request("EMPTY_QUERY", "Query cannot be empty")

        request = self._build_query_request(
            data.query, limits={"rows": int(data.row_limit)}
        )
        payload, query_ms = await self._send(request, statement=data.query)
        graph = self._to_graph_response(
            payload, statement=data.query, query_ms=query_ms
        )
        columns, rows, truncated = flatten_nodes_tabular(
            graph.nodes, int(data.row_limit)
        )

        return TableQueryResponse(
            status="succeeded",
            statement_id=None,
            columns=columns,
            rows=rows,
            row_count=len(rows),
            truncated=truncated,
            total_row_count=len(graph.nodes),
            transpiled_sql=None,
            metadata=QueryMetadata(total_ms=round(query_ms, 2)),
        )

    async def get_table_query_status(
        self, context, statement_id: str, row_limit: int
    ) -> TableQueryStatusResponse:
        """Unreachable in practice — table queries never return a statement id."""
        return TableQueryStatusResponse(status="canceled", statement_id=statement_id)

    async def cancel_statement(self, statement_id: str) -> None:
        """Nothing to cancel remotely.

        The request is a single HTTP round-trip; the normal cancellation path
        is the API-side asyncio task cancellation in ``async_job``, which
        drops the outgoing request. The remote may keep computing — that
        limitation is documented on the spec.
        """
        return None

    # ── Discovery ────────────────────────────────────────────────────────

    async def discover_types(self, request: Any) -> SchemaDiscoveryResponse:
        """Ask the connection for its labels, when it declared how.

        The response must be ``{"node_types": [...], "relationship_types":
        [...]}`` directly — discovery is not a graph, so the response_mapper
        does not apply.
        """
        if self._spec.discover_types_builder is None:
            raise _unsupported(self._spec.name, "schema discovery")
        rest_request = self._spec.discover_types_builder(request)
        payload, _ = await self._send(rest_request)
        if not isinstance(payload, dict):
            raise QueryExecutionError(
                f"REST connection '{self._spec.name}' discovery response must "
                f"be an object with node_types/relationship_types lists",
                code="REST_INVALID_RESPONSE",
            )
        return SchemaDiscoveryResponse(
            node_types=sorted(str(t) for t in (payload.get("node_types") or []) if t),
            relationship_types=sorted(
                str(t) for t in (payload.get("relationship_types") or []) if t
            ),
        )
