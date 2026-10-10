"""Proposals (FA.3): agents propose, a person accepts through the same service
as the manual action, or rejects with a reason. Memory store."""

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

OWNER = "owner@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def ctx(monkeypatch, tmp_path):
    from graphlagoon.services import investigation_storage
    from graphlagoon.services.blob_storage import LocalBlobStore

    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)

    def agent(scopes):
        token = client.post(
            "/api/agent-tokens",
            json={"name": "Claude", "scopes": scopes},
            headers=h(OWNER),
        ).json()["token"]
        return {"Authorization": f"Bearer {token}"}

    def case():
        r = client.post("/api/investigations", json={"title": "Pix"}, headers=h(OWNER))
        return f"/api/investigations/{r.json()['id']}"

    yield client, agent, case
    InMemoryStore.reset()
    get_settings.cache_clear()


ROLE = {"kind": "role", "payload": {"entity": "acct:5520-3", "role": "mule"}}


def test_accepted_role_proposal_matches_the_manual_action(ctx):
    client, agent, case = ctx
    proposer = agent(["read", "propose"])
    url = case()

    # The agent cannot set the role directly, nor propose without the scope.
    direct = client.patch(f"{url}/state", json={"roles": {"acct:5520-3": "mule"}}, headers=agent(["read", "write"]))
    assert direct.json()["detail"]["error"]["code"] == "AGENT_MUST_PROPOSE"
    no_scope = client.post(f"{url}/proposals", json=ROLE, headers=agent(["read", "write"]))
    assert no_scope.status_code == 403

    r = client.post(f"{url}/proposals", json={**ROLE, "rationale": "saque em 31 min"}, headers=proposer)
    assert r.status_code == 201, r.text
    proposal = r.json()
    assert proposal["status"] == "pending" and proposal["actor"]["kind"] == "agent"
    accept = f"{url}/proposals/{proposal['id']}/accept"
    assert client.post(accept, headers=proposer).json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"

    r = client.post(accept, headers=h(OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted" and r.json()["decided_by"] == OWNER
    assert client.post(accept, headers=h(OWNER)).status_code == 409

    manual = case()
    client.patch(f"{manual}/state", json={"roles": {"acct:5520-3": "mule"}}, headers=h(OWNER))

    def role_events(u):
        return [
            (e["actor_kind"], e["actor_email"], e["payload"])
            for e in client.get(f"{u}/events", headers=h(OWNER)).json()
            if e["kind"] == "role.changed"
        ]

    assert role_events(url) == role_events(manual) == [
        ("human", OWNER, {"entity": "acct:5520-3", "from": None, "to": "mule"})
    ]
    state = lambda u: client.get(u, headers=h(OWNER)).json()["state"]  # noqa: E731
    assert state(url) == state(manual)

    events = client.get(f"{url}/events", headers=h(OWNER)).json()
    accepted = next(e for e in events if e["kind"] == "proposal.accepted")
    assert accepted["actor_email"] == OWNER and accepted["actor_kind"] == "human"
    assert accepted["payload"]["proposed_by"]["agent_name"] == "Claude"


def test_reject_requires_a_reason_and_status_proposals_apply(ctx):
    client, agent, case = ctx
    proposer = agent(["read", "propose"])
    url = case()
    pid = client.post(f"{url}/proposals", json=ROLE, headers=proposer).json()["id"]

    reject = f"{url}/proposals/{pid}/reject"
    assert client.post(reject, json={}, headers=h(OWNER)).status_code == 422
    assert client.post(reject, json={"reason": "  "}, headers=h(OWNER)).status_code == 422
    r = client.post(reject, json={"reason": "conta da vítima"}, headers=h(OWNER))
    assert r.json()["status"] == "rejected" and r.json()["decision_note"] == "conta da vítima"
    assert client.get(url, headers=h(OWNER)).json()["state"].get("roles", {}) == {}
    assert client.post(f"{url}/proposals/{pid}/accept", headers=h(OWNER)).status_code == 409

    status = client.post(
        f"{url}/proposals", json={"kind": "status", "payload": {"status": "analise"}}, headers=proposer
    ).json()
    client.post(f"{url}/proposals/{status['id']}/accept", headers=h(OWNER))
    assert client.get(url, headers=h(OWNER)).json()["status"] == "analise"

    pending = client.get(f"{url}/proposals?status=pending", headers=h(OWNER)).json()
    assert pending == []
    for bad in (
        {"kind": "match", "payload": {}},
        {"kind": "status", "payload": {"status": "decidido"}},
        {"kind": "role", "payload": {"entity": "x", "role": "boss"}},
    ):
        assert client.post(f"{url}/proposals", json=bad, headers=proposer).status_code == 422


def test_hypothesis_proposals_apply_like_the_dossier(ctx):
    """F4.2: hypotheses live in state.hypotheses; agents propose, the accept
    calls the same service as the dossier, and evidence ids must be the case's."""
    client, agent, case = ctx
    proposer = agent(["read", "write", "propose"])
    url = case()
    ev = client.post(f"{url}/evidence", json={"title": "E1", "kind": "table", "snapshot": []},
                     headers=proposer).json()["id"]

    direct = client.post(f"{url}/hypotheses", json={"text": "x"}, headers=proposer)
    assert direct.json()["detail"]["error"]["code"] == "AGENT_MUST_PROPOSE"
    # state cannot smuggle hypotheses past the journal
    client.patch(url, json={"state": {"hypotheses": [{"id": "H9"}]}}, headers=h(OWNER))
    assert client.get(url, headers=h(OWNER)).json()["state"].get("hypotheses") is None

    text = "4471-0 é conta de passagem"
    p = client.post(f"{url}/proposals", json={"kind": "hypothesis", "payload": {
        "text": text, "evidence_for": [ev]}}, headers=proposer).json()
    assert client.post(f"{url}/proposals/{p['id']}/accept", headers=h(OWNER)).status_code == 200

    manual = case()
    ev2 = client.post(f"{manual}/evidence", json={"title": "E1", "kind": "table", "snapshot": []},
                      headers=h(OWNER)).json()["id"]
    r = client.post(f"{manual}/hypotheses", json={"text": text, "evidence_for": [ev2]}, headers=h(OWNER))
    assert r.status_code == 201, r.text
    strip = lambda hs: [{k: v for k, v in x.items() if k not in ("created_at", "evidence_for")} for x in hs]  # noqa: E731
    [hyp] = client.get(url, headers=h(OWNER)).json()["state"]["hypotheses"]
    assert strip([hyp]) == strip(r.json()["state"]["hypotheses"])
    assert hyp["id"] == "H1" and hyp["status"] == "aberta" and hyp["evidence_for"] == [ev]

    bad = client.post(f"{manual}/hypotheses", json={"text": "y", "evidence_against": [ev]}, headers=h(OWNER))
    assert bad.json()["detail"]["error"]["code"] == "EVIDENCE_NOT_IN_CASE"

    p = client.post(f"{url}/proposals", json={"kind": "hypothesis_status", "payload": {
        "hypothesis_id": "H1", "status": "sustentada"}}, headers=proposer).json()
    client.post(f"{url}/proposals/{p['id']}/accept", headers=h(OWNER))
    [hyp] = client.get(url, headers=h(OWNER)).json()["state"]["hypotheses"]
    assert hyp["status"] == "sustentada" and hyp["evidence_for"] == [ev]
    kinds = [e["kind"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()]
    assert kinds.count("hypothesis.created") == 1 and "hypothesis.updated" in kinds
    assert client.post(f"{url}/proposals", json={"kind": "hypothesis_status", "payload": {
        "hypothesis_id": "H1", "status": "talvez"}}, headers=proposer).status_code == 422
