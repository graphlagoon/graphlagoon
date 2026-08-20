"""Demo REST graph service: a shell over Amazon Neptune, in the host app.

Dev only. This is the worked example of what an integrator would build — a
plain REST facade over their graph store — and it is real end to end: the
routes mounted here execute **openCypher against the configured Neptune
endpoint** (locally, the emulator + seeded Neo4j from ``make dev-neptune``)
and answer in the REST-connection contract shape. Nothing is canned; the
queries a user types are real queries.

Three connections over the same shell, so every REST-connection feature is
testable:

* ``demo-full`` — every operation wired (query, expand, subgraph, node fetch,
  type discovery), contract-shaped responses.
* ``demo-mapper`` — the SAME operations through a FOREIGN response shape
  (``items``/``relations``), remapped by ``response_mapper`` — proving the
  mapper applies to canned-op responses, not just queries.
* ``demo-minimal`` — query-only via a custom ``request_builder`` (GET with a
  query param), so the degraded UI (no expand/subgraph/discovery) and the
  builder hook are both visible.

Registered only when ``GRAPH_LAGOON_NEPTUNE_ENDPOINT`` is set — without a
graph database behind it the shell would have nothing to serve, and offering
cards that fail on first query would be worse than offering none.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from graphlagoon.services.datasource.neptune.client import (
    NeptuneClient,
    NeptuneQueryError,
)
from graphlagoon.services.datasource.neptune.mapping import map_graph_results
from graphlagoon.services.datasource.rest import (
    RestConnectionSpec,
    RestConnectionUI,
    RestRequest,
)

logger = logging.getLogger(__name__)

_DISCOVERY_SAMPLE = 10000


class DemoRestQuery(BaseModel):
    query: str = ""
    parameters: Optional[dict] = None
    limits: dict = {}


class DemoRestExpand(BaseModel):
    node: str
    depth: int = 1
    edge_limit: int = 100
    directed: bool = False


def _settings():
    from graphlagoon.config import get_settings

    return get_settings()


def _to_contract(nodes: dict, edges: dict) -> dict:
    """Normalized Node/Edge maps -> the REST-connection contract shape."""
    return {
        "nodes": [
            {
                "id": n.node_id,
                "label": n.node_type,
                "properties": n.properties or {},
            }
            for n in nodes.values()
        ],
        "edges": [
            {
                "id": e.edge_id,
                "source": e.src,
                "target": e.dst,
                "label": e.relationship_type,
                "properties": e.properties or {},
            }
            for e in edges.values()
        ],
    }


def _to_foreign(graph: dict) -> dict:
    """Contract -> the mapper demo's own shape (undone by _foreign_mapper)."""
    return {
        "items": [
            {"key": n["id"], "type": n["label"], "attrs": n["properties"]}
            for n in graph["nodes"]
        ],
        "relations": [
            {
                "key": e["id"],
                "from": e["source"],
                "to": e["target"],
                "rel": e["label"],
                "attrs": e["properties"],
            }
            for e in graph["edges"]
        ],
    }


def _foreign_mapper(payload: dict) -> dict:
    """items/relations -> the normalized contract shape."""
    return {
        "nodes": [
            {"id": item["key"], "label": item["type"], "properties": item["attrs"]}
            for item in payload.get("items", [])
        ],
        "edges": [
            {
                "id": rel["key"],
                "source": rel["from"],
                "target": rel["to"],
                "label": rel["rel"],
                "properties": rel.get("attrs") or {},
            }
            for rel in payload.get("relations", [])
        ],
    }


def register_rest_demo(app: FastAPI) -> list[RestConnectionSpec]:
    """Mount the shell routes on the host app; return the connection specs."""

    # The shell owns one Neptune client, lazily created so importing the app
    # without the endpoint configured stays harmless.
    _client: dict[str, NeptuneClient] = {}

    def client() -> NeptuneClient:
        if "c" not in _client:
            settings = _settings()
            _client["c"] = NeptuneClient(
                settings.neptune_base_url,
                verify_tls=settings.neptune_tls_verify,
            )
        return _client["c"]

    async def run_contract(query: str, parameters: Optional[dict] = None) -> dict:
        """openCypher -> contract graph, with dangling endpoints resolved.

        Same follow-up NeptuneDatasource does: a query projecting only
        relationships names endpoints it never returned, and a real API would
        fill them in rather than serve half a graph.
        """
        rows = await client().execute_opencypher(query, parameters)
        nodes, edges, dangling = map_graph_results(rows)
        if dangling:
            extra = await client().execute_opencypher(
                "MATCH (n) WHERE id(n) IN $ids RETURN n", {"ids": sorted(dangling)}
            )
            resolved, _, _ = map_graph_results(extra)
            for node_id, node in resolved.items():
                nodes.setdefault(node_id, node)
        return _to_contract(nodes, edges)

    def shell_error(e: Exception) -> JSONResponse:
        """Plain REST-API error shape — this side plays an ordinary service."""
        status = 400 if isinstance(e, NeptuneQueryError) else 502
        return JSONResponse(status_code=status, content={"detail": str(e)})

    # ── Shell routes ─────────────────────────────────────────────────────

    @app.post("/dummy/rest/query")
    async def demo_query(request: DemoRestQuery):
        try:
            return await run_contract(request.query, request.parameters)
        except Exception as e:  # noqa: BLE001 — dev-only service
            return shell_error(e)

    @app.post("/dummy/rest/expand")
    async def demo_expand(request: DemoRestExpand):
        depth = max(1, min(int(request.depth), 2))
        limit = max(1, min(int(request.edge_limit), 1000))
        arrow = "->" if request.directed else "-"
        query = (
            f"MATCH p = (s)-[*1..{depth}]{arrow}(m) "
            f"WHERE id(s) = $node_id RETURN p LIMIT {limit}"
        )
        try:
            return await run_contract(query, {"node_id": request.node})
        except Exception as e:  # noqa: BLE001
            return shell_error(e)

    @app.post("/dummy/rest/subgraph")
    async def demo_subgraph(request: DemoRestQuery):
        limit = max(1, min(int(request.limits.get("edges", 500)), 5000))
        try:
            return await run_contract(
                f"MATCH (a)-[r]->(b) RETURN a, r, b LIMIT {limit}"
            )
        except Exception as e:  # noqa: BLE001
            return shell_error(e)

    @app.post("/dummy/rest/schema")
    async def demo_schema():
        try:
            labels = await client().execute_opencypher(
                f"MATCH (n) WITH n LIMIT {_DISCOVERY_SAMPLE} "
                f"UNWIND labels(n) AS label RETURN DISTINCT label"
            )
            types = await client().execute_opencypher(
                f"MATCH ()-[r]->() WITH r LIMIT {_DISCOVERY_SAMPLE} "
                f"RETURN DISTINCT type(r) AS label"
            )
            return {
                "node_types": sorted(
                    {str(row["label"]) for row in labels if row.get("label")}
                ),
                "relationship_types": sorted(
                    {str(row["label"]) for row in types if row.get("label")}
                ),
            }
        except Exception as e:  # noqa: BLE001
            return shell_error(e)

    # Foreign-shape twins for the mapper demo — same execution, different dress.

    @app.post("/dummy/rest/foreign/query")
    async def demo_foreign_query(request: DemoRestQuery):
        try:
            return _to_foreign(await run_contract(request.query, request.parameters))
        except Exception as e:  # noqa: BLE001
            return shell_error(e)

    @app.post("/dummy/rest/foreign/expand")
    async def demo_foreign_expand(request: DemoRestExpand):
        result = await demo_expand(request)
        if isinstance(result, JSONResponse):
            return result
        return _to_foreign(result)

    @app.post("/dummy/rest/foreign/subgraph")
    async def demo_foreign_subgraph(request: DemoRestQuery):
        result = await demo_subgraph(request)
        if isinstance(result, JSONResponse):
            return result
        return _to_foreign(result)

    # GET twin for the request_builder demo.

    @app.get("/dummy/rest/minimal")
    async def demo_minimal(q: str = ""):
        try:
            return await run_contract(q)
        except Exception as e:  # noqa: BLE001
            return shell_error(e)

    # ── Connection specs ─────────────────────────────────────────────────

    base_url = f"http://127.0.0.1:{os.environ.get('GRAPH_LAGOON_SELF_PORT', '8000')}"
    # The host wraps everything in AuthMiddleware, so the server-to-server
    # shell call authenticates the way the frontend does — also a live example
    # of the spec's static auth headers.
    headers = {"X-Forwarded-Email": "rest-demo@graphlagoon.local"}

    example = "MATCH (a:Person)-[r:KNOWS]->(b) RETURN a, r, b LIMIT 50"
    placeholder = "MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 50"

    return [
        RestConnectionSpec(
            name="demo-full",
            ui=RestConnectionUI(
                label="Demo Graph API",
                kind="REST API",
                tagline="Operational · real openCypher",
                description=(
                    "A REST facade over the local graph database (the same "
                    "one the Amazon Neptune demo queries) — every operation "
                    "wired: query, expand, initial subgraph, node fetch and "
                    "type discovery."
                ),
                caveat="Requires make dev-neptune (Neo4j + emulator).",
                query_language="openCypher",
                query_placeholder=placeholder,
                example_query=example,
            ),
            base_url=base_url,
            query_path="/dummy/rest/query",
            headers=headers,
            expand_builder=lambda r: RestRequest(
                path="/dummy/rest/expand",
                json_body={
                    "node": r.node_id,
                    "depth": r.depth,
                    "edge_limit": r.edge_limit,
                    "directed": r.directed,
                },
            ),
            subgraph_builder=lambda r: RestRequest(
                path="/dummy/rest/subgraph",
                json_body={"limits": {"edges": r.edge_limit}},
            ),
            fetch_nodes_builder=lambda ids: RestRequest(
                path="/dummy/rest/query",
                json_body={
                    "query": "MATCH (n) WHERE id(n) IN $ids RETURN n",
                    "parameters": {"ids": list(ids)},
                },
            ),
            discover_types_builder=lambda r: RestRequest(path="/dummy/rest/schema"),
        ),
        RestConnectionSpec(
            name="demo-mapper",
            ui=RestConnectionUI(
                label="Demo Foreign API",
                kind="REST API",
                tagline="Operational · response_mapper",
                description=(
                    "The same graph and the same openCypher, but every "
                    "response arrives in a foreign shape (items/relations) "
                    "and is remapped by a response_mapper — on queries AND "
                    "on every canned operation."
                ),
                caveat="Requires make dev-neptune (Neo4j + emulator).",
                query_language="openCypher",
                query_placeholder=placeholder,
                example_query=example,
            ),
            base_url=base_url,
            query_path="/dummy/rest/foreign/query",
            headers=headers,
            response_mapper=_foreign_mapper,
            expand_builder=lambda r: RestRequest(
                path="/dummy/rest/foreign/expand",
                json_body={
                    "node": r.node_id,
                    "depth": r.depth,
                    "edge_limit": r.edge_limit,
                    "directed": r.directed,
                },
            ),
            subgraph_builder=lambda r: RestRequest(
                path="/dummy/rest/foreign/subgraph",
                json_body={"limits": {"edges": r.edge_limit}},
            ),
            fetch_nodes_builder=lambda ids: RestRequest(
                path="/dummy/rest/foreign/query",
                json_body={
                    "query": "MATCH (n) WHERE id(n) IN $ids RETURN n",
                    "parameters": {"ids": list(ids)},
                },
            ),
            # Discovery answers the direct shape (the mapper does not apply to
            # it — discovery is not a graph), so it reuses the plain route.
            discover_types_builder=lambda r: RestRequest(path="/dummy/rest/schema"),
        ),
        RestConnectionSpec(
            name="demo-minimal",
            ui=RestConnectionUI(
                label="Demo Minimal API",
                kind="REST API",
                tagline="Operational · query only",
                description=(
                    "The same graph and the same openCypher through a custom "
                    "request_builder (GET with a query param) — and nothing "
                    "else declared, to show how the UI degrades for a "
                    "query-only connection."
                ),
                caveat=(
                    "Query-only by choice, not by limitation: expand, "
                    "subgraph and discovery are per-connection opt-ins — the "
                    "other demo connections have all of them wired."
                ),
                query_language="openCypher",
                query_placeholder=placeholder,
                example_query=example,
            ),
            base_url=base_url,
            headers=headers,
            request_builder=lambda query, parameters, limits: RestRequest(
                path="/dummy/rest/minimal", method="GET", params={"q": query}
            ),
        ),
    ]
