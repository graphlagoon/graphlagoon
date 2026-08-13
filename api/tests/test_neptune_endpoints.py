"""Endpoint behaviour for a Neptune-backed context.

Covers the two things the router owns: which operations a non-SQL datasource
rejects, and that the ones it supports come back in the normal response shape.
"""

import json
import sys
from unittest.mock import MagicMock as _MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient

# Stub gsql2rsql only when it is genuinely unavailable — stubbing it in
# sys.modules while installed poisons the import for test_transpile_options.
try:
    import gsql2rsql  # noqa: F401
except ImportError:
    for _name in (
        "gsql2rsql",
        "gsql2rsql.parser",
        "gsql2rsql.parser.opencypher_parser",
        "gsql2rsql.planner",
        "gsql2rsql.planner.logical_plan",
        "gsql2rsql.planner.pass_manager",
        "gsql2rsql.renderer",
        "gsql2rsql.renderer.sql_renderer",
        "gsql2rsql.renderer.schema_provider",
        "gsql2rsql.common",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from fastapi import FastAPI  # noqa: E402

from graphlagoon.config import Settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore, get_memory_store  # noqa: E402
from graphlagoon.routers import config as config_router  # noqa: E402
from graphlagoon.routers import graph as graph_router  # noqa: E402
from graphlagoon.routers import graph_contexts  # noqa: E402
from graphlagoon.services.datasource import (  # noqa: E402
    configure_datasources,
    get_datasource,
    reset_datasources,
)
from graphlagoon.services.datasource.neptune.client import NeptuneClient  # noqa: E402

USER = "test@example.com"
HEADERS = {"X-Forwarded-Email": USER}

NODE_A = {
    "~id": "n1",
    "~entityType": "node",
    "~labels": ["Person"],
    "~properties": {"name": "Alice"},
}
NODE_B = {
    "~id": "n2",
    "~entityType": "node",
    "~labels": ["Person"],
    "~properties": {"name": "Bob"},
}
REL = {
    "~id": "e1",
    "~entityType": "relationship",
    "~start": "n1",
    "~end": "n2",
    "~type": "KNOWS",
    "~properties": {},
}


def neptune_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/pg/statistics/summary":
        return httpx.Response(
            200,
            json={
                "payload": {
                    "graphSummary": {
                        "nodeLabels": ["Person"],
                        "edgeLabels": ["KNOWS"],
                    }
                }
            },
        )
    query = json.loads(request.content)["query"]
    if "RETURN p.name" in query:
        return httpx.Response(200, json={"results": [{"name": "Alice"}]})
    return httpx.Response(200, json={"results": [{"a": NODE_A, "r": REL, "b": NODE_B}]})


def build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(graph_contexts.router)
    app.include_router(graph_router.router)
    app.include_router(config_router.router)
    return app


@pytest.fixture
def client():
    InMemoryStore.reset()
    reset_datasources()
    configure_datasources(
        Settings(
            dev_mode=True,
            database_enabled=False,
            neptune_endpoint="neptune.test",
        )
    )

    # Swap only the HTTP transport: the real client, request building, response
    # parsing and error translation all stay in the path.
    datasource = get_datasource("neptune")
    datasource._client = NeptuneClient("https://neptune.test:8182")
    datasource._client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(neptune_handler)
    )

    yield TestClient(build_app())

    reset_datasources()
    InMemoryStore.reset()


@pytest.fixture
def neptune_context():
    store = get_memory_store()
    context = store.create_graph_context(
        title="Neptune graph",
        edge_table_name=None,
        node_table_name=None,
        owner_email=USER,
        datasource_type="neptune",
        node_types=["Person"],
        relationship_types=["KNOWS"],
    )
    return context


def error_code(response) -> str:
    return response.json()["detail"]["error"]["code"]


class TestContextCreation:
    def test_creates_without_tables(self, client):
        response = client.post(
            "/api/graph-contexts",
            headers=HEADERS,
            json={"title": "My Neptune graph", "datasource_type": "neptune"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["datasource_type"] == "neptune"
        assert body["edge_table_name"] is None
        assert body["node_table_name"] is None

    def test_ignores_table_fields_sent_for_a_neptune_context(self, client):
        """A client reusing the warehouse form gets a valid context, not a 422."""
        response = client.post(
            "/api/graph-contexts",
            headers=HEADERS,
            json={
                "title": "Leftovers",
                "datasource_type": "neptune",
                "edge_table_name": "cat.db.edges",
                "node_table_name": "cat.db.nodes",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["edge_table_name"] is None

    def test_sql_warehouse_context_still_requires_tables(self, client):
        response = client.post(
            "/api/graph-contexts",
            headers=HEADERS,
            json={"title": "No tables", "datasource_type": "sql_warehouse"},
        )
        assert response.status_code == 422

    def test_defaults_to_sql_warehouse_when_type_is_omitted(self, client):
        """Existing clients that never heard of datasource_type are unaffected."""
        response = client.post(
            "/api/graph-contexts",
            headers=HEADERS,
            json={
                "title": "Legacy",
                "edge_table_name": "cat.db.edges",
                "node_table_name": "cat.db.nodes",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["datasource_type"] == "sql_warehouse"


class TestUnsupportedOperations:
    def test_raw_sql_query_is_rejected(self, client, neptune_context):
        response = client.post(
            f"/api/graph-contexts/{neptune_context.id}/query",
            headers=HEADERS,
            json={"query": "SELECT * FROM edges"},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"

    def test_transpile_is_rejected(self, client, neptune_context):
        response = client.post(
            f"/api/graph-contexts/{neptune_context.id}/cypher/transpile",
            headers=HEADERS,
            json={"query": "MATCH (a)-[r]->(b) RETURN r"},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"

    def test_schema_drift_is_rejected(self, client, neptune_context):
        response = client.get(
            f"/api/graph-contexts/{neptune_context.id}/schema-drift",
            headers=HEADERS,
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"

    def test_sql_console_mode_is_rejected(self, client, neptune_context):
        response = client.post(
            f"/api/graph-contexts/{neptune_context.id}/query/table",
            headers=HEADERS,
            json={"query": "SELECT 1", "mode": "sql"},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"

    def test_cte_prefilter_is_rejected(self, client, neptune_context):
        response = client.post(
            f"/api/graph-contexts/{neptune_context.id}/cypher",
            headers=HEADERS,
            json={
                "query": "MATCH (a)-[r]->(b) RETURN a, r, b",
                "cte_prefilter": "WITH f AS (SELECT 1)",
            },
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"


class TestSupportedOperations:
    def test_cypher_query_returns_a_graph_without_transpiled_sql(
        self, client, neptune_context
    ):
        response = client.post(
            f"/api/graph-contexts/{neptune_context.id}/cypher",
            headers=HEADERS,
            json={"query": "MATCH (a)-[r]->(b) RETURN a, r, b"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert {n["node_id"] for n in body["nodes"]} == {"n1", "n2"}
        assert body["edges"][0]["relationship_type"] == "KNOWS"
        assert body["transpiled_sql"] is None
        # Nothing was transpiled, so no misleading zero timing.
        assert body["metadata"]["transpilation_ms"] is None

    def test_subgraph_returns_a_graph(self, client, neptune_context):
        response = client.post(
            f"/api/graph-contexts/{neptune_context.id}/subgraph",
            headers=HEADERS,
            json={"edge_limit": 100},
        )
        assert response.status_code == 200, response.text
        assert len(response.json()["nodes"]) == 2

    def test_expand_returns_a_graph(self, client, neptune_context):
        response = client.post(
            f"/api/graph-contexts/{neptune_context.id}/expand",
            headers=HEADERS,
            json={"node_id": "n1", "depth": 1, "edge_limit": 50},
        )
        assert response.status_code == 200, response.text
        assert len(response.json()["nodes"]) == 2

    def test_nodes_batch_returns_nodes(self, client, neptune_context):
        response = client.post(
            f"/api/graph-contexts/{neptune_context.id}/nodes/batch",
            headers=HEADERS,
            json={"node_ids": ["n1", "n2"]},
        )
        assert response.status_code == 200, response.text
        assert len(response.json()["nodes"]) == 2

    def test_cypher_console_mode_returns_rows_inline(self, client, neptune_context):
        response = client.post(
            f"/api/graph-contexts/{neptune_context.id}/query/table",
            headers=HEADERS,
            json={"query": "MATCH (p:Person) RETURN p.name AS name", "mode": "cypher"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "succeeded"
        assert body["columns"] == ["name"]
        # No statement id: the client never enters the poll/cancel flow.
        assert body["statement_id"] is None

    def test_discovery_reads_the_label_catalog(self, client):
        response = client.post(
            "/api/schema-discovery",
            headers=HEADERS,
            json={"datasource_type": "neptune"},
        )
        assert response.status_code == 200, response.text
        assert response.json() == {
            "node_types": ["Person"],
            "relationship_types": ["KNOWS"],
        }


class TestNeptuneNotConfigured:
    def test_creating_a_neptune_context_fails_cleanly(self):
        InMemoryStore.reset()
        reset_datasources()
        configure_datasources(Settings(dev_mode=True, database_enabled=False))

        with TestClient(build_app()) as test_client:
            response = test_client.post(
                "/api/graph-contexts",
                headers=HEADERS,
                json={"title": "Nope", "datasource_type": "neptune"},
            )
            assert response.status_code == 400
            assert error_code(response) == "DATASOURCE_NOT_CONFIGURED"

        reset_datasources()
        InMemoryStore.reset()

    def test_config_reports_which_datasources_are_available(self):
        reset_datasources()
        configure_datasources(Settings(dev_mode=True, database_enabled=False))

        with TestClient(build_app()) as test_client:
            body = test_client.get("/api/config", headers=HEADERS).json()
            assert body["datasources"] == {"sql_warehouse": True, "neptune": False}

        reset_datasources()
