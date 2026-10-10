"""GET /api/explorations with q, mine, limit, offset and node_count (F1, 05 §4)."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from graphlagoon.db.memory_store import InMemoryStore
from graphlagoon.routers import explorations

ME = "me@example.com"
OTHER = "other@example.com"


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def client(store):
    app = FastAPI()
    app.include_router(explorations.router)
    return TestClient(app)


@pytest.fixture
def rows(store):
    ctx = store.create_graph_context(title="ctx", edge_table_name="e", node_table_name="n", owner_email=ME)
    mk = lambda title, owner, state: store.create_exploration(  # noqa: E731
        graph_context_id=ctx.id, title=title, owner_email=owner, state=state
    )
    mine_empty = mk("Pix empty", ME, {"nodes": []})
    mine_full = mk("Pix mules", ME, {"nodes": [{"node_id": "a"}, {"node_id": "b"}]})
    theirs = mk("Pix by other", OTHER, {"has_snapshot": True})
    return mine_empty, mine_full, theirs


def _get(client, **params):
    r = client.get("/api/explorations", params=params, headers={"X-Forwarded-Email": ME})
    assert r.status_code == 200, r.text
    return r.json()


def test_node_count_mine_search_and_window(client, rows):
    mine_empty, mine_full, theirs = rows
    by_id = {e["id"]: e for e in _get(client)}
    assert len(by_id) == 3  # the context owner reads every exploration in it
    assert by_id[str(mine_empty.id)]["node_count"] == 0
    assert by_id[str(mine_full.id)]["node_count"] == 2
    assert by_id[str(theirs.id)]["node_count"] is None  # snapshot-only: not read here

    assert {e["owner_email"] for e in _get(client, mine="true")} == {ME}
    assert [e["title"] for e in _get(client, q="MULES")] == ["Pix mules"]
    assert len(_get(client, limit=2)) == 2
    assert len(_get(client, limit=2, offset=2)) == 1
    assert client.get("/api/explorations", params={"limit": 0}, headers={"X-Forwarded-Email": ME}).status_code == 422
