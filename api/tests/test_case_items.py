"""Case items (05 §1): uploads with a mapping reach the canvas without a
context, versions are content-addressed and never overwritten, text is
extracted for search and agents, pins are immutable, the brief is one item."""

import hashlib
import json
import sys
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

OWNER = "owner@example.com"
CPF = "123.456.789-01"
CSV = (
    "origem;destino;valor;data\n"
    f"{CPF};987.654.321-00;1500,00;01/03/2026 10:00\n"
    "987.654.321-00;111.222.333-44;1400,00;01/03/2026 11:30\n"
).encode("utf-8")
MAPPING = {
    "version": 1,
    "name": "pix csv",
    "inputs": {"t": {"match": "*.csv", "delimiter": ";", "header": True}},
    "nodes": [
        {"key": "origem", "type": "Pessoa", "from": "t", "id": {"col": "t.origem", "normalize": "cpf_cnpj"}},
        {"key": "destino", "type": "Pessoa", "from": "t", "id": {"col": "t.destino", "normalize": "cpf_cnpj"}},
    ],
    "edges": [
        {
            "from": "t",
            "type": "PIX",
            "endpoints": {"self": "origem", "other": "destino"},
            "props": {"valor": {"col": "t.valor", "convert": "decimal_br"}, "data": "t.data"},
        }
    ],
    "edge_semantics": {"amount_prop": "valor", "time_prop": "data"},
}
SNAPSHOT = {
    "nodes": [{"id": "p1", "type": "Pessoa", "properties": {"cpf": CPF}}, {"id": "c1", "type": "Conta", "properties": {}}],
    "edges": [{"id": "e1", "source": "p1", "target": "c1", "type": "TITULAR", "properties": {}}],
}


def h(email):
    return {"X-Forwarded-Email": email}


class _Snapshots:
    async def load(self, exploration_id):
        return snapshot.compress_snapshot(SNAPSHOT)


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: _Snapshots())
    store = InMemoryStore.get_instance()
    ctx = store.create_graph_context("Pix", "e", "n", OWNER)
    exp = store.create_exploration(ctx.id, "Contas", OWNER, {"has_snapshot": True})
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)
    inv = client.post("/api/investigations", json={"title": "Caso"}, headers=h(OWNER)).json()
    yield client, f"/api/investigations/{inv['id']}", store, exp, tmp_path
    InMemoryStore.reset()
    get_settings.cache_clear()


def _upload(client, url, name, data, **params):
    return client.post(
        f"{url}/items",
        content=data,
        params={"filename": name, "kind": "table", "subkind": "csv", **params},
        headers={**h(OWNER), "Content-Type": "application/octet-stream"},
    )


def test_csv_upload_with_mapping_reaches_the_canvas_without_a_context(env):
    client, url, store, _, _ = env
    contexts_before = set(store.graph_contexts)
    r = _upload(client, url, "pix.csv", CSV)
    assert r.status_code == 201, r.text
    item = r.json()
    assert (item["kind"], item["subkind"], item["status"], item["author_kind"]) == ("table", "csv", "confirmed", "human")
    assert item["latest"]["sha256"] == hashlib.sha256(CSV).hexdigest() and item["latest"]["has_text"]
    assert item["provenance"]["filename"] == "pix.csv"
    assert client.get(f"{url}/graph", headers=h(OWNER)).json()["nodes"] == []  # no mapping yet

    bad = client.patch(f"{url}/items/{item['id']}", json={"mapping": {"as": "graph", "spec": {"nope": 1}}}, headers=h(OWNER))
    assert bad.status_code == 422 and bad.json()["detail"]["error"]["code"] == "INVALID_MAPPING"
    r = client.patch(f"{url}/items/{item['id']}", json={"mapping": {"as": "graph", "spec": MAPPING}}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    graph = client.get(f"{url}/graph", headers=h(OWNER)).json()
    assert {n["uid"] for n in graph["nodes"]} == {"Pessoa:12345678901", "Pessoa:98765432100", "Pessoa:11122233344"}
    assert graph["edges"][0]["amount"] == 1500.0 and graph["edges"][0]["t"] is not None
    assert set(store.graph_contexts) == contexts_before and len(store.explorations) == 1  # the fixture's
    part = client.get(f"{url}/items/{item['id']}/snapshot", headers=h(OWNER)).json()
    assert part["identity_keys"][0]["normalize"] == "cpf_cnpj" and part["report"]["rows_read"] == 2
    # The queue counts it; the item lists with its canvas flag.
    assert client.get("/api/investigations", headers=h(OWNER)).json()[0]["item_count"] == 1
    [listed] = client.get(f"{url}/items?kind=table", headers=h(OWNER)).json()
    assert listed["mapping"]["as"] == "graph"


def test_versions_are_content_addressed_and_text_is_extracted(env):
    client, url, store, _, root = env
    r = client.post(
        f"{url}/items",
        json={"kind": "document", "subkind": "markdown", "title": "Resumo", "content": f"# Resumo\nTitular {CPF}"},
        headers=h(OWNER),
    )
    assert r.status_code == 201, r.text
    item = r.json()
    v1 = item["latest"]
    r = client.post(f"{url}/items/{item['id']}/versions", json={"content": "# Resumo v2"}, headers=h(OWNER))
    assert r.status_code == 201 and r.json()["current_version"] == 2
    # Same bytes again: a new version row, the same blob (never overwritten).
    r = client.post(f"{url}/items/{item['id']}/versions", json={"content": f"# Resumo\nTitular {CPF}"}, headers=h(OWNER))
    versions = client.get(f"{url}/items/{item['id']}/versions", headers=h(OWNER)).json()
    assert [v["version"] for v in versions] == [1, 2, 3] and versions[2]["sha256"] == v1["sha256"]
    blobs = list((root / item["id"] if (root / item["id"]).exists() else root).rglob("*"))
    assert len([b for b in blobs if b.is_file() and not b.name.endswith(".txt")]) == 2
    assert client.get(f"{url}/items/{item['id']}/content?version=2", headers=h(OWNER)).text == "# Resumo v2"
    assert client.get(f"{url}/items/{item['id']}/content", headers=h(OWNER)).text.startswith("# Resumo\n")
    text = client.get(f"{url}/items/{item['id']}/text", headers=h(OWNER)).json()
    assert CPF in text["text"] and text["version"]["version"] == 3

    # A PDF without pypdf installed has no text (graceful); binary stays binary.
    pdf = client.post(
        f"{url}/items", content=b"%PDF-1.4 " + CPF.encode(),
        params={"filename": "extrato.pdf", "kind": "document", "subkind": "upload"},
        headers={**h(OWNER), "Content-Type": "application/pdf"},
    ).json()
    assert client.get(f"{url}/items/{pdf['id']}/text", headers=h(OWNER)).json()["text"] is None
    got = client.get(f"{url}/items/{pdf['id']}/content", headers=h(OWNER))
    assert got.headers["content-type"].startswith("application/octet-stream") and "attachment" in got.headers["content-disposition"]

    # Search: title match and text match with a snippet.
    hits = client.get(f"{url}/search?q=titular", headers=h(OWNER)).json()
    assert [(x["title"], x["match"]) for x in hits] == [("Resumo", "text")] and "Titular" in hits[0]["snippet"]
    assert [x["match"] for x in client.get(f"{url}/search?q=resumo", headers=h(OWNER)).json()] == ["title"]

    # Agents: text masked, bytes refused.
    token = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()["token"]
    agent = {"Authorization": f"Bearer {token}"}
    masked = client.get(f"{url}/items/{item['id']}/text", headers=agent).json()["text"]
    assert CPF not in masked and "456.789" in masked
    r = client.get(f"{url}/items/{item['id']}/content", headers=agent)
    assert r.status_code == 403 and r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
    # Soft delete: gone from the list, still in the journal.
    assert client.delete(f"{url}/items/{pdf['id']}", headers=h(OWNER)).status_code == 200
    assert [i["id"] for i in client.get(f"{url}/items", headers=h(OWNER)).json()] == [item["id"]]
    kinds = [e["kind"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()]
    assert kinds.count("item.created") == 2 and kinds.count("item.version_added") == 4 and "item.deleted" in kinds


def test_exploration_ref_pin_freezes_and_pins_are_immutable(env):
    client, url, store, exp, _ = env
    r = client.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(exp.id)}, headers=h(OWNER))
    assert r.status_code == 201, r.text
    item = r.json()
    assert item["title"] == "Contas" and item["context_id"] == str(exp.graph_context_id) and item["latest"] is None
    assert item["accessible"] is True
    dup = client.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(exp.id)}, headers=h(OWNER))
    assert dup.status_code == 409
    graph = client.get(f"{url}/graph", headers=h(OWNER)).json()
    assert len(graph["nodes"]) == 2 and graph["nodes"][0]["sources"][0]["source_id"] == item["id"]
    part = client.get(f"{url}/items/{item['id']}/snapshot", headers=h(OWNER)).json()
    assert part["snapshot"] == SNAPSHOT and part["exploration"]["title"] == "Contas"
    assert client.get("/api/investigations", params={"exploration_id": str(exp.id)}, headers=h(OWNER)).json()

    pin = client.post(f"{url}/items/{item['id']}/pin", json={"label": "estado em 10/03"}, headers=h(OWNER))
    assert pin.status_code == 200, pin.text
    assert pin.json()["version"] == 1 and pin.json()["pin_label"] == "estado em 10/03"
    frozen = json.loads(client.get(f"{url}/items/{item['id']}/content", headers=h(OWNER)).content)
    assert frozen["snapshot"] == SNAPSHOT
    again = client.post(f"{url}/items/{item['id']}/pin", json={"version": 1}, headers=h(OWNER))
    assert again.status_code == 409 and again.json()["detail"]["error"]["code"] == "ALREADY_PINNED"
    item = client.get(f"{url}/items/{item['id']}", headers=h(OWNER)).json()
    assert [p["version"] for p in item["pinned"]] == [1]
    # The exploration goes away: the reference stays, the canvas keeps nothing live.
    store.delete_exploration(exp.id)
    assert client.get(f"{url}/items/{item['id']}", headers=h(OWNER)).json()["exploration_id"] is None


def test_agent_items_carry_authorship_and_the_brief_is_one_item(env):
    client, url, store, _, _ = env
    token = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()["token"]
    agent = {"Authorization": f"Bearer {token}"}
    r = client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "title": "Achado", "content": "Repassa em minutos"}, headers=agent)
    assert r.status_code == 201, r.text
    note = r.json()
    assert (note["author_kind"], note["author_email"], note["status"]) == ("agent", OWNER, "confirmed")
    assert note["agent_token_id"]
    # confirm/reject apply only to suggestions, and only by people.
    assert client.post(f"{url}/items/{note['id']}/confirm", headers=h(OWNER)).status_code == 409
    assert client.post(f"{url}/items/{note['id']}/confirm", headers=agent).status_code == 403
    # Agent suggest kinds may include an item kind: then it arrives suggested.
    client.patch(url, json={"settings": {"agent_suggest_kinds": ["note"]}}, headers=h(OWNER))
    suggested = client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "x"}, headers=agent).json()
    assert suggested["status"] == "suggested"
    assert client.get("/api/investigations", headers=h(OWNER)).json()[0]["suggested_count"] == 1
    assert client.post(f"{url}/items/{suggested['id']}/reject", headers=h(OWNER)).json()["status"] == "rejected"

    assert client.get(f"{url}/brief", headers=h(OWNER)).json() == {"item": None, "text": ""}
    brief = client.put(f"{url}/brief", json={"text": "# Brief\nExposição consolidada"}, headers=agent).json()
    assert brief["item"]["subkind"] == "brief" and brief["item"]["author_kind"] == "agent"
    same = client.put(f"{url}/brief", json={"text": "# Brief\nExposição consolidada"}, headers=h(OWNER)).json()
    assert same["item"]["current_version"] == 1  # unchanged text adds no version
    newer = client.put(f"{url}/brief", json={"text": "# Brief v2"}, headers=h(OWNER)).json()
    assert newer["item"]["current_version"] == 2 and newer["item"]["latest"]["author_kind"] == "human"
    assert client.get(f"{url}/brief", headers=h(OWNER)).json()["text"] == "# Brief v2"
    dup = client.post(f"{url}/items", json={"kind": "document", "subkind": "brief", "content": "x"}, headers=h(OWNER))
    assert dup.status_code == 409
    assert client.post(f"{url}/items", json={"kind": "graph", "subkind": "nope"}, headers=h(OWNER)).status_code == 422


def test_enrichment_mapping_and_upload_permission(env):
    client, url, store, _, _ = env
    qsa = _upload(client, url, "qsa.csv", b"cnpj;socio\n12345678000190;ANA\n").json()
    spec = {"name": "QSA", "input": {"delimiter": ";"}, "key_column": "cnpj", "columns": ["socio"], "match_node_types": ["Lojista"]}
    r = client.patch(f"{url}/items/{qsa['id']}", json={"mapping": {"as": "enrichment", "spec": spec}}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["mapping"]["spec"]["key_column"] == "cnpj"
    assert client.get(f"{url}/graph", headers=h(OWNER)).json()["nodes"] == []  # enrichment is not a graph
    group = store.create_group("uploaders", members=[{"kind": "email", "value": "other@example.com"}])
    store.set_permission("investigation.upload", "restricted", [{"group_id": group.id, "effect": "allow"}])
    denied = _upload(client, url, "x.csv", b"a")
    assert denied.status_code == 403 and denied.json()["detail"]["error"]["details"]["permission"] == "investigation.upload"
    # JSON items need no upload permission.
    assert client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "ok"}, headers=h(OWNER)).status_code == 201
