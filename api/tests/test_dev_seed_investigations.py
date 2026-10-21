"""The investigations dev seed, run in-process against the whole API (memory mode)."""

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

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.dev.seed import ADMIN_EMAIL  # noqa: E402
from graphlagoon.dev.seed_investigations import MARKER, run_seed_investigations  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import case_items, investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from graphlagoon.services.case_graph import case_graph  # noqa: E402


@pytest.fixture
def in_process(monkeypatch, tmp_path):
    for key, value in {
        "GRAPH_LAGOON_DEV_MODE": "true",
        "GRAPH_LAGOON_AGENTS_ENABLED": "true",
        "GRAPH_LAGOON_SUPERUSER_EMAILS": ADMIN_EMAIL,
        "GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS": "example.com",
    }.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    transport = httpx.ASGITransport(app=app)
    original = httpx.AsyncClient.__init__

    def patched(self, *args, **kwargs):
        kwargs["transport"] = transport
        original(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_seeds_the_four_scenarios_on_items_and_annotations_then_resets(in_process):
    store = in_process
    quiet = lambda *_: None  # noqa: E731
    stats = await run_seed_investigations("http://testserver", cases=6, chargebacks=3, log=quiet)

    seeded = [i for i in store.investigations.values() if MARKER in (i.description or "") and i.case_type != "chargeback_dispute"]
    assert len(seeded) == 7 and stats.agent and stats.case_types  # the fraud ring brings its follow-up case
    # The dev org's case types are data written by the superuser; every scenario uses one.
    assert {"fraud_ring", "credit_review", "insider_data_leak", "merchant_review", "chargeback_dispute"} <= set(store.case_types)
    assert {i.case_type for i in seeded} >= {"fraud_ring", "credit_review", "insider_data_leak", "merchant_review"}
    credit_case = next(i for i in seeded if i.case_type == "credit_review" and i.title.startswith("Credit review"))
    assert credit_case.fields == {"requested_limit": 2_500_000.0, "rating": "B"} and credit_case.sla_hours == {"open": 72, "analysis": 168}
    disputes = [i for i in store.investigations.values() if i.case_type == "chargeback_dispute"]
    assert len(disputes) == 3 and all(i.external_ref and i.fields["reason_code"] for i in disputes)
    assert {i.status for i in seeded} == {"open", "analysis", "closed"}
    # Decisions: a partial one with targets, one waiting for its four-eyes review, closed and reopened cases.
    decisions = [d for i in seeded for d in i.decisions or []]
    assert stats.decisions == len(decisions) >= 3 and any(d["targets"] for d in decisions)
    assert any(d["review"] == "pending" for d in decisions)
    # The Brazilian example is data: SIMBA statements through the org's mapping, the Siscoaf report from a template.
    pix = next(i for i in seeded if i.case_type == "pix_scam")
    assert {d.slug for d in store.org_library.values()} >= {"siscoaf-cos", "simba-bank-statements"}
    pix_items = [i for i in store.case_items.values() if i.investigation_id == pix.id]
    assert any((i.provenance or {}).get("template") == "siscoaf-cos" for i in pix_items)
    assert any(i.kind == "query" and (i.provenance or {}).get("tool") == "case_type" for i in pix_items)
    assert {n["type"] for n in (await case_graph(pix.id, pix.owner_email))["nodes"]} >= {"Account", "Person"}
    # 06 P7: the follow-up of the fraud ring shares its device: seen in the other case.
    from graphlagoon.services.case_entities import find_cases

    follow = next(i for i in store.investigations.values() if i.title.startswith("Fraud ring · refund"))
    device = next(n["uid"] for n in (await case_graph(follow.id, follow.owner_email))["nodes"] if n["type"] == "Device")
    first = next(i for i in seeded if i.title.startswith("Fraud ring · shared"))
    assert {c["title"] for c in await find_cases(device, follow.owner_email)} == {follow.title, first.title}
    tasks = [a for a in store.case_annotations.values() if a.kind == "task"]
    assert len(tasks) >= 5 and {t.value["decision_id"] for t in tasks if t.value.get("decision_id")}
    assert any(t.value["assignee_kind"] == "agent" for t in tasks) and any(t.status == "suggested" for t in tasks)
    assert all(i.status == "closed" for i in seeded if any(d["closed_at"] for d in i.decisions or []) and i.title.startswith("Insider"))
    assert not store.graph_contexts and not store.explorations  # no context per upload (05 §1)
    items = list(store.case_items.values())
    assert {i.kind for i in items} == {"graph", "table", "query", "document", "note"}
    assert stats.items["table"] >= 6 and stats.pinned >= 1 and stats.suggested >= 5
    assert {i.author_kind for i in items} == {"human", "agent"}
    annotations = list(store.case_annotations.values())
    assert {a.kind for a in annotations} >= {"role", "group", "tag", "hypothesis", "hypothesis_status", "same_as"}
    assert any(a.status == "suggested" and a.author_kind == "agent" for a in annotations)

    # Every case puts a graph on the canvas from its own material, no context involved.
    for inv in seeded:
        graph = await case_graph(inv.id, inv.owner_email)
        assert graph["nodes"], inv.title
    ring = next(i for i in seeded if i.title.startswith("Fraud ring"))
    types = {n["type"] for n in (await case_graph(ring.id, ring.owner_email))["nodes"]}
    assert types >= {"Customer", "Phone", "Email", "Device", "IP", "Card", "Address"}
    credit = next(i for i in seeded if i.title.startswith("Credit review"))
    kinds = {(i.kind, i.subkind) for i in items if i.investigation_id == credit.id}
    assert {("query", "sql"), ("document", "brief"), ("table", "csv")} <= kinds

    # The flagship mule network: the T5 flow-chain graph, trace saved and pinned with the fixture's numbers.
    flagship = next(i for i in seeded if i.title.startswith("Mule network"))
    assert stats.flagship == str(flagship.id)
    trace_item = next(i for i in items if i.investigation_id == flagship.id and (i.provenance or {}).get("tool") == "trace")
    # BYOD-2: the mule case carries a hand-drawn "Manual additions" item.
    assert any(i.subkind == "sketch" for i in items if i.investigation_id == flagship.id)
    data, version, _ = await case_items.get_content(flagship.id, flagship.owner_email, trace_item.id)
    trace = json.loads(data)
    assert version["pinned_at"] and (sorted(trace["exits"].values()), trace["coverage"]) == ([880, 1550, 2000], 0.9097)
    brief = await case_items.get_brief(flagship.id, flagship.owner_email)
    assert brief["item"]["author_kind"] == "agent" and "FIFO" in brief["text"]

    again = await run_seed_investigations("http://testserver", cases=2, reset=True, log=quiet)
    assert again.deleted == 10  # 7 cases (the ring brings its follow-up) + 3 disputes
    assert len([i for i in store.investigations.values() if MARKER in (i.description or "")]) == 3  # + the ring follow-up


@pytest.mark.asyncio
async def test_twenty_cases_as_documented_seed_without_errors(in_process):
    """`--cases 20` (the README's usage) reaches the extras whose closing outcomes
    need four eyes: the approver gets edit access before reviewing."""
    store = in_process
    stats = await run_seed_investigations("http://testserver", cases=20, chargebacks=0, log=lambda *_: None)
    seeded = [i for i in store.investigations.values() if MARKER in (i.description or "")]
    assert stats.cases == len(seeded) == 21  # + the fraud ring's follow-up case
    approved = [d for i in seeded for d in i.decisions or [] if d.get("review") == "approved"]
    assert approved and all(d.get("reviewed_by") != d["decided_by"] for d in approved)
