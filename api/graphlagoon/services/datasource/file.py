"""File datasource (investigations F2.5): a graph generated from a case file.

The graph is built once on the server from the case file and its mapping spec
(``services/investigation_files.generate_context``) and stored, in snapshot
format, under the context id on the snapshot service. Nothing here queries
anything: there is no SQL, no Cypher and no transpile — the canned operations
(subgraph, expand, node fetch) walk the stored graph in memory.
"""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from graphlagoon.models.schemas import (
    CypherQueryRequest,
    Edge,
    ExpandRequest,
    GraphResponse,
    Node,
    SchemaDiscoveryResponse,
    SubgraphRequest,
    TableQueryRequest,
    TableQueryResponse,
    TableQueryStatusResponse,
)
from graphlagoon.services.datasource.base import (
    DatasourceCapabilities,
    GraphDatasource,
    PreparedGraphQuery,
    invalid_request,
)


async def save_file_graph(context_id, graph: dict) -> None:
    """Stores ``graph`` (``{nodes, edges}`` in GraphResponse shape) as the
    context's data, in snapshot format."""
    from graphlagoon.services.snapshot import compress_snapshot, get_snapshot_service

    await get_snapshot_service().save(context_id, compress_snapshot(to_snapshot(graph)))


def to_snapshot(graph: dict) -> dict:
    return {
        "nodes": [
            {"id": n["node_id"], "type": n["node_type"], "properties": n.get("properties") or {}}
            for n in graph["nodes"]
        ],
        "edges": [
            {
                "id": e["edge_id"],
                "source": e["src"],
                "target": e["dst"],
                "type": e["relationship_type"],
                "properties": e.get("properties") or {},
            }
            for e in graph["edges"]
        ],
        "snapshot_version": 1,
    }


async def _load(context) -> tuple[list[Node], list[Edge]]:
    from graphlagoon.services.snapshot import decompress_snapshot, get_snapshot_service

    raw = await get_snapshot_service().load(context.id)
    data = decompress_snapshot(raw) if raw else {"nodes": [], "edges": []}
    nodes = [
        Node(node_id=n["id"], node_type=n["type"], properties=n.get("properties") or {})
        for n in data["nodes"]
    ]
    edges = [
        Edge(
            edge_id=e["id"],
            src=e["source"],
            dst=e["target"],
            relationship_type=e["type"],
            properties=e.get("properties") or {},
        )
        for e in data["edges"]
    ]
    return nodes, edges


def _no_query():
    return invalid_request(
        "DATASOURCE_UNSUPPORTED_OPERATION",
        "A file context has no query language: open its exploration or expand nodes",
        {"datasource_type": "file"},
    )


def _response(nodes: list[Node], edges: list[Edge], truncated: bool) -> GraphResponse:
    ids = {e.src for e in edges} | {e.dst for e in edges}
    return GraphResponse(
        nodes=[n for n in nodes if n.node_id in ids],
        edges=edges,
        truncated=truncated,
    )


class FileDatasource(GraphDatasource):
    type_name: ClassVar[str] = "file"
    capabilities: ClassVar[DatasourceCapabilities] = DatasourceCapabilities()

    def prepare_cypher(self, context, data: CypherQueryRequest) -> PreparedGraphQuery:
        raise _no_query()

    async def execute_prepared(self, context, prepared, **kwargs) -> GraphResponse:
        raise _no_query()

    async def get_subgraph(self, context, data: SubgraphRequest) -> GraphResponse:
        nodes, edges = await _load(context)
        types = {n.node_id: n.node_type for n in nodes}
        picked = [
            e
            for e in edges
            if (not data.edge_types or e.relationship_type in data.edge_types)
            and (
                not data.node_types
                or types.get(e.src) in data.node_types
                or types.get(e.dst) in data.node_types
            )
        ]
        return _response(nodes, picked[: data.edge_limit], len(picked) > data.edge_limit)

    async def expand(self, context, data: ExpandRequest) -> GraphResponse:
        nodes, edges = await _load(context)
        frontier, seen, picked = {data.node_id}, {data.node_id}, {}
        for _ in range(data.depth):
            nxt = set()
            for e in edges:
                if data.edge_types and e.relationship_type not in data.edge_types:
                    continue
                for a, b in ((e.src, e.dst), (e.dst, e.src)) if not data.directed else ((e.src, e.dst),):
                    if a in frontier and e.edge_id not in picked:
                        picked[e.edge_id] = e
                        if b not in seen:
                            seen.add(b)
                            nxt.add(b)
            frontier = nxt
        out = list(picked.values())
        return _response(nodes, out[: data.edge_limit], len(out) > data.edge_limit)

    async def fetch_nodes(
        self, context, node_ids: list[str], columns: Optional[list[str]] = None
    ) -> tuple[list[Node], float]:
        wanted = set(node_ids)
        nodes, _ = await _load(context)
        return [n for n in nodes if n.node_id in wanted], 0.0

    async def submit_table_query(self, context, data: TableQueryRequest) -> TableQueryResponse:
        raise _no_query()

    async def get_table_query_status(
        self, context, statement_id: str, row_limit: int
    ) -> TableQueryStatusResponse:
        return TableQueryStatusResponse(status="canceled", statement_id=statement_id)

    async def cancel_statement(self, statement_id: str) -> None:
        return None

    async def discover_types(self, request: Any) -> SchemaDiscoveryResponse:
        # Types are stored on the context when it is generated; nothing to discover.
        return SchemaDiscoveryResponse(node_types=[], relationship_types=[])
