"""Case types (06 §1): admin-defined data, never code. ``general`` is built in;
a case copies its type's defaults, keeps its fields valid, and the queue
filters, sorts and pages them (06 §2b)."""

import sys
from datetime import datetime, timedelta

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
from graphlagoon.services import cases  # noqa: E402

SUPERUSER = "admin@example.com"
USER = "ana@example.com"
MERCHANT = {
    "label": "Merchant review",
    "vocabularies": {"roles": ["suspect merchant", "front partner"], "tags": ["bust-out"], "link_attributes": ["phone"]},
    "roles_multi": True,
    "outcomes": [
        {"id": "terminate", "label": "Terminate", "closes_case": True, "requires_review": True},
        {"id": "block_terminal", "label": "Block a terminal", "closes_case": False},
    ],
    "actions": [{"id": "hold_settlements", "label": "Hold the settlements", "due_hours": 2}],
    "fields": [
        {"id": "merchant_id", "label": "Merchant", "type": "text", "required": True, "in_queue": True},
        {"id": "mcc", "label": "MCC", "type": "enum", "options": ["5411", "5999"]},
        {"id": "amount_at_risk", "label": "Amount at risk", "type": "money", "in_queue": True},
        {"id": "opened_on", "label": "Opened on", "type": "date"},
    ],
    "sla_hours": {"open": 24, "analysis": 120},
    "notice": "Need-to-know.",
    "agent_suggest_kinds": ["role", "tag"],
}


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app)
    InMemoryStore.reset()
    get_settings.cache_clear()


def _put(client, slug="merchant_review", spec=MERCHANT, who=SUPERUSER):
    return client.put(f"/api/admin/case-types/{slug}", json=spec, headers=h(who))


def _case(client, **body):
    r = client.post("/api/investigations", json={"title": "x", **body}, headers=h(USER))
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_general_is_built_in_and_read_only(client):
    [general] = client.get("/api/org/case-types", headers=h(USER)).json()
    assert general["slug"] == "general" and general["builtin"] and general["outcomes"] == []
    assert _put(client, "general").json()["detail"]["error"]["code"] == "CASE_TYPE_BUILTIN"
    assert client.delete("/api/admin/case-types/general", headers=h(SUPERUSER)).status_code == 409
    inv = _case(client)
    assert inv["case_type"] == "general" and inv["fields"] == {} and inv["deadline"] is None


def test_crud_is_superuser_only_audited_and_validated(client):
    assert _put(client, who=USER).status_code == 403
    r = _put(client)
    assert r.status_code == 200, r.text
    assert r.json()["slug"] == "merchant_review" and r.json()["fields"][0]["required"] is True
    listed = client.get("/api/org/case-types", headers=h(USER)).json()
    assert [t["slug"] for t in listed] == ["general", "merchant_review"]
    assert client.get("/api/org/case-types/merchant_review", headers=h(USER)).json()["notice"] == "Need-to-know."
    assert client.get("/api/org/case-types/nope", headers=h(USER)).status_code == 404
    for bad in (
        {**MERCHANT, "fields": [{"id": "x", "label": "X", "type": "enum"}]},  # an enum needs options
        {**MERCHANT, "outcomes": [{"id": "a", "label": "A"}, {"id": "a", "label": "B"}]},  # duplicate ids
        {**MERCHANT, "outcomes": [{"id": "a", "label": "A", "closes_case": False}]},  # nothing closes the case
        {**MERCHANT, "nope": 1},  # unknown key
    ):
        assert _put(client, spec=bad).status_code == 422, bad
    assert _put(client, "Bad Slug").status_code == 422
    assert _put(client, spec={**MERCHANT, "playbook": "missing"}).json()["detail"]["error"]["code"] == "UNKNOWN_PLAYBOOK"
    assert _put(client, spec={**MERCHANT, "playbook": "triage"}).status_code == 200
    # In use: 409 until no case uses it.
    inv = _case(client, case_type="merchant_review", fields={"merchant_id": "M-1"})
    r = client.delete("/api/admin/case-types/merchant_review", headers=h(SUPERUSER))
    assert r.status_code == 409 and r.json()["detail"]["error"]["code"] == "CASE_TYPE_IN_USE"
    client.patch(f"/api/investigations/{inv['id']}", json={"case_type": "general"}, headers=h(USER))
    assert client.delete("/api/admin/case-types/merchant_review", headers=h(SUPERUSER)).status_code == 200
    actions = [e["action"] for e in client.get("/api/admin/audit", headers=h(SUPERUSER)).json()["items"]]
    assert actions.count("case_type.write") == 2 and "case_type.delete" in actions


def test_a_case_copies_its_type_and_keeps_its_fields_valid(client):
    _put(client)
    assert client.post("/api/investigations", json={"title": "x", "case_type": "nope"}, headers=h(USER)).json()[
        "detail"]["error"]["code"] == "UNKNOWN_CASE_TYPE"
    missing = client.post("/api/investigations", json={"title": "x", "case_type": "merchant_review"}, headers=h(USER))
    assert missing.status_code == 422 and missing.json()["detail"]["error"]["code"] == "FIELD_REQUIRED"
    for fields, code in (({"merchant_id": "M", "mcc": "0000"}, "INVALID_FIELD"), ({"merchant_id": "M", "nope": 1}, "UNKNOWN_FIELD"),
                         ({"merchant_id": "M", "amount_at_risk": "lots"}, "INVALID_FIELD"), ({"merchant_id": "M", "opened_on": "May"}, "INVALID_FIELD")):
        r = client.post("/api/investigations", json={"title": "x", "case_type": "merchant_review", "fields": fields}, headers=h(USER))
        assert r.json()["detail"]["error"]["code"] == code, fields
    inv = _case(client, case_type="merchant_review", fields={"merchant_id": " M-9 ", "amount_at_risk": "84000", "opened_on": "2026-10-01T10:00"})
    assert inv["fields"] == {"merchant_id": "M-9", "amount_at_risk": 84000.0, "opened_on": "2026-10-01"}
    assert inv["settings"]["vocabularies"]["roles"] == ["suspect merchant", "front partner"]
    assert inv["settings"]["agent_suggest_kinds"] == ["role", "tag"] and inv["sla_hours"] == {"open": 24, "analysis": 120}
    url = f"/api/investigations/{inv['id']}"
    # Fields merge; a null removes one; a required one cannot go.
    r = client.patch(url, json={"fields": {"mcc": "5999", "amount_at_risk": None}}, headers=h(USER))
    assert r.json()["fields"] == {"merchant_id": "M-9", "mcc": "5999", "opened_on": "2026-10-01"}
    assert client.patch(url, json={"fields": {"merchant_id": None}}, headers=h(USER)).status_code == 422
    # Moving to another type re-seeds the defaults and keeps only its fields.
    moved = client.patch(url, json={"case_type": "general"}, headers=h(USER)).json()
    assert moved["case_type"] == "general" and moved["fields"] == {} and moved["sla_hours"] is None
    assert moved["settings"]["vocabularies"] == {"roles": [], "tags": [], "link_attributes": []}


def test_external_ref_makes_creation_idempotent_among_readable_cases(client):
    first = client.post("/api/investigations", json={"title": "Alert 9", "external_ref": "ALRT-9"}, headers=h(USER))
    again = client.post("/api/investigations", json={"title": "Alert 9 (retry)", "external_ref": "ALRT-9"}, headers=h(USER))
    assert (first.status_code, again.status_code) == (201, 200) and again.json()["id"] == first.json()["id"]
    # Someone who cannot read the first case gets their own (nothing leaks).
    other = client.post("/api/investigations", json={"title": "Alert 9", "external_ref": "ALRT-9"}, headers=h("bia@example.com"))
    assert other.status_code == 201 and other.json()["id"] != first.json()["id"]


def test_the_queue_filters_sorts_pages_and_counts(client):
    _put(client)
    for k, amount in enumerate((500, 150_000, 90_000, None)):
        fields = {"merchant_id": f"M-{k}", **({"amount_at_risk": amount} if amount is not None else {})}
        _case(client, title=f"Case {k}", case_type="merchant_review", fields=fields)
    _case(client, title="Other")
    page = client.get("/api/investigations?case_type=merchant_review&sort=-field.amount_at_risk&limit=2", headers=h(USER)).json()
    assert page["total"] == 4 and [i["title"] for i in page["items"]] == ["Case 1", "Case 2"]
    nxt = client.get("/api/investigations?case_type=merchant_review&sort=-field.amount_at_risk&limit=2&offset=2", headers=h(USER)).json()
    assert [i["title"] for i in nxt["items"]] == ["Case 0", "Case 3"]  # without the field: last
    big = client.get("/api/investigations?field.amount_at_risk=gte:100000", headers=h(USER)).json()
    assert [i["title"] for i in big["items"]] == ["Case 1"]
    assert client.get("/api/investigations?field.merchant_id=M-2", headers=h(USER)).json()["total"] == 1
    assert client.get("/api/investigations?q=other", headers=h(USER)).json()["total"] == 1
    assert page["counts"]["total"] == 5 and page["counts"]["open"] == 5
    assert client.get("/api/investigations?status=open,analysis", headers=h(USER)).json()["total"] == 5
    assert client.get("/api/investigations?status=decided", headers=h(USER)).json()["total"] == 0
    assert client.get("/api/investigations?sort=nope", headers=h(USER)).status_code == 422
    # Only the cases the caller reads.
    assert client.get("/api/investigations", headers=h("bia@example.com")).json()["total"] == 0


def test_sla_hours_give_a_deadline_with_urgency(client, monkeypatch):
    _put(client)
    alert = datetime(2026, 10, 1, 8, 0)
    inv = _case(client, case_type="merchant_review", fields={"merchant_id": "M"}, alert_at=alert.isoformat())
    stored = InMemoryStore.get_instance().get_investigation(__import__("uuid").UUID(inv["id"]))
    monkeypatch.setattr(cases, "_clock", lambda: alert + timedelta(hours=10))
    d = cases.deadline_of(stored)
    assert (d["phase"], d["total_hours"], d["hours_left"], d["urgent"], d["overdue"]) == ("open", 24, 14, False, False)
    monkeypatch.setattr(cases, "_clock", lambda: alert + timedelta(hours=20))
    assert cases.deadline_of(stored)["urgent"] is True  # under 20% of the SLA left
    monkeypatch.setattr(cases, "_clock", lambda: alert + timedelta(hours=30))
    assert cases.deadline_of(stored)["overdue"] is True
    page = client.get("/api/investigations?deadline=overdue", headers=h(USER)).json()
    assert page["total"] == 1 and page["counts"]["urgent"] == page["counts"]["overdue"] == 1
    stored.status = "analysis"  # the analysis phase adds its hours
    assert cases.deadline_of(stored)["total_hours"] == 144 and not cases.deadline_of(stored)["urgent"]


def test_roles_multi_keeps_several_roles_per_entity(client):
    _put(client)
    multi = _case(client, case_type="merchant_review", fields={"merchant_id": "M"})
    single = _case(client)
    for inv, expected in ((multi, ["front partner", "suspect merchant"]), (single, ["front partner"])):
        url = f"/api/investigations/{inv['id']}/annotations"
        for role in ("suspect merchant", "front partner"):
            r = client.post(url, json={"kind": "role", "targets": ["e1"], "value": {"role": role}}, headers=h(USER))
            assert r.status_code == 201, r.text
        roles = client.get(f"{url}?kind=role&status=confirmed", headers=h(USER)).json()
        assert sorted(a["value"]["role"] for a in roles) == expected
