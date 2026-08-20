"""Local Amazon Neptune openCypher emulator, backed by Neo4j. Dev only.

There is no official local Neptune (LocalStack emulates it only in its paid
tier), so this mirrors what ``warehouse/`` does for the Databricks statements
API: it speaks Neptune's exact HTTP contract and forwards the actual query
work to something real — here Neo4j, which speaks openCypher natively.

The point is that the production ``NeptuneClient`` / ``NeptuneDatasource`` code
path runs unchanged against this: same request shape, same tilde-prefixed
result format, same error envelope. Nothing about the API is mocked.

Not a security boundary and not production code — it forwards whatever query it
is given. Run it only against a local, throwaway Neo4j.

    uvicorn src.main:app --port 8183
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from neo4j import AsyncGraphDatabase
from neo4j.exceptions import CypherSyntaxError, Neo4jError
from neo4j.graph import Node as Neo4jNode
from neo4j.graph import Path as Neo4jPath
from neo4j.graph import Relationship as Neo4jRelationship

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("neptune-emulator")

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "graphlagoon")

_driver = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _driver
    _driver = AsyncGraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    logger.info(f"Neptune emulator connected to {NEO4J_URI}")
    yield
    await _driver.close()


app = FastAPI(title="Neptune emulator (dev)", lifespan=lifespan)


# ── Neptune wire format ──────────────────────────────────────────────────


def to_neptune(value: Any) -> Any:
    """Re-shape a Neo4j value the way Neptune's openCypher endpoint returns it."""
    if isinstance(value, Neo4jNode):
        return {
            "~id": str(value.element_id),
            "~entityType": "node",
            "~labels": list(value.labels),
            "~properties": dict(value),
        }
    if isinstance(value, Neo4jRelationship):
        return {
            "~id": str(value.element_id),
            "~entityType": "relationship",
            "~start": str(value.start_node.element_id),
            "~end": str(value.end_node.element_id),
            "~type": value.type,
            "~properties": dict(value),
        }
    if isinstance(value, Neo4jPath):
        # Neptune renders a path as a flat array alternating node, rel, node…
        items: list[Any] = [to_neptune(value.start_node)]
        for rel in value.relationships:
            items.append(to_neptune(rel))
            items.append(to_neptune(rel.end_node))
        return items
    if isinstance(value, (list, tuple)):
        return [to_neptune(item) for item in value]
    if isinstance(value, dict):
        return {key: to_neptune(item) for key, item in value.items()}
    return value


_ID_CALL = re.compile(r"(?<![\w.])id\s*\(", re.IGNORECASE)


def translate_query(query: str) -> str:
    """Bridge the one dialect gap between Neptune openCypher and Neo4j.

    In Neptune, ``id(n)`` returns the same string id that comes back as ``~id``.
    In Neo4j 5 that function is ``elementId(n)``; plain ``id(n)`` returns a
    legacy integer which would never match an id the client read off a result.
    Without this rewrite, every ``WHERE id(n) IN $ids`` lookup — node fetch,
    expand, dangling-endpoint resolution — silently returns nothing.

    The negative lookbehind leaves ``elementId(`` and any qualified ``x.id(``
    alone.
    """
    return _ID_CALL.sub("elementId(", query)


def neptune_error(code: str, message: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "requestId": str(uuid.uuid4()),
            "code": code,
            "detailedMessage": message,
        },
    )


# ── Endpoints ────────────────────────────────────────────────────────────


@app.post("/openCypher")
async def open_cypher(request: Request):
    """Run an openCypher query, in Neptune's request/response shape."""
    payload = await _read_payload(request)
    if payload is None:
        return neptune_error("InvalidParameterException", "Malformed request body")

    query = payload.get("query")
    if not query:
        return neptune_error("MissingParameterException", "Missing 'query'")

    parameters = payload.get("parameters") or {}
    if isinstance(parameters, str):
        # Neptune accepts the parameter map as a JSON string.
        import json

        try:
            parameters = json.loads(parameters)
        except ValueError:
            return neptune_error(
                "InvalidParameterException", "'parameters' is not valid JSON"
            )

    try:
        async with _driver.session() as session:
            result = await session.run(translate_query(query), parameters)
            rows = [
                {key: to_neptune(record[key]) for key in record.keys()}
                async for record in result
            ]
    except CypherSyntaxError as e:
        return neptune_error("MalformedQueryException", str(e))
    except Neo4jError as e:
        return neptune_error("InvalidParameterException", str(e))
    except Exception as e:  # noqa: BLE001 — surface as Neptune would
        logger.exception("query failed")
        return neptune_error("InternalFailureException", str(e), status_code=500)

    return {"results": rows}


@app.get("/openCypher/status")
async def query_status():
    """No query tracking locally — an empty list is a valid Neptune answer."""
    return {"acceptedQueryCount": 0, "runningQueryCount": 0, "queries": []}


@app.post("/openCypher/status")
async def cancel_query():
    """Accept cancellation requests so the client's best-effort path works."""
    return {"status": "200 OK"}


@app.get("/pg/statistics/summary")
async def summary():
    """Return 404, like a cluster with DFE statistics disabled.

    That is the more demanding path for the client: it forces the sampling
    fallback in ``discover_types`` to be exercised in local dev, which is
    exactly the code most likely to rot unnoticed.
    """
    return neptune_error(
        "StatisticsNotAvailableException",
        "Statistics are not available for this instance",
        status_code=404,
    )


@app.get("/status")
async def status():
    return {"status": "healthy", "role": "writer", "dbEngineVersion": "emulator"}


# ── REST-connection contract ─────────────────────────────────────────────
#
# The same Neo4j, exposed a second way: as a plain graph-serving REST API in
# the shape Graph Lagoon's REST-connection datasource expects
# ({"nodes": [...], "edges": [...]}). This is what lets `make dev-neptune`
# also register a REST demo connection backed by REAL data and a REAL query
# language, instead of only the canned in-process demo graph.


def to_contract(value: Any, nodes: dict, edges: dict) -> None:
    """Walk one result value, collecting contract-shaped nodes and edges."""
    if isinstance(value, Neo4jNode):
        nodes.setdefault(
            str(value.element_id),
            {
                "id": str(value.element_id),
                "label": next(iter(value.labels), ""),
                "properties": dict(value),
            },
        )
        return
    if isinstance(value, Neo4jRelationship):
        # Endpoints ride along: the contract mapper only synthesizes untyped
        # placeholders for endpoints it never saw, so include the real ones.
        to_contract(value.start_node, nodes, edges)
        to_contract(value.end_node, nodes, edges)
        edges.setdefault(
            str(value.element_id),
            {
                "id": str(value.element_id),
                "source": str(value.start_node.element_id),
                "target": str(value.end_node.element_id),
                "label": value.type,
                "properties": dict(value),
            },
        )
        return
    if isinstance(value, Neo4jPath):
        to_contract(value.start_node, nodes, edges)
        for rel in value.relationships:
            to_contract(rel, nodes, edges)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            to_contract(item, nodes, edges)
        return
    if isinstance(value, dict):
        for item in value.values():
            to_contract(item, nodes, edges)


async def _run_to_contract(query: str, parameters: Optional[dict] = None) -> dict:
    nodes: dict = {}
    edges: dict = {}
    async with _driver.session() as session:
        result = await session.run(translate_query(query), parameters or {})
        async for record in result:
            for key in record.keys():
                to_contract(record[key], nodes, edges)
    return {"nodes": list(nodes.values()), "edges": list(edges.values())}


def _contract_error(message: str, status_code: int = 400) -> JSONResponse:
    """Plain REST-API error shape — NOT Neptune's envelope; this side of the
    emulator plays an ordinary graph service."""
    return JSONResponse(status_code=status_code, content={"detail": message})


@app.post("/rest/query")
async def rest_query(request: Request):
    """openCypher in, contract graph out."""
    payload = await _read_payload(request)
    query = (payload or {}).get("query")
    if not query:
        return _contract_error("Missing 'query'")
    try:
        return await _run_to_contract(query, (payload or {}).get("parameters"))
    except (CypherSyntaxError, Neo4jError) as e:
        return _contract_error(str(e))
    except Exception as e:  # noqa: BLE001 — dev-only service
        logger.exception("rest query failed")
        return _contract_error(str(e), status_code=500)


@app.post("/rest/expand")
async def rest_expand(request: Request):
    payload = await _read_payload(request) or {}
    node_id = payload.get("node")
    if not node_id:
        return _contract_error("Missing 'node'")
    depth = max(1, min(int(payload.get("depth", 1)), 2))
    limit = max(1, min(int(payload.get("edge_limit", 100)), 1000))
    arrow = "->" if payload.get("directed") else "-"
    query = (
        f"MATCH p = (s)-[*1..{depth}]{arrow}(m) "
        f"WHERE elementId(s) = $node_id RETURN p LIMIT {limit}"
    )
    try:
        return await _run_to_contract(query, {"node_id": node_id})
    except Exception as e:  # noqa: BLE001
        logger.exception("rest expand failed")
        return _contract_error(str(e), status_code=500)


@app.post("/rest/subgraph")
async def rest_subgraph(request: Request):
    payload = await _read_payload(request) or {}
    limit = max(1, min(int(payload.get("limit", 500)), 5000))
    try:
        return await _run_to_contract(
            f"MATCH (a)-[r]->(b) RETURN a, r, b LIMIT {limit}"
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("rest subgraph failed")
        return _contract_error(str(e), status_code=500)


@app.post("/rest/schema")
async def rest_schema():
    try:
        async with _driver.session() as session:
            labels = await (await session.run("CALL db.labels()")).values()
            types = await (await session.run("CALL db.relationshipTypes()")).values()
        return {
            "node_types": sorted(row[0] for row in labels),
            "relationship_types": sorted(row[0] for row in types),
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("rest schema failed")
        return _contract_error(str(e), status_code=500)


async def _read_payload(request: Request) -> Optional[dict]:
    try:
        return await request.json()
    except Exception:
        # Neptune also accepts form-encoded bodies.
        try:
            form = await request.form()
            return dict(form)
        except Exception:
            return None
