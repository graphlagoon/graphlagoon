"""Journal, roles and notes of an investigation (F1.7), memory-store path."""

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
    r = client.post("/api/investigations", json={"title": "Pix"}, headers=h(OWNER))
    inv = r.json()
    for email, perm in ((READER, "read"), (WRITER, "write")):
        client.post(
            f"/api/investigations/{inv['id']}/share",
            json={"email": email, "permission": perm},
            headers=h(OWNER),
        )
    return inv


def events(client, case, **params):
    r = client.get(
        f"/api/investigations/{case['id']}/events", params=params, headers=h(READER)
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_server_mutations_are_journaled_and_chained(client, case):
    evs = events(client, case)
    assert [e["kind"] for e in evs] == ["case.created", "case.shared", "case.shared"]
    assert evs[0]["prev_hash"] is None
    assert all(b["prev_hash"] == a["hash"] for a, b in zip(evs, evs[1:]))


def test_events_are_immutable_and_paginated(client, case):
    url = f"/api/investigations/{case['id']}/events"
    first = events(client, case, limit=2)
    assert len(first) == 2
    rest = events(client, case, after=first[-1]["id"])
    assert [e["kind"] for e in rest] == ["case.shared"]
    eid = first[0]["id"]
    assert client.put(f"{url}/{eid}", json={}, headers=h(OWNER)).status_code in (
        404,
        405,
    )
    assert client.delete(f"{url}/{eid}", headers=h(OWNER)).status_code in (404, 405)


def test_client_events_whitelisted_and_need_write(client, case):
    url = f"/api/investigations/{case['id']}/events"
    ok = {"kind": "trace.run", "payload": {"hops": 3}}
    assert client.post(url, json=ok, headers=h(READER)).status_code == 403
    r = client.post(url, json=ok, headers=h(WRITER))
    assert r.status_code == 201 and r.json()["actor_email"] == WRITER
    forged = {"kind": "decision.recorded", "payload": {}}
    assert client.post(url, json=forged, headers=h(WRITER)).status_code == 422
    big = {"kind": "trace.run", "payload": {"x": "a" * 17000}}
    assert client.post(url, json=big, headers=h(WRITER)).status_code == 422


def test_roles_merge_and_journal(client, case):
    url = f"/api/investigations/{case['id']}/state"
    r = client.patch(url, json={"roles": {"Pessoa:1": "victim"}}, headers=h(WRITER))
    assert r.json()["state"]["roles"] == {"Pessoa:1": "victim"}
    r = client.patch(
        url, json={"roles": {"Pessoa:1": None, "Conta:9": "mule"}}, headers=h(WRITER)
    )
    assert r.json()["state"]["roles"] == {"Conta:9": "mule"}
    assert (
        client.patch(url, json={"roles": {"x": "boss"}}, headers=h(WRITER)).status_code
        == 422
    )
    changes = [
        e["payload"] for e in events(client, case) if e["kind"] == "role.changed"
    ]
    assert {"entity": "Pessoa:1", "from": "victim", "to": None} in changes
    assert len(changes) == 3


def test_notes_crud_author_only(client, case):
    url = f"/api/investigations/{case['id']}/notes"
    body = {"anchor": {"kind": "node", "id": "Pessoa:1"}, "body": "KYC mismatch"}
    assert client.post(url, json=body, headers=h(READER)).status_code == 403
    note = client.post(url, json=body, headers=h(WRITER)).json()
    assert note["author_email"] == WRITER and note["anchor"]["id"] == "Pessoa:1"
    nurl = f"{url}/{note['id']}"
    assert client.patch(nurl, json={"body": "x"}, headers=h(OWNER)).status_code == 403
    assert (
        client.patch(nurl, json={"body": "y"}, headers=h(WRITER)).json()["body"] == "y"
    )
    assert client.delete(nurl, headers=h(OWNER)).status_code == 403
    assert client.delete(nurl, headers=h(WRITER)).status_code == 200
    assert client.get(url, headers=h(READER)).json() == []
    kinds = [e["kind"] for e in events(client, case)]
    assert kinds[-3:] == ["note.created", "note.updated", "note.deleted"]
