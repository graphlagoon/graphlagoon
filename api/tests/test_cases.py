"""Cases (05 §1, §3, §7): transitions, reopen, sharing, the agent's suggested
status change, a reproducible frozen hash the export verifies, InMemoryStore
parity and the 016 migration on SQLite."""

import sys
from datetime import datetime, timedelta
from uuid import UUID

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
from graphlagoon.db.memory_store import INVESTIGATION_CHILDREN, InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import cases as service  # noqa: E402
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"
READER = "reader@example.com"
EDITOR = "editor@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app)
    InMemoryStore.reset()
    get_settings.cache_clear()


def _case(client, **body):
    r = client.post("/api/investigations", json={"title": "Case", **body}, headers=h(OWNER))
    assert r.status_code == 201, r.text
    return r.json()


def test_english_enums_transitions_and_reopen(client):
    inv = _case(client)
    assert (inv["status"], inv["case_type"], inv["deadline"], inv["decisions"]) == ("open", "general", None, [])
    url = f"/api/investigations/{inv['id']}"
    for status in ("closed", "decided", "archived"):
        assert client.patch(url, json={"status": status}, headers=h(OWNER)).status_code == 422  # only a decision closes
    assert client.patch(url, json={"status": "analysis"}, headers=h(OWNER)).json()["status"] == "analysis"
    assert client.patch(url, json={"status": "open"}, headers=h(OWNER)).json()["status"] == "open"
    r = client.patch(url, json={"stage": "waiting"}, headers=h(OWNER))
    assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "UNKNOWN_STAGE"  # general has no stages
    assert client.post(f"{url}/reopen", headers=h(OWNER)).status_code == 409  # not closed
    # general has no catalog: the decision is named and says whether it closes the case.
    r = client.post(f"{url}/decisions", json={"rationale": "nothing"}, headers=h(OWNER))
    assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "OUTCOME_REQUIRED"
    closed = client.post(
        f"{url}/decisions", json={"outcome_label": "Duplicate of #0411", "closes_case": True, "rationale": "same alert"},
        headers=h(OWNER),
    ).json()
    first = closed["decisions"][0]
    assert closed["status"] == "closed" and closed["frozen_hash"] == first["hash"] and first["closed_at"]
    assert (first["outcome"], first["outcome_label"], first["review"]) == (None, "Duplicate of #0411", None)
    r = client.patch(url, json={"status": "analysis"}, headers=h(OWNER))
    assert r.status_code == 409 and r.json()["detail"]["error"]["code"] == "CASE_CLOSED"
    reopened = client.post(f"{url}/reopen", headers=h(OWNER)).json()
    assert reopened["status"] == "analysis" and reopened["decisions"] == closed["decisions"]  # decisions stay
    assert reopened["frozen_hash"] is None
    events = client.get(f"{url}/events", headers=h(OWNER)).json()
    assert [e["kind"] for e in events][-3:] == ["decision.recorded", "case.closed", "case.reopened"]
    assert events[-1]["payload"] == {"decision_id": first["id"], "hash": first["hash"], "to": "analysis"}
    assert "hash" not in events[0]


def test_deadline_follows_the_sla_hours(client, monkeypatch):
    alert = datetime(2026, 1, 1)
    monkeypatch.setattr(service, "_clock", lambda: alert + timedelta(days=10))
    sla = {"open": 45 * 24, "analysis": 45 * 24}
    inv = _case(client, sla_hours=sla, alert_at=alert.isoformat())
    assert inv["deadline"] == {"phase": "open", "due_at": "2026-02-15T00:00:00", "hours_left": 840, "days_left": 35,
                               "total_hours": 1080, "urgent": False, "overdue": False}
    url = f"/api/investigations/{inv['id']}"
    analysis = client.patch(url, json={"status": "analysis"}, headers=h(OWNER)).json()
    assert (analysis["deadline"]["days_left"], analysis["deadline"]["total_hours"]) == (80, 2160)  # 45 + 45 days
    custom = client.patch(url, json={"sla_hours": {"open": 240, "analysis": 120}}, headers=h(OWNER)).json()
    assert (custom["deadline"]["days_left"], custom["deadline"]["urgent"]) == (5, False)
    tight = client.patch(url, json={"sla_hours": {"open": 240, "analysis": 24}}, headers=h(OWNER)).json()
    assert (tight["deadline"]["hours_left"], tight["deadline"]["urgent"]) == (24, True)  # under 20% of 264 h
    assert _case(client)["deadline"] is None  # general: no SLA
    # alert_at, else occurred_at, else created_at
    occurred = _case(client, sla_hours=sla, occurred_at=(alert - timedelta(days=5)).isoformat())
    assert occurred["deadline"]["days_left"] == 30
    queue = {i["id"]: i for i in client.get("/api/investigations", headers=h(OWNER)).json()["items"]}
    assert queue[occurred["id"]]["deadline"]["total_hours"] == 1080


def test_share_roles_assignee_and_access(client):
    inv = _case(client, assignee_email=EDITOR)
    url = f"/api/investigations/{inv['id']}"
    assert inv["shared_with"] == [{"email": EDITOR, "role": "editor"}]  # assignee ⇒ editor share
    assert client.post(f"{url}/share", json={"email": "*@example.com"}, headers=h(OWNER)).status_code == 422
    assert client.post(f"{url}/share", json={"email": READER}, headers=h(OWNER)).status_code == 200
    as_reader = client.get(url, headers=h(READER)).json()
    assert (as_reader["has_write_access"], as_reader["can_manage"]) == (False, False)
    assert client.patch(url, json={"title": "x"}, headers=h(READER)).status_code == 403
    assert client.patch(url, json={"title": "x"}, headers=h(EDITOR)).status_code == 200
    # Only who can share assigns.
    assert client.patch(url, json={"assignee_email": READER}, headers=h(EDITOR)).status_code == 403
    assert client.get(url, headers=h("nobody@example.com")).status_code == 404
    assert client.delete(f"{url}/share/{READER}", headers=h(OWNER)).status_code == 200
    assert client.get(url, headers=h(READER)).status_code == 404
    listed = client.get("/api/investigations", headers=h(EDITOR)).json()["items"]
    assert [i["id"] for i in listed] == [inv["id"]] and listed[0]["item_count"] == 0


def test_agent_status_change_becomes_a_suggestion(client):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    token = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()["token"]
    agent = {"Authorization": f"Bearer {token}"}
    r = client.patch(url, json={"status": "analysis"}, headers=agent)
    assert r.status_code == 200 and r.json()["status"] == "open"
    [suggestion] = client.get(f"{url}/annotations", headers=h(OWNER)).json()
    assert suggestion["kind"] == "status_change" and suggestion["status"] == "suggested"
    assert suggestion["author_kind"] == "agent" and suggestion["value"] == {"from": "open", "to": "analysis"}
    assert client.post(f"{url}/annotations/{suggestion['id']}/confirm", headers=agent).status_code == 403
    r = client.post(f"{url}/annotations/{suggestion['id']}/confirm", headers=h(OWNER))
    assert r.status_code == 200 and r.json()["confirmed_by"] == OWNER
    assert client.get(url, headers=h(OWNER)).json()["status"] == "analysis"
    assert client.get("/api/investigations", headers=h(OWNER)).json()["items"][0]["suggested_count"] == 0
    # A kind outside agent_suggest_kinds applies directly.
    client.patch(url, json={"settings": {"agent_suggest_kinds": []}}, headers=h(OWNER))
    assert client.patch(url, json={"status": "open"}, headers=agent).json()["status"] == "open"


DECISION = {"outcome_label": "Report to the FIU", "closes_case": True, "rationale": "Pass-through account."}


def _store_case(url):
    return InMemoryStore.get_instance().get_investigation(UUID(url.rsplit("/", 1)[1]))


def _hash_now(url, decision_id):
    import asyncio

    return asyncio.run(service.decision_hash(None, _store_case(url), decision_id))


def test_decision_hash_is_reproducible_and_the_export_verifies_it(client):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    client.post(f"{url}/share", json={"email": READER}, headers=h(OWNER))
    item = client.post(
        f"{url}/items",
        json={"kind": "document", "subkind": "markdown", "title": "KYC", "content": "# KYC\nincome 1800"},
        headers=h(OWNER),
    ).json()
    pin = client.post(f"{url}/items/{item['id']}/pin", json={"label": "E1"}, headers=h(OWNER))
    assert pin.status_code == 200 and pin.json()["pinned_by"] == OWNER
    assert client.post(f"{url}/decisions", json=DECISION, headers=h(READER)).status_code == 403
    assert client.post(f"{url}/decisions", json={**DECISION, "rationale": " "}, headers=h(OWNER)).status_code == 422
    r = client.post(f"{url}/decisions", json={**DECISION, "evidence": [{"item_id": item["id"], "version": 9}]}, headers=h(OWNER))
    assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "EVIDENCE_NOT_PINNED"

    r = client.post(f"{url}/decisions", json=DECISION, headers=h(OWNER))
    assert r.status_code == 200, r.text
    decided = r.json()
    decision = decided["decisions"][0]
    assert decided["status"] == "closed" and decision["evidence"] == [
        {"item_id": item["id"], "version": 1, "sha256": pin.json()["sha256"]}
    ]
    assert _hash_now(url, decision["id"]) == decision["hash"] == decided["frozen_hash"]
    # A later share stays outside the hash; tampering with a pinned version is detected.
    assert client.post(f"{url}/share", json={"email": "x@example.com"}, headers=h(OWNER)).status_code == 200
    assert _hash_now(url, decision["id"]) == decision["hash"]
    export = client.get(f"{url}/export?format=json", headers=h(OWNER))
    assert export.status_code == 200 and export.headers["X-Content-SHA256"]
    package = export.json()
    assert package["integrity"] == {"decisions": [{"id": decision["id"], "hash": decision["hash"], "verified": True}], "verified": True}
    assert package["evidence"][0]["pin_label"] == "E1"
    events = InMemoryStore.get_instance().investigation_events
    pin_event = next(e for e in events.values() if e.kind == "item.pinned") if isinstance(events, dict) else next(e for e in events if e.kind == "item.pinned")
    pin_event.payload = {**pin_event.payload, "sha256": "0" * 64}
    assert client.get(f"{url}/export?format=json", headers=h(OWNER)).json()["integrity"]["verified"] is False
    assert client.get(f"{url}/export?format=csv", headers=h(OWNER)).status_code == 200

    # Read-only afterwards; retained from deletion.
    for method, path, body in (
        ("patch", url, {"title": "y"}),
        ("patch", url, {"status": "analysis"}),
        ("post", f"{url}/items", {"kind": "note", "subkind": "free", "content": "x"}),
        ("post", f"{url}/annotations", {"kind": "tag", "targets": ["a"], "value": {"tag": "t"}}),
        ("post", f"{url}/items/{item['id']}/pin", {}),
        ("post", f"{url}/decisions", DECISION),
        ("delete", url, None),
    ):
        r = getattr(client, method)(path, headers=h(OWNER), **({"json": body} if body is not None else {}))
        assert r.status_code == 409, (method, path, r.text)
    actions = [e.action for e in InMemoryStore.get_instance().usage_logs]
    assert {"investigation.decide", "investigation.export"} <= set(actions)


MERCHANT = {
    "label": "Merchant review",
    "outcomes": [
        {"id": "offboard", "label": "Offboard", "closes_case": True, "requires_review": True},
        {"id": "monitor", "label": "Keep with monitoring", "closes_case": True, "requires_review": False},
        {"id": "block_terminal", "label": "Block terminal", "closes_case": False, "requires_review": False},
    ],
    "actions": [{"id": "hold_settlement", "label": "Hold settlement", "due_hours": 2}],
    "stages": ["Waiting for documents"],
}


def test_many_decisions_targets_four_eyes_and_reopen(client):
    """06 §1: a non-closing decision first, a closing one with four eyes, reopen
    and decide again; every hash stays valid."""
    assert client.put("/api/admin/case-types/merchant_review", json=MERCHANT, headers=h(SUPERUSER)).status_code == 200
    inv = _case(client, case_type="merchant_review")
    url = f"/api/investigations/{inv['id']}"
    for email in (EDITOR, READER):
        client.post(f"{url}/share", json={"email": email, "role": "editor"}, headers=h(OWNER))
    assert client.patch(url, json={"stage": "Waiting for documents"}, headers=h(OWNER)).json()["stage"] == "Waiting for documents"
    r = client.post(f"{url}/decisions", json={"outcome": "nope", "rationale": "x"}, headers=h(OWNER))
    assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "UNKNOWN_OUTCOME"
    r = client.post(f"{url}/decisions", json={"outcome": "block_terminal", "rationale": "x", "tasks": [{"action": "fly"}]}, headers=h(OWNER))
    assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "UNKNOWN_ACTION"

    first = client.post(
        f"{url}/decisions",
        json={"outcome": "block_terminal", "targets": ["entity:t-1", "entity:t-1", "entity:t-2"], "rationale": "shared terminal",
              "outcome_label": "ignored", "closes_case": True},
        headers=h(OWNER),
    ).json()
    d1 = first["decisions"][0]
    assert first["status"] == "open" and (d1["outcome_label"], d1["closes_case"]) == ("Block terminal", False)
    assert d1["targets"] == ["entity:t-1", "entity:t-2"]

    for reviewer, code in ((OWNER, "FOUR_EYES"), ("stranger@example.com", "REVIEWER_NO_ACCESS")):
        r = client.post(f"{url}/decisions", json={"outcome": "offboard", "rationale": "x", "reviewer_email": reviewer}, headers=h(OWNER))
        assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == code
    # The author may withdraw a pending decision, never approve it.
    withdrawn = client.post(f"{url}/decisions", json={"outcome": "offboard", "rationale": "x", "reviewer_email": EDITOR}, headers=h(OWNER)).json()
    wid = withdrawn["decisions"][-1]["id"]
    r = client.post(f"{url}/decisions/{wid}/review", json={"approve": False, "note": "wrong outcome"}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["decisions"][-1]["review"] == "rejected"
    pending = client.post(
        f"{url}/decisions", json={"outcome": "offboard", "rationale": "bust-out", "reviewer_email": EDITOR}, headers=h(OWNER)
    ).json()
    d2 = pending["decisions"][-1]  # after the withdrawn one
    assert pending["status"] == "open" and d2["review"] == "pending" and d2["closed_at"] is None
    r = client.post(f"{url}/decisions", json={"outcome": "monitor", "rationale": "x"}, headers=h(OWNER))
    assert r.status_code == 409 and r.json()["detail"]["error"]["code"] == "REVIEW_PENDING"
    review = f"{url}/decisions/{d2['id']}/review"
    r = client.post(review, json={"approve": True}, headers=h(OWNER))
    assert r.status_code == 403 and r.json()["detail"]["error"]["code"] == "FOUR_EYES"
    r = client.post(review, json={"approve": True}, headers=h(READER))
    assert r.status_code == 403 and r.json()["detail"]["error"]["code"] == "NOT_THE_REVIEWER"
    approved = client.post(review, json={"approve": True, "note": "ok"}, headers=h(EDITOR)).json()
    assert approved["status"] == "closed" and approved["decisions"][-1]["review"] == "approved"
    assert approved["frozen_hash"] == d2["hash"]
    assert client.post(review, json={"approve": True}, headers=h(EDITOR)).json()["detail"]["error"]["code"] == "NOT_PENDING"

    client.post(f"{url}/reopen", headers=h(OWNER))
    again = client.post(f"{url}/decisions", json={"outcome": "monitor", "rationale": "documents arrived"}, headers=h(OWNER)).json()
    assert again["status"] == "closed" and len(again["decisions"]) == 4
    checks = client.get(f"{url}/export?format=json", headers=h(OWNER)).json()["integrity"]
    assert checks["verified"] is True and [c["verified"] for c in checks["decisions"]] == [True] * 4
    assert len({c["hash"] for c in checks["decisions"]}) == 4
    kinds = [e["kind"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()]
    assert {"decision.approved", "case.closed", "case.reopened"} <= set(kinds)

    # A rejected review leaves the case open.
    other = _case(client, case_type="merchant_review")
    ourl = f"/api/investigations/{other['id']}"
    d = client.post(f"{ourl}/decisions", json={"outcome": "offboard", "rationale": "x"}, headers=h(OWNER)).json()["decisions"][0]
    client.post(f"{ourl}/share", json={"email": EDITOR, "role": "editor"}, headers=h(OWNER))
    rejected = client.post(f"{ourl}/decisions/{d['id']}/review", json={"approve": False}, headers=h(EDITOR)).json()
    assert rejected["status"] == "open" and rejected["decisions"][0]["review"] == "rejected"


def test_agents_cannot_decide_review_or_reopen(client):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    created = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()
    agent = {"Authorization": f"Bearer {created['token']}"}
    assert client.post(f"{url}/decisions", json=DECISION, headers=agent).status_code == 403
    d = client.post(f"{url}/decisions", json={**DECISION, "closes_case": False}, headers=h(OWNER)).json()["decisions"][0]
    assert client.post(f"{url}/decisions/{d['id']}/review", json={"approve": True}, headers=agent).status_code == 403
    client.post(f"{url}/decisions", json=DECISION, headers=h(OWNER))
    assert client.post(f"{url}/reopen", headers=agent).status_code == 403


def _blobs(tmp_path, inv_id):
    root = tmp_path / inv_id
    return sorted(p.name for p in root.rglob("*") if p.is_file()) if root.exists() else []


def test_delete_removes_the_case_blobs(client, tmp_path):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    r = client.post(
        f"{url}/items",
        json={"kind": "document", "subkind": "markdown", "title": "KYC", "content": "# KYC\nrenda 1800"},
        headers=h(OWNER),
    )
    assert r.status_code == 201, r.text
    names = _blobs(tmp_path, inv["id"])
    assert len(names) == 2 and any(n.endswith(".txt") for n in names)  # version bytes + text extraction
    assert client.delete(url, headers=h(OWNER)).status_code == 200
    assert _blobs(tmp_path, inv["id"]) == [] and not (tmp_path / inv["id"]).exists()
    assert client.get(url, headers=h(OWNER)).status_code == 404


def test_superuser_deletes_a_retained_case_with_a_reason(client, tmp_path, monkeypatch):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "x"}, headers=h(OWNER))
    assert client.post(f"{url}/decisions", json=DECISION, headers=h(OWNER)).json()["status"] == "closed"
    assert client.delete(url, headers=h(SUPERUSER)).status_code == 409
    assert client.delete(f"{url}?reason=audit", headers=h(OWNER)).status_code == 409  # owner is not enough
    assert _blobs(tmp_path, inv["id"]), "the retained case keeps its blobs"
    # Past the retention period anyone who manages the case may delete it.
    years = get_settings().investigation_retention_years
    monkeypatch.setattr(service, "_clock", lambda: datetime.now() + timedelta(days=366 * years))
    import asyncio

    assert asyncio.run(service.under_retention(InMemoryStore.get_instance().get_investigation(UUID(inv["id"])))) is False
    monkeypatch.setattr(service, "_clock", datetime.now)
    assert client.delete(f"{url}?reason=audit", headers=h(SUPERUSER)).status_code == 200
    assert _blobs(tmp_path, inv["id"]) == []
    assert InMemoryStore.get_instance().usage_logs[-1].log_metadata["reason"] == "audit"


def test_agent_rate_limit_counts_in_the_shared_store(client, monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE", "2")
    get_settings.cache_clear()
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    created = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()
    agent = {"Authorization": f"Bearer {created['token']}"}
    assert [client.get(url, headers=agent).status_code for _ in range(3)] == [200, 200, 429]
    windows = InMemoryStore.get_instance().agent_request_times
    assert list(windows) == [UUID(created["id"])] and len(windows[UUID(created["id"])]) == 2
    # The window is the store's, not a per-process dict: a fresh store starts clean.
    InMemoryStore.reset()
    assert InMemoryStore.get_instance().agent_request_times == {}
    assert not hasattr(auth, "_agent_request_times") or not isinstance(auth._agent_request_times, dict)


# ---------------------------------------------------------------------------
# InMemoryStore parity
# ---------------------------------------------------------------------------

CHILD_FIELDS = {
    "case_items": {"kind": "note", "subkind": "free", "title": "t", "author_email": OWNER},
    "case_item_versions": {
        "item_id": None, "version": 1, "sha256": "0" * 64, "blob_key": "k", "size_bytes": 1,
        "content_type": "text/plain", "created_by": OWNER,
    },
    "case_annotations": {"kind": "role", "author_email": OWNER},
    "case_entities": {"uid": "Account:1", "stamp": "s"},
    "investigation_events": {"actor_email": OWNER, "kind": "case.created"},
}


def test_child_fields_cover_every_table():
    assert set(CHILD_FIELDS) == set(INVESTIGATION_CHILDREN)


@pytest.mark.parametrize("table", sorted(CHILD_FIELDS))
def test_memory_child_crud_and_cascade(table):
    store = InMemoryStore()
    inv = store.create_investigation("c", OWNER)
    row = store.add_investigation_child(table, investigation_id=inv.id, **CHILD_FIELDS[table])
    assert store.get_investigation_child(table, row.id) is row
    assert store.list_investigation_children(table, inv.id) == [row]
    field = next(iter(CHILD_FIELDS[table]))
    store.update_investigation_child(table, row.id, **{field: "changed"})
    assert getattr(row, field) == "changed"
    store.delete_investigation(inv.id)
    assert store.get_investigation_child(table, row.id) is None


def test_memory_item_delete_cascades_versions_and_exploration_delete_nulls_the_ref():
    store = InMemoryStore()
    ctx = store.create_graph_context("t", "e", "n", OWNER)
    exp = store.create_exploration(ctx.id, "x", OWNER, {})
    inv = store.create_investigation("c", OWNER)
    item = store.add_investigation_child(
        "case_items", investigation_id=inv.id, kind="graph", subkind="exploration_ref", title="x",
        author_email=OWNER, exploration_id=exp.id, context_id=ctx.id,
    )
    version = store.add_investigation_child(
        "case_item_versions", investigation_id=inv.id, item_id=item.id, version=1, sha256="0" * 64,
        blob_key="k", size_bytes=1, content_type="text/plain", created_by=OWNER,
    )
    store.delete_exploration(exp.id)
    assert item.exploration_id is None and item.context_id == ctx.id
    store.delete_investigation_child("case_items", item.id)
    assert store.get_investigation_child("case_item_versions", version.id) is None
    store.share_investigation(inv.id, "a@example.com")
    store.share_investigation(inv.id, "a@example.com", "editor")  # upsert
    assert [(s.email, s.role) for s in inv.shares] == [("a@example.com", "editor")]
    assert store.unshare_investigation(inv.id, "a@example.com")


# ---------------------------------------------------------------------------
# Migration 016 on SQLite: upgrade, idempotent upgrade, downgrade, re-upgrade
# ---------------------------------------------------------------------------


def _migration():
    import importlib.util
    from pathlib import Path

    import graphlagoon

    path = Path(graphlagoon.__file__).parent / "alembic" / "versions" / "016_cases.py"
    spec = importlib.util.spec_from_file_location("migration_016", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_016_runs_on_sqlite_and_replaces_the_old_chain():
    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    migration = _migration()
    assert (migration.revision, migration.down_revision) == ("016", "015")
    from pathlib import Path

    import graphlagoon

    names = {p.name for p in (Path(graphlagoon.__file__).parent / "alembic" / "versions").glob("01[6-9]*.py")}
    assert names == {"016_cases.py"}

    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE graph_contexts (id CHAR(32) PRIMARY KEY)"))
        conn.execute(sa.text("CREATE TABLE explorations (id CHAR(32) PRIMARY KEY)"))
        for _ in range(2):  # idempotent
            with Operations.context(MigrationContext.configure(conn)):
                migration.upgrade()
        tables = set(sa.inspect(conn).get_table_names())
        assert set(migration.TABLES) <= tables
        assert {c["name"] for c in sa.inspect(conn).get_columns("case_items")} >= {
            "kind", "subkind", "status", "author_kind", "provenance", "query", "mapping", "anchor", "deleted_at",
        }
        assert {c["name"] for c in sa.inspect(conn).get_columns("graph_contexts")} >= {"identity_keys", "edge_semantics"}
        assert "scopes" not in {c["name"] for c in sa.inspect(conn).get_columns("agent_tokens")}
        with Operations.context(MigrationContext.configure(conn)):
            migration.downgrade()
        assert not set(migration.TABLES) & set(sa.inspect(conn).get_table_names())
        with Operations.context(MigrationContext.configure(conn)):
            migration.upgrade()
        assert set(migration.TABLES) <= set(sa.inspect(conn).get_table_names())


def test_type_defaults_and_settings_patch(client):
    """The case type only fills defaults (06 §1); the settings PATCH keeps identity keys,
    edge semantics by type, vocabularies and label templates as given."""
    inv = _case(client)
    assert inv["settings"]["vocabularies"] == {"roles": [], "tags": [], "link_attributes": []}
    assert _case(client, settings={"vocabularies": {"roles": ["x"]}})["settings"]["vocabularies"] == {"roles": ["x"]}

    url = f"/api/investigations/{inv['id']}"
    settings = {
        "identity_keys": [{"node_type": "Login", "entity": "Session", "source": {"kind": "prop", "name": "ua"}, "normalize": "regex", "pattern": "sid=(\\w+)"}],
        "edge_semantics": {"USES": {"weight_prop": "times", "timestamp_prop": "at"}, "*": {"amount_prop": "amount", "time_prop": "date"}},
        "vocabularies": {"roles": ["mule"], "tags": ["kyc"], "link_attributes": ["phone"]},
        "label_templates": {"Person": "{name} · {document}"},
        "agent_suggest_kinds": ["role"],
    }
    r = client.patch(url, json={"settings": settings}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["settings"] == settings
    assert client.get(url, headers=h(OWNER)).json()["settings"] == settings
    events = client.get(f"{url}/events", headers=h(OWNER)).json()
    assert events[-1]["kind"] == "case.updated" and "settings" in events[-1]["payload"]
    # A decision may name its reviewer (an editor of the case) and need not close it.
    client.post(f"{url}/share", json={"email": "rev@example.com", "role": "editor"}, headers=h(OWNER))
    r = client.post(f"{url}/decisions", json={"outcome_label": "Block", "rationale": "x", "reviewer_email": " rev@example.com "}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["decisions"][0]["reviewer_email"]) == ("open", "rev@example.com")
