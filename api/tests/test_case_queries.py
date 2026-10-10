"""Saved queries of a case (05 §1): ``:name`` parameters validated like a
template's, a run through the console's datasource path (mocked) stored as a
version with ``run``, and a graph-output run that reaches the canvas."""

import json
import sys

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
from graphlagoon.models.schemas import (  # noqa: E402
    Edge,
    GraphResponse,
    Node,
    TableQueryResponse,
    TableQueryStatusResponse,
)
from graphlagoon.routers import graph as graph_router  # noqa: E402
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from graphlagoon.services.case_queries import InvestigationError, substitute  # noqa: E402
from graphlagoon.services.datasource.base import DatasourceCapabilities, PreparedGraphQuery  # noqa: E402

OWNER = "owner@example.com"
PARAMS = [
    {"id": "cpfs", "label": "CPFs", "required": True},
    {"id": "uf", "label": "UF", "type": "select", "options": ["SP", "RJ"], "default": "SP"},
    {"id": "min", "label": "min", "required": False},
]


def h(email):
    return {"X-Forwarded-Email": email}


def test_substitute_validates_like_a_template():
    text, used = substitute(
        "SELECT * FROM t WHERE cpf IN (:cpfs) AND uf = :uf AND v > :min AND ts > '10:30'",
        PARAMS,
        {"cpfs": ["1", "2'x"], "min": 50},
    )
    assert text == "SELECT * FROM t WHERE cpf IN ('1', '2''x') AND uf = 'SP' AND v > 50 AND ts > '10:30'"
    assert used == {"cpfs": ["1", "2'x"], "uf": "SP", "min": 50}
    with pytest.raises(InvestigationError) as missing:
        substitute("SELECT :cpfs", PARAMS, {})
    assert missing.value.code == "QUERY_PARAMETER_MISSING"
    with pytest.raises(InvestigationError) as invalid:
        substitute("SELECT :uf", PARAMS, {"uf": "MG"})
    assert invalid.value.code == "QUERY_PARAMETER_INVALID"
    with pytest.raises(InvestigationError) as unknown:
        substitute("SELECT 1", PARAMS, {"x": 1})
    assert unknown.value.code == "QUERY_PARAMETER_UNKNOWN"
    assert substitute("SELECT v > :min", PARAMS, {})[0] == "SELECT v > NULL"  # optional without default


class _Datasource:
    """Console path doubles: one poll for a table, prepare + execute for a graph."""

    capabilities = DatasourceCapabilities(supports_sql=True) if hasattr(DatasourceCapabilities, "supports_sql") else None

    def __init__(self):
        self.seen = []

    async def submit_table_query(self, context, data):
        self.seen.append(("table", data.query, data.mode, data.row_limit))
        return TableQueryResponse(status="running", statement_id="stmt-1")

    async def get_table_query_status(self, context, statement_id, row_limit):
        return TableQueryStatusResponse(
            status="succeeded", statement_id=statement_id, columns=["cpf", "total"],
            rows=[["12345678901", "1500"], ["98765432100", "1400"]], row_count=2,
        )

    def prepare_cypher(self, context, data):
        self.seen.append(("cypher", data.query))
        return PreparedGraphQuery(statement="SELECT transpiled", transpiled_sql="SELECT transpiled")

    async def execute_prepared(self, context, prepared, **kwargs):
        return GraphResponse(
            nodes=[Node(node_id="a", node_type="Conta", properties={"conta": "1"}), Node(node_id="b", node_type="Conta", properties={})],
            edges=[Edge(edge_id="e1", src="a", dst="b", relationship_type="PIX", properties={"valor": 10})],
        )


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_WAREHOUSE_POLL_INTERVAL", "0")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    ds = _Datasource()
    monkeypatch.setattr(graph_router, "resolve_datasource_or_400", lambda context: ds)

    async def no_scope(*args, **kwargs):
        return None

    monkeypatch.setattr(graph_router, "enforce_query_scope", no_scope)
    monkeypatch.setattr("graphlagoon.services.datasource.base.require_capability", lambda *a, **k: None)
    store = InMemoryStore.get_instance()
    ctx = store.create_graph_context("Pix", "e", "n", OWNER)
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)
    inv = client.post("/api/investigations", json={"title": "Caso"}, headers=h(OWNER)).json()
    yield client, f"/api/investigations/{inv['id']}", ctx, ds
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_saved_query_reruns_and_versions_each_run(env):
    client, url, ctx, ds = env
    r = client.post(
        f"{url}/items",
        json={
            "kind": "query", "subkind": "sql", "title": "Exposição por CPF", "context_id": str(ctx.id),
            "query": {"text": "SELECT cpf, sum(v) total FROM t WHERE cpf IN (:cpfs)", "language": "sql",
                      "parameters": [PARAMS[0]], "output": "table"},
        },
        headers=h(OWNER),
    )
    assert r.status_code == 201, r.text
    item = r.json()
    assert item["latest"] is None and item["query"]["parameters"][0]["id"] == "cpfs"
    missing = client.post(f"{url}/items/{item['id']}/run", json={"parameters": {}}, headers=h(OWNER))
    assert missing.status_code == 422 and missing.json()["detail"]["error"]["code"] == "QUERY_PARAMETER_MISSING"

    r = client.post(f"{url}/items/{item['id']}/run", json={"parameters": {"cpfs": ["12345678901"]}, "row_limit": 50}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    run = r.json()["latest"]["run"]
    assert run["statement_id"] == "stmt-1" and run["row_count"] == 2 and run["params"] == {"cpfs": ["12345678901"]}
    assert run["run_by"] == OWNER and run["author_kind"] == "human" and run["duration_ms"] >= 0
    assert ds.seen[0] == ("table", "SELECT cpf, sum(v) total FROM t WHERE cpf IN ('12345678901')", "sql", 50)
    result = json.loads(client.get(f"{url}/items/{item['id']}/content", headers=h(OWNER)).content)
    assert result["columns"] == ["cpf", "total"] and len(result["rows"]) == 2
    # Re-running is a new version; the previous stays and can be pinned.
    client.post(f"{url}/items/{item['id']}/run", json={"parameters": {"cpfs": ["1"]}}, headers=h(OWNER))
    versions = client.get(f"{url}/items/{item['id']}/versions", headers=h(OWNER)).json()
    assert [v["version"] for v in versions] == [1, 2] and versions[1]["run"]["params"] == {"cpfs": ["1"]}
    assert client.post(f"{url}/items/{item['id']}/pin", json={"version": 1, "label": "corrida 1"}, headers=h(OWNER)).status_code == 200
    events = [e for e in client.get(f"{url}/events", headers=h(OWNER)).json() if e["kind"] == "item.version_added"]
    assert events[0]["payload"]["run"]["statement_id"] == "stmt-1"
    # Not a query / no context.
    note = client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "x"}, headers=h(OWNER)).json()
    assert client.post(f"{url}/items/{note['id']}/run", json={}, headers=h(OWNER)).status_code == 422


def test_graph_output_run_reaches_the_canvas(env):
    client, url, ctx, ds = env
    item = client.post(
        f"{url}/items",
        json={"kind": "query", "subkind": "cypher", "title": "Vizinhos", "context_id": str(ctx.id),
              "query": {"text": "MATCH (a)-[r]->(b) RETURN a, r, b", "language": "cypher", "output": "graph"}},
        headers=h(OWNER),
    ).json()
    assert client.get(f"{url}/graph", headers=h(OWNER)).json()["nodes"] == []
    r = client.post(f"{url}/items/{item['id']}/run", json={}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["latest"]["run"]["output"] == "graph" and r.json()["latest"]["run"]["row_count"] == 1
    graph = client.get(f"{url}/graph", headers=h(OWNER)).json()
    assert {n["uid"] for n in graph["nodes"]} == {f"a@{ctx.id}", f"b@{ctx.id}"} and graph["edges"][0]["type"] == "PIX"
    assert graph["nodes"][0]["sources"][0]["source_id"] == item["id"]
