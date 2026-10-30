"""GET /api/live: the revisions an open page polls to refresh without a reload."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from graphlagoon.app import create_api_router
from graphlagoon.config import get_settings
from graphlagoon.db.memory_store import InMemoryStore
from graphlagoon.middleware import auth

OWNER = "owner@example.com"
STRANGER = "stranger@example.com"


def _h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_LIVE_REFRESH_SECONDS", "7")
    get_settings.cache_clear()
    InMemoryStore.reset()
    store = InMemoryStore.get_instance()
    context = store.create_graph_context("Pix", "e", "n", OWNER)
    exploration = store.create_exploration(context.id, "Mulas", OWNER, {})
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app), exploration
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_exploration_and_case_revisions_move_with_every_write(env):
    client, exploration = env
    eid = str(exploration.id)
    cid = client.post("/api/investigations", json={"title": "Caso"}, headers=_h(OWNER)).json()["id"]
    client.post(f"/api/investigations/{cid}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": eid},
                headers=_h(OWNER))

    first = client.get("/api/live", params={"exploration": eid, "case": cid}, headers=_h(OWNER)).json()
    assert first["refresh_seconds"] == 7
    assert first["explorations"][eid] == {"revision": 0, "last_change": None}
    assert first["cases"][cid]["explorations"] == {eid: 0}
    assert first["cases"][cid]["last_event_id"]

    client.put(f"/api/explorations/{eid}", json={"title": "Mulas 2"}, headers=_h(OWNER))
    client.post(f"/api/investigations/{cid}/items", json={"kind": "note", "subkind": "free", "content": "x"}, headers=_h(OWNER))
    after = client.get("/api/live", params={"exploration": eid, "case": cid}, headers=_h(OWNER)).json()
    assert after["explorations"][eid]["revision"] == 1
    assert after["explorations"][eid]["last_change"]["by"] == OWNER
    assert after["cases"][cid]["explorations"] == {eid: 1}
    assert after["cases"][cid]["last_event_id"] != first["cases"][cid]["last_event_id"]


def test_what_the_caller_cannot_read_is_null(env):
    client, exploration = env
    cid = client.post("/api/investigations", json={"title": "Caso"}, headers=_h(OWNER)).json()["id"]
    out = client.get("/api/live", params={"exploration": str(exploration.id), "case": cid}, headers=_h(STRANGER)).json()
    assert out["explorations"] == {str(exploration.id): None}
    assert out["cases"] == {cid: None}


def test_a_stale_save_is_refused_and_the_revision_is_server_owned(env):
    client, exploration = env
    url = f"/api/explorations/{exploration.id}"
    r = client.put(url, json={"state": {"revision": 99, "graph_query": "MATCH (n) RETURN n"}, "expected_revision": 0},
                   headers=_h(OWNER))
    assert r.status_code == 200 and r.json()["state"]["revision"] == 1
    r = client.put(url, json={"title": "x", "expected_revision": 0}, headers=_h(OWNER))
    assert r.status_code == 409
    assert r.json()["detail"]["error"]["details"]["revision"] == 1
    assert client.put(url, json={"title": "x"}, headers=_h(OWNER)).status_code == 200  # no expected: last write wins
