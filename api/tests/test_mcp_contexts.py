"""A graph context as a data catalog for agents: list the contexts, describe one (its
graph tables, types, properties, declared sources, the warehouse's column metadata),
and read from it with no case and no graph — an ad-hoc read-only query, or one declared
source asked about some ids. Nothing is written; a case-scoped token stays inside the
contexts of its cases."""

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
from graphlagoon.models.schemas import (  # noqa: E402
    ColumnInfo, PropertyColumn, TableQueryResponse, TableQueryStatusResponse, TableSchema,
)
from graphlagoon.routers import graph as graph_router  # noqa: E402
from graphlagoon.routers import graph_contexts  # noqa: E402
from graphlagoon.services import investigation_storage, snapshot, warehouse  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from graphlagoon.services.datasource.base import DatasourceCapabilities  # noqa: E402
from graphlagoon.services.enrichment_providers import (  # noqa: E402
    EnrichmentProvider, EnrichmentProviderError, ParamSpec, clear_enrichment_provider_registry,
    register_enrichment_provider,
)
from tests.test_enrichment import DEVICES, _Warehouse  # noqa: E402
from tests.test_mcp_explorations import SNAP, _Files  # noqa: E402
from tests.test_mcp_server import OWNER, _mcp, _rest, _tool  # noqa: E402

STRANGER = "stranger@example.com"


class _Catalog(_Warehouse):
    """The lookup warehouse, which also describes tables."""

    async def get_table_schema(self, table, database=None, catalog=None):
        if table == "extra":
            raise RuntimeError("TABLE_OR_VIEW_NOT_FOUND")
        return TableSchema(table_name=table, database=database, catalog=catalog, columns=[
            ColumnInfo(name="node_id", data_type="string", nullable=False, comment="The account number"),
            ColumnInfo(name="opened_at", data_type="timestamp"),
        ])


class _Datasource:
    capabilities = DatasourceCapabilities(supports_sql=True)

    def __init__(self):
        self.seen = []

    async def submit_table_query(self, context, data):
        self.seen.append(data)
        return TableQueryResponse(status="running", statement_id="stmt-1")

    async def get_table_query_status(self, context, statement_id, row_limit):
        return TableQueryStatusResponse(
            status="succeeded", statement_id=statement_id, columns=["node_type", "n"],
            rows=[["Conta", "2"]], row_count=1, total_row_count=1,
        )

    async def cancel_statement(self, statement_id):
        return None


def _provider_entry(name, provider, target, **ref):
    return {"name": name, "label": name.upper(), "description": f"What {name} adds",
            "provider": {"name": provider, "target": target, "run": "manual", **ref}}


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    monkeypatch.setenv("GRAPH_LAGOON_CATALOG_SCHEMAS", "main.graphs")
    monkeypatch.setenv("GRAPH_LAGOON_WAREHOUSE_POLL_INTERVAL", "0")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    clear_enrichment_provider_registry()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    files = _Files()
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: files)
    ds = _Datasource()
    monkeypatch.setattr(graph_router, "resolve_datasource_or_400", lambda context: ds)
    wh = _Catalog()
    monkeypatch.setattr(warehouse, "get_warehouse_client", lambda: wh)

    calls = []

    async def kyc(request):
        calls.append(request)
        if any(n["node_id"] == "boom" for n in request.nodes):
            raise EnrichmentProviderError("KYC service is down")
        return {n["node_id"]: {"kyc_tier": f"tier-{n['node_id']}"} for n in request.nodes if n["node_id"] != "unknown"}

    async def weight(request):
        return {e["edge_id"]: {"weight": 7} for e in request.edges}

    register_enrichment_provider(EnrichmentProvider(
        name="kyc", enrich=kyc, targets=("nodes",), label="KYC", description="Registered description",
        params=[ParamSpec("as_of_days", type="int", default=30, min=1, max=365)], columns=("kyc_tier",)))
    register_enrichment_provider(EnrichmentProvider(name="weight", enrich=weight, targets=("edges",)))

    store = InMemoryStore.get_instance()
    context = store.create_graph_context(
        "Pix", "main.graphs.e", "main.graphs.n", OWNER,
        description="Accounts and the PIX transfers between them. PIX: payer -> payee.",
        node_types=["Conta"], relationship_types=["PIX"],
        node_properties=[PropertyColumn(name="titular", data_type="string", description="Account holder").model_dump()],
        enrichment_tables=[
            DEVICES,
            {"name": "only_table", "label": "Only a table", "table": "main.graphs.extra"},
            _provider_entry("kyc", "kyc", "nodes", params={"as_of_days": 90}, runtime_params=["as_of_days"]),
            _provider_entry("weight", "weight", "edges"),
        ],
    )
    other = store.create_graph_context("Other", "main.graphs.e2", "main.graphs.n2", OWNER)
    foreign = store.create_graph_context("Foreign", "main.graphs.e3", "main.graphs.n3", STRANGER)
    exploration = store.create_exploration(context.id, "Mulas", OWNER, {"has_snapshot": True})
    files.files[(str(exploration.id), "snapshot")] = snapshot.compress_snapshot(SNAP)
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    app.dependency_overrides[graph_contexts.get_warehouse] = lambda: wh
    mount_mcp(app)
    yield app, context, other, foreign, exploration, ds, calls
    clear_enrichment_provider_registry()
    InMemoryStore.reset()
    get_settings.cache_clear()


async def _error(client, tool, **args):
    result = await client.call_tool(tool, args)
    assert result.is_error, result.content
    return result.content[0].text


async def _token(rest, **body):
    return (await rest.post("/api/agent-tokens", json={"name": "claude", **body})).json()["token"]


@pytest.mark.asyncio
async def test_from_nothing_to_an_answer_in_four_calls(env):
    """The acceptance path: with only a token, find a context, read what it offers, ask
    a declared source and query its tables — no id handed over by a person."""
    app, context, other, foreign, exploration, ds, calls = env
    async with mcp_lifespan(app), _rest(app) as rest:
        async with _mcp(app, await _token(rest)) as client:
            listed = (await _tool(client, "list_contexts"))["contexts"]
            # Readable ones only, newest first; a stranger's context is not there.
            assert {c["title"] for c in listed} == {"Pix", "Other"}
            pix = next(c for c in listed if c["title"] == "Pix")
            assert pix["sources"] == ["devices", "kyc", "weight"] and pix["description"].startswith("Accounts")
            assert [c["title"] for c in (await _tool(client, "list_contexts", q="pix transfers"))["contexts"]] == ["Pix"]

            cat = await _tool(client, "describe_context", context_id=pix["id"])
            assert cat["context"]["description"].endswith("PIX: payer -> payee.")
            assert cat["context"]["query_languages"] == ["cypher", "sql"]
            assert cat["graph"]["node_table"] == "main.graphs.n" and cat["graph"]["edge_columns"]["src"] == "src"
            assert cat["graph"]["node_types"] == ["Conta"] and cat["graph"]["relationship_types"] == ["PIX"]
            assert cat["graph"]["node_properties"] == [
                {"name": "titular", "data_type": "string", "description": "Account holder"}]
            assert [(t["table"], t["role"]) for t in cat["tables"]] == [
                ("main.graphs.e", "edges"), ("main.graphs.n", "nodes"),
                ("main.graphs.devices", "authorized"), ("main.graphs.extra", "authorized")]
            assert "columns" not in cat["tables"][0]
            by_name = {s["name"]: s for s in cat["sources"]}
            # An entry that only authorizes its table is a table, not a source.
            assert list(by_name) == ["devices", "kyc", "weight"]
            assert by_name["devices"]["how"] == ["lookup"] and "Conta" in by_name["devices"]["ask"]["lookup"]["ids"]
            kyc = by_name["kyc"]
            assert kyc["how"] == ["run"] and kyc["ask"]["run"]["ids"] == "node ids"
            assert kyc["description"] == "What kyc adds" and kyc["run"]["columns"] == ["kyc_tier"]
            assert kyc["run"]["params"][0]["value"] == 90 and kyc["run"]["params"][0]["overridable"] is True
            assert "edge_id" in by_name["weight"]["ask"]["run"]["ids"]

            out = await _tool(client, "query_source", context_id=pix["id"], name="kyc", ids=["1", "2", "unknown"])
            assert (out["how"], out["kind"], out["asked"], out["matched"]) == ("run", "provider", 3, 2)
            assert out["rows"] == {"1": {"kyc_tier": "tier-1"}, "2": {"kyc_tier": "tier-2"}}
            assert out["params"] == {"as_of_days": 90} and calls[-1].edges == []

            rows = await _tool(client, "query_context", context_id=pix["id"],
                               query="SELECT node_type, count(*) AS n FROM main.graphs.n GROUP BY node_type")
            assert (rows["columns"], rows["rows"], rows["row_limit"]) == (["node_type", "n"], [["Conta", "2"]], 200)
            assert ds.seen[-1].mode == "sql" and ds.seen[-1].row_limit == 200

        # Nothing was written: the exploration of that context is as it was.
        page = (await rest.get(f"/api/explorations/{exploration.id}")).json()
        assert not page["state"].get("revision") and not page["state"].get("last_change")
        tools = [a.log_metadata.get("tool") for a in InMemoryStore.get_instance().usage_logs
                 if a.action in ("agent.read", "enrichment.run")]
        assert tools == ["list_contexts", "list_contexts", "describe_context", "query_source", "query_context"]


@pytest.mark.asyncio
async def test_the_warehouse_describes_the_tables_of_the_context_only(env):
    app, context, *_ = env
    cid = str(context.id)
    async with mcp_lifespan(app), _rest(app) as rest:
        async with _mcp(app, await _token(rest)) as client:
            cat = await _tool(client, "describe_context", context_id=cid, tables=["main.graphs.n", "main.graphs.extra"])
            nodes = next(t for t in cat["tables"] if t["table"] == "main.graphs.n")
            assert nodes["reachable"] is True and nodes["columns"][0] == {
                "name": "node_id", "data_type": "string", "nullable": False, "comment": "The account number"}
            # One the warehouse cannot describe is an answer, not a failure.
            gone = next(t for t in cat["tables"] if t["table"] == "main.graphs.extra")
            assert gone["reachable"] is False and gone["columns"] == []
            assert "TABLE_NOT_IN_CONTEXT" in await _error(
                client, "describe_context", context_id=cid, tables=["main.hr.salaries"])
            assert "TOO_MANY_TABLES" in await _error(
                client, "describe_context", context_id=cid, tables=["main.graphs.n"] * 11)
        # The same catalog over REST, for a reader; not for a stranger.
        r = await rest.get(f"/api/graph-contexts/{cid}/catalog", params={"tables": ["main.graphs.e"]})
        assert r.status_code == 200 and r.json()["tables"][0]["columns"][1]["name"] == "opened_at"
        assert [s["name"] for s in r.json()["sources"]] == ["devices", "kyc", "weight"]
        r = await rest.get(f"/api/graph-contexts/{cid}/catalog", headers={"X-Forwarded-Email": STRANGER})
        assert r.status_code in (403, 404)


@pytest.mark.asyncio
async def test_a_query_stays_inside_the_context_and_is_read_only(env):
    app, context, *_, ds, _calls = env
    cid = str(context.id)
    async with mcp_lifespan(app), _rest(app) as rest:
        async with _mcp(app, await _token(rest)) as client:
            text = await _error(client, "query_context", context_id=cid, query="SELECT * FROM main.hr.salaries")
            assert "QUERY_SCOPE_DENIED" in text and ds.seen == []
            assert "EMPTY_QUERY" in await _error(client, "query_context", context_id=cid, query="  ")
            assert "INVALID_BODY" in await _error(client, "query_context", context_id=cid, query="x", language="gremlin")
            await _tool(client, "query_context", context_id=cid, query="MATCH (n) RETURN count(*)", language="cypher",
                        row_limit=999999)
            assert ds.seen[-1].mode == "cypher" and ds.seen[-1].row_limit == 5000


@pytest.mark.asyncio
async def test_a_source_is_asked_by_its_name_in_the_context(env):
    app, context, other, *_, calls = env
    cid = str(context.id)
    async with mcp_lifespan(app), _rest(app) as rest:
        async with _mcp(app, await _token(rest)) as client:
            # A lookup: rows per key, only the declared columns.
            out = await _tool(client, "query_source", context_id=cid, name="devices", ids=["1"])
            assert out["how"] == "lookup" and out["rows"]["1"] == [
                {"device_id": "d1", "ip": "10.0.0.1"}, {"device_id": "d2", "ip": "10.0.0.2"}]
            # A provider on edges needs the edge, not an id.
            out = await _tool(client, "query_source", context_id=cid, name="weight",
                              items=[{"edge_id": "t1", "src": "1", "dst": "2", "relationship_type": "PIX"}])
            assert out["target"] == "edges" and out["rows"] == {"t1": {"weight": 7}}
            assert "enriches edges" in await _error(client, "query_source", context_id=cid, name="weight", ids=["t1"])
            # Parameters: only the ones the author opened, inside their bounds.
            out = await _tool(client, "query_source", context_id=cid, name="kyc", ids=["1"], params={"as_of_days": 7})
            assert out["params"] == {"as_of_days": 7} and calls[-1].params == {"as_of_days": 7}
            for args, code in (
                ({"name": "kyc", "ids": ["1"], "params": {"as_of_days": 0}}, "ENRICHMENT_PARAM_INVALID"),
                ({"name": "kyc"}, "INVALID_KEY"),
                ({"name": "kyc", "ids": ["1"], "how": "lookup"}, "INVALID_BODY"),
                ({"name": "devices", "ids": ["1"], "params": {"x": 1}}, "ENRICHMENT_PARAM_INVALID"),
                ({"name": "only_table", "ids": ["1"]}, "SOURCE_NOT_DECLARED"),
                ({"name": "nope", "ids": ["1"]}, "SOURCE_NOT_DECLARED"),
                ({"name": "kyc", "ids": ["boom"]}, "KYC service is down"),
            ):
                assert code in await _error(client, "query_source", context_id=cid, **args), code
            # A source of one context is not a source of another.
            text = await _error(client, "query_source", context_id=str(other.id), name="kyc", ids=["1"])
            assert "SOURCE_NOT_DECLARED" in text and "describe_context" in text


@pytest.mark.asyncio
async def test_no_access_and_a_case_scoped_token(env):
    app, context, other, foreign, exploration, ds, calls = env
    async with mcp_lifespan(app), _rest(app) as rest:
        async with _mcp(app, await _token(rest)) as client:
            for tool, args in (("describe_context", {}), ("query_context", {"query": "SELECT 1"}),
                               ("query_source", {"name": "kyc", "ids": ["1"]}), ("list_enrichments", {})):
                text = await _error(client, tool, context_id=str(foreign.id), **args)
                assert "FORBIDDEN" in text or "NOT_FOUND" in text, text
        case = (await rest.post("/api/investigations", json={"title": "Caso"})).json()["id"]
        await rest.post(f"/api/investigations/{case}/items",
                        json={"kind": "graph", "subkind": "exploration_ref", "exploration_id": str(exploration.id)})
        scoped = await _token(rest, scope="case", investigation_ids=[case])
        async with _mcp(app, scoped) as client:
            # Only the context its case uses.
            assert [c["title"] for c in (await _tool(client, "list_contexts"))["contexts"]] == ["Pix"]
            assert (await _tool(client, "describe_context", context_id=str(context.id)))["context"]["title"] == "Pix"
            for tool, args in (("describe_context", {}), ("query_context", {"query": "SELECT 1"}),
                               ("query_source", {"name": "kyc", "ids": ["1"]}), ("list_enrichments", {})):
                assert "OUT_OF_SCOPE" in await _error(client, tool, context_id=str(other.id), **args), tool
