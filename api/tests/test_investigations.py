"""Investigation CRUD, access and nominal sharing (F1.2), memory-store path."""

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
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.routers import investigations  # noqa: E402

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"
ASSIGNEE = "assignee@example.com"
READER = "reader@example.com"
WRITER = "writer@example.com"
OUTSIDER = "outsider@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()
    get_settings.cache_clear()


@pytest.fixture
def client(store):
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(investigations.router)
    return TestClient(app)


@pytest.fixture
def case(client):
    r = client.post(
        "/api/investigations",
        json={"title": "Golpe Pix 123", "assignee_email": ASSIGNEE},
        headers=h(OWNER),
    )
    assert r.status_code == 201, r.text
    inv = r.json()
    for email, perm in ((READER, "read"), (WRITER, "write")):
        r = client.post(
            f"/api/investigations/{inv['id']}/share",
            json={"email": email, "permission": perm},
            headers=h(OWNER),
        )
        assert r.status_code == 200, r.text
    return inv


def test_create_defaults(case):
    assert case["status"] == "selecao"
    assert case["owner_email"] == OWNER
    assert case["can_manage"] and case["has_write_access"]


@pytest.mark.parametrize("who", [OWNER, ASSIGNEE, READER, WRITER, SUPERUSER])
def test_visible_to_owner_assignee_shares_and_superuser(client, case, who):
    assert (
        client.get(f"/api/investigations/{case['id']}", headers=h(who)).status_code
        == 200
    )
    ids = [i["id"] for i in client.get("/api/investigations", headers=h(who)).json()]
    assert ids == [case["id"]]


def test_outsider_gets_404_and_empty_list(client, case):
    r = client.get(f"/api/investigations/{case['id']}", headers=h(OUTSIDER))
    assert r.status_code == 404
    assert r.json()["detail"]["error"]["code"] == "INVESTIGATION_NOT_FOUND"
    assert client.get("/api/investigations", headers=h(OUTSIDER)).json() == []
    r = client.patch(
        f"/api/investigations/{case['id']}", json={"title": "x"}, headers=h(OUTSIDER)
    )
    assert r.status_code == 404


def test_patch_needs_write(client, case):
    url = f"/api/investigations/{case['id']}"
    assert client.patch(url, json={"title": "r"}, headers=h(READER)).status_code == 403
    r = client.patch(url, json={"status": "analise", "title": None}, headers=h(WRITER))
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["title"]) == ("analise", "Golpe Pix 123")
    assert (
        client.patch(url, json={"status": "decidido"}, headers=h(OWNER)).status_code
        == 422
    )


@pytest.mark.parametrize("email", ["*", "*@example.com"])
def test_wildcard_share_refused(client, case, email):
    r = client.post(
        f"/api/investigations/{case['id']}/share",
        json={"email": email},
        headers=h(OWNER),
    )
    assert r.status_code == 422
    assert "tipping-off" in r.json()["detail"]["error"]["message"]


def test_only_owner_shares_and_deletes(client, case):
    url = f"/api/investigations/{case['id']}"
    assert (
        client.post(
            f"{url}/share", json={"email": "x@example.com"}, headers=h(WRITER)
        ).status_code
        == 403
    )
    assert client.delete(url, headers=h(WRITER)).status_code == 403
    assert client.delete(f"{url}/share/{READER}", headers=h(OWNER)).status_code == 200
    assert client.get(url, headers=h(READER)).status_code == 404
    assert client.delete(url, headers=h(OWNER)).status_code == 200
    assert client.get(url, headers=h(OWNER)).status_code == 404


def test_decided_case_is_retained(client, store, case):
    from uuid import UUID

    store.update_investigation(UUID(case["id"]), decision={"outcome": "arquivar"})
    url = f"/api/investigations/{case['id']}"
    assert client.patch(url, json={"title": "x"}, headers=h(OWNER)).status_code == 409
    assert client.delete(url, headers=h(OWNER)).status_code == 409
    assert client.delete(url, headers=h(SUPERUSER)).status_code == 409
    assert (
        client.delete(f"{url}?reason=duplicado", headers=h(SUPERUSER)).status_code
        == 200
    )


def test_mutations_are_audited(client, store, case):
    client.patch(
        f"/api/investigations/{case['id']}", json={"title": "y"}, headers=h(OWNER)
    )
    actions = [e.action for e in store.usage_logs]
    assert actions == [
        "investigation.create",
        "investigation.share",
        "investigation.share",
        "investigation.update",
    ]
