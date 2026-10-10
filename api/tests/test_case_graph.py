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
    "Pix": {
        "nodes": [
            {"id": "p1", "type": "Titular", "properties": {"cpf": "123.456.789-01", "nome": "Ana R."}},
            {"id": "a1", "type": "Conta", "properties": {}},
        ],
        "edges": [{"id": "e1", "source": "p1", "target": "a1", "type": "TITULAR", "properties": {}}],
    },
    "Cadastro": {
        "nodes": [
            {"id": "9", "type": "Cliente", "properties": {"doc": 12345678901, "renda": 1800}},
            {"id": "m1", "type": "Cliente", "properties": {"doc": "***.418.207-**", "cep": "04571-020"}},
        ],
        "edges": [],
    },
}
KEY = {"node_type": "Titular", "entity": "Pessoa", "source": {"kind": "prop", "name": "cpf"}, "normalize": "cpf_cnpj"}


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    store = InMemoryStore.get_instance()
    explorations = {}
    for title, keys in (("Pix", [KEY]), ("Cadastro", [])):
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
    inv_id = client.post("/api/investigations", json={"title": "Caso"}, headers=h(OWNER)).json()["id"]
    url = f"/api/investigations/{inv_id}"
    for eid in explorations:
        r = client.post(f"{url}/sources", json={"kind": "exploration", "exploration_id": str(eid), "mode": "live"}, headers=h(OWNER))
        assert r.status_code == 201, r.text
    yield client, url, store.get_investigation(UUID(inv_id))
    InMemoryStore.reset()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_case_graph_applies_case_keys_and_accepted_matches(env):
    client, url, inv = env
    graph = await case_graph(inv.id, OWNER)
    assert len(graph["nodes"]) == 4 and "Pessoa:12345678901" in {n["uid"] for n in graph["nodes"]}

    # The case's own key for Cliente (05 §1 settings.identity_keys) merges "9" into the Pessoa.
    inv.state["identity_keys"] = [{**KEY, "node_type": "Cliente", "source": {"kind": "prop", "name": "doc"}}]
    graph = await case_graph(inv.id, OWNER)
    [ana] = [n for n in graph["nodes"] if n["uid"] == "Pessoa:12345678901"]
    assert [o["node_id"] for o in ana["sources"]] == ["p1", "9"] and ana["properties"]["renda"] == 1800
    assert ana["conflicts"] == {"node_type": [{"value": "Cliente", "source_id": ana["sources"][1]["source_id"]}]}

    # An accepted match (left = keep) folds the masked Cliente in; a suggestion alone does not.
    masked = next(n["uid"] for n in graph["nodes"] if n["uid"].startswith("m1@"))
    pair = {"left": {"uid": "Pessoa:12345678901"}, "right": {"uid": masked}, "score": 0.9, "reasons": []}
    [m] = client.post(f"{url}/matches", json={"matches": [pair]}, headers=h(OWNER)).json()
    assert len((await case_graph(inv.id, OWNER))["nodes"]) == 3
    r = client.patch(f"{url}/matches/{m['id']}", json={"status": "aceito", "reason_text": "KYC"}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    graph = await case_graph(inv.id, OWNER)
    [ana] = [n for n in graph["nodes"] if n["uid"] == "Pessoa:12345678901"]
    assert len(graph["nodes"]) == 2 and [o["node_id"] for o in ana["sources"]] == ["p1", "9", "m1"]
    assert ana["properties"]["cep"] == "04571-020" and graph["edges"][0]["src"] == "Pessoa:12345678901"
