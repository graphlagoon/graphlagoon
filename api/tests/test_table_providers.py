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
        "source": "tx_history", "paramBindings": {"account": "{node_id}"},
        "match": {"target": "node", "nodeTypes": ["Account"]},
        **overrides,
    }


def _source(**ref):
    """The context's declaration of the provider: every parameter open unless said otherwise."""
    return {"name": "tx_history", "label": "Transactions (ledger)", "description": "Transactions of an account",
            "table_provider": {"name": "tx-history", "runtime_params": ["account", "days", "kind"], **ref}}


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
    ctx.enrichment_tables = [_source()]
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
    assert body["template_name"] == "Transactions (ledger)"  # the context's name for the source
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


# --- The context declares the source -------------------------------------------


def test_an_action_runs_only_through_a_source_the_context_declares(env):
    client, url, recorder, ctx = env
    register_table_provider(_provider(recorder))
    ctx.enrichment_tables = []
    r = client.post(url, json={"target": NODE}, headers=h(READER))
    assert r.status_code == 404 and r.json()["detail"]["error"]["code"] == "TABLE_SOURCE_NOT_DECLARED"
    assert recorder.calls == []
    # An action written before sources existed names the provider: it finds the source that uses it.
    ctx.enrichment_tables = [_source()]
    ctx.context_menu_actions = [{**_action(), "source": None, "provider": "tx-history"}]
    assert client.post(url, json={"target": NODE}, headers=h(READER)).json()["status"] == "succeeded"


def test_the_context_sets_values_and_says_which_ones_a_caller_may_change(env):
    client, url, recorder, ctx = env
    register_table_provider(_provider(recorder))
    # Only `account` is open: `days` is the context's 30, `kind` the provider's default.
    ctx.enrichment_tables = [_source(params={"days": 30}, runtime_params=["account"])]
    body = client.post(url, json={"target": NODE}, headers=h(READER)).json()
    assert recorder.calls[-1].params == {"account": "acc-1", "days": 30, "kind": "pix"}
    assert {p["id"]: p["locked"] for p in body["parameters"]} == {"account": False, "days": True, "kind": True}
    # Neither the caller nor the action's own fixed value gets past what the context closed.
    ctx.context_menu_actions = [_action(params={"days": 7, "kind": "ted"})]
    body = client.post(url, json={"target": NODE, "parameters": {"days": "7"}}, headers=h(READER)).json()
    assert body["status"] == "succeeded" and recorder.calls[-1].params == {"account": "acc-1", "days": 30, "kind": "pix"}


def test_declaring_a_source_takes_context_create_and_a_provider_that_fits(env, monkeypatch):
    client, url, recorder, ctx = env
    put = f"/api/graph-contexts/{ctx.id}"
    ctx.enrichment_tables = []
    r = client.put(put, json={"enrichment_tables": [_source()]}, headers=h(OWNER))
    assert r.status_code == 400 and r.json()["detail"]["error"]["code"] == "TABLE_PROVIDER_NOT_REGISTERED"
    allowed = {"ok": False}
    register_table_provider(_provider(recorder, applies_to=lambda context: allowed["ok"]))
    r = client.put(put, json={"enrichment_tables": [_source()]}, headers=h(OWNER))
    assert r.status_code == 403 and r.json()["detail"]["error"]["code"] == "TABLE_PROVIDER_NOT_ALLOWED"
    allowed["ok"] = True
    for ref, said in (({"params": {"days": 0}}, "below the minimum"), ({"runtime_params": ["nope"]}, "declares no parameter"),
                      ({"runtime_params": ["days"]}, "required")):
        r = client.put(put, json={"enrichment_tables": [_source(**ref)]}, headers=h(OWNER))
        assert r.status_code == 400, r.text
        error = r.json()["detail"]["error"]
        assert error["code"] == "TABLE_SOURCE_PARAM_INVALID" and said in error["message"]
    r = client.put(put, json={"enrichment_tables": [_source()]}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["enrichment_tables"][0]["table_provider"]["name"] == "tx-history"
    # A writer without "Create graph contexts" cannot attach one (it may still edit the rest).
    from graphlagoon.routers import graph_contexts as router

    async def refuse(request):
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail={"error": {"code": "PERMISSION_DENIED", "message": "no"}})

    monkeypatch.setattr(router, "require_permission", lambda permission: refuse)
    changed = _source(params={"days": 10})
    assert client.put(put, json={"enrichment_tables": [changed]}, headers=h(OWNER)).status_code == 403
    assert client.put(put, json={"description": "x", "enrichment_tables": [_source()]}, headers=h(OWNER)).status_code == 200


def test_a_source_is_asked_directly_by_its_name(env):
    client, url, recorder, ctx = env
    register_table_provider(_provider(recorder))
    direct = f"/api/graph-contexts/{ctx.id}/sources/tx_history/table"
    body = client.post(direct, json={"parameters": {"account": "acc-9", "days": "7"}, "row_limit": 2}, headers=h(READER)).json()
    assert body["status"] == "succeeded" and body["row_count"] == 2 and body["truncated"] is True
    request = recorder.calls[-1]
    assert request.params == {"account": "acc-9", "days": 7, "kind": "pix"} and request.target == {}
    # With the item it is about, for a provider that reads it.
    client.post(direct, json={"parameters": {"account": "a"}, "target": {"type": "node", "id": "acc-1"}}, headers=h(READER))
    assert recorder.calls[-1].target == {"type": "node", "id": "acc-1"}
    body = client.post(direct, json={}, headers=h(READER)).json()
    assert body["status"] == "needs_parameters" and body["problems"] == {"account": "needs a value"}
    body = client.post(direct, json={"parameters": {"account": "a", "bogus": "1"}}, headers=h(READER)).json()
    assert body["problems"] == {"bogus": "the provider has no such parameter"}
    r = client.post(f"/api/graph-contexts/{ctx.id}/sources/nope/table", json={}, headers=h(READER))
    assert r.status_code == 404 and r.json()["detail"]["error"]["code"] == "TABLE_SOURCE_NOT_DECLARED"
    assert client.post(direct, json={"parameters": {"account": "a"}}, headers=h(STRANGER)).status_code in (403, 404)
