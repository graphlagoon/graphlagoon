"""MCP server at /mcp (05 §6): the SDK client acts as an analyst on the case
through the thin F2 tools, every write attributed to the agent and masked."""

import json
import sys

import pytest

pytest.importorskip("mcp")

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

import httpx  # noqa: E402
import httpx2  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from mcp import Client  # noqa: E402
from mcp.client.streamable_http import streamable_http_client  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.mcp.server import mask_text, mcp_lifespan, mount_mcp  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import investigation_storage, snapshot  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

OWNER = "owner@example.com"
CPF = "123.456.789-01"
SNAPSHOT = {
    "nodes": [
        {"id": "p1", "type": "Pessoa", "properties": {"nome": "Ana", "cpf": CPF}},
        {"id": "c1", "type": "Conta", "properties": {"conta": "0341-1234-567890"}},
    ],
    "edges": [{"id": "e1", "source": "p1", "target": "c1", "type": "TITULAR", "properties": {}}],
}


class _Snapshots:
    def __init__(self, data=SNAPSHOT):
        self.data = data

    async def load(self, exploration_id):
        return snapshot.compress_snapshot(self.data)


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
    context = store.create_graph_context(
        "Pix", "e", "n", OWNER,
        identity_keys=[{"node_type": "Pessoa", "entity": "Pessoa", "source": {"name": "cpf"}, "normalize": "cpf_cnpj"}],
    )
    exploration = store.create_exploration(context.id, "Contas mula", OWNER, {"has_snapshot": True})
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    mount_mcp(app)
    yield app, exploration
    InMemoryStore.reset()
    get_settings.cache_clear()


def _rest(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"X-Forwarded-Email": OWNER}
    )


def _mcp(app, token):
    http = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), headers={"Authorization": f"Bearer {token}"})
    return Client(streamable_http_client("http://test/mcp", http_client=http))


async def _tool(client, tool, **args):
    result = await client.call_tool(tool, args)
    assert not result.is_error, result.content
    return json.loads(result.content[0].text)["untrusted_data"]


@pytest.mark.asyncio
async def test_agent_works_the_case_attributed_and_masked(env):
    app, exploration = env
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        async with _mcp(app, token) as client:
            tools = {t.name for t in (await client.list_tools()).tools}
            assert {"create_investigation", "get_graph", "list_items", "get_item", "add_item", "annotate",
                    "run_query", "get_brief", "write_brief", "search_case", "pin_evidence"} <= tools
            assert not tools & {"delete_investigation", "share_investigation", "propose", "upload_artifact"}
            prompts = {p.name for p in (await client.list_prompts()).prompts}
            assert prompts == {"investigar_golpe_pix", "revisar_lojista", "montar_dossie"}
            prompt = await client.get_prompt("montar_dossie", {"investigation_id": "c-1"})
            assert "c-1" in prompt.messages[0].content.text and "write_brief" in prompt.messages[0].content.text

            case = await _tool(client, "create_investigation", title="Golpe Pix", kind_preset="pix_med")
            cid = case["id"]
            ref = await _tool(client, "add_item", investigation_id=cid, kind="graph", subkind="exploration_ref",
                              exploration_id=str(exploration.id))
            assert ref["author_kind"] == "agent" and ref["status"] == "confirmed"
            graph = await _tool(client, "get_graph", investigation_id=cid)
            dump = json.dumps(graph)
            # CPF and account leave masked, in properties and in the unified id.
            assert "456.789" in dump and CPF not in dump and "12345678901" not in dump and "1234-567890" not in dump
            person = next(n for n in graph["nodes"] if n["type"] == "Pessoa")
            assert person["uid"] == "Pessoa:***.456.789-**"

            note = await _tool(client, "add_item", investigation_id=cid, kind="note", subkind="anchored",
                               title="Achado", text="Recebeu de 5 vítimas", anchor={"entity_ids": [person["uid"]]})
            doc = await _tool(client, "add_item", investigation_id=cid, kind="document", subkind="markdown",
                              title="resumo.md", text=f"# Resumo\nTitular {CPF}")
            read = await _tool(client, "get_item", investigation_id=cid, item_id=doc["id"])
            assert CPF not in read["text"] and read["versions"][0]["version"] == 1
            csv = await _tool(client, "add_item", investigation_id=cid, kind="table", subkind="csv", title="qsa.csv",
                              text=f"cnpj;socio\n12.345.678/0001-90;{CPF}",
                              mapping={"as": "enrichment", "spec": {"name": "QSA", "input": {"delimiter": ";"},
                                       "key_column": "cnpj", "columns": ["socio"], "match_node_types": ["Lojista"]}})
            assert csv["mapping"]["spec"]["key_column"] == "cnpj"
            got = await _tool(client, "get_item", investigation_id=cid, item_id=csv["id"])
            assert CPF not in got["text"] and "0001-90" not in got["text"]
            hits = await _tool(client, "search_case", investigation_id=cid, q="titular")
            assert [h["title"] for h in hits] == ["resumo.md"]

            role = await _tool(client, "annotate", investigation_id=cid, kind="role", targets=[person["uid"]],
                               value={"role": "mula"}, reason="Repassa em minutos")
            assert role["status"] == "suggested" and role["targets"] == ["Pessoa:***.456.789-**"]
            brief = await _tool(client, "write_brief", investigation_id=cid, text="# Brief\nConta de passagem")
            assert brief["item"]["subkind"] == "brief"
            pinned = await _tool(client, "pin_evidence", investigation_id=cid, item_id=doc["id"], label="E1")
            assert pinned["pinned_by"] == OWNER and pinned["version"] == 1
            entity = await _tool(client, "get_entity", investigation_id=cid, uid=person["uid"])
            assert entity["notes"][0]["title"] == "Achado" and entity["annotations"][0]["kind"] == "role"
            summary = await _tool(client, "get_investigation", investigation_id=cid)
            assert summary["items"] == 5 and summary["suggested"] == 1 and summary["kind_preset"] == "pix_med"

        # A person sees the real ids; every write shows the agent acting for OWNER.
        [stored] = (await rest.get(f"/api/investigations/{cid}/annotations")).json()
        assert stored["targets"] == ["Pessoa:12345678901"] and stored["author_kind"] == "agent"
        r = await rest.post(f"/api/investigations/{cid}/annotations/{stored['id']}/confirm")
        assert r.status_code == 200 and r.json()["confirmed_by"] == OWNER
        events = (await rest.get(f"/api/investigations/{cid}/events")).json()
        assert {e["kind"] for e in events} >= {"item.created", "item.version_added", "role.suggested", "item.pinned"}
        agent_events = [e for e in events if e["kind"] != "role.confirmed"]
        assert all(e["actor_kind"] == "agent" and e["agent_name"] == "claude" for e in agent_events)
        assert all(e["actor_email"] == OWNER for e in events)
        assert note["anchor"]["entity_ids"] == ["Pessoa:***.456.789-**"]  # as the agent saw it


@pytest.mark.asyncio
async def test_people_are_kept_out_of_mcp_and_agents_out_of_human_only_routes(env):
    app, _ = env
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "ro"})).json()["token"]
        cid = (await rest.post("/api/investigations", json={"title": "x"})).json()["id"]
        r = await rest.post(f"/api/investigations/{cid}/decision", json={"outcome": "arquivar", "rationale": "x"},
                            headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 403 and r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
        # Without an agent token there is no MCP: a person uses the UI.
        assert (await rest.post("/mcp", json={})).status_code == 401


def test_mask_text_keeps_the_middle_digits():
    assert mask_text("CPF 123.456.789-01") == "CPF ***.456.789-**"
    assert mask_text("12345678000199") == "**.345.678/****-**"
    assert mask_text("sha 0a12345678901b") == "sha 0a12345678901b"  # not a document


@pytest.mark.asyncio
async def test_resolve_entities_suggests_same_as_a_person_confirms(env, monkeypatch):
    app, exploration = env
    snap = {"nodes": [
        {"id": "p1", "type": "Pessoa", "properties": {"nome": "Ana Lima", "cpf": CPF, "cep": "01001-000"}},
        {"id": "t9", "type": "Titular", "properties": {"nome": "ANA LIMA", "cpf": "***.456.789-**", "cep": "01001999"}},
    ], "edges": []}
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: _Snapshots(snap))
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        cid = (await rest.post("/api/investigations", json={"title": "x"})).json()["id"]
        url = f"/api/investigations/{cid}"
        await rest.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(exploration.id)})
        async with _mcp(app, token) as client:
            out = await _tool(client, "resolve_entities", investigation_id=cid)
            assert len(out["created"]) == 1 and out["created"][0]["status"] == "suggested"
            assert (await _tool(client, "resolve_entities", investigation_id=cid))["created"] == []  # no duplicates
            [same] = await _tool(client, "list_annotations", investigation_id=cid, kind="same_as")
            assert CPF not in json.dumps(same)
            assert len((await _tool(client, "get_graph", investigation_id=cid))["nodes"]) == 2
        [stored] = (await rest.get(f"{url}/annotations")).json()
        r = await rest.post(f"{url}/annotations/{stored['id']}/confirm")
        assert r.status_code == 200, r.text
        graph = (await rest.get(f"{url}/graph")).json()
        assert len(graph["nodes"]) == 1 and graph["nodes"][0]["properties"]["cep"] == "01001-000"
        kinds = [e["kind"] for e in (await rest.get(f"{url}/events")).json()]
        assert kinds.index("same_as.suggested") < kinds.index("same_as.confirmed")


@pytest.mark.asyncio
async def test_trace_money_find_paths_and_typologies_on_the_case_graph(env, monkeypatch):
    """The golpe-pix fixture as an exploration item; the route and the MCP tool
    give the browser's FIFO numbers, with the method stamp, and journal the run."""
    from tests.test_trace import FIXTURE

    app, exploration = env
    snap = {
        "nodes": [{"id": n["node_id"], "type": n["node_type"], "properties": n.get("properties", {})} for n in FIXTURE["nodes"]],
        "edges": [{"id": e["edge_id"], "source": e["src"], "target": e["dst"], "type": e["relationship_type"],
                   "properties": e["properties"]} for e in FIXTURE["edges"]],
    }
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: _Snapshots(snap))
    ctx = str(exploration.graph_context_id)
    InMemoryStore.get_instance().update_graph_context(exploration.graph_context_id, edge_semantics=FIXTURE["edge_semantics"])
    fifo = next(c["expected"] for c in FIXTURE["cases"] if c["name"] == "fifo")
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        cid = (await rest.post("/api/investigations", json={"title": "x"})).json()["id"]
        url = f"/api/investigations/{cid}"
        item = (await rest.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref",
                                                        "exploration_id": str(exploration.id)})).json()
        sid = item["id"]

        r = await rest.post(f"{url}/analysis/trace", json={"seed_edge_ids": [f"{sid}:e2"]})
        assert r.status_code == 200, r.text
        result = r.json()
        assert result["exits"] == {f"{k}@{ctx}": v for k, v in fifo["exits"].items()}
        assert result["coverage"] == fifo["coverage"] and result["method"]["engine"] == "server"

        async with _mcp(app, token) as client:
            out = await _tool(client, "trace_money", investigation_id=cid, seed_node=f"0001-9@{ctx}", allocation="proportional")
            assert out["exits"][f"exchange-gama@{ctx}"] == 1597.73 and out["method"]["seedEdgeIds"] == [f"{sid}:e2"]
            # The agent keeps the run as a table item stamped with the method and pins it.
            saved = await _tool(client, "add_item", investigation_id=cid, kind="table", subkind="result",
                                title="Rastreio proporcional", content_json=out,
                                provenance={"tool": "trace", "params": out["method"]})
            assert saved["latest"]["content_type"] == "application/json"
            await _tool(client, "pin_evidence", investigation_id=cid, item_id=saved["id"])
            paths = await _tool(client, "find_paths", investigation_id=cid, source=f"0001-9@{ctx}", target=f"saque-atm@{ctx}")
            assert [n.split("@")[0] for n in paths["paths"][0]["nodes"]] == ["0001-9", "4471-0", "5520-3", "saque-atm"]
            typ = await _tool(client, "run_typologies", investigation_id=cid, typologies=["passagem"])
            [passagem] = typ["typologies"]
            assert passagem["normRef"] == "CC 4.001 IV-k, IV-ad" and f"4471-0@{ctx}" in [h["nodeId"] for h in passagem["hits"]]
            badge = await _tool(client, "annotate", investigation_id=cid, kind="typology",
                                targets=[h["nodeId"] for h in passagem["hits"]],
                                value={"typology": "passagem", "norm_ref": passagem["normRef"], "label": passagem["label"]})
            assert badge["status"] == "suggested"

        r = await rest.post(f"{url}/analysis/typologies", json={"typologies": ["nope"]})
        assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "UNKNOWN_TYPOLOGY"
        assert len((await rest.post(f"{url}/analysis/typologies", json={})).json()["typologies"]) == 7
        package = (await rest.get(f"{url}/export?format=json")).json()
        assert package["trace_methods"][0]["method"]["allocation"] == "proportional"
        events = (await rest.get(f"{url}/events")).json()
        assert [e["payload"]["allocation"] for e in events if e["kind"] == "trace.run"] == ["fifo", "proportional"]
        assert any(e["kind"] == "path.run" for e in events)
