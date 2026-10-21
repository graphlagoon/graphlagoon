"""Tasks (06 §1, P4): a decision's actions become tasks inside its hash; agents
suggest tasks and move only their own; follow-ups outlive the freeze; the
cross-case list respects access and token scope."""

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


MERCHANT = {
    "label": "Merchant review",
    "outcomes": [{"id": "offboard", "label": "Offboard", "closes_case": True, "requires_review": False}],
    "actions": [
        {"id": "hold_settlement", "label": "Hold settlement", "due_hours": 2},
        {"id": "notify", "label": "Notify the merchant"},
    ],
}


def _token(client, **extra):
    return client.post("/api/agent-tokens", json={"name": "claude", **extra}, headers=h(OWNER)).json()["token"]


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def _tasks(client, url, who=OWNER):
    return [a for a in client.get(f"{url}/annotations?kind=task", headers=h(who)).json()]


def test_a_decision_turns_its_actions_into_tasks_inside_its_hash(client, monkeypatch):
    client.put("/api/admin/case-types/merchant_review", json=MERCHANT, headers=h(SUPERUSER))
    inv = _case(client, case_type="merchant_review")
    url = f"/api/investigations/{inv['id']}"
    decided_at = datetime(2026, 10, 19, 12, 0)
    monkeypatch.setattr(service, "_clock", lambda: decided_at)
    r = client.post(
        f"{url}/decisions",
        json={"outcome": "offboard", "rationale": "bust-out", "targets": ["entity:m-1"],
              "tasks": [{"action": "hold_settlement"}, {"action": "notify", "assignee": EDITOR},
                        {"title": "Report to the card scheme", "assignee_kind": "agent", "agent_name": "claude"}]},
        headers=h(OWNER),
    )
    assert r.status_code == 200, r.text
    decision = r.json()["decisions"][0]
    tasks = {t["id"]: t for t in _tasks(client, url)}
    assert list(tasks) == decision["task_ids"]
    hold, notify, report = (tasks[i]["value"] for i in decision["task_ids"])
    assert hold == {"title": "Hold settlement", "state": "open", "assignee_kind": "human", "assignee": None, "due_at": "2026-10-19T14:00:00",
                    "action": "hold_settlement", "decision_id": decision["id"]}
    assert (notify["assignee"], notify["due_at"]) == (EDITOR, None)
    assert (report["title"], report["assignee_kind"], report["agent_name"]) == ("Report to the card scheme", "agent", "claude")
    assert all(t["targets"] == ["entity:m-1"] and t["status"] == "confirmed" for t in tasks.values())
    kinds = [e["kind"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()]
    assert kinds[-5:] == ["task.set", "task.set", "task.set", "decision.recorded", "case.closed"]
    # Done after the case closed: outside the freeze, and the decision's hash still verifies.
    first = decision["task_ids"][0]
    done = client.patch(f"{url}/annotations/{first}", json={"value": {"state": "done"}, "reason": "held"}, headers=h(OWNER))
    assert done.status_code == 200 and done.json()["value"]["state"] == "done"
    assert client.post(f"{url}/annotations", json={"kind": "task", "value": {"title": "Call back"}}, headers=h(OWNER)).status_code == 201
    assert client.post(f"{url}/annotations", json={"kind": "tag", "targets": ["a"], "value": {"tag": "t"}}, headers=h(OWNER)).status_code == 409
    integrity = client.get(f"{url}/export?format=json", headers=h(OWNER)).json()["integrity"]
    assert integrity["verified"] is True


def test_agents_suggest_tasks_and_move_only_their_own(client):
    inv = _case(client)
    url = f"/api/investigations/{inv['id']}"
    agent = bearer(_token(client))
    other = bearer(client.post("/api/agent-tokens", json={"name": "triage-bot"}, headers=h(OWNER)).json()["token"])
    r = client.post(f"{url}/annotations", json={"kind": "task", "value": {"title": "Pull the KYC file", "assignee": EDITOR}}, headers=agent)
    assert r.status_code == 201 and r.json()["status"] == "suggested" and r.json()["author_kind"] == "agent"
    assert client.post(f"{url}/annotations/{r.json()['id']}/confirm", headers=h(OWNER)).json()["status"] == "confirmed"

    mine = client.post(f"{url}/annotations", json={"kind": "task", "value": {"title": "Trace the exits", "assignee_kind": "agent", "agent_name": "claude"}}, headers=h(OWNER)).json()
    human = client.post(f"{url}/annotations", json={"kind": "task", "value": {"title": "Call the client", "assignee": OWNER}}, headers=h(OWNER)).json()
    r = client.patch(f"{url}/annotations/{mine['id']}", json={"value": {"state": "done"}, "reason": "3 exits"}, headers=agent)
    assert r.status_code == 200 and r.json()["value"]["state"] == "done" and r.json()["reason"] == "3 exits"
    for token, task in ((agent, human), (other, mine)):
        r = client.patch(f"{url}/annotations/{task['id']}", json={"value": {"state": "done"}}, headers=token)
        assert r.status_code == 403 and r.json()["detail"]["error"]["code"] == "TASK_NOT_YOURS"
    # The agent finds its work across cases; the person finds theirs.
    listed = client.get("/api/investigations/tasks?mine=true", headers=agent).json()
    assert [t["value"]["title"] for t in listed] == ["Trace the exits"] and listed[0]["case_title"] == "Case"
    assert [t["value"]["title"] for t in client.get("/api/investigations/tasks?mine=true&state=open", headers=h(OWNER)).json()] == ["Call the client"]
    assert client.get("/api/investigations/tasks?mine=true&state=open", headers=agent).json() == []


def test_task_validation_overdue_and_access(client):
    a, b = _case(client), _case(client, title="Other")
    url = f"/api/investigations/{a['id']}"
    for value in ({}, {"title": "x", "state": "later"}, {"title": "x", "due_at": "tomorrow"}, {"title": "x", "assignee_kind": "bot"}):
        r = client.post(f"{url}/annotations", json={"kind": "task", "value": value}, headers=h(OWNER))
        assert r.status_code == 422 and r.json()["detail"]["error"]["code"] == "INVALID_ANNOTATION", value
    late = (datetime.now() - timedelta(hours=1)).isoformat()
    soon = (datetime.now() + timedelta(hours=5)).isoformat()
    client.post(f"{url}/annotations", json={"kind": "task", "value": {"title": "Late", "due_at": late}}, headers=h(OWNER))
    client.post(f"{url}/annotations", json={"kind": "task", "value": {"title": "Soon", "due_at": soon}}, headers=h(OWNER))
    client.post(f"/api/investigations/{b['id']}/annotations", json={"kind": "task", "value": {"title": "Elsewhere"}}, headers=h(OWNER))
    every = client.get("/api/investigations/tasks", headers=h(OWNER)).json()
    assert [t["value"]["title"] for t in every] == ["Late", "Soon", "Elsewhere"]  # due first, undated last
    assert [t["value"]["title"] for t in client.get("/api/investigations/tasks?overdue=true", headers=h(OWNER)).json()] == ["Late"]
    assert every[0]["overdue"] is True and every[1]["overdue"] is False
    # Without access to the cases there is nothing; a case-scoped token sees only its case.
    assert client.get("/api/investigations/tasks", headers=h(READER)).json() == []
    scoped = bearer(_token(client, scope="case", investigation_ids=[b["id"]]))
    assert [t["value"]["title"] for t in client.get("/api/investigations/tasks", headers=scoped).json()] == ["Elsewhere"]
