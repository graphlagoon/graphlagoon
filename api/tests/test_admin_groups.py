"""Admin API for groups & permissions (memory-store path).

Mirrors test_admin.py's structure: a superuser fixture, a bare app with
AuthMiddleware, and a gate walk asserting every route on the admin_groups
router 403s for non-superusers (the router is a sibling of admin.router
because FastAPI 0.139's lazy nested includes hide routes from
introspection — so it carries, and must keep, its own require_superuser
router dependency).
"""

import sys

import pytest

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
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.routers import admin, admin_groups  # noqa: E402
from graphlagoon.services.group_resolution import (  # noqa: E402
    StubGroupResolver,
    set_group_resolver,
)

SUPERUSER = "admin@example.com"
STRANGER = "stranger@example.com"


def _headers(email):
    return {"X-Forwarded-Email": email}


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
    app.include_router(admin.router)
    app.include_router(admin_groups.router)
    yield TestClient(app)


def _create_group(client, name="builders", members=None):
    response = client.post(
        "/api/admin/groups",
        json={"name": name, "members": members or []},
        headers=_headers(SUPERUSER),
    )
    assert response.status_code == 201, response.text
    return response.json()


class TestGate:
    def test_router_level_dependency_present(self):
        from graphlagoon.utils.authz import require_superuser

        assert any(
            d.dependency is require_superuser
            for d in admin_groups.router.dependencies
        )

    def _valid_request_for(self, route: APIRoute):
        method = next(iter(route.methods))
        placeholder = "00000000-0000-0000-0000-000000000000"
        path = route.path.replace("{group_id}", placeholder).replace(
            "{permission_id}", "context.create"
        )
        body = None
        if path.endswith("/groups/resolution/refresh"):
            body = {}
        elif "/groups" in path and method in {"POST", "PUT"}:
            body = {"name": "g"}
        elif "/permissions/" in path and method == "PUT":
            body = {"mode": "everyone", "rules": []}
        elif path.endswith("/permissions/inspect"):
            path = f"{path}?email=x@example.com"
        return method, path, body

    @pytest.mark.parametrize(
        "route",
        [r for r in admin_groups.router.routes if isinstance(r, APIRoute)],
        ids=lambda r: f"{next(iter(r.methods))}-{r.path}",
    )
    def test_every_route_rejects_non_superuser(self, client, route):
        method, path, body = self._valid_request_for(route)
        response = client.request(
            method, path, json=body, headers=_headers(STRANGER)
        )
        assert response.status_code == 403, response.text
        assert response.json()["detail"]["error"]["code"] == "FORBIDDEN"


class TestGroupCrud:
    def test_round_trip_normalizes_members(self, client):
        group = _create_group(
            client,
            members=[
                {"kind": "email", "value": "  Bob@X.Com "},
                {"kind": "databricks_group", "value": "Data-Analysts"},
                {"kind": "email", "value": "bob@x.com"},  # duplicate after casefold
            ],
        )
        assert [m["value"] for m in group["members"]] == [
            "bob@x.com",
            "data-analysts",
        ]
        listing = client.get("/api/admin/groups", headers=_headers(SUPERUSER)).json()
        assert [g["name"] for g in listing["items"]] == ["builders"]
        assert listing["resolver"]["mode"] == "stub"

    def test_duplicate_name_rejected(self, client):
        _create_group(client)
        response = client.post(
            "/api/admin/groups",
            json={"name": "builders"},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 400
        assert response.json()["detail"]["error"]["code"] == "GROUP_NAME_TAKEN"

    def test_invalid_email_member_rejected(self, client):
        response = client.post(
            "/api/admin/groups",
            json={
                "name": "g",
                "members": [{"kind": "email", "value": "not-an-email"}],
            },
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 400
        assert response.json()["detail"]["error"]["code"] == "INVALID_MEMBER"

    def test_update_replaces_members(self, client):
        group = _create_group(
            client, members=[{"kind": "email", "value": "a@x.co"}]
        )
        response = client.put(
            f"/api/admin/groups/{group['id']}",
            json={
                "name": "renamed",
                "members": [{"kind": "email", "value": "b@x.co"}],
            },
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 200
        updated = response.json()
        assert updated["name"] == "renamed"
        assert [m["value"] for m in updated["members"]] == ["b@x.co"]

    def test_delete_cascades_rules(self, client):
        group = _create_group(client)
        client.put(
            "/api/admin/permissions/context.create",
            json={
                "mode": "restricted",
                "rules": [{"group_id": group["id"], "effect": "allow"}],
            },
            headers=_headers(SUPERUSER),
        )
        assert (
            client.delete(
                f"/api/admin/groups/{group['id']}", headers=_headers(SUPERUSER)
            ).status_code
            == 200
        )
        perms = client.get(
            "/api/admin/permissions", headers=_headers(SUPERUSER)
        ).json()
        entry = next(p for p in perms["items"] if p["id"] == "context.create")
        assert entry["rules"] == []

    def test_unknown_group_404(self, client):
        response = client.delete(
            "/api/admin/groups/00000000-0000-0000-0000-000000000000",
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 404
        assert response.json()["detail"]["error"]["code"] == "GROUP_NOT_FOUND"


class TestPermissions:
    def test_catalog_renders_with_defaults(self, client):
        payload = client.get(
            "/api/admin/permissions", headers=_headers(SUPERUSER)
        ).json()
        assert [p["id"] for p in payload["items"]] == [
            "context.create",
            "exploration.save",
        ]
        assert all(p["mode"] == "everyone" and p["rules"] == [] for p in payload["items"])
        assert all(p["label"] and p["description"] for p in payload["items"])

    def test_put_round_trip_with_group_name(self, client):
        group = _create_group(client)
        response = client.put(
            "/api/admin/permissions/context.create",
            json={
                "mode": "restricted",
                "rules": [{"group_id": group["id"], "effect": "allow"}],
            },
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 200, response.text
        entry = response.json()
        assert entry["mode"] == "restricted"
        assert entry["rules"] == [
            {
                "group_id": group["id"],
                "group_name": "builders",
                "effect": "allow",
            }
        ]

    def test_unknown_permission_404(self, client):
        response = client.put(
            "/api/admin/permissions/nope.nope",
            json={"mode": "everyone", "rules": []},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 404
        assert response.json()["detail"]["error"]["code"] == "PERMISSION_UNKNOWN"

    def test_rule_referencing_missing_group_400(self, client):
        response = client.put(
            "/api/admin/permissions/context.create",
            json={
                "mode": "restricted",
                "rules": [
                    {
                        "group_id": "00000000-0000-0000-0000-000000000000",
                        "effect": "allow",
                    }
                ],
            },
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 400
        assert response.json()["detail"]["error"]["code"] == "GROUP_NOT_FOUND"


class TestAuditTrail:
    def test_all_four_mutations_are_recorded(self, client):
        group = _create_group(client)
        client.put(
            f"/api/admin/groups/{group['id']}",
            json={"name": "renamed"},
            headers=_headers(SUPERUSER),
        )
        client.put(
            "/api/admin/permissions/context.create",
            json={"mode": "everyone", "rules": []},
            headers=_headers(SUPERUSER),
        )
        client.delete(
            f"/api/admin/groups/{group['id']}", headers=_headers(SUPERUSER)
        )
        entries = client.get(
            "/api/admin/audit", headers=_headers(SUPERUSER)
        ).json()["items"]
        actions = [e["action"] for e in entries]
        for expected in (
            "group.create",
            "group.update",
            "permission.update",
            "group.delete",
        ):
            assert expected in actions, actions


class TestInspector:
    def test_reports_reason_and_matched_group(self, client):
        group = _create_group(
            client, members=[{"kind": "email", "value": "member@x.co"}]
        )
        client.put(
            "/api/admin/permissions/context.create",
            json={
                "mode": "restricted",
                "rules": [{"group_id": group["id"], "effect": "allow"}],
            },
            headers=_headers(SUPERUSER),
        )
        outsider = client.get(
            "/api/admin/permissions/inspect?email=out@x.co",
            headers=_headers(SUPERUSER),
        ).json()
        entry = next(
            p for p in outsider["permissions"] if p["id"] == "context.create"
        )
        assert entry["allowed"] is False
        assert entry["reason"] == "restricted_no_match"

        member = client.get(
            "/api/admin/permissions/inspect?email=member@x.co",
            headers=_headers(SUPERUSER),
        ).json()
        entry = next(
            p for p in member["permissions"] if p["id"] == "context.create"
        )
        assert entry["allowed"] is True
        assert entry["matched"]["group_name"] == "builders"
        assert member["group_memberships"][0]["via"] == "email"

    def test_databricks_resolution_surfaces(self, client):
        _create_group(
            client,
            name="dbx",
            members=[{"kind": "databricks_group", "value": "eng"}],
        )
        set_group_resolver(StubGroupResolver({"dev@x.co": frozenset({"eng"})}))
        report = client.get(
            "/api/admin/permissions/inspect?email=dev@x.co",
            headers=_headers(SUPERUSER),
        ).json()
        assert report["resolved_databricks_groups"] == ["eng"]
        assert report["group_memberships"][0]["via"] == "databricks:eng"


class TestResolverEndpoints:
    def test_refresh_returns_status(self, client):
        response = client.post(
            "/api/admin/groups/resolution/refresh",
            json={},
            headers=_headers(SUPERUSER),
        )
        assert response.status_code == 200
        assert response.json()["mode"] == "stub"

    def test_overview_counts_groups(self, client):
        _create_group(client)
        overview = client.get(
            "/api/admin/overview", headers=_headers(SUPERUSER)
        ).json()
        assert overview["counts"]["groups"] == 1
