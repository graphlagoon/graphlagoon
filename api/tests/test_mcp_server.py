"""MCP server at /mcp (05 §6): the SDK client acts as an analyst on the case
through tools that are twins of the human actions, every write attributed to
the agent, suggestions where the case says so, case data as untrusted data."""

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
from graphlagoon.mcp.server import mcp_lifespan, mount_mcp  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.routers import graph as graph_router  # noqa: E402
from graphlagoon.services import investigation_storage, org_library, snapshot  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from tests.test_case_queries import _Datasource  # noqa: E402

OWNER = "owner@example.com"
DOC = "078-05-1120"
SNAPSHOT = {
    "nodes": [
        {"id": "p1", "type": "Person", "properties": {"name": "Ana", "national_id": DOC, "phone": "415 555 0100"}},
        {"id": "p2", "type": "Person", "properties": {"name": "Bia", "national_id": "219-09-9999", "phone": "415 555 0100"}},
        {"id": "c1", "type": "Account", "properties": {"account": "0341-1234-567890"}},
    ],
    "edges": [{"id": "e1", "source": "p1", "target": "c1", "type": "HOLDS", "properties": {}}],
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
        "Bank", "e", "n", OWNER,
        identity_keys=[{"node_type": "Person", "entity": "Person", "source": {"name": "national_id"}, "normalize": "digits"}],
    )
    exploration = store.create_exploration(context.id, "Mule accounts", OWNER, {"has_snapshot": True})
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
    markdown read as text → changes_since; a person confirms inline."""
    app, exploration = env
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        async with _mcp(app, token) as client:
            tools = {t.name: t for t in (await client.list_tools()).tools}
            assert set(tools) == set(TOOL_ROUTES)
            assert {"list_cases", "get_brief", "read_item", "add_note", "add_document", "save_query", "import_file",
                    "group", "run_analysis", "changes_since", "get_playbook", "get_case_type"} <= set(tools)
            assert not {n for n in tools if any(w in n.replace("propose_decision", "") for w in ("delete", "share", "decision", "export", "confirm", "reject"))}
            assert tools["add_note"].meta["human_equivalent"] == ["POST /api/investigations/{investigation_id}/items"]
            prompts = {p.name for p in (await client.list_prompts()).prompts}
            assert prompts == set(org_library.SEED) | {"playbook"}
            prompt = await client.get_prompt("assemble_brief", {"investigation_id": "c-1"})
            assert "Case c-1" in prompt.messages[0].content.text and "write_brief" in prompt.messages[0].content.text
            templates = {t.uri_template for t in (await client.list_resource_templates()).resource_templates}
            assert {"case://{investigation_id}/brief", "case://{investigation_id}/items/{item_id}",
                    "case://{investigation_id}/graph{?offset,limit}", "case://{investigation_id}/changes{?since}",
                    "org://playbooks/{slug}", "org://case-types/{slug}"} <= templates

            case = await _tool(client, "create_case", title="Mule network", external_ref="ALRT-7")
            cid = case["id"]
            again = await _tool(client, "create_case", title="Mule network (retry)", external_ref="ALRT-7")
            assert (case["created"], again["created"], again["id"]) == (True, False, cid)  # a retry is safe
            listed = await _tool(client, "list_cases", external_ref="ALRT-7")
            assert listed["total"] == 1 and listed["items"][0]["id"] == cid
            t0 = (await _tool(client, "changes_since", investigation_id=cid))["now"]

            # 1. brief, as a tool and as a resource
            assert (await _tool(client, "get_brief", investigation_id=cid))["text"] in (None, "")
            await _tool(client, "write_brief", investigation_id=cid, text="# Brief\nPass-through account")
            assert "Pass-through account" in await _resource(client, f"case://{cid}/brief")

            # 2. material and search
            ref = await _tool(client, "add_item", investigation_id=cid, kind="graph", subkind="exploration_ref",
                              exploration_id=str(exploration.id))
            assert ref["author_kind"] == "agent" and ref["status"] == "confirmed"
            doc = await _tool(client, "add_document", investigation_id=cid, title="summary.md",
                              text=f"# Summary\nHolder {DOC} received from 5 victims")
            link = await _tool(client, "add_document", investigation_id=cid, title="Policy", url="https://example.com/policy")
            assert (doc["subkind"], link["subkind"], link["provenance"]["url"]) == ("markdown", "link", "https://example.com/policy")
            hits = await _tool(client, "search_case", investigation_id=cid, q="holder")
            assert [h["title"] for h in hits] == ["summary.md"] and DOC in hits[0]["snippet"]

            # 3. a saved query of the case, run against the (mocked) warehouse
            query = await _tool(client, "save_query", investigation_id=cid, context_id=str(exploration.graph_context_id),
                                title="Top receivers", text="SELECT doc, total FROM t WHERE region = :region",
                                parameters=[{"id": "region", "label": "Region", "default": "west"}])
            assert query["kind"] == "query" and query["query"]["parameters"][0]["id"] == "region"
            ran = await _tool(client, "run_query", investigation_id=cid, item_id=query["id"])
            assert ran["latest"]["run"]["row_count"] == 2 and ran["latest"]["run"]["author_kind"] == "agent"
            rows = await _tool(client, "read_item", investigation_id=cid, item_id=query["id"])
            assert "12345678901" in rows["text"]  # what the person sees, the agent sees

            # 4. a table the agent computed, then a group of entities
            table = await _tool(client, "add_table", investigation_id=cid, title="Mules", columns=["account", "n"], rows=[["1", 5]])
            assert table["subkind"] == "result" and table["provenance"] == {"tool": "agent"}
            graph = await _tool(client, "get_graph", investigation_id=cid, limit=2)
            assert graph["total"] == 3 and len(graph["nodes"]) == 2
            people = [n["uid"] for n in (await _tool(client, "get_graph", investigation_id=cid))["nodes"] if n["type"] == "Person"]
            ana = "Person:078051120"
            assert ana in people
            grp = await _tool(client, "group", investigation_id=cid, action="create", name="Ring", entity_ids=[ana])
            assert grp["kind"] == "group" and grp["status"] == "confirmed" and grp["value"]["by"] == "agent"
            grp = await _tool(client, "group", investigation_id=cid, action="add", name="Ring", entity_ids=people)
            assert sorted(grp["targets"]) == sorted(people)
            grp = await _tool(client, "group", investigation_id=cid, action="remove", group_id=grp["id"], entity_ids=[ana])
            assert grp["targets"] == [u for u in people if u != ana]

            # 5. a role from the org vocabulary: suggested, a person confirms
            types = await _tool(client, "get_case_type")
            assert [t["slug"] for t in types] == ["general"]
            assert (await _tool(client, "get_case_type", slug="general"))["outcomes"] == []
            role = await _tool(client, "annotate", investigation_id=cid, kind="role", targets=[ana],
                               value={"role": "mule"}, reason="Forwards within minutes")
            assert role["status"] == "suggested" and role["targets"] == [ana]
            note = await _tool(client, "add_note", investigation_id=cid, text="Received from 5 victims", entity_ids=[ana])
            assert note["subkind"] == "anchored" and note["anchor"]["entity_ids"] == [ana]
            missing = await client.call_tool("add_note", {"investigation_id": cid, "text": "x", "entity_ids": ["Person:nobody"]})
            assert missing.is_error and "ENTITY_NOT_FOUND" in missing.content[0].text
            status = await _tool(client, "update_case", investigation_id=cid, status="analysis", tags=["fraud"])
            assert status["status"] == "open" and status["tags"] == ["fraud"]  # status change is a suggestion

            # 6. the markdown item as text, by tool and by resource; never bytes
            read = await _tool(client, "read_item", investigation_id=cid, item_id=doc["id"], offset=10, limit=18)
            assert read["text"] == f"Holder {DOC}" and read["text_length"] == len(f"# Summary\nHolder {DOC} received from 5 victims")
            assert DOC in await _resource(client, f"case://{cid}/items/{doc['id']}")
            pinned = await _tool(client, "pin_evidence", investigation_id=cid, item_id=doc["id"], label="E1")
            assert pinned["pinned_by"] == OWNER and pinned["version"] == 1

            # 7. what changed since the start, and since now
            changes = await _tool(client, "changes_since", investigation_id=cid, since=t0)
            kinds = {e["kind"] for e in changes["events"]}
            assert {"item.created", "role.suggested", "group.set", "item.pinned", "status_change.suggested"} <= kinds
            assert {i["title"] for i in changes["items"]} >= {"summary.md", "Top receivers", "Mules"}
            assert {a["kind"] for a in changes["annotations"]} == {"group", "role", "status_change"}
            later = json.loads(await _resource(client, f"case://{cid}/changes?since={changes['now']}"))["untrusted_data"]
            assert later["events"] == [] and later["items"] == []
            playbook = await _tool(client, "get_playbook", slug="triage")
            assert playbook["seeded"] and "run_analysis" in playbook["body"]
            assert "write_brief" in await _resource(client, "org://playbooks/triage")
            summary = await _tool(client, "get_case", investigation_id=cid)
            assert summary["suggested"] == 2 and summary["case_type"]["label"] == "General"

        # A person sees the real ids; every write shows the agent acting for OWNER.
        stored = (await rest.get(f"/api/investigations/{cid}/annotations?kind=role")).json()
        assert stored[0]["targets"] == ["Person:078051120"] and stored[0]["author_kind"] == "agent"
        r = await rest.post(f"/api/investigations/{cid}/annotations/{stored[0]['id']}/confirm")
        assert r.status_code == 200 and r.json()["confirmed_by"] == OWNER
        events = (await rest.get(f"/api/investigations/{cid}/events")).json()
        agent_events = [e for e in events if e["kind"] != "role.confirmed"]
        assert agent_events and all(e["actor_kind"] == "agent" and e["agent_name"] == "claude" for e in agent_events)
        assert all(e["actor_email"] == OWNER for e in events)
        [t] = (await rest.get("/api/agent-tokens")).json()
        assert t["last_used_at"] is not None


@pytest.mark.asyncio
async def test_people_are_kept_out_of_mcp_and_agents_out_of_human_only_routes(env):
    app, _ = env
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "ro"})).json()["token"]
        cid = (await rest.post("/api/investigations", json={"title": "x"})).json()["id"]
        r = await rest.post(f"/api/investigations/{cid}/decisions", json={"outcome_label": "No action", "rationale": "x"},
                            headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 403 and r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
        # Without an agent token there is no MCP: a person uses the UI.
        assert (await rest.post("/mcp", json={})).status_code == 401


@pytest.mark.asyncio
async def test_a_case_scoped_token_cannot_open_cases(env):
    app, _ = env
    async with mcp_lifespan(app), _rest(app) as rest:
        cid = (await rest.post("/api/investigations", json={"title": "x"})).json()["id"]
        token = (await rest.post("/api/agent-tokens", json={"name": "scoped", "scope": "case", "investigation_ids": [cid]})).json()["token"]
        async with _mcp(app, token) as client:
            result = await client.call_tool("create_case", {"title": "elsewhere"})
            assert result.is_error and "CASE_SCOPED_TOKEN" in result.content[0].text
        # REST already refuses it before the service (the case routes of a scoped token are its cases).
        r = await rest.post("/api/investigations", json={"title": "y"}, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 403


@pytest.mark.asyncio
async def test_run_analysis_er_and_links_suggest_and_group(env, monkeypatch):
    app, exploration = env
    snap = {"nodes": [
        {"id": "p1", "type": "Person", "properties": {"name": "Ana Lima", "national_id": DOC, "postcode": "01001-000",
                                                      "phone": "415 555 0100", "email": "ana@example.com"}},
        {"id": "t9", "type": "Holder", "properties": {"name": "ANA LIMA", "email": "Ana@Example.com", "phone": "(415) 555-0100"}},
        {"id": "p3", "type": "Person", "properties": {"name": "Caio", "national_id": "219-09-9999", "phone": "415-555-0100"}},
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
            assert same["targets"][0] == "Person:078051120" and same["targets"][1].startswith("t9@")
            links = await _tool(client, "run_analysis", investigation_id=cid, kind="links",
                                params={"attributes": ["phone"]}, save=True, title="Links by phone")
            assert links["result"]["pairs"][0]["shared"] == ["phone"] and links["item"]["subkind"] == "derived"
            assert links["item"]["provenance"]["tool"] == "links"
            assert all(e["type"] == "shares_phone" for e in links["result"]["edges"])
            # the saved derived layer is part of the unified graph: the linked entities are now a community
            communities = await _tool(client, "run_analysis", investigation_id=cid, kind="communities")
            [ring] = communities["result"]["communities"]
            assert ring["size"] == 3 and "Person:078051120" in ring["members"]
        [stored] = (await rest.get(f"{url}/annotations?kind=same_as")).json()
        r = await rest.post(f"{url}/annotations/{stored['id']}/confirm")
        assert r.status_code == 200, r.text
        graph = (await rest.get(f"{url}/graph")).json()
        assert len(graph["nodes"]) == 2 and any(n["properties"].get("postcode") == "01001-000" for n in graph["nodes"])


@pytest.mark.asyncio
async def test_run_analysis_trace_paths_and_communities_on_the_case_graph(env, monkeypatch):
    """The flow-chain fixture as an exploration item; route and tool give the
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
    stops = {"stop_types": FIXTURE["params"]["stopTypes"], "min_amount": FIXTURE["params"]["minAmount"]}
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        cid = (await rest.post("/api/investigations", json={"title": "x"})).json()["id"]
        url = f"/api/investigations/{cid}"
        item = (await rest.post(f"{url}/items", json={"kind": "graph", "subkind": "exploration_ref",
                                                        "exploration_id": str(exploration.id)})).json()
        sid = item["id"]

        r = await rest.post(f"{url}/analysis/trace", json={"seed_edge_ids": [f"{sid}:e2"], **stops})
        assert r.status_code == 200, r.text
        result = r.json()
        assert result["exits"] == {f"{k}@{ctx}": v for k, v in fifo["exits"].items()}
        assert result["coverage"] == fifo["coverage"] and result["method"]["engine"] == "server"

        async with _mcp(app, token) as client:
            out = await _tool(client, "run_analysis", investigation_id=cid, kind="trace",
                              params={"seed_node": f"0001-9@{ctx}", "allocation": "proportional", **stops}, save=True)
            assert out["result"]["exits"][f"exchange-gama@{ctx}"] == 1597.73
            assert out["result"]["method"]["seedEdgeIds"] == [f"{sid}:e2"]
            # The run is kept as a table item stamped with the method; the agent pins it.
            assert out["item"]["provenance"]["params"]["allocation"] == "proportional"
            await _tool(client, "pin_evidence", investigation_id=cid, item_id=out["item"]["id"])
            paths = await _tool(client, "run_analysis", investigation_id=cid, kind="paths",
                                params={"source": f"0001-9@{ctx}", "target": f"atm-cash@{ctx}"})
            assert [n.split("@")[0] for n in paths["result"]["paths"][0]["nodes"]] == ["0001-9", "4471-0", "5520-3", "atm-cash"]
            communities = await _tool(client, "run_analysis", investigation_id=cid, kind="communities", params={"min_size": 3})
            assert communities["result"]["communities"][0]["size"] >= 3
            result = await client.call_tool("run_analysis", {"investigation_id": cid, "kind": "nope"})
            assert result.is_error and "UNKNOWN_ANALYSIS" in result.content[0].text

        package = (await rest.get(f"{url}/export?format=json")).json()
        assert package["trace_methods"][0]["method"]["allocation"] == "proportional"
        events = (await rest.get(f"{url}/events")).json()
        assert [e["payload"]["allocation"] for e in events if e["kind"] == "trace.run"] == ["fifo", "proportional"]
        assert any(e["kind"] == "path.run" for e in events)


PNG = (  # a 1×1 PNG
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82"
)
RING = {
    "label": "Fraud ring",
    "vocabularies": {"roles": ["mule", "organizer"], "tags": [], "link_attributes": ["phone"]},
    "outcomes": [
        {"id": "escalate", "label": "Escalate as a ring", "closes_case": True},
        {"id": "monitor", "label": "Keep monitoring", "closes_case": False},
    ],
    "actions": [{"id": "block", "label": "Block the accounts", "due_hours": 2}],
    "fields": [{"id": "alert_id", "label": "Alert", "type": "text", "required": True}],
    "report_templates": ["ring-memo"],
}
SIGNUPS = {
    "version": 1, "name": "Sign-ups",
    "inputs": {"t": {"match": "*.csv", "delimiter": ";", "header": True}},
    "nodes": [
        {"key": "customer", "type": "Customer", "from": "t", "id": "t.customer"},
        {"key": "phone", "type": "Phone", "from": "t", "id": {"col": "t.phone", "normalize": "phone"}},
    ],
    "edges": [{"from": "t", "type": "USES_PHONE", "endpoints": {"self": "customer", "other": "phone"}}],
}


@pytest.mark.asyncio
async def test_claude_code_works_a_case_from_the_alert_to_the_proposed_decision(env):
    """06 P8: the acceptance flow of a Claude Code session — case types, an
    idempotent case from an alert, a file mapped onto the graph, a role, a task,
    an image it can look at, a report from the org template, the entity in another
    case, a proposed decision — and the person records it from the app."""
    from graphlagoon.services import case_types

    app, _ = env
    await org_library.put_doc("ring-memo", "Ring memo", "# Ring memo · {{case.title}}\n\n{{roles}}\n\nAlert {{fields.alert_id}}", "template")
    await case_types.put_case_type("fraud_ring", RING)
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        async with _mcp(app, token) as client:
            # 0. the quickstart playbook and the org's types
            quick = await _tool(client, "get_playbook", slug="claude_code_quickstart")
            assert "propose_decision" in quick["body"]
            assert [t["slug"] for t in await _tool(client, "get_case_type")] == ["general", "fraud_ring"]
            ring = await _tool(client, "get_case_type", slug="fraud_ring")
            assert [o["id"] for o in ring["outcomes"]] == ["escalate", "monitor"] and ring["fields"][0]["required"]

            # 1. a case for the alert, idempotent; another older case shares the phone
            case = await _tool(client, "create_case", title="Ring · sign-ups", case_type="fraud_ring",
                               fields={"alert_id": "ALRT-9"}, external_ref="ALRT-9")
            again = await _tool(client, "create_case", title="retry", case_type="fraud_ring",
                                fields={"alert_id": "ALRT-9"}, external_ref="ALRT-9")
            cid = case["id"]
            assert (case["created"], again["created"], again["id"]) == (True, False, cid)
            older = await _tool(client, "create_case", title="Refunds · last month", case_type="fraud_ring", fields={"alert_id": "A-1"})

            # 2. files onto the graph through a mapping
            csv = "customer;phone\nC1;+1 415 555 0100\nC2;415-555-0100\nC3;415 555 0199\n"
            for target, text in ((cid, csv), (older["id"], "customer;phone\nR7;(415) 555-0100\n")):
                imported = await _tool(client, "import_file", investigation_id=target, filename="signups.csv", text=text,
                                       mapping={"as": "graph", "spec": SIGNUPS})
                assert imported["mapping"]["as"] == "graph"
            graph = await _tool(client, "get_graph", investigation_id=cid)
            phone = "Phone:4155550100"  # the phone normalizer keeps digits: the same id in both cases
            assert phone in {n["uid"] for n in graph["nodes"]}
            customers = [n["uid"] for n in graph["nodes"] if n["type"] == "Customer"]
            seen = await _tool(client, "find_entity_cases", uid=phone, investigation_id=cid)
            assert [c["title"] for c in seen["cases"]] == ["Refunds · last month"] and seen["cases"][0]["present"]

            # 3. a role (suggested), a task for itself, a view of the canvas, an image it can look at
            role = await _tool(client, "annotate", investigation_id=cid, kind="role", targets=customers[:1],
                               value={"role": "mule"}, reason="shares the phone")
            assert role["status"] == "suggested"
            await rest.post(f"/api/investigations/{cid}/annotations/{role['id']}/confirm")
            task = await _tool(client, "add_task", investigation_id=cid, title="Pull 90 days of statements",
                               assignee_kind="agent", agent_name="claude", targets=customers[:1])
            assert task["status"] == "suggested" and task["value"]["agent_name"] == "claude"
            bad = await client.call_tool("add_item", {"investigation_id": cid, "kind": "graph", "subkind": "view",
                                                      "content_json": {"filters": {"colour": "red"}}})
            assert bad.is_error and "INVALID_CONTENT" in bad.content[0].text
            view = await _tool(client, "add_item", investigation_id=cid, kind="graph", subkind="view", title="The ring",
                               content_json={"filters": {"types": ["Customer", "Phone"]}, "layout": "force", "groups_closed": []})
            assert view["subkind"] == "view"
            shot = (await rest.post(f"/api/investigations/{cid}/items", content=PNG,
                                    params={"kind": "document", "subkind": "upload", "filename": "kyc-photo.png"},
                                    headers={"Content-Type": "image/png"})).json()
            image = await client.call_tool("read_item", {"investigation_id": cid, "item_id": shot["id"]})
            assert not image.is_error and [c.type for c in image.content] == ["text", "image"]
            assert image.content[1].mime_type == "image/png" and image.content[1].data
            assert "image content" in json.loads(image.content[0].text)["untrusted_data"]["image"]

            # 4. evidence, a report from the type's template, and the proposed decision
            pinned = await _tool(client, "pin_evidence", investigation_id=cid, item_id=view["id"], label="E1")
            assert pinned["version"] == 1
            listed = await _tool(client, "render_report", investigation_id=cid)
            assert listed["templates"][0] == {"slug": "ring-memo", "title": "Ring memo", "for_this_type": True}
            report = await _tool(client, "render_report", investigation_id=cid, template="ring-memo")
            assert report["status"] == "suggested"
            text = (await _tool(client, "read_item", investigation_id=cid, item_id=report["id"]))["text"]
            assert "Ring memo · Ring · sign-ups" in text and "mule" in text and "Alert ALRT-9" in text
            wrong = await client.call_tool("propose_decision", {"investigation_id": cid, "outcome": "jail", "rationale": "x"})
            assert wrong.is_error and "UNKNOWN_OUTCOME" in wrong.content[0].text
            proposal = await _tool(client, "propose_decision", investigation_id=cid, outcome="escalate", targets=customers[:2],
                                   tasks=[{"action": "block"}], rationale="Two customers share one phone (E1); one is a known mule.")
            assert (proposal["kind"], proposal["status"], proposal["author_kind"]) == ("decision_proposal", "suggested", "agent")
            # The agent cannot record it, nor confirm its own proposal.
            denied = await rest.post(f"/api/investigations/{cid}/decisions", json={"outcome": "escalate", "rationale": "x"},
                                     headers={"Authorization": f"Bearer {token}"})
            assert denied.status_code == 403

        # 5. the person records the proposed decision from the app
        r = await rest.post(f"/api/investigations/{cid}/annotations/{proposal['id']}/confirm")
        assert r.status_code == 409 and r.json()["detail"]["error"]["code"] == "PROPOSAL_NEEDS_DECISION"
        r = await rest.post(f"/api/investigations/{cid}/decisions", json={
            "outcome": "escalate", "targets": proposal["targets"], "tasks": proposal["value"]["tasks"],
            "rationale": proposal["value"]["rationale"], "proposal_id": proposal["id"],
        })
        assert r.status_code == 200, r.text
        decided = r.json()
        d = decided["decisions"][0]
        assert decided["status"] == "closed" and d["proposal_id"] == proposal["id"]
        assert d["proposed_by"] == {"author_kind": "agent", "author_email": OWNER}
        notes = (await rest.get(f"/api/investigations/{cid}/annotations", params={"kind": "decision_proposal"})).json()
        assert notes[0]["status"] == "confirmed"
        again = await rest.post(f"/api/investigations/{cid}/decisions", json={"outcome": "monitor", "rationale": "x", "proposal_id": proposal["id"]})
        assert again.status_code == 409  # closed

        # 6. afterwards the agent finds its follow-ups (the decision's task is a person's)
        async with _mcp(app, token) as client:
            await rest.post(f"/api/investigations/{cid}/annotations/{task['id']}/confirm")
            mine = await _tool(client, "list_tasks")
            assert [t["value"]["title"] for t in mine["tasks"]] == ["Pull 90 days of statements"]
            done = await _tool(client, "update_task", investigation_id=cid, task_id=task["id"], state="done", note="3 months pulled")
            assert done["value"]["state"] == "done"
