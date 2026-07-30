"""Public sharing ("*" sentinel) tests (memory mode).

A share row with shared_with_email == "*" makes a context/exploration
visible to every authenticated user, always read-only. Only the owner or
a superuser can publish/unpublish.
"""

import sys

import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and break
# test_transpile_options.
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

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"
STRANGER = "stranger@example.com"


@pytest.fixture
def superuser_env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from graphlagoon.routers import explorations, graph_contexts

    app = FastAPI()
    app.include_router(graph_contexts.router)
    app.include_router(explorations.router)
    yield TestClient(app)


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def context(store):
    """A context owned by OWNER with no shares at all."""
    return store.create_graph_context(
        title="ctx",
        edge_table_name="e",
        node_table_name="n",
        owner_email=OWNER,
    )


@pytest.fixture
def exploration(store, context):
    return store.create_exploration(
        graph_context_id=context.id, title="exp", owner_email=OWNER, state={}
    )


def _headers(email):
    return {"X-Forwarded-Email": email}


def _publish_context(client, context, as_email=OWNER, permission="read"):
    return client.post(
        f"/api/graph-contexts/{context.id}/share",
        json={"email": "*", "permission": permission},
        headers=_headers(as_email),
    )


class TestPublicContext:
    def test_owner_publishes_stranger_sees_read_only(self, client, context):
        resp = _publish_context(client, context, permission="write")
        assert resp.status_code == 200

        resp = client.get("/api/graph-contexts", headers=_headers(STRANGER))
        assert resp.status_code == 200
        items = resp.json()
        assert [i["id"] for i in items] == [str(context.id)]
        # Public is always read-only, even though "write" was requested
        assert items[0]["has_write_access"] is False
        assert "*" in items[0]["shared_with"]

    def test_stranger_cannot_update_public_context(self, client, context):
        _publish_context(client, context)
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"title": "hax"},
            headers=_headers(STRANGER),
        )
        assert resp.status_code == 403

    def test_stranger_cannot_delete_public_context(self, client, context):
        _publish_context(client, context)
        resp = client.delete(
            f"/api/graph-contexts/{context.id}", headers=_headers(STRANGER)
        )
        assert resp.status_code == 403

    def test_stranger_cannot_publish(self, client, context):
        resp = _publish_context(client, context, as_email=STRANGER)
        assert resp.status_code == 403

    def test_unpublish_via_literal_asterisk_path(self, client, context):
        """Regression: "*" as a raw path segment in DELETE .../share/*."""
        _publish_context(client, context)

        resp = client.delete(
            f"/api/graph-contexts/{context.id}/share/*",
            headers=_headers(OWNER),
        )
        assert resp.status_code == 200

        resp = client.get("/api/graph-contexts", headers=_headers(STRANGER))
        assert resp.json() == []

    def test_exact_write_share_survives_public_read(self, client, context):
        """A user with an exact write share keeps write on a public item."""
        client.post(
            f"/api/graph-contexts/{context.id}/share",
            json={"email": STRANGER, "permission": "write"},
            headers=_headers(OWNER),
        )
        _publish_context(client, context)

        resp = client.get("/api/graph-contexts", headers=_headers(STRANGER))
        assert resp.json()[0]["has_write_access"] is True


class TestPublicExploration:
    def _publish_exploration(self, client, exploration, as_email=OWNER):
        return client.post(
            f"/api/explorations/{exploration.id}/share",
            json={"email": "*", "permission": "write"},
            headers=_headers(as_email),
        )

    def test_owner_publishes_stranger_sees_read_only(self, client, exploration):
        resp = self._publish_exploration(client, exploration)
        assert resp.status_code == 200

        resp = client.get("/api/explorations", headers=_headers(STRANGER))
        assert resp.status_code == 200
        items = resp.json()
        assert [i["id"] for i in items] == [str(exploration.id)]
        assert items[0]["has_write_access"] is False

        resp = client.get(
            f"/api/explorations/{exploration.id}", headers=_headers(STRANGER)
        )
        assert resp.status_code == 200

    def test_stranger_cannot_update_public_exploration(self, client, exploration):
        self._publish_exploration(client, exploration)
        resp = client.put(
            f"/api/explorations/{exploration.id}",
            json={"title": "hax"},
            headers=_headers(STRANGER),
        )
        assert resp.status_code == 403

    def test_stranger_cannot_publish(self, client, exploration):
        resp = self._publish_exploration(client, exploration, as_email=STRANGER)
        assert resp.status_code == 403

    def test_unpublish_via_literal_asterisk_path(self, client, exploration):
        self._publish_exploration(client, exploration)

        resp = client.delete(
            f"/api/explorations/{exploration.id}/share/*",
            headers=_headers(OWNER),
        )
        assert resp.status_code == 200

        resp = client.get("/api/explorations", headers=_headers(STRANGER))
        assert resp.json() == []

    def test_public_exploration_reveals_parent_context(self, client, exploration):
        """Exploration-level shares grant parent-context visibility — public
        shares follow the same rule as per-user/domain shares."""
        self._publish_exploration(client, exploration)

        resp = client.get("/api/graph-contexts", headers=_headers(STRANGER))
        assert resp.status_code == 200
        ids = [i["id"] for i in resp.json()]
        assert str(exploration.graph_context_id) in ids


class TestSuperuserPublicSharing:
    def test_superuser_publishes_and_unpublishes_unowned_context(
        self, superuser_env, client, context
    ):
        resp = _publish_context(client, context, as_email=SUPERUSER)
        assert resp.status_code == 200

        resp = client.get("/api/graph-contexts", headers=_headers(STRANGER))
        assert len(resp.json()) == 1

        resp = client.delete(
            f"/api/graph-contexts/{context.id}/share/*",
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200

        resp = client.get("/api/graph-contexts", headers=_headers(STRANGER))
        assert resp.json() == []
