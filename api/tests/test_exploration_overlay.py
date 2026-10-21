"""The user's layer of an exploration (BYOD-2): saved beside the snapshot, never
inside it; written only by who can write the exploration (and holds
``exploration.edit_graph``); read by who can read it; folded into a case."""

import sys

import pytest

try:
    import gsql2rsql  # noqa: F401
except ImportError:
    from unittest.mock import MagicMock as _MagicMock

    for _name in (
        "gsql2rsql", "gsql2rsql.parser", "gsql2rsql.parser.opencypher_parser", "gsql2rsql.planner",
        "gsql2rsql.planner.logical_plan", "gsql2rsql.planner.subquery_flattening", "gsql2rsql.planner.pass_manager",
        "gsql2rsql.renderer", "gsql2rsql.renderer.sql_renderer", "gsql2rsql.renderer.schema_provider",
        "gsql2rsql.common", "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import investigation_storage, snapshot  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

OWNER = "owner@example.com"
READER = "reader@example.com"
SNAPSHOT = {
    "nodes": [
        {"id": "a1", "type": "Account", "properties": {"risk": "low"}},
        {"id": "a2", "type": "Account", "properties": {}},
    ],
    "edges": [{"id": "e1", "source": "a1", "target": "a2", "type": "PIX", "properties": {"amount": 10}}],
}
ENRICH = {
    "id": "f1",
    "filename": "risk.csv",
    "spec": {"name": "Risk", "key_column": "account", "columns": ["risk", "segment"]},
    "rows": {"a1": [{"risk": "high", "segment": "retail"}], "a2": [{"risk": "mid"}]},
    "row_count": 2,
}
OVERLAY = {
    "version": 1,
    "nodes": [{"id": "sketch:p1", "type": "Person", "properties": {"label": "Ana"}}],
    "edges": [{"id": "sketch:x1", "source": "sketch:p1", "target": "a1", "type": "OWNS", "properties": {}}],
    "enrichments": [ENRICH],
    "imports": [],
}


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_EXPLORATION_OVERLAY_MAX_BYTES", "20000")
    get_settings.cache_clear()
    InMemoryStore.reset()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path / "inv")))
    files = snapshot.LocalSnapshotService(str(tmp_path / "snap"))
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: files)
    store = InMemoryStore.get_instance()
    ctx = store.create_graph_context("Bank", "e", "n", OWNER)
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)
    r = client.post(f"/api/graph-contexts/{ctx.id}/explorations", json={"title": "Pix", "state": {}, "snapshot": SNAPSHOT}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    yield client, store, r.json()["id"], tmp_path / "snap"
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_layer_round_trips_beside_the_snapshot_and_survives_state_saves(env):
    client, _, eid, files = env
    url = f"/api/explorations/{eid}"
    assert client.get(f"{url}/overlay", headers=h(OWNER)).status_code == 404

    r = client.put(f"{url}/overlay", json=OVERLAY, headers=h(OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["state"]["has_overlay"] is True
    assert (files / f"{eid}.overlay.json.gz").exists() and (files / f"{eid}.json.gz").exists()
    got = client.get(f"{url}/overlay", headers=h(OWNER)).json()
    assert got["nodes"][0]["id"] == "sketch:p1" and got["enrichments"][0]["spec"]["match_node_types"] == ["*"]
    # The snapshot is the context's graph, untouched.
    served = client.get(f"{url}/snapshot", headers=h(OWNER)).json()
    assert [(n["id"], n["properties"]) for n in served["nodes"]] == [(n["id"], n["properties"]) for n in SNAPSHOT["nodes"]]

    # Saving the exploration (a state from the client, which never carries the flag) keeps the layer.
    r = client.put(url, json={"state": {"has_overlay": False}, "snapshot": SNAPSHOT}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["state"]["has_overlay"] is True

    # An empty layer removes it.
    r = client.put(f"{url}/overlay", json={"version": 1}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["state"]["has_overlay"] is False
    assert not (files / f"{eid}.overlay.json.gz").exists()
    assert client.get(f"{url}/overlay", headers=h(OWNER)).status_code == 404


def test_new_explorations_never_claim_a_layer(env):
    client, store, _, _ = env
    ctx = next(iter(store.graph_contexts))
    r = client.post(f"/api/graph-contexts/{ctx}/explorations", json={"title": "Other", "state": {"has_overlay": True}}, headers=h(OWNER))
    assert r.json()["state"]["has_overlay"] is False


def test_readers_read_the_layer_but_only_writers_change_it(env):
    client, _, eid, _ = env
    url = f"/api/explorations/{eid}"
    assert client.put(f"{url}/overlay", json=OVERLAY, headers=h(OWNER)).status_code == 200
    assert client.get(f"{url}/overlay", headers=h(READER)).status_code == 403
    r = client.post(f"{url}/share", json={"email": READER, "permission": "read"}, headers=h(OWNER))
    assert r.status_code in (200, 201), r.text
    assert client.get(f"{url}/overlay", headers=h(READER)).status_code == 200
    assert client.put(f"{url}/overlay", json={"version": 1}, headers=h(READER)).status_code == 403


def test_the_layer_is_gated_by_exploration_edit_graph(env):
    client, store, eid, _ = env
    group = store.create_group("editors", members=[{"kind": "email", "value": READER}])
    store.set_permission("exploration.edit_graph", "restricted", [{"group_id": group.id, "effect": "allow"}])
    denied = client.put(f"/api/explorations/{eid}/overlay", json=OVERLAY, headers=h(OWNER))
    assert denied.status_code == 403
    assert denied.json()["detail"]["error"]["details"]["permission"] == "exploration.edit_graph"
    assert "exploration.edit_graph" not in client.get("/api/config", headers=h(OWNER)).json()["permissions"]


def test_oversized_and_invalid_layers_are_refused(env):
    client, _, eid, _ = env
    url = f"/api/explorations/{eid}/overlay"
    big = {**OVERLAY, "enrichments": [{**ENRICH, "rows": {str(i): [{"risk": "x" * 50}] for i in range(500)}}]}
    assert client.put(url, json=big, headers=h(OWNER)).status_code == 413
    bad = {**OVERLAY, "enrichments": [{**ENRICH, "spec": {"name": "x", "columns": ["risk"]}}]}  # no key column
    assert client.put(url, json=bad, headers=h(OWNER)).status_code == 422


def test_deleting_the_exploration_deletes_its_layer(env):
    client, _, eid, files = env
    assert client.put(f"/api/explorations/{eid}/overlay", json=OVERLAY, headers=h(OWNER)).status_code == 200
    assert client.delete(f"/api/explorations/{eid}", headers=h(OWNER)).status_code == 200
    assert not (files / f"{eid}.overlay.json.gz").exists()


def test_a_case_sees_the_exploration_with_its_layer(env):
    client, _, eid, _ = env
    assert client.put(f"/api/explorations/{eid}/overlay", json=OVERLAY, headers=h(OWNER)).status_code == 200
    case = client.post("/api/investigations", json={"title": "Case"}, headers=h(OWNER)).json()
    url = f"/api/investigations/{case['id']}"
    r = client.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": eid}, headers=h(OWNER))
    assert r.status_code == 201, r.text
    graph = client.get(f"{url}/graph", headers=h(OWNER)).json()
    nodes = {n["sources"][0]["node_id"]: n for n in graph["nodes"]}
    # The hand-drawn node and its edge to a context node; enrichment fills, never overrides.
    assert nodes["sketch:p1"]["properties"]["label"] == "Ana"
    assert {e["type"] for e in graph["edges"]} == {"PIX", "OWNS"}
    assert nodes["a1"]["properties"] == {"risk": "low", "segment": "retail"}
    assert nodes["a2"]["properties"] == {"risk": "mid"}
    # Pinning freezes the exploration as seen, layer included.
    item = r.json()["id"]
    r = client.post(f"{url}/items/{item}/pin", json={}, headers=h(OWNER))
    assert r.status_code in (200, 201), r.text
    frozen = client.get(f"{url}/items/{item}/content", params={"version": r.json()["version"]}, headers=h(OWNER))
    assert frozen.status_code == 200 and b"sketch:p1" in frozen.content and b"retail" in frozen.content
