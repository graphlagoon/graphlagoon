"""Unified case graph (05 §8): parity with utils/unifyGraph.ts on the shared
fixtures, and ``case_graph`` applying the case's identity keys and accepted matches."""

import json
import sys
from pathlib import Path
from uuid import UUID

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

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import investigation_storage, snapshot  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from graphlagoon.services.case_graph import case_graph, unify  # noqa: E402

OWNER = "owner@example.com"
ROOT = Path(__file__).resolve().parents[2] / "frontend/src/__tests__/fixtures/unify"
FIXTURES = sorted(ROOT.glob("*.json")) if ROOT.is_dir() else []


def _canonical(graph: dict) -> str:
    nodes = sorted(
        (
            {
                "uid": n["uid"],
                "type": n["type"],
                "entity": n["entity"],
                "properties": n["properties"],
                "sources": n["sources"],
                **({"conflicts": n["conflicts"]} if n.get("conflicts") else {}),
            }
            for n in graph["nodes"]
        ),
        key=lambda n: n["uid"],
    )
    edges = sorted(
        (
            {k: e[k] for k in ("id", "src", "dst", "type", "properties", "source_id")}
            for e in graph["edges"]
        ),
        key=lambda e: e["id"],
    )
    return json.dumps(
        {"nodes": nodes, "edges": edges}, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )


@pytest.mark.skipif(not FIXTURES, reason="frontend fixtures not checked out")
@pytest.mark.parametrize("path", FIXTURES, ids=[p.stem for p in FIXTURES])
def test_unify_matches_the_typescript_engine(path):
    fx = json.loads(path.read_text())
    parts = [
        (s["id"], s["context_id"], fx["contexts"][s["context_id"]].get("identity_keys"), s, None)
        for s in fx["sources"]
    ]
    aliases = [
        (m["left"]["uid"], m["right"]["uid"]) for m in fx["matches"] if m["status"] == "aceito"
    ]
    got = unify(parts, fx["overrides"].get("identity_keys"), aliases)
    expected = json.dumps(
        fx["expected"], sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    assert _canonical(got) == expected


SNAPSHOTS = {
    "Bank": {
        "nodes": [
            {"id": "p1", "type": "Holder", "properties": {"national_id": "123.456.789-01", "name": "Ana R."}},
            {"id": "a1", "type": "Account", "properties": {}},
        ],
        "edges": [{"id": "e1", "source": "p1", "target": "a1", "type": "HOLDS", "properties": {}}],
    },
    "CRM": {
        "nodes": [
            {"id": "9", "type": "Customer", "properties": {"doc": 12345678901, "income": 1800}},
            {"id": "m1", "type": "Customer", "properties": {"doc": "***.418.207-**", "postcode": "04571-020"}},
        ],
        "edges": [],
    },
}
KEY = {"node_type": "Holder", "entity": "Person", "source": {"kind": "prop", "name": "national_id"}, "normalize": "digits"}


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    store = InMemoryStore.get_instance()
    explorations = {}
    for title, keys in (("Bank", [KEY]), ("CRM", [])):
        ctx = store.create_graph_context(title, "e", "n", OWNER, identity_keys=keys)
        explorations[store.create_exploration(ctx.id, title, OWNER, {"has_snapshot": True}).id] = title

    class _Snapshots:
        async def load(self, exploration_id):
            return snapshot.compress_snapshot(SNAPSHOTS[explorations[exploration_id]])

    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: _Snapshots())
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)
    inv_id = client.post("/api/investigations", json={"title": "Case"}, headers=h(OWNER)).json()["id"]
    url = f"/api/investigations/{inv_id}"
    for eid in explorations:
        r = client.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(eid)}, headers=h(OWNER))
        assert r.status_code == 201, r.text
    yield client, url, store.get_investigation(UUID(inv_id))
    InMemoryStore.reset()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_case_graph_applies_case_keys_and_accepted_matches(env):
    client, url, inv = env
    graph = await case_graph(inv.id, OWNER)
    assert len(graph["nodes"]) == 4 and "Person:12345678901" in {n["uid"] for n in graph["nodes"]}

    # The case's own key for Customer (05 §1 settings.identity_keys) merges "9" into the Person.
    inv.settings["identity_keys"] = [{**KEY, "node_type": "Customer", "source": {"kind": "prop", "name": "doc"}}]
    graph = await case_graph(inv.id, OWNER)
    [ana] = [n for n in graph["nodes"] if n["uid"] == "Person:12345678901"]
    assert [o["node_id"] for o in ana["sources"]] == ["p1", "9"] and ana["properties"]["income"] == 1800
    assert ana["conflicts"] == {"node_type": [{"value": "Customer", "source_id": ana["sources"][1]["source_id"]}]}

    # A confirmed same_as (targets = [keep, drop]) folds the redacted Customer in; an agent's
    # suggestion alone does not (05 §6).
    masked = next(n["uid"] for n in graph["nodes"] if n["uid"].startswith("m1@"))
    token = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()["token"]
    r = client.post(
        f"{url}/annotations",
        json={"kind": "same_as", "targets": ["Person:12345678901", masked], "value": {"score": 0.9}, "reason": "same customer"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201 and r.json()["status"] == "suggested", r.text
    assert len((await case_graph(inv.id, OWNER))["nodes"]) == 3
    r = client.post(f"{url}/annotations/{r.json()['id']}/confirm", headers=h(OWNER))
    assert r.status_code == 200, r.text
    graph = await case_graph(inv.id, OWNER)
    [ana] = [n for n in graph["nodes"] if n["uid"] == "Person:12345678901"]
    assert len(graph["nodes"]) == 2 and [o["node_id"] for o in ana["sources"]] == ["p1", "9", "m1"]
    assert ana["properties"]["postcode"] == "04571-020" and graph["edges"][0]["src"] == "Person:12345678901"


# ---------------------------------------------------------------------------
# Generic entities (05 §4b): links parity, pre-unified derived items, edge
# semantics by relationship type
# ---------------------------------------------------------------------------

ER_ROOT = ROOT.parent / "er"


@pytest.mark.skipif(not (ER_ROOT / "shared-attributes.json").exists(), reason="frontend fixtures not checked out")
def test_shared_attribute_links_match_the_typescript_engine():
    from graphlagoon.services.entity_resolution import shared_attribute_links

    fx = json.loads((ER_ROOT / "shared-attributes.json").read_text())
    p = fx["params"]
    got = shared_attribute_links(fx["graph"], p["attributes"], p.get("minShared", 1), p.get("maxEntities"), p.get("entityTypes"))
    assert got == fx["expected"]
    # The carrier IP (4 entities) is above maxEntities; without a ceiling it links everyone.
    assert shared_attribute_links(fx["graph"], ["ip"], 1, 3)["pairs"] == []
    assert len(shared_attribute_links(fx["graph"], ["ip"], 1)["pairs"]) == 6
    # An attribute whose name says nothing takes the normalizer it is given.
    phones = {"nodes": [{"uid": "a", "type": "Person", "properties": {"telefone": "+1 (415) 555-0100"}},
                        {"uid": "b", "type": "Person", "properties": {"telefone": "14155550100"}}], "edges": []}
    assert shared_attribute_links(phones, ["telefone"])["pairs"] == []
    assert shared_attribute_links(phones, ["telefone"], normalize={"telefone": "phone"})["pairs"] == [
        {"left": "a", "right": "b", "shared": ["telefone"]}
    ]


def test_entity_resolution_blocks_on_any_attribute_and_scores_names():
    from graphlagoon.services.entity_resolution import suggest

    nodes = [
        {"uid": "a", "properties": {"name": "Maria Aparecida Souza", "email": "M@x.com", "phone": "+1 415 555 0100"}},
        {"uid": "b", "properties": {"Name": "MARIA A. SOUZA", "email": "m@x.com", "phone": "14155550100"}},
        {"uid": "c", "properties": {"name": "John Doe", "email": "m@x.com"}},  # one shared value, another name
        {"uid": "d", "properties": {"name": "Maria Souza"}},  # nothing to block on
    ]
    got = suggest(nodes)
    assert [(m["left"]["uid"], m["right"]["uid"]) for m in got] == [("a", "b")]
    assert got[0]["reasons"][1] == {"term": "shared", "weight": 0.3, "value": 1, "attributes": ["email", "phone"]}
    # Blocking on a single attribute never corroborates: below the threshold.
    assert suggest(nodes, block_on=["email"]) == []
    # Any property works as a blocking key or as the name.
    custom = [{"uid": "x", "properties": {"legal": "Blue Shop", "registry_id": "R-77", "branch": "9"}},
              {"uid": "y", "properties": {"legal": "BLUE SHOP", "registry_id": "r-77", "branch": "9"}}]
    assert suggest(custom, block_on=["registry_id", "branch"], name_keys=["legal"])[0]["score"] == 1.0


def test_unified_parts_keep_their_ids_and_case_semantics_apply_by_edge_type():
    base = {
        "nodes": [{"id": "p1", "type": "Person", "properties": {"national_id": "12345678901"}}, {"id": "d1", "type": "Device", "properties": {}}],
        "edges": [{"id": "e1", "source": "p1", "target": "d1", "type": "USA", "properties": {"quando": "2024-03-15T14:05:00", "vezes": "3"}}],
    }
    key = {"node_type": "Person", "entity": "Person", "source": {"kind": "prop", "name": "national_id"}, "normalize": "digits"}
    derived = {
        "unified": True,
        "nodes": [{"id": "Person:12345678901", "type": "Person", "properties": {}}, {"id": "d1@ctx", "type": "Device", "properties": {}}],
        "edges": [{"id": "l1", "source": "Person:12345678901", "target": "d1@ctx", "type": "shares_device_id", "properties": {"shared_by": 2}}],
    }
    graph = unify(
        [("s1", "ctx", [key], base, None), ("s2", "s2", [], derived, None, True)],
        edge_overrides={"USA": {"weight_prop": "vezes", "timestamp_prop": "quando"}},
    )
    assert {n["uid"] for n in graph["nodes"]} == {"Person:12345678901", "d1@ctx"}
    [ana] = [n for n in graph["nodes"] if n["uid"] == "Person:12345678901"]
    assert [o["source_id"] for o in ana["sources"]] == ["s1", "s2"]
    from graphlagoon.services.trace import parse_time

    usa, link = graph["edges"]
    assert (usa["amount"], usa["t"]) == (3.0, parse_time("2024-03-15T14:05:00")) and link["src"] == "Person:12345678901"
    # A derived item's normalizer list reaches mapped files too.
    from graphlagoon.services.case_graph import derived_identity_keys

    keys = derived_identity_keys({"nodes": [{"type": "Device", "id": {"col": "t.dev", "normalize": "device_id"}}, {"type": "Log", "id": {"col": "t.x", "normalize": "lower"}}]})
    assert [k["node_type"] for k in keys] == ["Device"]
