"""Route-level enforcement of the permission catalog (memory-store path).

The evaluation core is covered in test_permissions.py; here the concern is
the FastAPI wiring: gated routes 403 with PERMISSION_DENIED, ungated flows
keep working in the default posture, and /api/config carries the effective
permission list.
"""

import sys

import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and
# break test_transpile_options.
try:
    import gsql2rsql  # noqa: F401
except ImportError:
    from unittest.mock import MagicMock as _MagicMock

    for _name in (
        "gsql2rsql",
        "gsql2rsql.parser",
        "gsql2rsql.parser.opencypher_parser",
        "gsql2rsql.planner",
        "gsql2rsql.planner.logical_plan",
        "gsql2rsql.planner.subquery_flattening",
        "gsql2rsql.planner.pass_manager",
        "gsql2rsql.renderer",
        "gsql2rsql.renderer.sql_renderer",
        "gsql2rsql.renderer.schema_provider",
        "gsql2rsql.common",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.routers import config, explorations, graph_contexts  # noqa: E402
from graphlagoon.services.group_resolution import (  # noqa: E402
    StubGroupResolver,
    set_group_resolver,
)

SUPERUSER = "admin@example.com"
MEMBER = "member@example.com"
OUTSIDER = "outsider@example.com"


def _headers(email):
    return {"X-Forwarded-Email": email}


class _UnreachableWarehouse:
    """Table validation skips unreachable warehouses (documented behavior in
    test_context_table_validation) — exactly what these tests want."""

    async def get_table_schema(self, table, database=None, catalog=None):
        raise Exception("connection refused")


@pytest.fixture
def superuser_env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def store():
    InMemoryStore.reset()
    set_group_resolver(StubGroupResolver())
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()
    set_group_resolver(StubGroupResolver())


@pytest.fixture
def client(superuser_env, store):
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(graph_contexts.router)
    app.include_router(explorations.router)
    app.include_router(config.router)
    app.dependency_overrides[graph_contexts.get_warehouse] = (
        lambda: _UnreachableWarehouse()
    )
    yield TestClient(app)


CONTEXT_PAYLOAD = {
    "title": "ctx",
    "edge_table_name": "db.edges",
    "node_table_name": "db.nodes",
}


def _restrict_context_create_to(store, *emails) -> None:
    group = store.create_group(
        "builders", members=[{"kind": "email", "value": e} for e in emails]
    )
    store.set_permission(
        "context.create", "restricted", [{"group_id": group.id, "effect": "allow"}]
    )
    return group


class TestDefaultPosture:
    def test_anyone_can_create_context_with_no_rules(self, client):
        response = client.post(
            "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(OUTSIDER)
        )
        assert response.status_code == 200, response.text

    def test_anyone_can_save_exploration_with_no_rules(self, client, store):
        context = store.create_graph_context("t", "e", "n", OUTSIDER)
        response = client.post(
            f"/api/graph-contexts/{context.id}/explorations",
            json={"title": "x", "state": {}},
            headers=_headers(OUTSIDER),
        )
        assert response.status_code == 200, response.text


class TestRestrictedCreate:
    def test_member_can_create(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        response = client.post(
            "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(MEMBER)
        )
        assert response.status_code == 200, response.text

    def test_outsider_gets_permission_denied(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        response = client.post(
            "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(OUTSIDER)
        )
        assert response.status_code == 403
        error = response.json()["detail"]["error"]
        assert error["code"] == "PERMISSION_DENIED"
        assert error["details"]["permission"] == "context.create"
        assert error["details"]["reason"] == "restricted_no_match"
        assert "Create graph contexts" in error["message"]

    def test_superuser_bypasses(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        response = client.post(
            "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(SUPERUSER)
        )
        assert response.status_code == 200, response.text

    def test_databricks_group_member_can_create(self, client, store):
        group = store.create_group(
            "dbx-builders",
            members=[{"kind": "databricks_group", "value": "data-analysts"}],
        )
        store.set_permission(
            "context.create", "restricted", [{"group_id": group.id, "effect": "allow"}]
        )
        set_group_resolver(
            StubGroupResolver({MEMBER: frozenset({"data-analysts"})})
        )
        assert (
            client.post(
                "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(MEMBER)
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/graph-contexts", json=CONTEXT_PAYLOAD, headers=_headers(OUTSIDER)
            ).status_code
            == 403
        )


class TestDenyExplorationSave:
    @pytest.fixture
    def denied(self, store):
        group = store.create_group(
            "banned", members=[{"kind": "email", "value": MEMBER}]
        )
        store.set_permission(
            "exploration.save", "everyone", [{"group_id": group.id, "effect": "deny"}]
        )
        return group

    def test_deny_beats_everyone_mode_on_create(self, client, store, denied):
        context = store.create_graph_context("t", "e", "n", MEMBER)
        response = client.post(
            f"/api/graph-contexts/{context.id}/explorations",
            json={"title": "x", "state": {}},
            headers=_headers(MEMBER),
        )
        assert response.status_code == 403
        error = response.json()["detail"]["error"]
        assert error["details"] == {
            "permission": "exploration.save",
            "reason": "deny_rule",
        }

    def test_deny_applies_to_update_even_for_the_owner(self, client, store, denied):
        context = store.create_graph_context("t", "e", "n", MEMBER)
        exploration = store.create_exploration(context.id, "x", MEMBER, {})
        response = client.put(
            f"/api/explorations/{exploration.id}",
            json={"title": "renamed"},
            headers=_headers(MEMBER),
        )
        assert response.status_code == 403
        assert (
            response.json()["detail"]["error"]["code"] == "PERMISSION_DENIED"
        )

    def test_others_still_save(self, client, store, denied):
        context = store.create_graph_context("t", "e", "n", OUTSIDER)
        response = client.post(
            f"/api/graph-contexts/{context.id}/explorations",
            json={"title": "x", "state": {}},
            headers=_headers(OUTSIDER),
        )
        assert response.status_code == 200, response.text


class TestConfigCarriesPermissions:
    def test_superuser_gets_full_catalog(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        payload = client.get("/api/config", headers=_headers(SUPERUSER)).json()
        assert payload["permissions"] == ["context.create", "exploration.save"]

    def test_restricted_outsider_lacks_the_id(self, client, store):
        _restrict_context_create_to(store, MEMBER)
        payload = client.get("/api/config", headers=_headers(OUTSIDER)).json()
        assert payload["permissions"] == ["exploration.save"]
        member_payload = client.get("/api/config", headers=_headers(MEMBER)).json()
        assert member_payload["permissions"] == [
            "context.create",
            "exploration.save",
        ]
