"""Annotations (05 §1, §6): roles replace, hypotheses move through
hypothesis_status, an agent's arrive suggested and a person confirms or
rejects in place, typologies and groups are free vocabularies."""

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
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)
    inv = client.post("/api/investigations", json={"title": "Caso"}, headers=h(OWNER)).json()
    token = client.post("/api/agent-tokens", json={"name": "claude"}, headers=h(OWNER)).json()["token"]
    yield client, f"/api/investigations/{inv['id']}", {"Authorization": f"Bearer {token}"}
    InMemoryStore.reset()
    get_settings.cache_clear()


def _post(client, url, headers, **body):
    r = client.post(f"{url}/annotations", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def test_roles_replace_and_validation(env):
    client, url, _ = env
    first = _post(client, url, h(OWNER), kind="role", targets=["Pessoa:1"], value={"role": "mula"})
    assert first["status"] == "confirmed" and first["author_kind"] == "human"
    second = _post(client, url, h(OWNER), kind="role", targets=["Pessoa:1"], value={"role": "cessionário"}, reason="KYC")
    roles = client.get(f"{url}/annotations?kind=role", headers=h(OWNER)).json()
    assert [(a["id"], a["value"]["role"], a["reason"]) for a in roles] == [(second["id"], "cessionário", "KYC")]
    for body in (
        {"kind": "role", "targets": [], "value": {"role": "x"}},
        {"kind": "role", "targets": ["a"], "value": {}},
        {"kind": "same_as", "targets": ["a", "a"]},
        {"kind": "hypothesis", "value": {"text": ""}},
        {"kind": "nope"},
    ):
        r = client.post(f"{url}/annotations", json=body, headers=h(OWNER))
        assert r.status_code == 422, body
    tag = _post(client, url, h(OWNER), kind="tag", targets=["Pessoa:1", "Pessoa:2"], value={"tag": "laranja"})
    assert client.get(f"{url}/annotations?target=Pessoa:2", headers=h(OWNER)).json()[0]["id"] == tag["id"]
    r = client.patch(f"{url}/annotations/{tag['id']}", json={"targets": ["Pessoa:2"], "value": {"tag": "mula"}}, headers=h(OWNER))
    assert r.status_code == 200 and r.json()["value"] == {"tag": "mula"}
    assert client.delete(f"{url}/annotations/{tag['id']}", headers=h(OWNER)).status_code == 200
    kinds = [e["kind"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()]
    assert kinds[-4:] == ["role.set", "tag.set", "tag.updated", "tag.removed"]


def test_hypotheses_and_their_status(env):
    client, url, agent = env
    hyp = _post(client, url, h(OWNER), kind="hypothesis", value={"text": "4471-0 é conta de passagem"})
    assert hyp["value"]["status"] == "open"
    moved = _post(client, url, h(OWNER), kind="hypothesis_status", targets=[hyp["id"]], value={"status": "supported"})
    assert moved["status"] == "confirmed"
    [current] = client.get(f"{url}/annotations?kind=hypothesis", headers=h(OWNER)).json()
    assert current["value"]["status"] == "supported"
    # The agent's status change is a suggestion until confirmed.
    suggestion = _post(client, url, agent, kind="hypothesis_status", targets=[hyp["id"]], value={"status": "refuted"}, reason="E2 contradiz")
    assert suggestion["status"] == "suggested" and suggestion["author_kind"] == "agent"
    assert client.get(f"{url}/annotations?kind=hypothesis", headers=h(OWNER)).json()[0]["value"]["status"] == "supported"
    confirmed = client.post(f"{url}/annotations/{suggestion['id']}/confirm", headers=h(OWNER)).json()
    assert confirmed["status"] == "confirmed" and confirmed["confirmed_by"] == OWNER
    assert client.get(f"{url}/annotations?kind=hypothesis", headers=h(OWNER)).json()[0]["value"]["status"] == "refuted"
    bad = client.post(f"{url}/annotations", json={"kind": "hypothesis_status", "targets": [hyp["id"]], "value": {"status": "maybe"}}, headers=h(OWNER))
    assert bad.status_code == 422
    not_hyp = client.post(f"{url}/annotations", json={"kind": "hypothesis_status", "targets": [suggestion["id"]], "value": {"status": "open"}}, headers=h(OWNER))
    assert not_hyp.status_code == 422


def test_agent_suggestions_follow_the_case_settings(env):
    client, url, agent = env
    role = _post(client, url, agent, kind="role", targets=["Pessoa:1"], value={"role": "mula"}, reason="recebe e repassa")
    assert role["status"] == "suggested"
    assert client.get(f"{url}/annotations?status=suggested", headers=h(OWNER)).json()[0]["id"] == role["id"]
    assert client.post(f"{url}/annotations/{role['id']}/confirm", headers=agent).status_code == 403
    assert client.post(f"{url}/annotations/{role['id']}/confirm", headers=h(OWNER)).status_code == 200
    assert client.post(f"{url}/annotations/{role['id']}/confirm", headers=h(OWNER)).status_code == 409
    rejected = _post(client, url, agent, kind="role", targets=["Pessoa:1"], value={"role": "vítima"})
    assert client.post(f"{url}/annotations/{rejected['id']}/reject", headers=h(OWNER)).json()["status"] == "rejected"
    confirmed_roles = client.get(f"{url}/annotations?kind=role&status=confirmed", headers=h(OWNER)).json()
    assert [a["value"]["role"] for a in confirmed_roles] == ["mula"]
    # A group is not a suggest kind by default: the agent's applies directly.
    group = _post(client, url, agent, kind="group", targets=["Pessoa:1", "Pessoa:2"], value={"name": "Grupo Alfa", "color": 3})
    assert group["status"] == "confirmed"
    client.patch(url, json={"settings": {"agent_suggest_kinds": ["group"]}}, headers=h(OWNER))
    assert _post(client, url, agent, kind="group", targets=["Pessoa:3"], value={"name": "B"})["status"] == "suggested"
    assert _post(client, url, agent, kind="role", targets=["Pessoa:3"], value={"role": "x"})["status"] == "confirmed"
    events = client.get(f"{url}/events", headers=h(OWNER)).json()
    assert {e["kind"] for e in events} >= {"role.suggested", "role.confirmed", "role.rejected", "group.set"}
    assert all(e["actor_kind"] == "agent" for e in events if e["kind"] == "role.suggested")
