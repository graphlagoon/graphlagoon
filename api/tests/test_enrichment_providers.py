"""Enrichment by providers the deployer registers in Python (no SQL, no warehouse)."""

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
from pydantic import ValidationError  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.models.schemas import EnrichmentTable, GraphContextResponse  # noqa: E402
from graphlagoon.routers import graph_contexts  # noqa: E402
from graphlagoon.services.enrichment_providers import (  # noqa: E402
    EnrichmentProvider,
    EnrichmentProviderError,
    clear_enrichment_provider_registry,
    get_enrichment_providers,
    register_enrichment_provider,
)
from graphlagoon.services.public_config import build_public_config  # noqa: E402

OWNER = "owner@example.com"
READER = "reader@example.com"
STRANGER = "stranger@example.com"
KYC = {
    "name": "kyc",
    "label": "KYC risk",
    "provider": {"name": "kyc-demo", "target": "nodes", "run": "auto"},
}
BATCH = {
    "edges": [{"edge_id": "e1", "src": "a", "dst": "b", "relationship_type": "PAYS"}],
    "nodes": [
        {"node_id": "a", "node_type": "Conta", "properties": {"doc": "1"}},
        {"node_id": "b", "node_type": "Conta"},
    ],
}


def _h(email):
    return {"X-Forwarded-Email": email}


class _Recorder:
    def __init__(self, answer=None, error=None, delay=0.0):
        self.calls = []
        self.answer = answer if answer is not None else {
            "a": {"risk": 0.9, "since": object()},
            "b": {"risk": None},
            "zz": {"risk": 1},  # not sent: dropped
        }
        self.error, self.delay = error, delay

    async def __call__(self, request):
        self.calls.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return self.answer


def _provider(recorder=None, **kw):
    async def enrich(request):
        return await (recorder or _Recorder())(request)

    return EnrichmentProvider(name="kyc-demo", enrich=enrich, label="KYC (demo)", **kw)


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_CATALOG_SCHEMAS", "main.graphs")
    get_settings.cache_clear()
    InMemoryStore.reset()
    clear_enrichment_provider_registry()
    store = InMemoryStore.get_instance()
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(graph_contexts.router)
    # A provider entry must never reach the warehouse.
    app.dependency_overrides[graph_contexts.get_warehouse] = lambda: None
    yield TestClient(app), store
    clear_enrichment_provider_registry()
    InMemoryStore.reset()
    get_settings.cache_clear()


def _run(client, ctx, who=READER, body=BATCH, name="kyc"):
    return client.post(f"/api/graph-contexts/{ctx.id}/enrichment/{name}/run", json=body, headers=_h(who))


# --- Registration -------------------------------------------------------------


def test_registration_validates_eagerly():
    clear_enrichment_provider_registry()

    def sync(request):
        return {}

    with pytest.raises(ValueError, match="async"):
        register_enrichment_provider(EnrichmentProvider(name="x", enrich=sync))
    with pytest.raises(ValueError, match="name"):
        register_enrichment_provider(_provider().__class__(name="Bad Name", enrich=_provider().enrich))
    with pytest.raises(ValueError, match="targets"):
        register_enrichment_provider(_provider(targets=("rows",)))
    p = _provider()
    register_enrichment_provider(p)
    register_enrichment_provider(p)  # same object: idempotent
    with pytest.raises(ValueError, match="already registered"):
        register_enrichment_provider(_provider())
    assert get_enrichment_providers() == [p]
    clear_enrichment_provider_registry()


def test_public_config_lists_copy_and_targets_only(env):
    register_enrichment_provider(_provider(targets=("nodes",), description="Lakebase KYC"))
    config = asyncio.run(build_public_config(OWNER))
    assert config["enrichment_providers"] == [
        {"name": "kyc-demo", "label": "KYC (demo)", "description": "Lakebase KYC", "targets": ["nodes"]}
    ]


# --- Shape --------------------------------------------------------------------


def test_entry_is_a_table_or_a_provider():
    EnrichmentTable(**KYC)
    with pytest.raises(ValidationError, match="table or a provider"):
        EnrichmentTable(name="x", label="X")
    with pytest.raises(ValidationError, match="no table"):
        EnrichmentTable(**{**KYC, "table": "main.graphs.t"})
    with pytest.raises(ValidationError):
        EnrichmentTable(**{**KYC, "provider": {"name": "kyc-demo", "sql": "x"}})


# --- Save ---------------------------------------------------------------------


def test_save_refuses_an_unregistered_provider_or_target(env):
    client, store = env
    ctx = store.create_graph_context("pix", "main.graphs.e", "main.graphs.n", OWNER)
    url = f"/api/graph-contexts/{ctx.id}"
    r = client.put(url, json={"enrichment_tables": [KYC]}, headers=_h(OWNER))
    assert r.status_code == 400
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_PROVIDER_NOT_REGISTERED"
    register_enrichment_provider(_provider(targets=("edges",)))
    r = client.put(url, json={"enrichment_tables": [KYC]}, headers=_h(OWNER))
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_PROVIDER_TARGET"


def test_saved_entry_reads_back_even_after_its_provider_is_gone(env):
    client, store = env
    register_enrichment_provider(_provider())
    ctx = store.create_graph_context("pix", "main.graphs.e", "main.graphs.n", OWNER)
    url = f"/api/graph-contexts/{ctx.id}"
    r = client.put(url, json={"enrichment_tables": [KYC]}, headers=_h(OWNER))
    assert r.status_code == 200, r.text
    clear_enrichment_provider_registry()
    r = client.get(url, headers=_h(OWNER))
    assert r.status_code == 200
    entry = r.json()["enrichment_tables"][0]
    assert entry["provider"]["name"] == "kyc-demo" and entry["table"] is None
    assert client.get("/api/graph-contexts", headers=_h(OWNER)).status_code == 200
    # An unrelated edit keeps the unchanged entry without re-proving it.
    r = client.put(url, json={"description": "x", "enrichment_tables": [KYC]}, headers=_h(OWNER))
    assert r.status_code == 200, r.text
    GraphContextResponse.model_validate(r.json())
    # Running it says why.
    store.share_graph_context(ctx.id, READER, "read")
    r = _run(client, ctx)
    assert r.status_code == 400
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_PROVIDER_NOT_REGISTERED"


# --- Run ----------------------------------------------------------------------


def _ctx(store):
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[KYC]
    )
    store.share_graph_context(ctx.id, READER, "read")
    return ctx


def test_reader_runs_a_provider_and_gets_scalars_for_sent_ids_only(env):
    client, store = env
    recorder = _Recorder()
    register_enrichment_provider(_provider(recorder))
    ctx = _ctx(store)
    r = _run(client, ctx)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["target"] == "nodes" and body["label"] == "KYC risk"
    assert set(body["rows"]) == {"a", "b"}
    assert body["rows"]["a"]["risk"] == 0.9 and isinstance(body["rows"]["a"]["since"], str)
    assert body["columns"] == ["risk", "since"] and body["truncated"] is False
    request = recorder.calls[0]
    assert request.target == "nodes" and request.user_email == READER
    assert request.context_id == ctx.id
    # Node properties travel only when the entry asks for them.
    assert request.nodes[0]["properties"] == {}


def test_stranger_cannot_run(env):
    client, store = env
    register_enrichment_provider(_provider())
    ctx = _ctx(store)
    assert _run(client, ctx, who=STRANGER).status_code in (403, 404)


def test_provider_error_message_reaches_the_user_other_errors_do_not(env):
    client, store = env
    ctx = _ctx(store)
    register_enrichment_provider(_provider(_Recorder(error=EnrichmentProviderError("Lakebase is down"))))
    r = _run(client, ctx)
    assert r.status_code == 502
    assert r.json()["detail"]["error"] == {
        "code": "ENRICHMENT_PROVIDER_FAILED", "message": "Lakebase is down", "details": {},
    }
    clear_enrichment_provider_registry()
    register_enrichment_provider(_provider(_Recorder(error=RuntimeError("password=hunter2"))))
    r = _run(client, ctx)
    assert r.status_code == 502 and "hunter2" not in r.text
    clear_enrichment_provider_registry()
    register_enrichment_provider(_provider(_Recorder(answer=["not", "a", "dict"])))
    assert _run(client, ctx).json()["detail"]["error"]["code"] == "ENRICHMENT_PROVIDER_FAILED"


def test_provider_is_cancelled_after_its_timeout(env):
    client, store = env
    ctx = _ctx(store)
    register_enrichment_provider(_provider(_Recorder(delay=1.0), timeout_seconds=0.05))
    r = _run(client, ctx)
    assert r.status_code == 504
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_PROVIDER_TIMEOUT"


def test_caps_keys_and_rows(env, monkeypatch):
    client, store = env
    ctx = _ctx(store)
    register_enrichment_provider(_provider())
    monkeypatch.setenv("GRAPH_LAGOON_ENRICHMENT_MAX_KEYS", "1")
    get_settings.cache_clear()
    r = _run(client, ctx)
    assert r.json()["detail"]["error"]["code"] == "TOO_MANY_KEYS"
    monkeypatch.setenv("GRAPH_LAGOON_ENRICHMENT_MAX_KEYS", "500")
    monkeypatch.setenv("GRAPH_LAGOON_ENRICHMENT_MAX_ROWS", "1")
    get_settings.cache_clear()
    body = _run(client, ctx).json()
    assert len(body["rows"]) == 1 and body["truncated"] is True
    r = _run(client, ctx, body={"edges": BATCH["edges"], "nodes": []})
    assert r.json()["detail"]["error"]["code"] == "INVALID_KEY"


def test_a_snapshot_keeps_which_values_enrichment_wrote():
    from graphlagoon.models.schemas import GraphSnapshot

    snapshot = GraphSnapshot.model_validate({
        "nodes": [{"id": "a", "type": "Conta", "properties": {"kyc_tier": "high"}}],
        "edges": [],
        "enriched": {"nodes": {"a": {"KYC": ["kyc_tier"]}}},
    })
    dumped = snapshot.model_dump()
    assert dumped["enriched"] == {"nodes": {"a": {"KYC": ["kyc_tier"]}}}
    assert GraphSnapshot.model_validate({"nodes": [], "edges": []}).enriched is None


def test_a_timeout_raised_by_the_provider_itself_is_a_failure_not_our_timeout(env):
    client, store = env
    ctx = _ctx(store)
    register_enrichment_provider(_provider(_Recorder(error=TimeoutError("socket"))))
    r = _run(client, ctx)
    assert r.status_code == 502
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_PROVIDER_FAILED"


def test_an_agent_edit_takes_a_key_from_enrichment():
    from graphlagoon.services.exploration_graph import apply_edit

    before = {
        "nodes": [
            {"id": "a", "type": "Conta", "properties": {"kyc_tier": "high", "kyc_score": 0.9}},
            {"id": "b", "type": "Conta", "properties": {"kyc_tier": "low"}},
        ],
        "edges": [],
        "enriched": {"nodes": {"a": {"KYC": ["kyc_tier", "kyc_score"]}, "b": {"KYC": ["kyc_tier"]}}},
    }
    after, _, _ = apply_edit(before, None, {
        "set_properties": [{"id": "a", "kind": "node", "properties": {"kyc_tier": "reviewed"}}],
        "remove_node_ids": ["b"],
    })
    # The value the agent set is its own now; the untouched one is still enrichment's.
    assert after["enriched"] == {"nodes": {"a": {"KYC": ["kyc_score"]}}}
    fresh, _, _ = apply_edit(before, None, {"replace": True, "add_nodes": [{"id": "a", "type": "Conta"}]})
    assert "enriched" not in fresh


def test_an_entry_may_say_what_it_does_and_old_ones_read_the_same():
    from graphlagoon.models.schemas import EnrichmentTable

    described = EnrichmentTable(name="kyc", label="KYC", description="KYC tier. Run before grouping by risk.",
                                provider={"name": "kyc", "target": "nodes"})
    assert described.model_dump()["description"].startswith("KYC tier")
    assert EnrichmentTable(name="kyc", label="KYC", provider={"name": "kyc"}).description is None
    with pytest.raises(ValueError):
        EnrichmentTable(name="kyc", label="KYC", description="x" * 1001, provider={"name": "kyc"})
