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


def test_deadlines_selection_then_analysis_with_an_injected_clock(client, store, case, monkeypatch):
    """F4.4: 45 days to select from creation, 45 to analyse from selected_at."""
    from datetime import datetime, timedelta
    from uuid import UUID

    from graphlagoon.services import investigations as service

    created = datetime(2026, 9, 1, 10, 0)
    store.update_investigation(UUID(case["id"]), created_at=created)
    clock = {"now": created + timedelta(days=40, hours=1)}
    monkeypatch.setattr(service, "_clock", lambda: clock["now"])

    got = client.get(f"/api/investigations/{case['id']}", headers=h(OWNER)).json()["deadline"]
    assert got["phase"] == "selection" and got["days_left"] == 5  # under 7: orange in the queue
    assert got["due_at"].startswith("2026-10-16T10:00")

    r = client.patch(f"/api/investigations/{case['id']}", json={"status": "analise"}, headers=h(OWNER))
    assert r.json()["selected_at"].startswith("2026-10-11T11:00")
    assert r.json()["deadline"]["phase"] == "analysis" and r.json()["deadline"]["days_left"] == 45

    clock["now"] += timedelta(days=50)  # overdue counts below zero
    [row] = client.get("/api/investigations", headers=h(OWNER)).json()
    assert row["deadline"]["days_left"] == -5

    r = client.patch(f"/api/investigations/{case['id']}", json={"status": "arquivado"}, headers=h(OWNER))
    assert r.json()["deadline"] is None


def test_status_transitions_are_explicit(client, case):
    """F1 (05 §3): selecao → analise → arquivado; a sideways jump answers 409."""
    url = f"/api/investigations/{case['id']}"
    r = client.patch(url, json={"status": "arquivado"}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["status"] == "arquivado"
    r = client.patch(url, json={"status": "selecao"}, headers=h(OWNER))
    assert r.status_code == 409
    assert r.json()["detail"]["error"]["code"] == "INVALID_STATUS_TRANSITION"
    assert client.patch(url, json={"status": "analise"}, headers=h(OWNER)).json()["status"] == "analise"
    # Same status again is a no-op, not an error.
    assert client.patch(url, json={"status": "analise"}, headers=h(OWNER)).status_code == 200


def test_reopen_is_human_only_and_journaled(client, store, case):
    """F1: decidido → analise through POST /reopen; the old hash stays in the journal."""
    from uuid import UUID

    url = f"/api/investigations/{case['id']}"
    assert client.post(f"{url}/reopen", headers=h(OWNER)).status_code == 409  # not decided
    store.update_investigation(
        UUID(case["id"]), status="decidido", decision={"outcome": "arquivar"}, frozen_hash="ab" * 32
    )
    assert client.post(f"{url}/reopen", headers=h(READER)).status_code == 403
    # Archiving a decided case is the one PATCH it still takes.
    assert client.patch(url, json={"title": "x"}, headers=h(OWNER)).status_code == 409
    r = client.post(f"{url}/reopen", headers=h(WRITER))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "analise" and body["decision"] is None and body["frozen_hash"] is None
    assert body["deadline"]["phase"] == "analysis"
    event = client.get(f"{url}/events", headers=h(OWNER)).json()[-1]
    assert event["kind"] == "case.reopened"
    assert event["payload"]["previous_frozen_hash"] == "ab" * 32
    assert event["payload"]["previous_decision"] == {"outcome": "arquivar"}
    assert [e.action for e in store.usage_logs][-1] == "investigation.reopen"
    assert client.patch(url, json={"title": "editable again"}, headers=h(OWNER)).status_code == 200


def test_deadline_counts_from_alert_at_and_honours_the_override(client, store, case, monkeypatch):
    from datetime import datetime, timedelta
    from uuid import UUID

    from graphlagoon.services import investigations as service

    alert = datetime(2026, 9, 1, 10, 0)
    store.update_investigation(UUID(case["id"]), created_at=alert + timedelta(days=10))
    monkeypatch.setattr(service, "_clock", lambda: alert + timedelta(days=1))
    r = client.patch(
        f"/api/investigations/{case['id']}",
        json={"alert_at": alert.isoformat(), "deadline_days_override": 10},
        headers=h(OWNER),
    )
    assert r.status_code == 200, r.text
    assert r.json()["deadline"] == {"phase": "selection", "due_at": "2026-09-11T10:00:00", "days_left": 9}
