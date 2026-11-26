"""Table providers: a ``run-table-provider`` right-click action runs code the
deployer registered and returns rows for one node or edge, through the same route
and response as a query-template table."""

import asyncio
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
from graphlagoon.services.public_config import build_public_config  # noqa: E402
from graphlagoon.services.table_providers import (  # noqa: E402
    ParamSpec,
    TableProvider,
    TableProviderError,
    TableProviderResult,
    clear_table_provider_registry,
    get_table_providers,
    register_table_provider,
)

OWNER = "owner@example.com"
READER = "reader@example.com"
STRANGER = "stranger@example.com"
NODE = {"type": "node", "id": "acc-1", "node_type": "Account", "properties": {"doc": "123"}}
PARAMS = [
    ParamSpec("account", required=True, description="Account id"),
    ParamSpec("days", type="int", default=90, min=1, max=365, description="Window"),
    ParamSpec("kind", choices=["pix", "ted"], default="pix"),
]


def h(email, **extra):
    return {"X-Forwarded-Email": email, **extra}


class _Recorder:
    def __init__(self):
        self.calls, self.error, self.delay, self.answer = [], None, 0.0, None

    async def __call__(self, request):
        self.calls.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        if self.answer is not None:
            return self.answer
        return TableProviderResult(
            columns=["at", "amount"],
            rows=[["2026-11-01", 120.5], {"at": "2026-10-30", "amount": None, "extra": 1}, ["2026-10-01"]],
        )


def _provider(recorder, **kw):
    async def run(request):
        return await recorder(request)

    return TableProvider(name="tx-history", run=run, label="Transactions (API)",
                         description="Transactions of one account", params=PARAMS, **kw)


def _action(**overrides):
    return {
        "id": "tx", "label": "Transactions", "enabled": True, "kind": "run-table-provider",
        "provider": "tx-history", "paramBindings": {"account": "{node_id}"},
        "match": {"target": "node", "nodeTypes": ["Account"]},
        **overrides,
    }


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    clear_table_provider_registry()
    store = InMemoryStore.get_instance()
    ctx = store.create_graph_context("Accounts", "e", "n", OWNER)
    store.share_graph_context(ctx.id, READER, "read")
    ctx.context_menu_actions = [_action()]
    recorder = _Recorder()
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app), f"/api/graph-contexts/{ctx.id}/menu-actions/tx/table", recorder, ctx
    clear_table_provider_registry()
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_registration_validates_eagerly_and_the_page_learns_copy_and_parameters():
    clear_table_provider_registry()

    def sync(request):
        return None

    with pytest.raises(ValueError, match="async"):
        register_table_provider(TableProvider(name="x", run=sync))
    with pytest.raises(ValueError, match="targets"):
        register_table_provider(_provider(_Recorder(), targets=("nodes",)))
    p = _provider(_Recorder())
    register_table_provider(p)
    register_table_provider(p)
    with pytest.raises(ValueError, match="already registered"):
        register_table_provider(_provider(_Recorder()))
    assert get_table_providers() == [p]
    listed = asyncio.run(build_public_config(OWNER))["table_providers"]
    assert listed[0]["name"] == "tx-history" and listed[0]["description"] == "Transactions of one account"
    assert listed[0]["targets"] == ["node"] and [x["name"] for x in listed[0]["params"]] == ["account", "days", "kind"]
    assert "run" not in listed[0] and "timeout_seconds" not in listed[0]
    clear_table_provider_registry()


def test_a_reader_gets_rows_for_the_clicked_node(env):
    client, url, recorder, ctx = env
    register_table_provider(_provider(recorder))
    r = client.post(url, json={"target": NODE}, headers=h(READER, **{"X-Forwarded-Access-Token": "tok"}))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "succeeded" and body["query_type"] == "provider" and body["template_id"] is None
    assert body["template_name"] == "Transactions (API)"
    assert body["columns"] == ["at", "amount"]
    # Lists and dicts both work; cells are text; a short row is padded, an extra key dropped.
    assert body["rows"] == [["2026-11-01", "120.5"], ["2026-10-30", None], ["2026-10-01", None]]
    request = recorder.calls[0]
    assert request.params == {"account": "acc-1", "days": 90, "kind": "pix"}
    assert request.user_email == READER and request.user_token == "tok" and request.context_id == ctx.id
    assert request.target["id"] == "acc-1" and request.row_limit == 1000
    assert "properties" not in request.target  # only what the action binds leaves
    by_id = {p["id"]: p for p in body["parameters"]}
    assert by_id["account"]["source"] == "binding" and by_id["days"]["source"] == "default"
    assert by_id["days"]["description"] == "Window (int, 1 to 365)"
    assert by_id["kind"]["type"] == "select" and by_id["kind"]["options"] == ["pix", "ted"]
    assert client.post(url, json={"target": NODE}, headers=h(STRANGER)).status_code in (403, 404)


def test_values_given_fixed_and_refused(env):
    client, url, recorder, ctx = env
    register_table_provider(_provider(recorder))
    r = client.post(url, json={"target": NODE, "parameters": {"days": "7", "kind": "ted"}}, headers=h(READER))
    assert recorder.calls[-1].params == {"account": "acc-1", "days": 7, "kind": "ted"}
    assert {p["id"]: p["source"] for p in r.json()["parameters"]}["days"] == "given"
    calls = len(recorder.calls)
    for given, said in (({"days": "9999"}, "above the maximum"), ({"kind": "boleto"}, "must be one of"),
                        ({"days": "soon"}, "decimal")):
        body = client.post(url, json={"target": NODE, "parameters": given}, headers=h(READER)).json()
        assert body["status"] == "needs_parameters" and said in next(iter(body["problems"].values()))
    # No binding resolves and nothing is given: the required one is missing.
    ctx.context_menu_actions = [_action(paramBindings={"account": "{prop:missing}"})]
    body = client.post(url, json={"target": NODE}, headers=h(READER)).json()
    assert body["status"] == "needs_parameters" and body["problems"] == {"account": "needs a value"}
    assert len(recorder.calls) == calls
    # What the action fixes wins over what the caller sends, and says so.
    ctx.context_menu_actions = [_action(params={"days": 30})]
    body = client.post(url, json={"target": NODE, "parameters": {"days": "7"}}, headers=h(READER)).json()
    assert body["status"] == "succeeded" and recorder.calls[-1].params["days"] == 30
    assert {p["id"]: p["locked"] for p in body["parameters"]} == {"account": False, "days": True, "kind": False}


def test_rows_are_cut_and_failures_come_back_with_the_parameters(env):
    client, url, recorder, ctx = env
    register_table_provider(_provider(recorder, timeout_seconds=0.05))
    body = client.post(url, json={"target": NODE, "row_limit": 2}, headers=h(READER)).json()
    assert body["row_count"] == 2 and body["truncated"] is True and recorder.calls[-1].row_limit == 2
    recorder.error = TableProviderError("The ledger is down")
    body = client.post(url, json={"target": NODE}, headers=h(READER)).json()
    assert body["status"] == "failed" and body["error"] == {"code": "TABLE_PROVIDER_FAILED", "message": "The ledger is down"}
    assert body["parameters"][0]["value"] == "acc-1"
    recorder.error = RuntimeError("password=hunter2")
    body = client.post(url, json={"target": NODE}, headers=h(READER)).json()
    assert body["error"]["message"] == "The provider failed"
    recorder.error, recorder.answer = None, {"columns": []}
    assert client.post(url, json={"target": NODE}, headers=h(READER)).json()["status"] == "failed"
    recorder.answer, recorder.delay = None, 1.0
    body = client.post(url, json={"target": NODE}, headers=h(READER)).json()
    assert body["error"]["code"] == "TABLE_PROVIDER_TIMEOUT"


def test_refusals(env):
    client, url, recorder, ctx = env
    r = client.post(url, json={"target": NODE}, headers=h(READER))
    assert r.status_code == 400 and r.json()["detail"]["error"]["code"] == "TABLE_PROVIDER_NOT_REGISTERED"
    allowed = {"ok": False}
    register_table_provider(_provider(recorder, applies_to=lambda context: allowed["ok"]))
    r = client.post(url, json={"target": NODE}, headers=h(READER))
    assert r.status_code == 403 and r.json()["detail"]["error"]["code"] == "TABLE_PROVIDER_NOT_ALLOWED"
    allowed["ok"] = True
    edge = {"type": "edge", "id": "e1", "src": "a", "dst": "b", "relationship_type": "PIX"}
    r = client.post(url, json={"target": edge}, headers=h(READER))
    assert r.status_code == 400 and r.json()["detail"]["error"]["code"] == "TABLE_PROVIDER_TARGET"
    ctx.context_menu_actions = [_action(enabled=False)]
    r = client.post(url, json={"target": NODE}, headers=h(READER))
    assert r.json()["detail"]["error"]["code"] == "MENU_ACTION_NOT_TABLE"
    assert recorder.calls == []
