"""MCP tools on an exploration itself (no case needed): read its graph, create
one with a graph, add, delete, expand, query into and enrich it in place. The
edit lands in the saved snapshot under the same id, bumps the revision the
page polls, is audited, and is journalled in the cases that reference it."""

import json
import sys

import pytest

pytest.importorskip("mcp")

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

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.mcp.server import mcp_lifespan, mount_mcp  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.models.schemas import Edge, GraphResponse, Node  # noqa: E402
from graphlagoon.services.datasource.base import PreparedGraphQuery  # noqa: E402
from graphlagoon.routers import graph as graph_router  # noqa: E402
from graphlagoon.services import investigation_storage, snapshot, warehouse  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from tests.test_enrichment import DEVICES, _Warehouse  # noqa: E402
from tests.test_mcp_server import OWNER, _mcp, _rest, _tool  # noqa: E402

SNAP = {
    "nodes": [
        {"id": "1", "type": "Conta", "properties": {"titular": "Ana"}, "x": 10.0, "y": 20.0},
        {"id": "2", "type": "Conta", "properties": {"titular": "Bia"}},
    ],
    "edges": [{"id": "t1", "source": "1", "target": "2", "type": "PIX", "properties": {"valor": 100}}],
}


class _Files:
    """The snapshot service, in memory, per exploration and kind."""

    def __init__(self):
        self.files = {}

    async def save(self, eid, data, kind="snapshot"):
        self.files[(str(eid), kind)] = data

    async def load(self, eid, kind="snapshot"):
        return self.files.get((str(eid), kind))

    async def delete(self, eid, kind="snapshot"):
        self.files.pop((str(eid), kind), None)

    async def exists(self, eid, kind="snapshot"):
        return (str(eid), kind) in self.files

    def graph(self, eid, kind="snapshot"):
        return snapshot.decompress_snapshot(self.files[(str(eid), kind)])


class _Datasource:
    def __init__(self):
        self.queries = []

    def prepare_cypher(self, context, data):
        self.queries.append(data.query)
        return PreparedGraphQuery(statement="SELECT 1", transpiled_sql="SELECT 1")

    async def execute_prepared(self, context, prepared, **kwargs):
        return GraphResponse(
            nodes=[Node(node_id="2", node_type="Conta", properties={"titular": "Bia"}),
                   Node(node_id="9", node_type="Conta", properties={"titular": "Caio"})],
            edges=[Edge(edge_id="t9", src="2", dst="9", relationship_type="PIX", properties={"valor": 50})],
        )

    async def expand(self, context, data):
        return GraphResponse(
            nodes=[Node(node_id=data.node_id, node_type="Conta", properties={}),
                   Node(node_id="7", node_type="Conta", properties={"titular": "Duda"})],
            edges=[Edge(edge_id=f"x{data.node_id}", src=data.node_id, dst="7", relationship_type="PIX", properties={})],
        )


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    monkeypatch.setenv("GRAPH_LAGOON_CATALOG_SCHEMAS", "main.graphs")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    files = _Files()
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: files)
    ds = _Datasource()
    monkeypatch.setattr(graph_router, "resolve_datasource_or_400", lambda context: ds)

    async def no_scope(*args, **kwargs):
        return None

    monkeypatch.setattr(graph_router, "enforce_query_scope", no_scope)
    monkeypatch.setattr(warehouse, "get_warehouse_client", lambda: _Warehouse())
    store = InMemoryStore.get_instance()
    context = store.create_graph_context("Pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[DEVICES])
    exploration = store.create_exploration(context.id, "Mulas", OWNER, {"has_snapshot": True})
    files.files[(str(exploration.id), "snapshot")] = snapshot.compress_snapshot(SNAP)
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    mount_mcp(app)
    yield app, context, exploration, files, ds
    InMemoryStore.reset()
    get_settings.cache_clear()


async def _error(client, tool, **args):
    result = await client.call_tool(tool, args)
    assert result.is_error, result.content
    return result.content[0].text


@pytest.mark.asyncio
async def test_agent_edits_an_exploration_in_place_and_the_page_sees_it(env):
    app, context, exploration, files, ds = env
    eid = str(exploration.id)
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        cid = (await rest.post("/api/investigations", json={"title": "Caso"})).json()["id"]
        await rest.post(f"/api/investigations/{cid}/items", json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": eid})
        async with _mcp(app, token) as client:
            listed = await _tool(client, "list_explorations", context_id=str(context.id))
            assert [e["id"] for e in listed] == [eid]

            seen = await _tool(client, "get_exploration", exploration_id=eid)
            assert (seen["node_count"], seen["edge_count"], seen["revision"], seen["materialized"]) == (2, 1, 0, True)
            assert seen["nodes"][0]["origin"] == "snapshot"

            out = await _tool(client, "edit_exploration", exploration_id=eid, expected_revision=0,
                              add_nodes=[{"id": "3", "type": "Conta", "properties": {"titular": "Caio"}}],
                              add_edges=[{"id": "t2", "source": "2", "target": "3", "type": "PIX"}],
                              remove_edge_ids=["t1"], set_properties=[{"id": "1", "properties": {"risco": "alto"}}])
            assert (out["added_nodes"], out["added_edges"], out["removed_edges"], out["revision"]) == (1, 1, 1, 1)

            text = await _error(client, "edit_exploration", exploration_id=eid, expected_revision=0, remove_node_ids=["1"])
            assert "EXPLORATION_CHANGED" in text
            text = await _error(client, "edit_exploration", exploration_id=eid, remove_node_ids=["ghost"])
            assert "NODE_NOT_FOUND" in text

            out = await _tool(client, "edit_exploration", exploration_id=eid, remove_node_ids=["3"])
            assert (out["removed_nodes"], out["removed_edges"], out["node_count"]) == (1, 1, 2)

            out = await _tool(client, "expand_exploration", exploration_id=eid, node_ids=["1"])
            assert (out["added_nodes"], out["added_edges"]) == (1, 1)

            out = await _tool(client, "query_into_exploration", exploration_id=eid, query="MATCH (a)-[r]->(b) RETURN a, r, b")
            assert (out["added_nodes"], out["added_edges"]) == (1, 1)  # node 2 was there already

            out = await _tool(client, "enrich_exploration", exploration_id=eid, table="devices", node_ids=["1"], promote=True)
            assert (out["matched"], out["several_rows"], out["updated_nodes"]) == (1, 1, 1)
            assert (out["added_nodes"], out["added_edges"]) == (2, 2)

        # The page reads the same exploration: same id, the agent's graph, a newer revision.
        saved = files.graph(eid)
        nodes = {n["id"]: n for n in saved["nodes"]}
        assert set(nodes) == {"1", "2", "7", "9", "Dispositivo:d1", "Dispositivo:d2"}
        assert nodes["1"]["properties"] == {"titular": "Ana", "risco": "alto", "device_id": "d1", "ip": "10.0.0.1"}
        assert nodes["1"]["x"] == 10.0  # the layout of what was there is kept
        assert "t1" not in {e["id"] for e in saved["edges"]}
        page = (await rest.get(f"/api/explorations/{eid}")).json()
        assert page["state"]["revision"] == 5 and page["state"]["last_change"]["tool"] == "enrich_exploration"
        assert page["state"]["last_change"]["author_kind"] == "agent"
        assert (await rest.get(f"/api/explorations/{eid}/snapshot")).json()["nodes"] == saved["nodes"]

        # A browser save from the old revision is refused instead of overwriting the agent.
        r = await rest.put(f"/api/explorations/{eid}", json={"expected_revision": 0, "title": "Mulas 2"})
        assert r.status_code == 409 and r.json()["detail"]["error"]["code"] == "EXPLORATION_CHANGED"
        r = await rest.put(f"/api/explorations/{eid}", json={"expected_revision": 5, "title": "Mulas 2"})
        assert r.status_code == 200 and r.json()["state"]["revision"] == 6
        assert r.json()["state"]["last_change"]["author_kind"] == "human"

        # The case that references it journals each change; the case graph is the new one.
        events = (await rest.get(f"/api/investigations/{cid}/events")).json()
        changed = [e for e in events if e["kind"] == "exploration.changed"]
        assert len(changed) == 5 and changed[0]["actor_kind"] == "agent"
        assert changed[0]["payload"]["added_nodes"] == 1
        graph = (await rest.get(f"/api/investigations/{cid}/graph")).json()
        assert len(graph["nodes"]) == 6

        edits = [a for a in InMemoryStore.get_instance().usage_logs if a.action == "exploration.agent_edit"]
        assert len(edits) == 5 and edits[0].log_metadata["agent"]["name"] == "claude"
        assert edits[-1].log_metadata["tool"] == "enrich_exploration"


@pytest.mark.asyncio
async def test_create_an_exploration_with_a_graph_and_start_one_over(env):
    app, context, exploration, files, ds = env
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        async with _mcp(app, token) as client:
            made = await _tool(client, "create_exploration", context_id=str(context.id), title="Do zero",
                               nodes=[{"id": "a", "type": "Pessoa"}, {"id": "b", "type": "Conta"}],
                               edges=[{"source": "a", "target": "b", "type": "TITULAR"}])
            eid = made["exploration"]["id"]
            assert (made["node_count"], made["edge_count"]) == (2, 1) and "item" not in made
            assert made["exploration"]["state"]["has_snapshot"] is True
            assert {n["id"] for n in files.graph(eid)["nodes"]} == {"a", "b"}

            queried = await _tool(client, "create_exploration", context_id=str(context.id), title="Da consulta",
                                  graph_query="MATCH (a)-[r]->(b) RETURN a, r, b")
            assert (queried["node_count"], queried["edge_count"]) == (2, 1)

            # replace: a brand-new graph under the same id, the person's layer gone too.
            await rest.put(f"/api/explorations/{exploration.id}/overlay",
                           json={"nodes": [{"id": "z", "type": "Conta", "properties": {}}], "edges": []})
            out = await _tool(client, "edit_exploration", exploration_id=str(exploration.id), replace=True,
                              add_nodes=[{"id": "n1", "type": "Conta"}])
            assert (out["node_count"], out["edge_count"]) == (1, 0)
            page = (await rest.get(f"/api/explorations/{exploration.id}")).json()
            assert page["state"]["has_overlay"] is False

            blank = (await rest.post(f"/api/graph-contexts/{context.id}/explorations",
                                     json={"title": "Vazia", "state": {}})).json()
            text = await _error(client, "edit_exploration", exploration_id=blank["id"], add_nodes=[{"id": "q", "type": "T"}])
            assert "EXPLORATION_NOT_MATERIALIZED" in text
            text = await _error(client, "enrich_exploration", exploration_id=str(exploration.id), table="nope")
            assert "ENRICHMENT_TABLE_NOT_FOUND" in text


@pytest.mark.asyncio
async def test_a_case_scoped_token_reaches_only_the_explorations_of_its_cases(env):
    app, context, exploration, files, ds = env
    store = InMemoryStore.get_instance()
    other = store.create_exploration(context.id, "Outra", OWNER, {"has_snapshot": True})
    files.files[(str(other.id), "snapshot")] = snapshot.compress_snapshot(SNAP)
    async with mcp_lifespan(app), _rest(app) as rest:
        cid = (await rest.post("/api/investigations", json={"title": "Caso"})).json()["id"]
        await rest.post(f"/api/investigations/{cid}/items",
                        json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(exploration.id)})
        token = (await rest.post("/api/agent-tokens", json={"name": "s", "scope": "case", "investigation_ids": [cid]})).json()["token"]
        async with _mcp(app, token) as client:
            assert [e["id"] for e in await _tool(client, "list_explorations")] == [str(exploration.id)]
            assert "OUT_OF_SCOPE" in await _error(client, "get_exploration", exploration_id=str(other.id))
            assert "OUT_OF_SCOPE" in await _error(client, "edit_exploration", exploration_id=str(other.id), remove_node_ids=["1"])
            assert "OUT_OF_SCOPE" in await _error(client, "create_exploration", context_id=str(context.id), title="x")
            out = await _tool(client, "edit_exploration", exploration_id=str(exploration.id), remove_node_ids=["2"])
            assert out["removed_nodes"] == 1
        # And the REST twin of the agent never deletes the exploration itself.
        r = await rest.delete(f"/api/explorations/{exploration.id}", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 403


@pytest.mark.asyncio
async def test_the_focus_node_travels_with_the_exploration(env):
    app, context, exploration, files, ds = env
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        async with _mcp(app, token) as client:
            made = await _tool(client, "create_exploration", context_id=str(context.id), title="Foco",
                               nodes=[{"id": "a", "type": "Pessoa"}, {"id": "b", "type": "Conta"}], focus_node_id="a")
            eid = made["exploration"]["id"]
            assert made["exploration"]["state"]["focus_node_id"] == "a"
            assert (await _tool(client, "get_exploration", exploration_id=eid))["focus_node_id"] == "a"
            assert (await _tool(client, "get_exploration", exploration_id=str(exploration.id)))["focus_node_id"] is None

            out = await _tool(client, "edit_exploration", exploration_id=eid, add_nodes=[{"id": "c", "type": "Conta"}], focus_node_id="c")
            assert out["revision"] == 1
            seen = await _tool(client, "get_exploration", exploration_id=eid)
            assert (seen["focus_node_id"], seen["node_count"]) == ("c", 3)
            out = await _tool(client, "edit_exploration", exploration_id=eid, focus_node_id="")
            assert out["revision"] == 2 and (await _tool(client, "get_exploration", exploration_id=eid))["focus_node_id"] is None
            await _tool(client, "edit_exploration", exploration_id=eid, focus_node_id="b")

        # The page reads and writes it as any other state key.
        page = (await rest.get(f"/api/explorations/{eid}")).json()
        assert page["state"]["focus_node_id"] == "b" and page["state"]["revision"] == 3
        r = await rest.put(f"/api/explorations/{eid}", json={"state": {**page["state"], "focus_node_id": "a"}, "expected_revision": 3})
        assert r.status_code == 200 and r.json()["state"]["focus_node_id"] == "a"
        assert (await rest.get(f"/api/explorations/{eid}")).json()["state"]["focus_node_id"] == "a"


@pytest.mark.asyncio
async def test_an_agent_sets_the_look_of_an_exploration(env):
    """Style, icons and labels travel with the exploration: given at creation, read
    back, changed key by key (the others stay), reset with null, typos refused."""
    app, context, exploration, files, ds = env
    red = {"nodeTypeColors": {"Pessoa": "#ff0000"}, "nodeTypeIcons": {"Pessoa": "user"}}
    labels = {"textFormat": {"defaults": {"nodeTemplate": "{prop:name}", "edgeTemplate": "{relationship_type}"}, "rules": []}}
    async with mcp_lifespan(app), _rest(app) as rest:
        token = (await rest.post("/api/agent-tokens", json={"name": "claude"})).json()["token"]
        async with _mcp(app, token) as client:
            made = await _tool(client, "create_exploration", context_id=str(context.id), title="Vermelho",
                               nodes=[{"id": "a", "type": "Pessoa", "properties": {"name": "Ana"}}], look=red)
            eid = made["exploration"]["id"]
            assert made["exploration"]["state"]["nodeTypeIcons"] == {"Pessoa": "user"}
            seen = await _tool(client, "get_exploration", exploration_id=eid)
            assert seen["look"]["nodeTypeColors"] == {"Pessoa": "#ff0000"}
            assert "graph_query" not in seen["look"]

            # Labels change; the colors and icons given before stay. No graph op needed.
            out = await _tool(client, "edit_exploration", exploration_id=eid, look=labels)
            assert out["revision"] == 1 and out["look_changed"] == ["textFormat"]
            seen = await _tool(client, "get_exploration", exploration_id=eid)
            assert seen["look"]["textFormat"]["defaults"]["nodeTemplate"] == "{prop:name}"
            assert seen["look"]["nodeTypeIcons"] == {"Pessoa": "user"}
            assert seen["revision"] == 1

            # null resets one key; the REST state (what the page loads) agrees.
            await _tool(client, "edit_exploration", exploration_id=eid, look={"nodeTypeIcons": None})
            state = (await rest.get(f"/api/explorations/{eid}")).json()["state"]
            assert state["nodeTypeIcons"] is None and state["nodeTypeColors"] == {"Pessoa": "#ff0000"}
            assert "nodeTypeIcons" not in (await _tool(client, "get_exploration", exploration_id=eid))["look"]

            # A key that is not part of a look is refused, named.
            with pytest.raises(Exception) as err:
                await _tool(client, "edit_exploration", exploration_id=eid, look={"nodeColours": {}})
            assert "nodeColours" in str(err.value)
            with pytest.raises(Exception):
                await _tool(client, "create_exploration", context_id=str(context.id), title="Ruim", look={"focus_node_id": 7})

