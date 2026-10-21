"""Entity seen in other cases (06 P7): presence on the unified graph (kept in
case_entities, rebuilt when stale) and interest (annotation and decision
targets), only over the cases the caller reads."""

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


KEYS = [{"node_type": "Account", "entity": "Account", "source": "node_id", "normalize": "account"}]


def _with_graph(client, title, accounts, who=OWNER):
    r = client.post("/api/investigations", json={"title": title, "settings": {"identity_keys": KEYS}}, headers=h(who))
    inv = r.json()
    url = f"/api/investigations/{inv['id']}"
    nodes = [{"id": a, "type": "Account", "properties": {"name": f"Acct {a}"}} for a in accounts]
    item = client.post(f"{url}/items", json={"kind": "graph", "subkind": "snapshot", "title": "Transfers",
                                             "content_json": {"nodes": nodes, "edges": []}}, headers=h(who))
    assert item.status_code == 201, item.text
    return inv, url, item.json()


def _cases(client, uid, who=OWNER, headers=None):
    r = client.get("/api/investigations/entities/cases", params={"uid": uid}, headers=headers or h(who))
    assert r.status_code == 200, r.text
    return {c["title"]: c for c in r.json()}


def test_presence_and_interest_across_the_cases_the_caller_reads(client):
    a, aurl, aitem = _with_graph(client, "Ring A", ["4471-0", "8812-7"])
    b, burl, _ = _with_graph(client, "Ring B", ["4471-0"])
    _with_graph(client, "Someone else's", ["4471-0"], who=EDITOR)  # never shared with OWNER
    uid = next(n["uid"] for n in client.get(f"{aurl}/graph", headers=h(OWNER)).json()["nodes"] if n["properties"]["name"] == "Acct 4471-0")
    assert uid == "Account:4471-0"  # the account normalizer keeps the check digit separator
    # A case with no graph that annotated and decided on the account.
    d = _case(client, title="Earlier review")
    durl = f"/api/investigations/{d['id']}"
    client.post(f"{durl}/annotations", json={"kind": "role", "targets": [uid], "value": {"role": "mule"}}, headers=h(OWNER))
    client.post(f"{durl}/annotations", json={"kind": "tag", "targets": [uid], "value": {"tag": "needs KYC"}}, headers=h(OWNER))
    client.post(f"{durl}/decisions", json={"outcome_label": "Offboard", "closes_case": True, "rationale": "x", "targets": [uid]}, headers=h(OWNER))

    found = _cases(client, uid)
    assert set(found) == {"Ring A", "Ring B", "Earlier review"}
    assert (found["Ring A"]["present"], found["Ring A"]["label"], found["Ring A"]["node_type"]) == (True, "Acct 4471-0", "Account")
    early = found["Earlier review"]
    assert (early["present"], early["roles"], early["tags"], early["status"]) == (False, ["mule"], ["needs KYC"], "closed")
    assert [x["outcome_label"] for x in early["decisions"]] == ["Offboard"]
    assert set(_cases(client, uid, EDITOR)) == {"Someone else's"}  # the others never leak
    client.post(f"{aurl}/share", json={"email": READER}, headers=h(OWNER))
    assert set(_cases(client, uid, READER)) == {"Ring A"}
    # A case-scoped token sees only its case.
    token = client.post("/api/agent-tokens", json={"name": "n", "scope": "case", "investigation_ids": [b["id"]]}, headers=h(OWNER)).json()["token"]
    assert set(_cases(client, uid, headers={"Authorization": f"Bearer {token}"})) == {"Ring B"}

    # The presence follows the graph: a new version without the account takes Ring A out.
    store = InMemoryStore.get_instance()
    assert {e.uid for e in store.case_entities.values() if str(e.investigation_id) == a["id"]} == {"Account:4471-0", "Account:8812-7"}
    r = client.post(f"{aurl}/items/{aitem['id']}/versions", json={"content_json": {"nodes": [{"id": "8812-7", "type": "Account"}], "edges": []}}, headers=h(OWNER))
    assert r.status_code in (200, 201), r.text
    assert "Ring A" not in _cases(client, uid)
    assert {e.uid for e in store.case_entities.values() if str(e.investigation_id) == a["id"]} == {"Account:8812-7"}
    assert client.get("/api/investigations/entities/cases", headers=h(OWNER)).status_code == 422  # uid required
