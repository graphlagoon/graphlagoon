"""Superuser permission tests (memory mode).

Superusers are configured via GRAPH_LAGOON_SUPERUSER_EMAILS and get full
read/write/delete/share access to all contexts, explorations, and query
templates. Regular users keep the default owner/share rules (regression
guarded here by STRANGER assertions).
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
    # Mixed case + whitespace on purpose: parsing must normalize.
    monkeypatch.setenv(
        "GRAPH_LAGOON_SUPERUSER_EMAILS", " Admin@Example.com , second@example.com "
    )
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from graphlagoon.routers import (
        config,
        explorations,
        graph_contexts,
        query_templates,
    )

    app = FastAPI()
    app.include_router(graph_contexts.router)
    app.include_router(explorations.router)
    app.include_router(query_templates.router)
    app.include_router(config.router)
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


@pytest.fixture
def private_template(store, context):
    return store.create_query_template(
        graph_context_id=context.id,
        owner_email=OWNER,
        name="private-tpl",
        query_type="cypher",
        query="MATCH (n) RETURN n",
        visibility="private",
    )


def _headers(email):
    return {"X-Forwarded-Email": email}


class TestSettings:
    def test_default_is_empty(self):
        get_settings.cache_clear()
        try:
            assert get_settings().superuser_email_list == []
        finally:
            get_settings.cache_clear()

    def test_parsing_normalizes_case_and_whitespace(self, superuser_env):
        assert get_settings().superuser_email_list == [
            "admin@example.com",
            "second@example.com",
        ]

    def test_is_superuser(self, superuser_env):
        from graphlagoon.utils.authz import is_superuser

        assert is_superuser(SUPERUSER) is True
        assert is_superuser("ADMIN@EXAMPLE.COM") is True
        assert is_superuser(OWNER) is False
        assert is_superuser("") is False


class TestContexts:
    def test_superuser_lists_unowned_contexts(self, superuser_env, client, context):
        resp = client.get("/api/graph-contexts", headers=_headers(SUPERUSER))
        assert resp.status_code == 200
        items = resp.json()
        assert [i["id"] for i in items] == [str(context.id)]
        assert items[0]["has_write_access"] is True

    def test_stranger_lists_nothing(self, superuser_env, client, context):
        resp = client.get("/api/graph-contexts", headers=_headers(STRANGER))
        assert resp.status_code == 200
        assert resp.json() == []

    def test_superuser_updates_unowned_context(self, superuser_env, client, context):
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"title": "renamed"},
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200
        assert resp.json()["title"] == "renamed"

    def test_stranger_cannot_update(self, superuser_env, client, context):
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"title": "hax"},
            headers=_headers(STRANGER),
        )
        assert resp.status_code == 403

    def test_superuser_shares_and_unshares_unowned_context(
        self, superuser_env, client, context
    ):
        resp = client.post(
            f"/api/graph-contexts/{context.id}/share",
            json={"email": "friend@example.com", "permission": "read"},
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200
        resp = client.delete(
            f"/api/graph-contexts/{context.id}/share/friend@example.com",
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200

    def test_superuser_share_still_validates_wildcard_domain(
        self, superuser_env, client, context
    ):
        resp = client.post(
            f"/api/graph-contexts/{context.id}/share",
            json={"email": "*@notallowed.com", "permission": "read"},
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 400

    def test_superuser_deletes_unowned_context(self, superuser_env, client, context):
        resp = client.delete(
            f"/api/graph-contexts/{context.id}", headers=_headers(SUPERUSER)
        )
        assert resp.status_code == 200

    def test_stranger_cannot_delete(self, superuser_env, client, context):
        resp = client.delete(
            f"/api/graph-contexts/{context.id}", headers=_headers(STRANGER)
        )
        assert resp.status_code == 403


class TestExplorations:
    def test_superuser_lists_all_explorations(self, superuser_env, client, exploration):
        resp = client.get("/api/explorations", headers=_headers(SUPERUSER))
        assert resp.status_code == 200
        items = resp.json()
        assert [i["id"] for i in items] == [str(exploration.id)]
        assert items[0]["has_write_access"] is True

    def test_stranger_lists_nothing(self, superuser_env, client, exploration):
        resp = client.get("/api/explorations", headers=_headers(STRANGER))
        assert resp.status_code == 200
        assert resp.json() == []

    def test_superuser_gets_unowned_exploration(
        self, superuser_env, client, exploration
    ):
        resp = client.get(
            f"/api/explorations/{exploration.id}", headers=_headers(SUPERUSER)
        )
        assert resp.status_code == 200

    def test_stranger_cannot_get(self, superuser_env, client, exploration):
        resp = client.get(
            f"/api/explorations/{exploration.id}", headers=_headers(STRANGER)
        )
        assert resp.status_code == 403

    def test_superuser_lists_explorations_in_unowned_context(
        self, superuser_env, client, context, exploration
    ):
        resp = client.get(
            f"/api/graph-contexts/{context.id}/explorations",
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    def test_superuser_creates_exploration_in_unowned_context(
        self, superuser_env, client, context
    ):
        resp = client.post(
            f"/api/graph-contexts/{context.id}/explorations",
            json={"title": "by-admin", "state": {}},
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200
        assert resp.json()["owner_email"] == SUPERUSER

    def test_superuser_updates_unowned_exploration(
        self, superuser_env, client, exploration
    ):
        resp = client.put(
            f"/api/explorations/{exploration.id}",
            json={"title": "renamed"},
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200
        assert resp.json()["title"] == "renamed"

    def test_superuser_shares_unowned_exploration(
        self, superuser_env, client, exploration
    ):
        resp = client.post(
            f"/api/explorations/{exploration.id}/share",
            json={"email": "friend@example.com", "permission": "write"},
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200
        resp = client.delete(
            f"/api/explorations/{exploration.id}/share/friend@example.com",
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200

    def test_superuser_deletes_unowned_exploration(
        self, superuser_env, client, exploration
    ):
        resp = client.delete(
            f"/api/explorations/{exploration.id}", headers=_headers(SUPERUSER)
        )
        assert resp.status_code == 200

    def test_stranger_cannot_delete(self, superuser_env, client, exploration):
        resp = client.delete(
            f"/api/explorations/{exploration.id}", headers=_headers(STRANGER)
        )
        assert resp.status_code == 403


class TestQueryTemplates:
    def _url(self, context, template_id=None):
        base = f"/api/graph-contexts/{context.id}/query-templates"
        return f"{base}/{template_id}" if template_id else base

    def test_superuser_lists_others_private_templates(
        self, superuser_env, client, context, private_template
    ):
        resp = client.get(self._url(context), headers=_headers(SUPERUSER))
        assert resp.status_code == 200
        assert [t["id"] for t in resp.json()] == [str(private_template.id)]

    def test_owner_private_template_hidden_from_stranger_with_access(
        self, superuser_env, client, store, context, private_template
    ):
        # Give STRANGER read access so listing succeeds, then check the
        # private template stays hidden for non-superusers.
        store.share_graph_context(context.id, STRANGER, permission="read")
        resp = client.get(self._url(context), headers=_headers(STRANGER))
        assert resp.status_code == 200
        assert resp.json() == []

    def test_superuser_updates_others_private_template(
        self, superuser_env, client, context, private_template
    ):
        resp = client.put(
            self._url(context, private_template.id),
            json={"name": "renamed"},
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "renamed"

    def test_superuser_changes_visibility_of_others_template(
        self, superuser_env, client, context, private_template
    ):
        resp = client.put(
            self._url(context, private_template.id),
            json={"visibility": "shared"},
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 200
        assert resp.json()["visibility"] == "shared"

    def test_superuser_creates_shared_template_in_unowned_context(
        self, superuser_env, client, context
    ):
        resp = client.post(
            self._url(context),
            json={
                "name": "admin-tpl",
                "query_type": "cypher",
                "query": "MATCH (n) RETURN n",
                "visibility": "shared",
            },
            headers=_headers(SUPERUSER),
        )
        assert resp.status_code == 201

    def test_superuser_deletes_others_private_template(
        self, superuser_env, client, context, private_template
    ):
        resp = client.delete(
            self._url(context, private_template.id), headers=_headers(SUPERUSER)
        )
        assert resp.status_code == 200


class TestConfigEndpoint:
    def test_superuser_flag_true(self, superuser_env, client, store):
        resp = client.get("/api/config", headers=_headers(SUPERUSER))
        assert resp.status_code == 200
        assert resp.json()["is_superuser"] is True

    def test_superuser_flag_case_insensitive(self, superuser_env, client, store):
        resp = client.get("/api/config", headers=_headers("ADMIN@EXAMPLE.COM"))
        assert resp.json()["is_superuser"] is True

    def test_regular_user_flag_false(self, superuser_env, client, store):
        resp = client.get("/api/config", headers=_headers(OWNER))
        assert resp.json()["is_superuser"] is False
