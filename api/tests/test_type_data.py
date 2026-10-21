"""Extension by data (06 §1, P5): a case type's starter queries become the new
case's query items and its analysis defaults fill what a trace leaves unset; the
org library keeps file mappings (validated JSON) and report templates, which
render over a case into a markdown draft."""

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


import asyncio  # noqa: E402

from graphlagoon.models.schemas import TraceRequest  # noqa: E402
from graphlagoon.services import trace as trace_service  # noqa: E402

KYC = {
    "label": "Merchant review",
    "outcomes": [{"id": "offboard", "label": "Offboard the merchant", "closes_case": True}],
    "fields": [{"id": "merchant_id", "label": "Merchant", "type": "text"}, {"id": "tpv_90d", "label": "TPV 90 d", "type": "money"}],
    "starter_queries": [
        {"title": "TPV and chargebacks by day", "language": "sql", "query": "SELECT day, tpv, cb FROM acq.daily WHERE merchant = :m",
         "parameters": [{"id": "m", "label": "Merchant"}]},
        {"title": "Terminals shared by merchants", "language": "cypher", "query": "MATCH (t:Terminal)<-[:USES]-(m) RETURN t, count(m)"},
    ],
    "analysis_defaults": {"trace": {"max_hops": 6, "max_dwell_hours": 0, "allocation": "proportional"}},
}
MEMO = """# Offboarding memo · {{case.number}}

**{{case.title}}** ({{case.type}}) · merchant {{fields.merchant_id}} · TPV {{fields.tpv_90d}}

## Decision
{{decision.outcome}} on {{decision.targets}} — {{decision.rationale}}

## Evidence
{{evidence}}

## Roles
{{roles}}

Prepared by {{user}} on {{today}}. {{signature.block}}
"""


def _admin_put(client, path, body):
    r = client.put(path, json=body, headers=h(SUPERUSER))
    assert r.status_code == 200, r.text
    return r.json()


def test_starter_queries_become_the_cases_items_and_trace_defaults_fill_the_gaps(client):
    bad = {**KYC, "starter_queries": [{"title": "x", "query": "SELECT 1", "parameters": [{"label": "no id"}]}]}
    assert client.put("/api/admin/case-types/merchant_review", json=bad, headers=h(SUPERUSER)).status_code == 422
    _admin_put(client, "/api/admin/case-types/merchant_review", KYC)
    inv = _case(client, case_type="merchant_review")
    url = f"/api/investigations/{inv['id']}"
    queries = client.get(f"{url}/items?kind=query", headers=h(OWNER)).json()
    assert [(q["title"], q["subkind"], q["provenance"]) for q in queries] == [
        ("TPV and chargebacks by day", "sql", {"tool": "case_type", "case_type": "merchant_review"}),
        ("Terminals shared by merchants", "cypher", {"tool": "case_type", "case_type": "merchant_review"}),
    ]
    assert queries[0]["query"]["parameters"][0]["id"] == "m" and queries[1]["query"]["language"] == "cypher"
    assert _case(client)["id"] and client.get("/api/investigations", headers=h(OWNER)).json()["total"] == 2  # general: none

    unset = asyncio.run(trace_service._type_defaults(UUID(inv["id"]), OWNER, TraceRequest(seed_node="a")))
    assert (unset.max_hops, unset.max_dwell_hours, unset.allocation, unset.min_amount) == (6, 0, "proportional", 0)
    given = asyncio.run(trace_service._type_defaults(UUID(inv["id"]), OWNER, TraceRequest(seed_node="a", max_hops=2)))
    assert given.max_hops == 2 and given.allocation == "proportional"
    general = _case(client)
    assert asyncio.run(trace_service._type_defaults(UUID(general["id"]), OWNER, TraceRequest(seed_node="a"))).max_hops == 3


def test_the_library_keeps_validated_mappings(client):
    mapping = {"as": "enrichment", "spec": {"name": "mcc", "key_column": "mcc", "columns": ["mcc", "description"], "input": {"delimiter": ";"},
                                            "match_node_types": ["Merchant"], "match_source": {"kind": "prop", "name": "mcc"}}}
    import json

    for body, code in (("not json", 422), (json.dumps([1]), 422), (json.dumps({"as": "graph", "spec": {"version": 9}}), 422)):
        r = client.post("/api/admin/library", json={"slug": "bad", "title": "Bad", "kind": "mapping", "body": body}, headers=h(SUPERUSER))
        assert r.status_code == code and r.json()["detail"]["error"]["code"] == "INVALID_LIBRARY_DOC", body
    r = client.post("/api/admin/library", json={"slug": "mcc-table", "title": "MCC table", "kind": "mapping", "body": json.dumps(mapping)}, headers=h(SUPERUSER))
    assert r.status_code == 201, r.text
    assert [d["slug"] for d in client.get("/api/org/library?kind=mapping", headers=h(OWNER)).json()] == ["mcc-table"]
    assert client.post("/api/admin/library", json={"slug": "x", "title": "X", "kind": "mapping", "body": "{}"}, headers=h(OWNER)).status_code == 403


def test_a_template_renders_over_the_case_into_a_markdown_draft(client):
    client.post("/api/admin/library", json={"slug": "offboarding-memo", "title": "Offboarding memo", "kind": "template", "body": MEMO}, headers=h(SUPERUSER))
    r = client.put("/api/admin/case-types/merchant_review", json={**KYC, "report_templates": ["nope"]}, headers=h(SUPERUSER))
    assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "UNKNOWN_TEMPLATE"
    r = client.put("/api/admin/case-types/merchant_review", json={**KYC, "report_templates": ["triage"]}, headers=h(SUPERUSER))
    assert r.status_code == 422  # a playbook is not a template
    _admin_put(client, "/api/admin/case-types/merchant_review", {**KYC, "report_templates": ["offboarding-memo"]})
    inv = _case(client, title="Bets4U", case_type="merchant_review", fields={"merchant_id": "M0009876", "tpv_90d": 250000})
    url = f"/api/investigations/{inv['id']}"
    item = client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "title": "Site visit", "content": "closed shop"}, headers=h(OWNER)).json()
    client.post(f"{url}/items/{item['id']}/pin", json={"label": "E1"}, headers=h(OWNER))
    client.post(f"{url}/annotations", json={"kind": "role", "targets": ["entity:m-1"], "value": {"role": "suspect merchant"}}, headers=h(OWNER))
    client.post(f"{url}/decisions", json={"outcome": "offboard", "rationale": "bust-out pattern", "targets": ["entity:m-1"]}, headers=h(OWNER))
    assert client.post(f"{url}/reports", json={"template": "nope"}, headers=h(OWNER)).status_code == 404

    # The case is closed by now: a report is still drafted (outside the decision's hash).
    r = client.post(f"{url}/reports", json={"template": "offboarding-memo"}, headers=h(OWNER))
    assert r.status_code == 201, r.text
    report = r.json()
    assert (report["kind"], report["subkind"], report["status"]) == ("document", "markdown", "confirmed")
    assert report["title"] == f"Offboarding memo · #{inv['id'].replace('-', '')[:6]}"
    assert report["provenance"] == {"tool": "report", "template": "offboarding-memo", "unknown_placeholders": ["signature.block"]}
    text = client.get(f"{url}/items/{report['id']}/text", headers=h(OWNER)).json()["text"]
    assert "**Bets4U** (Merchant review) · merchant M0009876 · TPV 250,000.00" in text
    assert "Offboard the merchant on entity:m-1 — bust-out pattern" in text
    assert "- E1 Site visit (v1, sha256 " in text and "- entity:m-1 — suspect merchant" in text
    assert "{{signature.block}}" in text and f"Prepared by {OWNER}" in text
    assert client.get(f"{url}/export?format=json", headers=h(OWNER)).json()["integrity"]["verified"] is True
    assert "investigation.item_add" in [e.action for e in InMemoryStore.get_instance().usage_logs]

    # An agent's draft waits for a person.
    token = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()["token"]
    other = _case(client, case_type="merchant_review")
    drafted = client.post(f"/api/investigations/{other['id']}/reports", json={"template": "offboarding-memo", "title": "Draft"},
                          headers={"Authorization": f"Bearer {token}"})
    assert drafted.status_code == 201 and (drafted.json()["status"], drafted.json()["title"]) == ("suggested", "Draft")


def test_a_table_is_seen_as_a_chart_by_its_state(client):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    table = client.post(f"{url}/items", json={"kind": "table", "subkind": "result", "title": "By day",
                                              "content_json": {"columns": ["day", "tpv", "cb"], "rows": [["2026-10-01", 10, 1]]}}, headers=h(OWNER)).json()
    note = client.post(f"{url}/items", json={"kind": "note", "subkind": "free", "content": "x"}, headers=h(OWNER)).json()
    chart = {"chart": {"type": "bar", "x": "day", "series": ["tpv", "cb"]}}
    r = client.patch(f"{url}/items/{table['id']}", json={"state": chart}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["state"] == chart and r.json()["current_version"] == 1  # view only, no version
    assert client.patch(f"{url}/items/{note['id']}", json={"state": chart}, headers=h(OWNER)).status_code == 422
    assert client.patch(f"{url}/items/{table['id']}", json={"state": {"chart": {"type": "pie", "x": "day", "series": ["tpv"]}}}, headers=h(OWNER)).status_code == 422
    assert client.patch(f"{url}/items/{table['id']}", json={"state": {"chart": None}}, headers=h(OWNER)).json()["state"] == {"chart": None}


def test_the_authoring_catalog_matches_what_the_renderer_fills(client):
    """The admin help and the AI prompts read /api/org/authoring: its placeholders
    are exactly the renderer's, and the schema is the one the PUT validates."""
    from graphlagoon.services import reports

    _admin_put(client, "/api/admin/case-types/merchant_review", KYC)
    inv = _case(client, case_type="merchant_review", fields={"merchant_id": "M-1"})
    ctx = asyncio.run(reports.context(UUID(inv["id"]), OWNER))
    keys = {k for k in ctx if not k.startswith("fields.")} | {"fields.<id>"}
    assert keys == set(reports.PLACEHOLDERS)
    every = " ".join("{{" + k.replace("<id>", "merchant_id") + "}}" for k in reports.PLACEHOLDERS)
    assert reports.render(every, ctx)[1] == []

    r = client.get("/api/org/authoring", headers=h(READER))
    assert r.status_code == 200
    cat = r.json()
    assert {p["key"] for p in cat["report_placeholders"]} == set(reports.PLACEHOLDERS)
    assert set(cat["case_type_schema"]["properties"]) >= {"label", "outcomes", "actions", "fields", "starter_queries", "analysis_defaults"}
    assert "widths" not in cat["mapping"]["normalizers"] and "phone" in cat["mapping"]["normalizers"]
    assert "task" in cat["suggest_kinds"]["default"] and "decision_proposal" not in cat["suggest_kinds"]["all"]
    tools = {t["name"]: t["summary"] for t in cat["agent_tools"]}
    assert "propose_decision" in tools and tools["get_case_type"].endswith(".")


def test_the_examples_the_ai_prompts_teach_are_valid():
    """The case type example in the "Ask an AI" prompt passes the server's validation."""
    import json
    from pathlib import Path

    from graphlagoon.models.schemas import CaseTypeSpec

    path = Path(__file__).resolve().parents[2] / "frontend/src/assets/authoring/case-type-example.json"
    if not path.exists():
        pytest.skip("frontend not checked out")
    CaseTypeSpec.model_validate(json.loads(path.read_text()))


def test_the_library_examples_the_ai_prompts_teach_are_valid():
    """Report template placeholders, playbook tool names and the file mapping of
    the admin area's examples are all real."""
    import json
    import re
    from pathlib import Path

    from graphlagoon.mcp.registry import TOOL_ROUTES
    from graphlagoon.services import reports
    from graphlagoon.services.case_items import validate_mapping

    root = Path(__file__).resolve().parents[2] / "frontend/src/assets/authoring"
    if not root.exists():
        pytest.skip("frontend not checked out")
    used = set(reports.PLACEHOLDER.findall((root / "report-template-example.md").read_text()))
    assert used and used <= set(reports.PLACEHOLDERS)
    tools = set(re.findall(r"`([a-z_]+)`", (root / "playbook-example.md").read_text()))
    assert {"propose_decision", "find_entity_cases"} <= tools
    assert tools - {"links", "communities", "chart"} <= set(TOOL_ROUTES)
    validate_mapping(json.loads((root / "mapping-example.json").read_text()))


def test_the_frontend_authoring_fixture_is_the_live_catalog():
    """frontend/src/__tests__/fixtures/authoring/catalog.json feeds the prompt and
    editor tests; regenerate it when the catalog changes:
    ``.venv/bin/python -c "import asyncio,json;from graphlagoon.services import authoring;print(json.dumps(asyncio.run(authoring.catalog()),indent=1))" > ../frontend/src/__tests__/fixtures/authoring/catalog.json``"""
    import json
    from pathlib import Path

    from graphlagoon.services import authoring

    path = Path(__file__).resolve().parents[2] / "frontend/src/__tests__/fixtures/authoring/catalog.json"
    if not path.exists():
        pytest.skip("frontend not checked out")
    assert json.loads(path.read_text()) == asyncio.run(authoring.catalog())
