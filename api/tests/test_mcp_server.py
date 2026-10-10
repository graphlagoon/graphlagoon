"""MCP server at /mcp (05 §6): the SDK client acts as an analyst on the case
through tools that are twins of the human actions, every write attributed to
the agent, suggestions where the case says so, personal data masked."""

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
from graphlagoon.mcp.registry import TOOL_ROUTES  # noqa: E402
from graphlagoon.mcp.server import mask_text, mcp_lifespan, mount_mcp  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.routers import graph as graph_router  # noqa: E402
from graphlagoon.services import investigation_storage, org_library, snapshot  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from tests.test_case_queries import _Datasource  # noqa: E402

OWNER = "owner@example.com"
CPF = "123.456.789-01"
MASKED_CPF = "***.456.789-**"
SNAPSHOT = {
    "nodes": [
        {"id": "p1", "type": "Pessoa", "properties": {"nome": "Ana", "cpf": CPF, "telefone": "11 99999-0000"}},
        {"id": "p2", "type": "Pessoa", "properties": {"nome": "Bia", "cpf": "987.654.321-00", "telefone": "11 99999-0000"}},
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
    monkeypatch.setenv("GRAPH_LAGOON_WAREHOUSE_POLL_INTERVAL", "0")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: _Snapshots())
    ds = _Datasource()
    monkeypatch.setattr(graph_router, "resolve_datasource_or_400", lambda context: ds)

    async def no_scope(*args, **kwargs):
        return None

    monkeypatch.setattr(graph_router, "enforce_query_scope", no_scope)
    monkeypatch.setattr("graphlagoon.services.datasource.base.require_capability", lambda *a, **k: None)
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


async def _resource(client, uri):
    result = await client.read_resource(uri)
    return result.contents[0].text


@pytest.mark.asyncio
async def test_agent_works_the_case_end_to_end(env):
    """brief → search → save+run query → table → group → role (suggested) →
    markdown read as masked text → changes_since; a person confirms inline."""
    app, exploration = env
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        async with _mcp(app, token) as client:
            tools = {t.name: t for t in (await client.list_tools()).tools}
            assert set(tools) == set(TOOL_ROUTES)
            assert {"list_cases", "get_brief", "read_item", "add_note", "add_document", "save_query", "import_file",
                    "group", "run_analysis", "changes_since", "get_playbook", "list_vocabulary"} <= set(tools)
            assert not {n for n in tools if any(w in n for w in ("delete", "share", "decision", "export", "confirm", "reject"))}
            assert tools["add_note"].meta["human_equivalent"] == ["POST /api/investigations/{investigation_id}/items"]
            prompts = {p.name for p in (await client.list_prompts()).prompts}
            assert prompts == set(org_library.SEED) | {"playbook"}
            prompt = await client.get_prompt("montar_dossie", {"investigation_id": "c-1"})
            assert "Case c-1" in prompt.messages[0].content.text and "write_brief" in prompt.messages[0].content.text
            templates = {t.uri_template for t in (await client.list_resource_templates()).resource_templates}
            assert {"case://{investigation_id}/brief", "case://{investigation_id}/items/{item_id}",
                    "case://{investigation_id}/graph{?offset,limit}", "case://{investigation_id}/changes{?since}",
                    "org://playbooks/{slug}", "org://vocabularies/{kind}"} <= templates

            case = await _tool(client, "create_case", title="Golpe Pix", kind_preset="pix_med")
            cid = case["id"]
            t0 = (await _tool(client, "changes_since", investigation_id=cid))["now"]

            # 1. brief, as a tool and as a resource
            assert (await _tool(client, "get_brief", investigation_id=cid))["text"] in (None, "")
            await _tool(client, "write_brief", investigation_id=cid, text="# Brief\nConta de passagem")
            assert "Conta de passagem" in await _resource(client, f"case://{cid}/brief")

            # 2. material and search
            ref = await _tool(client, "add_item", investigation_id=cid, kind="graph", subkind="exploration_ref",
                              exploration_id=str(exploration.id))
            assert ref["author_kind"] == "agent" and ref["status"] == "confirmed"
            doc = await _tool(client, "add_document", investigation_id=cid, title="resumo.md",
                              text=f"# Resumo\nTitular {CPF} recebeu de 5 vítimas")
            link = await _tool(client, "add_document", investigation_id=cid, title="BCB", url="https://bcb.gov.br/med")
            assert (doc["subkind"], link["subkind"], link["provenance"]["url"]) == ("markdown", "link", "https://bcb.gov.br/med")
            hits = await _tool(client, "search_case", investigation_id=cid, q="titular")
            assert [h["title"] for h in hits] == ["resumo.md"] and CPF not in hits[0]["snippet"]

            # 3. a saved query of the case, run against the (mocked) warehouse
            query = await _tool(client, "save_query", investigation_id=cid, context_id=str(exploration.graph_context_id),
                                title="Top recebedores", text="SELECT cpf, total FROM t WHERE uf = :uf",
                                parameters=[{"id": "uf", "label": "UF", "default": "SP"}])
            assert query["kind"] == "query" and query["query"]["parameters"][0]["id"] == "uf"
            ran = await _tool(client, "run_query", investigation_id=cid, item_id=query["id"])
            assert ran["latest"]["run"]["row_count"] == 2 and ran["latest"]["run"]["author_kind"] == "agent"
            rows = await _tool(client, "read_item", investigation_id=cid, item_id=query["id"])
            assert "***.456.789-**" in rows["text"] and "12345678901" not in rows["text"]

            # 4. a table the agent computed, then a group of entities
            table = await _tool(client, "add_table", investigation_id=cid, title="Mulas", columns=["conta", "n"], rows=[["1", 5]])
            assert table["subkind"] == "result" and table["provenance"] == {"tool": "agent"}
            graph = await _tool(client, "get_graph", investigation_id=cid, limit=2)
            assert graph["total"] == 3 and len(graph["nodes"]) == 2
            people = [n["uid"] for n in (await _tool(client, "get_graph", investigation_id=cid))["nodes"] if n["type"] == "Pessoa"]
            ana = next(u for u in people if "456.789" in u)
            assert ana == f"Pessoa:{MASKED_CPF}"
            grp = await _tool(client, "group", investigation_id=cid, action="create", name="Rede", entity_ids=[ana])
            assert grp["kind"] == "group" and grp["status"] == "confirmed" and grp["value"]["by"] == "agent"
            grp = await _tool(client, "group", investigation_id=cid, action="add", name="Rede", entity_ids=people)
            assert sorted(grp["targets"]) == sorted(people)
            grp = await _tool(client, "group", investigation_id=cid, action="remove", group_id=grp["id"], entity_ids=[ana])
            assert grp["targets"] == [u for u in people if u != ana]

            # 5. a role from the org vocabulary: suggested, a person confirms
            vocabulary = await _tool(client, "list_vocabulary", kind="role", kind_preset="pix_med")
            assert vocabulary["suggested"][:2] == ["vítima", "mula"]
            role = await _tool(client, "annotate", investigation_id=cid, kind="role", targets=[ana],
                               value={"role": "mula"}, reason="Repassa em minutos")
            assert role["status"] == "suggested" and role["targets"] == [ana]
            note = await _tool(client, "add_note", investigation_id=cid, text="Recebeu de 5 vítimas", entity_ids=[ana])
            assert note["subkind"] == "anchored" and note["anchor"]["entity_ids"] == [ana]
            status = await _tool(client, "update_case", investigation_id=cid, status="analysis", tags=["pix"])
            assert status["status"] == "open" and status["tags"] == ["pix"]  # status change is a suggestion

            # 6. the markdown item as text: masked by tool and by resource; never bytes
            read = await _tool(client, "read_item", investigation_id=cid, item_id=doc["id"], offset=9, limit=20)
            assert read["text"] == f"Titular {MASKED_CPF}"[:20] and read["text_length"] == len(f"# Resumo\nTitular {CPF} recebeu de 5 vítimas")
            text = await _resource(client, f"case://{cid}/items/{doc['id']}")
            assert MASKED_CPF in text and CPF not in text
            pinned = await _tool(client, "pin_evidence", investigation_id=cid, item_id=doc["id"], label="E1")
            assert pinned["pinned_by"] == OWNER and pinned["version"] == 1

            # 7. what changed since the start, and since now
            changes = await _tool(client, "changes_since", investigation_id=cid, since=t0)
            kinds = {e["kind"] for e in changes["events"]}
            assert {"item.created", "role.suggested", "group.set", "item.pinned", "status_change.suggested"} <= kinds
            assert {i["title"] for i in changes["items"]} >= {"resumo.md", "Top recebedores", "Mulas"}
            assert {a["kind"] for a in changes["annotations"]} == {"group", "role", "status_change"}
            assert CPF not in json.dumps(changes)
            later = json.loads(await _resource(client, f"case://{cid}/changes?since={changes['now']}"))["untrusted_data"]
            assert later["events"] == [] and later["items"] == []
            playbook = await _tool(client, "get_playbook", slug="revisar_lojista")
            assert playbook["seeded"] and "run_analysis" in playbook["body"]
            assert "hub_atributo" in await _resource(client, "org://playbooks/revisar_lojista")
            summary = await _tool(client, "get_case", investigation_id=cid)
            assert summary["suggested"] == 2 and summary["kind_preset"] == "pix_med"

        # A person sees the real ids; every write shows the agent acting for OWNER.
        stored = (await rest.get(f"/api/investigations/{cid}/annotations?kind=role")).json()
        assert stored[0]["targets"] == ["Pessoa:12345678901"] and stored[0]["author_kind"] == "agent"
        r = await rest.post(f"/api/investigations/{cid}/annotations/{stored[0]['id']}/confirm")
        assert r.status_code == 200 and r.json()["confirmed_by"] == OWNER
        events = (await rest.get(f"/api/investigations/{cid}/events")).json()
        agent_events = [e for e in events if e["kind"] != "role.confirmed"]
        assert agent_events and all(e["actor_kind"] == "agent" and e["agent_name"] == "claude" for e in agent_events)
        assert all(e["actor_email"] == OWNER for e in events)
        [t] = (await rest.get("/api/agent-tokens")).json()
        assert t["last_used_at"] is not None


@pytest.mark.asyncio
async def test_unmasked_token_needs_the_org_policy(env, monkeypatch):
    """read_item: masked by default; token.unmasked alone is not enough; org ∧ token lifts it."""
    app, _ = env
    async with mcp_lifespan(app), _rest(app) as rest:
        cid = (await rest.post("/api/investigations", json={"title": "x"})).json()["id"]
        doc = (await rest.post(f"/api/investigations/{cid}/items", json={
            "kind": "document", "subkind": "markdown", "title": "d", "content": f"CPF {CPF}"})).json()
        token = (await rest.post("/api/agent-tokens", json={"name": "u", "unmasked": True})).json()["token"]
        async with _mcp(app, token) as client:
            assert (await _tool(client, "read_item", investigation_id=cid, item_id=doc["id"]))["text"] == f"CPF {MASKED_CPF}"
        monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ALLOW_UNMASKED_DATA", "true")
        get_settings.cache_clear()
        async with _mcp(app, token) as client:
            assert (await _tool(client, "read_item", investigation_id=cid, item_id=doc["id"]))["text"] == f"CPF {CPF}"
            assert CPF in await _resource(client, f"case://{cid}/items/{doc['id']}")


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
async def test_run_analysis_er_and_links_suggest_and_group(env, monkeypatch):
    app, exploration = env
    snap = {"nodes": [
        {"id": "p1", "type": "Pessoa", "properties": {"nome": "Ana Lima", "cpf": CPF, "cep": "01001-000", "telefone": "11 98888-7777"}},
        {"id": "t9", "type": "Titular", "properties": {"nome": "ANA LIMA", "cpf": "***.456.789-**", "cep": "01001999"}},
        {"id": "p3", "type": "Pessoa", "properties": {"nome": "Caio", "cpf": "111.222.333-44", "telefone": "(11) 98888-7777"}},
    ], "edges": []}
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: _Snapshots(snap))
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        cid = (await rest.post("/api/investigations", json={"title": "x"})).json()["id"]
        url = f"/api/investigations/{cid}"
        await rest.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(exploration.id)})
        async with _mcp(app, token) as client:
            out = await _tool(client, "run_analysis", investigation_id=cid, kind="er")
            assert len(out["created"]) == 1 and out["created"][0]["status"] == "suggested"
            assert (await _tool(client, "run_analysis", investigation_id=cid, kind="er"))["created"] == []  # no duplicates
            [same] = await _tool(client, "list_annotations", investigation_id=cid, kind="same_as")
            assert CPF not in json.dumps(same)
            links = await _tool(client, "run_analysis", investigation_id=cid, kind="links",
                                params={"attributes": ["telefone"]}, save=True, title="Vínculos telefone")
            assert links["result"]["pairs"][0]["shared"] == ["telefone"] and links["item"]["subkind"] == "derived"
            assert links["item"]["provenance"]["tool"] == "links" and CPF not in json.dumps(links)
            # the saved derived layer is part of the unified graph: the pair is now a community
            communities = await _tool(client, "run_analysis", investigation_id=cid, kind="communities")
            [pair] = communities["result"]["communities"]
            assert pair["size"] == 2 and f"Pessoa:{MASKED_CPF}" in pair["members"]
        [stored] = (await rest.get(f"{url}/annotations?kind=same_as")).json()
        r = await rest.post(f"{url}/annotations/{stored['id']}/confirm")
        assert r.status_code == 200, r.text
        graph = (await rest.get(f"{url}/graph")).json()
        assert len(graph["nodes"]) == 2 and any(n["properties"].get("cep") == "01001-000" for n in graph["nodes"])


@pytest.mark.asyncio
async def test_run_analysis_trace_paths_and_typologies_on_the_case_graph(env, monkeypatch):
    """The golpe-pix fixture as an exploration item; route and tool give the
    browser's FIFO numbers, with the method stamp, and journal the run."""
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
            out = await _tool(client, "run_analysis", investigation_id=cid, kind="trace",
                              params={"seed_node": f"0001-9@{ctx}", "allocation": "proportional"}, save=True)
            assert out["result"]["exits"][f"exchange-gama@{ctx}"] == 1597.73
            assert out["result"]["method"]["seedEdgeIds"] == [f"{sid}:e2"]
            # The run is kept as a table item stamped with the method; the agent pins it.
            assert out["item"]["provenance"]["params"]["allocation"] == "proportional"
            await _tool(client, "pin_evidence", investigation_id=cid, item_id=out["item"]["id"])
            paths = await _tool(client, "run_analysis", investigation_id=cid, kind="paths",
                                params={"source": f"0001-9@{ctx}", "target": f"saque-atm@{ctx}"})
            assert [n.split("@")[0] for n in paths["result"]["paths"][0]["nodes"]] == ["0001-9", "4471-0", "5520-3", "saque-atm"]
            typ = await _tool(client, "run_analysis", investigation_id=cid, kind="typologies", params={"typologies": ["passagem"]})
            [passagem] = typ["result"]["typologies"]
            assert passagem["normRef"] == "CC 4.001 IV-k, IV-ad" and f"4471-0@{ctx}" in [h["nodeId"] for h in passagem["hits"]]
            badge = await _tool(client, "annotate", investigation_id=cid, kind="typology",
                                targets=[h["nodeId"] for h in passagem["hits"]],
                                value={"typology": "passagem", "norm_ref": passagem["normRef"], "label": passagem["label"]})
            assert badge["status"] == "suggested"
            communities = await _tool(client, "run_analysis", investigation_id=cid, kind="communities", params={"min_size": 3})
            assert communities["result"]["communities"][0]["size"] >= 3
            result = await client.call_tool("run_analysis", {"investigation_id": cid, "kind": "nope"})
            assert result.is_error and "UNKNOWN_ANALYSIS" in result.content[0].text

        package = (await rest.get(f"{url}/export?format=json")).json()
        assert package["trace_methods"][0]["method"]["allocation"] == "proportional"
        events = (await rest.get(f"{url}/events")).json()
        assert [e["payload"]["allocation"] for e in events if e["kind"] == "trace.run"] == ["fifo", "proportional"]
        assert any(e["kind"] == "path.run" for e in events)
