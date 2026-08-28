"""Admin area API tests (memory mode).

Every ``/api/admin/*`` route inherits ``require_superuser`` from the router;
the parametrised test below walks the router so a new admin route is covered
without touching this file. Auth is faked by header, as in test_superuser.py.
"""

import sys

import pytest

# Stub gsql2rsql only when genuinely unavailable (see gotcha in test_superuser.py).
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
from fastapi.routing import APIRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware, configure_auth  # noqa: E402
from graphlagoon.routers import admin, explorations, graph, graph_contexts  # noqa: E402

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"
STRANGER = "stranger@example.com"
SECRET_TOKEN = "dapi-super-secret-token-value"


def _headers(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def superuser_env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", " Admin@Example.com ")
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_DATABRICKS_TOKEN", SECRET_TOKEN)
    monkeypatch.setenv("GRAPH_LAGOON_DATABASE_URL", "postgresql://u:pw@db/x")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


class _FakeWarehouse:
    async def clear_all_tables(self):
        return {"status": "cleared"}


@pytest.fixture
def client(superuser_env, store, monkeypatch):
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(admin.router)
    app.include_router(graph_contexts.router)
    app.include_router(explorations.router)
    app.include_router(graph.router)
    app.dependency_overrides[graph.get_warehouse] = lambda: _FakeWarehouse()
    monkeypatch.setattr(
        "graphlagoon.services.warehouse.get_warehouse_client", lambda: _FakeWarehouse()
    )
    yield TestClient(app)


@pytest.fixture
def context(store):
    return store.create_graph_context(
        title="ctx", edge_table_name="e", node_table_name="n", owner_email=OWNER
    )


@pytest.fixture
def exploration(store, context):
    return store.create_exploration(
        graph_context_id=context.id, title="exp", owner_email=OWNER, state={}
    )


def _admin_routes():
    return [r for r in admin.router.routes if isinstance(r, APIRoute)]


def _valid_request_for(route: APIRoute):
    """A well-formed request so validation (which runs before dependencies)
    cannot turn the expected 403 into a 422."""
    method = next(iter(route.methods))
    placeholder = "00000000-0000-0000-0000-000000000000"
    path = route.path.replace("{context_id}", placeholder).replace(
        "{exploration_id}", placeholder
    )
    body = None
    if path.endswith("/transfer"):
        body = {"new_owner_email": "x@example.com"}
    elif path.endswith("/environment/clear"):
        body = {"confirm": "CLEAR ALL"}
    return method, path, body


class TestGate:
    def test_router_level_dependency_present(self):
        from graphlagoon.utils.authz import require_superuser

        assert any(d.dependency is require_superuser for d in admin.router.dependencies)

    def test_expected_routes(self):
        found = sorted((next(iter(r.methods)), r.path) for r in _admin_routes())
        assert found == [
            ("GET", "/api/admin/audit"),
            ("GET", "/api/admin/config"),
            ("GET", "/api/admin/overview"),
            ("GET", "/api/admin/users"),
            ("POST", "/api/admin/contexts/{context_id}/transfer"),
            ("POST", "/api/admin/environment/clear"),
            ("POST", "/api/admin/explorations/{exploration_id}/transfer"),
            ("POST", "/api/admin/health/warehouse"),
        ]

    @pytest.mark.parametrize("route", _admin_routes(), ids=lambda r: r.path)
    def test_every_route_rejects_non_superuser(self, client, route):
        method, path, body = _valid_request_for(route)
        response = client.request(method, path, json=body, headers=_headers(STRANGER))
        assert response.status_code == 403, response.text
        assert response.json()["detail"]["error"]["code"] == "FORBIDDEN"

    @pytest.mark.parametrize("route", _admin_routes(), ids=lambda r: r.path)
    def test_every_route_rejects_anonymous_outside_dev(
        self, client, route, monkeypatch
    ):
        monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "false")
        get_settings.cache_clear()
        method, path, body = _valid_request_for(route)
        response = client.request(method, path, json=body)
        assert response.status_code == 403, response.text

    def test_admin_prefix_is_never_public(self):
        assert "/api/admin" not in AuthMiddleware.PUBLIC_PATHS
        assert not any(
            "/api/admin".startswith(p) or p.startswith("/api/admin")
            for p in AuthMiddleware.PUBLIC_PREFIXES
        )

    def test_user_provider_wins_over_forged_header(self, client):
        """A host app that configured its own provider must not be bypassed by
        a client-supplied X-Forwarded-Email (privilege escalation in mounted
        deployments without AuthMiddleware)."""
        configure_auth(lambda request: STRANGER)
        try:
            response = client.get("/api/admin/overview", headers=_headers(SUPERUSER))
            assert response.status_code == 403
        finally:
            configure_auth(None)

    def test_async_provider_is_honoured_by_middleware(self, client):
        async def provider(request):
            return STRANGER

        configure_auth(provider)
        try:
            response = client.get("/api/admin/overview", headers=_headers(SUPERUSER))
            assert response.status_code == 403
        finally:
            configure_auth(None)

    def test_async_provider_without_middleware_is_a_500(self, superuser_env, store):
        """Without AuthMiddleware a sync dependency cannot await the provider;
        that is a deployment error and must not silently fall back to the
        (forgeable) header."""
        app = FastAPI()
        app.include_router(admin.router)
        bare = TestClient(app)

        async def provider(request):
            return SUPERUSER

        configure_auth(provider)
        try:
            response = bare.get("/api/admin/overview", headers=_headers(SUPERUSER))
            assert response.status_code == 500
            assert response.json()["detail"]["error"]["code"] == "AUTH_MISCONFIGURED"
        finally:
            configure_auth(None)


class TestOverviewAndConfig:
    def test_overview_shape(self, client, store, context, exploration):
        response = client.get("/api/admin/overview", headers=_headers(SUPERUSER))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["persistence_backend"] == "memory"
        assert body["alembic_version"] is None
        assert body["dev_mode"] is True
        assert body["counts"]["contexts"] == 1
        assert body["counts"]["explorations"] == 1
        assert body["superusers"] == ["admin@example.com"]
        assert body["public_config"]["is_superuser"] is True
        assert "datasources" in body["public_config"]
        assert body["health"]["database"]["status"] == "memory"
        assert set(body["storage"]) == {
            "exploration_snapshots",
            "precomputed_graphs",
            "style_presets",
        }

    def test_config_never_leaks_secrets(self, client):
        response = client.get("/api/admin/config", headers=_headers(SUPERUSER))
        assert response.status_code == 200
        text = response.text
        assert SECRET_TOKEN not in text
        assert "pw@db" not in text
        entries = {e["key"]: e for e in response.json()}
        assert entries["databricks_token"] == {
            "key": "databricks_token",
            "env_var": "GRAPH_LAGOON_DATABRICKS_TOKEN",
            "value": "set",
            "kind": "secret",
        }
        assert entries["database_url"]["value"] == "set"
        assert entries["dev_mode"]["value"] is True
        assert entries["dev_mode"]["kind"] == "public"
        # hidden fields are omitted entirely
        assert "superuser_emails" not in entries

    def test_warehouse_probe_is_on_demand_and_bounded(self, client, monkeypatch):
        import httpx

        async def fake_get(self, url, headers=None):
            raise httpx.ConnectError("refused")

        monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
        response = client.post(
            "/api/admin/health/warehouse", headers=_headers(SUPERUSER)
        )
        assert response.status_code == 200
        assert response.json()["status"] == "error"


class TestUsers:
    def test_lists_known_users_with_counts_and_superuser_badge(
        self, client, store, context, exploration
    ):
        # A request registers its caller in memory mode (touch_user).
        client.get("/api/graph-contexts", headers=_headers(STRANGER))
        response = client.get("/api/admin/users", headers=_headers(SUPERUSER))
        assert response.status_code == 200
        body = response.json()
        by_email = {u["email"]: u for u in body["items"]}
        assert by_email[OWNER]["contexts_owned"] == 1
        assert by_email[OWNER]["explorations_owned"] == 1
        assert by_email[OWNER]["is_superuser"] is False
        assert by_email[SUPERUSER]["is_superuser"] is True
        assert by_email[STRANGER]["contexts_owned"] == 0
        assert body["total"] == len(body["items"])

    def test_search_and_pagination(self, client, store):
        for i in range(5):
            store.ensure_user(f"user{i}@example.com")
        response = client.get(
            "/api/admin/users",
            params={"q": "user", "page": 2, "page_size": 2},
            headers=_headers(SUPERUSER),
        )
        body = response.json()
        assert body["total"] >= 5
        assert len(body["items"]) == 2
        assert body["page"] == 2

    def test_page_size_capped(self, client):
        response = client.get(
            "/api/admin/users",
            params={"page_size": 10_000},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 422


class TestTransfer:
    def test_transfers_context_and_audits(self, client, store, context):
        store.share_graph_context(context.id, STRANGER, "read")
        response = client.post(
            f"/api/admin/contexts/{context.id}/transfer",
            json={"new_owner_email": STRANGER},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 200, response.text
        assert response.json()["previous_owner_email"] == OWNER
        assert response.json()["owner_email"] == STRANGER
        assert store.get_graph_context(context.id).owner_email == STRANGER
        # redundant share removed, new owner registered
        assert store.get_graph_context(context.id).shares == []
        assert STRANGER in store.users
        entry = store.usage_logs[-1]
        assert entry.action == "context.transfer"
        assert entry.user_email == SUPERUSER
        assert entry.log_metadata == {"from": OWNER, "to": STRANGER, "title": "ctx"}
        # the new owner now sees it as their own
        listing = client.get("/api/graph-contexts", headers=_headers(STRANGER)).json()
        assert [c["owner_email"] for c in listing] == [STRANGER]

    def test_transfers_exploration(self, client, store, exploration):
        response = client.post(
            f"/api/admin/explorations/{exploration.id}/transfer",
            json={"new_owner_email": STRANGER},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 200, response.text
        assert store.get_exploration(exploration.id).owner_email == STRANGER
        assert store.usage_logs[-1].action == "exploration.transfer"

    @pytest.mark.parametrize("bad", ["*", "*@example.com", "nope", "a b@c.d", " "])
    def test_rejects_wildcards_and_junk(self, client, context, bad):
        response = client.post(
            f"/api/admin/contexts/{context.id}/transfer",
            json={"new_owner_email": bad},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 422, response.text

    def test_404_for_unknown(self, client):
        response = client.post(
            "/api/admin/contexts/00000000-0000-0000-0000-000000000000/transfer",
            json={"new_owner_email": STRANGER},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 404


class TestAudit:
    def test_lists_newest_first_with_filters(self, client, store, context):
        client.post(
            f"/api/graph-contexts/{context.id}/share",
            json={"email": STRANGER, "permission": "read"},
            headers=_headers(OWNER),
        )
        client.delete(f"/api/graph-contexts/{context.id}", headers=_headers(OWNER))
        response = client.get("/api/admin/audit", headers=_headers(SUPERUSER))
        body = response.json()
        assert [e["action"] for e in body["items"]] == [
            "context.delete",
            "context.share",
        ]
        assert "context.transfer" in body["actions"]
        filtered = client.get(
            "/api/admin/audit",
            params={"action": "context.share"},
            headers=_headers(SUPERUSER),
        ).json()
        assert filtered["total"] == 1
        assert filtered["items"][0]["metadata"] == {
            "with": STRANGER,
            "permission": "read",
        }


class TestDangerZone:
    def test_requires_confirmation(self, client, context):
        response = client.post(
            "/api/admin/environment/clear",
            json={"confirm": "yes"},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 400
        assert response.json()["detail"]["error"]["code"] == "CONFIRMATION_REQUIRED"

    def test_refused_outside_dev_mode_even_for_superuser(
        self, client, context, monkeypatch
    ):
        monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "false")
        get_settings.cache_clear()
        response = client.post(
            "/api/admin/environment/clear",
            json={"confirm": "CLEAR ALL"},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 403

    def test_clears_but_keeps_audit(self, client, store, context, exploration):
        client.delete(f"/api/explorations/{exploration.id}", headers=_headers(OWNER))
        response = client.post(
            "/api/admin/environment/clear",
            json={"confirm": "CLEAR ALL"},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "cleared"
        assert store.graph_contexts == {} and store.explorations == {}
        actions = [e.action for e in store.usage_logs]
        assert actions == ["exploration.delete", "admin.clear_all"]

    def test_dev_clear_all_alias_now_requires_superuser(self, client, context):
        response = client.delete("/api/dev/clear-all", headers=_headers(OWNER))
        assert response.status_code == 403
        response = client.delete("/api/dev/clear-all", headers=_headers(SUPERUSER))
        assert response.status_code == 200
        assert response.json()["status"] == "cleared"


class TestLastSeen:
    def test_request_registers_user_and_last_seen(self, client, store):
        client.get("/api/graph-contexts", headers=_headers(STRANGER))
        user = store.users[STRANGER]
        assert user.last_seen_at is not None
