"""Agent tokens, scopes and the agent actor in the journal (FA.1), memory store."""

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

from datetime import datetime, timedelta  # noqa: E402
from uuid import UUID  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    yield monkeypatch
    InMemoryStore.reset()
    get_settings.cache_clear()


@pytest.fixture
def client(env):
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    return TestClient(app)


def mint(client, email=OWNER, scopes=("read", "write"), **extra):
    r = client.post(
        "/api/agent-tokens",
        json={"name": "claude", "scopes": list(scopes), **extra},
        headers=h(email),
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_token_shown_once_and_acts_for_owner_in_the_journal(client):
    created = mint(client)
    assert created["token"].startswith("glt_")
    listed = client.get("/api/agent-tokens", headers=h(OWNER)).json()
    assert [t["id"] for t in listed] == [created["id"]]
    assert "token" not in listed[0]
    store = InMemoryStore.get_instance()
    assert created["token"] not in str(vars(next(iter(store.agent_tokens.values()))))

    agent = bearer(created["token"])
    case = client.post("/api/investigations", json={"title": "Pix"}, headers=agent)
    assert case.status_code == 201, case.text
    assert case.json()["owner_email"] == OWNER
    url = f"/api/investigations/{case.json()['id']}"
    note = client.post(f"{url}/notes", json={"body": "mule"}, headers=agent)
    assert note.status_code == 201, note.text

    events = client.get(f"{url}/events", headers=h(OWNER)).json()
    assert {e["actor_kind"] for e in events} == {"agent"}
    assert all(e["actor_email"] == OWNER for e in events)
    assert all(e["agent_name"] == "claude" for e in events)
    audit = [log for log in store.usage_logs if log.action == "investigation.create"]
    assert audit[0].log_metadata["agent"]["name"] == "claude"


def test_expired_or_revoked_token_is_401(client):
    expired, revoked = mint(client), mint(client)
    store = InMemoryStore.get_instance()
    store.agent_tokens[UUID(expired["id"])].expires_at = datetime.now() - timedelta(
        seconds=1
    )
    assert client.delete(
        f"/api/agent-tokens/{revoked['id']}", headers=h(OWNER)
    ).json() == {"status": "revoked"}
    for token in (expired, revoked):
        r = client.get("/api/investigations", headers=bearer(token["token"]))
        assert r.status_code == 401
        assert r.json()["detail"]["error"]["code"] == "INVALID_AGENT_TOKEN"
    assert client.get("/api/investigations", headers=bearer("glt_x")).status_code == 401


def test_agent_on_human_only_routes_is_403_even_for_superuser_owner(client):
    agent = bearer(mint(client, SUPERUSER, scopes=("read", "write"))["token"])
    case = client.post("/api/investigations", json={"title": "Pix"}, headers=agent)
    url = f"/api/investigations/{case.json()['id']}"
    for method, path, body in (
        ("DELETE", url, None),
        ("POST", f"{url}/share", {"email": "x@example.com", "permission": "read"}),
        ("DELETE", f"{url}/share/x@example.com", None),
        ("POST", "/api/agent-tokens", {"name": "n", "scopes": ["read"]}),
        ("GET", "/api/agent-tokens", None),
        ("GET", "/api/admin/overview", None),
        ("GET", "/api/admin/agent-tokens", None),
    ):
        r = client.request(method, path, json=body, headers=agent)
        assert r.status_code == 403, (method, path, r.text)
        assert r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
    # the same superuser, as a person, may delete
    assert client.delete(url, headers=h(SUPERUSER)).status_code == 200


def test_scopes_limit_the_agent(client):
    agent = bearer(mint(client, scopes=("read",))["token"])
    assert client.get("/api/investigations", headers=agent).status_code == 200
    r = client.post("/api/investigations", json={"title": "Pix"}, headers=agent)
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["details"] == {"scope": "write"}


def test_max_validity_and_rate_limit(client, env):
    r = client.post(
        "/api/agent-tokens",
        json={"name": "n", "scopes": ["read"], "expires_in_days": 91},
        headers=h(OWNER),
    )
    assert r.status_code == 422
    env.setenv("GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE", "2")
    get_settings.cache_clear()
    agent = bearer(mint(client, scopes=("read",))["token"])
    codes = [
        client.get("/api/investigations", headers=agent).status_code for _ in "abc"
    ]
    assert codes == [200, 200, 429]


def test_admin_lists_and_revokes_any_token(client):
    token = mint(client)
    listed = client.get("/api/admin/agent-tokens", headers=h(SUPERUSER)).json()
    assert [(t["id"], t["owner_email"]) for t in listed] == [(token["id"], OWNER)]
    assert (
        client.delete(f"/api/admin/agent-tokens/{token['id']}", headers=h(OWNER))
    ).status_code == 403
    assert (
        client.delete(f"/api/admin/agent-tokens/{token['id']}", headers=h(SUPERUSER))
    ).status_code == 200
    r = client.get("/api/investigations", headers=bearer(token["token"]))
    assert r.status_code == 401


def test_agents_disabled_hides_token_routes_and_rejects_tokens(client, env):
    token = mint(client)
    env.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "false")
    get_settings.cache_clear()
    for method, path in (
        ("GET", "/api/agent-tokens"),
        ("POST", "/api/agent-tokens"),
        ("DELETE", f"/api/agent-tokens/{token['id']}"),
        ("GET", "/api/admin/agent-tokens"),
    ):
        r = client.request(method, path, json={}, headers=h(SUPERUSER))
        assert r.status_code == 404, (method, path)
    r = client.get("/api/investigations", headers=bearer(token["token"]))
    assert r.status_code == 401
