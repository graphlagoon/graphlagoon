"""API surface of a REST-connection context, end to end.

Same structure as ``test_neptune_endpoints``: real routers, in-memory store,
X-Forwarded-Email auth, and only the outgoing HTTP transport faked. What's new
here is the *named instance* dimension — a context selects a connection by
name, config advertises registered connections, and a connection removed from
the registry leaves its contexts failing cleanly.
"""

import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from graphlagoon.config import Settings
from graphlagoon.db.memory_store import InMemoryStore, get_memory_store
from graphlagoon.routers import config as config_router
from graphlagoon.routers import graph as graph_router
from graphlagoon.routers import graph_contexts
from graphlagoon.services.datasource import (
    configure_datasources,
    get_datasource,
    reset_datasources,
)
from graphlagoon.services.datasource.rest import (
    RestConnectionSpec,
    RestConnectionUI,
    RestRequest,
    clear_rest_registry,
    register_rest_connection,
)

USER = "user@example.com"
HEADERS = {"X-Forwarded-Email": USER}
BASE_URL = "https://graph-api.test"

GRAPH_PAYLOAD = {
    "nodes": [
        {"id": "a", "label": "Person", "properties": {"name": "Alice"}},
        {"id": "b", "label": "Person", "properties": {"name": "Bob"}},
    ],
    "edges": [{"id": "e1", "source": "a", "target": "b", "label": "KNOWS"}],
}


def remote_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/schema":
        return httpx.Response(
            200,
            json={"node_types": ["Person"], "relationship_types": ["KNOWS"]},
        )
    return httpx.Response(200, json=GRAPH_PAYLOAD)


def make_spec(name="fraud-api", **overrides) -> RestConnectionSpec:
    defaults = dict(
        name=name,
        ui=RestConnectionUI(
            label="Fraud Graph Service",
            tagline="Operational · curated subgraph",
            query_language="FraudQL",
            example_query="accounts linked to case 42",
        ),
        base_url=BASE_URL,
    )
    defaults.update(overrides)
    return RestConnectionSpec(**defaults)


FULL_SPEC_BUILDERS = dict(
    expand_builder=lambda r: RestRequest(path="/expand", json_body={"node": r.node_id}),
    subgraph_builder=lambda r: RestRequest(path="/subgraph"),
    fetch_nodes_builder=lambda ids: RestRequest(path="/nodes", json_body={"ids": ids}),
    discover_types_builder=lambda r: RestRequest(path="/schema", method="GET"),
)


def build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(graph_contexts.router)
    app.include_router(graph_router.router)
    app.include_router(config_router.router)
    return app


def mock_transport(name: str) -> None:
    """Swap only the outgoing transport on an instantiated datasource."""
    datasource = get_datasource("rest", name)
    datasource._client = httpx.AsyncClient(
        base_url=BASE_URL, transport=httpx.MockTransport(remote_handler)
    )


@pytest.fixture
def client():
    InMemoryStore.reset()
    reset_datasources()
    clear_rest_registry()
    configure_datasources(Settings(dev_mode=True, database_enabled=False))

    # One full-featured connection, one query-only connection.
    register_rest_connection(make_spec("fraud-api", **FULL_SPEC_BUILDERS))
    register_rest_connection(make_spec("scores-api"))
    mock_transport("fraud-api")
    mock_transport("scores-api")

    yield TestClient(build_app())

    clear_rest_registry()
    reset_datasources()
    InMemoryStore.reset()


def make_context(name="fraud-api"):
    store = get_memory_store()
    return store.create_graph_context(
        title="REST graph",
        edge_table_name=None,
        node_table_name=None,
        owner_email=USER,
        datasource_type="rest",
        datasource_name=name,
    )


def error_code(response) -> str:
    return response.json()["detail"]["error"]["code"]


# ── Context creation ─────────────────────────────────────────────────────


class TestContextCreation:
    def test_create_with_registered_connection(self, client):
        response = client.post(
            "/api/graph-contexts",
            headers=HEADERS,
            json={
                "title": "My REST graph",
                "datasource_type": "rest",
                "datasource_name": "fraud-api",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["datasource_type"] == "rest"
        assert body["datasource_name"] == "fraud-api"
        assert body["edge_table_name"] is None
        assert body["node_table_name"] is None

    def test_create_without_name_is_422(self, client):
        response = client.post(
            "/api/graph-contexts",
            headers=HEADERS,
            json={"title": "No name", "datasource_type": "rest"},
        )
        assert response.status_code == 422

    def test_create_with_unregistered_name_is_400(self, client):
        response = client.post(
            "/api/graph-contexts",
            headers=HEADERS,
            json={
                "title": "Ghost",
                "datasource_type": "rest",
                "datasource_name": "nope",
            },
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_NOT_CONFIGURED"
        details = response.json()["detail"]["error"]["details"]
        assert details["datasource_name"] == "nope"

    def test_name_is_stripped_from_non_rest_contexts(self, client):
        response = client.post(
            "/api/graph-contexts",
            headers=HEADERS,
            json={
                "title": "Warehouse",
                "datasource_type": "sql_warehouse",
                "datasource_name": "fraud-api",
                "edge_table_name": "db.edges",
                "node_table_name": "db.nodes",
            },
        )
        assert response.status_code == 200
        assert response.json()["datasource_name"] is None


# ── Config exposure ──────────────────────────────────────────────────────


class TestConfigExposure:
    def test_connections_advertised_with_capabilities(self, client):
        body = client.get("/api/config", headers=HEADERS).json()
        # The frozen boolean record is untouched by REST connections.
        assert body["datasources"] == {"sql_warehouse": True, "neptune": False}

        connections = {c["name"]: c for c in body["datasource_connections"]}
        assert set(connections) == {"fraud-api", "scores-api"}

        fraud = connections["fraud-api"]
        assert fraud["type"] == "rest"
        assert fraud["label"] == "Fraud Graph Service"
        assert fraud["query_language"] == "FraudQL"
        assert fraud["capabilities"] == {
            "expand": True,
            "subgraph": True,
            "fetch_nodes": True,
            "schema_discovery": True,
        }
        assert connections["scores-api"]["capabilities"] == {
            "expand": False,
            "subgraph": False,
            "fetch_nodes": False,
            "schema_discovery": False,
        }

    def test_no_secrets_in_config(self, client):
        spec = make_spec(
            "secret-api",
            headers={"Authorization": "Bearer TOPSECRET"},
        )
        register_rest_connection(spec)
        try:
            body = client.get("/api/config", headers=HEADERS).json()
            serialized = json.dumps(body["datasource_connections"])
            assert "TOPSECRET" not in serialized
            assert BASE_URL not in serialized
            assert "base_url" not in serialized
            assert "headers" not in serialized
        finally:
            clear_rest_registry()
            register_rest_connection(make_spec("fraud-api", **FULL_SPEC_BUILDERS))
            register_rest_connection(make_spec("scores-api"))


# ── Query execution ──────────────────────────────────────────────────────


class TestQueryExecution:
    def test_cypher_endpoint_runs_the_query(self, client):
        context = make_context()
        response = client.post(
            f"/api/graph-contexts/{context.id}/cypher",
            headers=HEADERS,
            json={"query": "accounts linked to case 42"},
        )
        assert response.status_code == 200
        body = response.json()
        assert len(body["nodes"]) == 2
        assert len(body["edges"]) == 1
        assert body["transpiled_sql"] is None

    def test_expand_on_full_connection(self, client):
        context = make_context("fraud-api")
        response = client.post(
            f"/api/graph-contexts/{context.id}/expand",
            headers=HEADERS,
            json={"node_id": "a"},
        )
        assert response.status_code == 200

    def test_expand_on_query_only_connection_is_400(self, client):
        context = make_context("scores-api")
        response = client.post(
            f"/api/graph-contexts/{context.id}/expand",
            headers=HEADERS,
            json={"node_id": "a"},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"

    def test_subgraph_on_query_only_connection_is_400(self, client):
        context = make_context("scores-api")
        response = client.post(
            f"/api/graph-contexts/{context.id}/subgraph",
            headers=HEADERS,
            json={},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"

    def test_raw_sql_is_400(self, client):
        context = make_context()
        response = client.post(
            f"/api/graph-contexts/{context.id}/query",
            headers=HEADERS,
            json={"query": "SELECT 1"},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"

    def test_transpile_is_400(self, client):
        context = make_context()
        response = client.post(
            f"/api/graph-contexts/{context.id}/cypher/transpile",
            headers=HEADERS,
            json={"query": "anything"},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"

    def test_console_runs_inline(self, client):
        context = make_context()
        response = client.post(
            f"/api/graph-contexts/{context.id}/query/table",
            headers=HEADERS,
            json={"query": "all accounts", "mode": "cypher"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "succeeded"
        assert body["statement_id"] is None
        assert body["columns"][:2] == ["node_id", "label"]

    def test_console_sql_mode_is_400(self, client):
        context = make_context()
        response = client.post(
            f"/api/graph-contexts/{context.id}/query/table",
            headers=HEADERS,
            json={"query": "SELECT 1", "mode": "sql"},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"


# ── Discovery ────────────────────────────────────────────────────────────


class TestDiscovery:
    def test_discovery_via_declared_builder(self, client):
        response = client.post(
            "/api/schema-discovery",
            headers=HEADERS,
            json={"datasource_type": "rest", "datasource_name": "fraud-api"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["node_types"] == ["Person"]
        assert body["relationship_types"] == ["KNOWS"]

    def test_discovery_without_name_is_422(self, client):
        response = client.post(
            "/api/schema-discovery",
            headers=HEADERS,
            json={"datasource_type": "rest"},
        )
        assert response.status_code == 422

    def test_discovery_on_query_only_connection_is_400(self, client):
        response = client.post(
            "/api/schema-discovery",
            headers=HEADERS,
            json={"datasource_type": "rest", "datasource_name": "scores-api"},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_UNSUPPORTED_OPERATION"


# ── Orphaned contexts ────────────────────────────────────────────────────


class TestOrphanedContext:
    def test_query_after_connection_removed_is_400(self, client):
        context = make_context("fraud-api")
        # The connection disappears from the parent app's config...
        clear_rest_registry()
        reset_datasources()
        configure_datasources(Settings(dev_mode=True, database_enabled=False))

        response = client.post(
            f"/api/graph-contexts/{context.id}/cypher",
            headers=HEADERS,
            json={"query": "anything"},
        )
        assert response.status_code == 400
        assert error_code(response) == "DATASOURCE_NOT_CONFIGURED"
        details = response.json()["detail"]["error"]["details"]
        assert details["datasource_name"] == "fraud-api"
