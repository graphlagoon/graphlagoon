"""Table actions of the right-click menu: a run-query-template action with
``resultMode: "table"`` runs its template for one clicked item on the server
(console datasource path, mocked) and returns rows; bindings, the value rule,
template visibility and the MCP twin all go through ``menu_action_tables``."""

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
from graphlagoon.models.schemas import TableQueryResponse, TableQueryStatusResponse  # noqa: E402
from graphlagoon.routers import graph as graph_router  # noqa: E402
from graphlagoon.services.datasource.base import DatasourceCapabilities  # noqa: E402
from graphlagoon.services.graph_operations import QueryExecutionError  # noqa: E402
from graphlagoon.services.menu_action_tables import (  # noqa: E402
    bind_parameters,
    matches,
    resolve_binding,
    substitute,
)

OWNER = "owner@example.com"
READER = "reader@example.com"
SQL = (
    "SELECT t.* FROM tx t JOIN edges e ON e.dst = t.account "
    "WHERE e.src = '$company' AND t.at >= date_sub(current_date(), $days) ORDER BY t.at DESC"
)
PARAMS = [
    {"id": "company", "label": "Company", "required": True},
    {"id": "days", "label": "Days", "default": "30", "required": True},
]


def h(email):
    return {"X-Forwarded-Email": email}


class _Datasource:
    capabilities = DatasourceCapabilities(supports_sql=True)

    def __init__(self):
        self.seen = []
        self.fail = None

    async def submit_table_query(self, context, data):
        self.seen.append(data)
        if self.fail:
            raise QueryExecutionError(self.fail, code="SQL_ERROR")
        return TableQueryResponse(status="running", statement_id="stmt-1")

    async def get_table_query_status(self, context, statement_id, row_limit):
        return TableQueryStatusResponse(
            status="succeeded", statement_id=statement_id, columns=["account", "amount", "at"],
            rows=[["acc-1", "120.5", "2026-11-01"], ["acc-2", "80", "2026-10-30"]], row_count=2,
        )

    async def cancel_statement(self, statement_id):
        return None


def _action(template_id, **overrides):
    return {
        "id": "tx-30d", "label": "Transactions (30 days)", "enabled": True, "kind": "run-query-template",
        "templateId": str(template_id), "templateName": "Transactions", "resultMode": "table",
        "paramBindings": {"company": "{node_id}"},
        "match": {"target": "node", "nodeTypes": ["Company"]},
        **overrides,
    }


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_WAREHOUSE_POLL_INTERVAL", "0")
    get_settings.cache_clear()
    InMemoryStore.reset()
    ds = _Datasource()
    monkeypatch.setattr(graph_router, "resolve_datasource_or_400", lambda context: ds)
    scoped = []

    async def scope(context, user, sql=None, prefilter=None, datasource=None):
        scoped.append(sql)

    monkeypatch.setattr(graph_router, "enforce_query_scope", scope)
    store = InMemoryStore.get_instance()
    ctx = store.create_graph_context("Companies", "e", "n", OWNER)
    template = store.create_query_template(ctx.id, OWNER, "Transactions", "sql", SQL, parameters=PARAMS)
    ctx.context_menu_actions = [
        _action(template.id),
        {**_action(template.id), "id": "as-graph", "resultMode": "graph"},
    ]
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app), f"/api/graph-contexts/{ctx.id}/menu-actions", ds, scoped, store, ctx
    InMemoryStore.reset()
    get_settings.cache_clear()


NODE = {"type": "node", "id": "co-1", "node_type": "Company", "properties": {"name": "ACME"}}


def test_runs_the_template_for_the_clicked_node(env):
    client, url, ds, scoped, *_ = env
    r = client.post(f"{url}/tx-30d/table", json={"target": NODE, "row_limit": 500}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    body = r.json()
    # The datasource answered "running": the browser polls the table-query route.
    assert body["status"] == "running" and body["statement_id"] == "stmt-1"
    sent = ds.seen[0]
    assert sent.query == SQL.replace("$company", "co-1").replace("$days", "30")
    assert sent.mode == "sql" and sent.row_limit == 500
    assert scoped == [sent.query]  # scope-checked like the console
    by_id = {p["id"]: p for p in body["parameters"]}
    assert by_id["company"]["value"] == "co-1" and by_id["company"]["source"] == "binding"
    assert by_id["days"]["source"] == "default"


def test_given_values_win_and_problems_stop_the_run(env):
    client, url, ds, *_ = env
    r = client.post(f"{url}/tx-30d/table", json={"target": NODE, "parameters": {"days": "7"}}, headers=h(OWNER))
    assert "date_sub(current_date(), 7)" in ds.seen[0].query and r.json()["parameters"][1]["source"] == "given"
    unsafe = client.post(
        f"{url}/tx-30d/table", json={"target": NODE, "parameters": {"company": "x' OR '1'='1"}}, headers=h(OWNER)
    ).json()
    assert unsafe["status"] == "needs_parameters" and "company" in unsafe["problems"]
    assert len(ds.seen) == 1  # nothing else reached the warehouse
    # A binding left by a parameter since removed from the template does not block the browser.
    stale = client.post(f"{url}/tx-30d/table", json={"target": NODE, "parameters": {"nope": "1"}}, headers=h(OWNER))
    assert stale.json()["status"] == "running" and stale.json()["problems"] == {}


def test_refusals(env):
    client, url, ds, _, store, ctx = env
    assert client.post(f"{url}/missing/table", json={"target": NODE}, headers=h(OWNER)).status_code == 404
    graph_mode = client.post(f"{url}/as-graph/table", json={"target": NODE}, headers=h(OWNER))
    assert graph_mode.status_code == 400 and graph_mode.json()["detail"]["error"]["code"] == "MENU_ACTION_NOT_TABLE"
    # The browser decided the action applies (metrics are its own): the route does not re-judge.
    person = {**NODE, "node_type": "Person"}
    assert client.post(f"{url}/tx-30d/table", json={"target": person}, headers=h(OWNER)).status_code == 200
    ds.seen.clear()
    # A reader without access to the context gets nothing.
    assert client.post(f"{url}/tx-30d/table", json={"target": NODE}, headers=h(READER)).status_code in (403, 404)
    # A private template of someone else reads as gone.
    private = store.create_query_template(ctx.id, READER, "Mine", "sql", SQL, parameters=PARAMS, visibility="private")
    ctx.context_menu_actions = [_action(private.id)]
    gone = client.post(f"{url}/tx-30d/table", json={"target": NODE}, headers=h(OWNER))
    assert gone.status_code == 404 and gone.json()["detail"]["error"]["code"] == "TEMPLATE_NOT_FOUND"
    assert ds.seen == []


def test_a_warehouse_error_comes_back_with_the_parameters(env):
    client, url, ds, *_ = env
    ds.fail = "Table or view not found: tx"
    body = client.post(f"{url}/tx-30d/table", json={"target": NODE}, headers=h(OWNER)).json()
    assert body["status"] == "failed" and body["error"] == {"code": "SQL_ERROR", "message": "Table or view not found: tx"}
    assert [p["id"] for p in body["parameters"]] == ["company", "days"]


def test_cypher_templates_render_as_cte(monkeypatch):
    import asyncio

    from graphlagoon.services import menu_action_tables

    ds = _Datasource()
    ds.capabilities = DatasourceCapabilities(supports_sql=True, supports_transpile=True)

    async def no_scope(*a, **k):
        return None

    monkeypatch.setattr(graph_router, "resolve_datasource_or_400", lambda c: ds)
    monkeypatch.setattr(graph_router, "enforce_query_scope", no_scope)
    monkeypatch.setenv("GRAPH_LAGOON_WAREHOUSE_POLL_INTERVAL", "0")
    get_settings.cache_clear()
    InMemoryStore.reset()
    store = InMemoryStore.get_instance()
    ctx = store.create_graph_context("C", "e", "n", OWNER)
    template = store.create_query_template(
        ctx.id, OWNER, "Tx", "cypher", "MATCH (c {id: '$company'})-[*1..2]-(a:Account) RETURN a", parameters=PARAMS[:1]
    )
    ctx.context_menu_actions = [_action(template.id)]
    # wait=True: the agents' path polls to the end.
    result = asyncio.run(menu_action_tables.run(ctx, OWNER, "tx-30d", NODE, wait=True))
    assert result["status"] == "succeeded" and result["row_count"] == 2
    assert ds.seen[0].mode == "cypher" and ds.seen[0].vlp_rendering_mode == "cte"
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_pure_helpers():
    edge = {"type": "edge", "id": "e1", "src": "a", "dst": "b", "relationship_type": "PAYS", "properties": {"v": 10}}
    assert resolve_binding("{src}->{dst}:{prop:v}", edge) == "a->b:10"
    assert resolve_binding("{prop:missing}", edge) is None
    assert resolve_binding("{prop:v|upper}", edge) is None  # modifiers are the browser's
    assert resolve_binding("{metric:pagerank}", NODE) is None
    assert resolve_binding("fixed", NODE) == "fixed"
    assert substitute("$node $node_id", {"node": "x", "node_id": "$node"}) == "x $node"  # longest first, one pass

    action = _action("t", match={"target": "node", "nodeTypes": ["Company"], "propertyConditions": [
        {"property": "name", "operator": "contains", "value": "AC"}]})
    assert matches(action, NODE)
    assert not matches(action, {**NODE, "properties": {"name": "Other"}})
    assert not matches({**action, "match": {"target": "edge"}}, NODE)
    assert not matches({**action, "match": {"target": "node", "propertyConditions": [
        {"property": "metric:pagerank", "operator": "exists"}]}}, NODE)

    template = {"parameters": [{"id": "uf", "label": "UF", "type": "select", "options": ["SP"], "required": False}]}
    assert bind_parameters(template, {}, NODE, {"typo": "1"})[1] == {"typo": "the template has no such parameter"}
    assert bind_parameters(template, {}, NODE, {"typo": "1"}, strict=False)[1] == {}
    params, problems = bind_parameters(template, {}, NODE, {"uf": "RJ"})
    assert problems == {"uf": "must be one of SP"} and params[0]["value"] == "RJ"
    assert bind_parameters(template, {}, NODE, {})[1] == {}  # optional, empty: fine
