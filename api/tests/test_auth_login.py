"""The app-hosted sign-in with Databricks (auth_mode=databricks outside the
Apps proxy): Authorization Code + PKCE, the token used once for /Me, a signed
session cookie, CSRF on writes, and agent tokens bound to the session."""

import sys
import time
from urllib.parse import parse_qs, urlparse

import httpx
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

import base64  # noqa: E402
import hashlib  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.routers import auth as auth_router  # noqa: E402
from graphlagoon.services import session as sessions  # noqa: E402
from graphlagoon.services.identity_verification import StubIdentityVerifier, set_identity_verifier  # noqa: E402

OWNER = "owner@example.com"
OTHER = "other@example.com"
SECRET = "unit-test-session-secret"
CSRF = {"X-Requested-With": "graphlagoon"}


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "false")
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_MODE", "databricks")
    monkeypatch.setenv("GRAPH_LAGOON_DATABRICKS_HOST", "dbx.example")
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_OAUTH_CLIENT_ID", "app-id")
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_OAUTH_CLIENT_SECRET", "app-secret")
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_SESSION_SECRET", SECRET)
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE", "100000")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    set_identity_verifier(StubIdentityVerifier({"user-token": OWNER}))
    exchanges = []

    def token_endpoint(request):
        exchanges.append(request)
        assert request.url == "https://dbx.example/oidc/v1/token"
        form = parse_qs(request.content.decode())
        assert form["grant_type"] == ["authorization_code"] and form["client_id"] == ["app-id"]
        assert request.headers["authorization"].startswith("Basic ")
        if form["code"] != ["good-code"]:
            return httpx.Response(400, json={"error": "invalid_grant"})
        return httpx.Response(200, json={"access_token": "user-token", "token_type": "Bearer", "expires_in": 3600})

    auth_router.set_oauth_transport(httpx.MockTransport(token_endpoint))
    yield monkeypatch, exchanges
    auth_router.set_oauth_transport(None)
    set_identity_verifier(None)
    InMemoryStore.reset()
    get_settings.cache_clear()


@pytest.fixture
def client(env):
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    return TestClient(app, base_url="https://app.example")


def _code(response):
    return response.json()["detail"]["error"]["code"]


def _start(client, next_path="/cases"):
    r = client.get("/api/auth/login", params={"next": next_path}, follow_redirects=False)
    assert r.status_code == 302, r.text
    return r, parse_qs(urlparse(r.headers["location"]).query)


def test_login_redirects_with_state_and_pkce(client):
    r, query = _start(client)
    assert r.headers["location"].startswith("https://dbx.example/oidc/v1/authorize?")
    assert query["client_id"] == ["app-id"] and query["response_type"] == ["code"]
    assert query["redirect_uri"] == ["https://app.example/api/auth/callback"]
    assert query["code_challenge_method"] == ["S256"] and query["state"][0]
    cookie = r.cookies.get(sessions.OAUTH_COOKIE)
    pending = sessions.verify(cookie, SECRET)
    assert pending["state"] == query["state"][0] and pending["next"] == "/cases"
    challenge = base64.urlsafe_b64encode(hashlib.sha256(pending["verifier"].encode()).digest()).rstrip(b"=").decode()
    assert query["code_challenge"] == [challenge]
    assert "HttpOnly" in r.headers["set-cookie"] and "Secure" in r.headers["set-cookie"]


def test_next_must_be_a_local_path(client):
    for bad in ("https://evil.example/", "//evil.example", "cases"):
        _, query = _start(client, bad)
        r = client.get("/api/auth/login", params={"next": bad}, follow_redirects=False)
        assert sessions.verify(r.cookies.get(sessions.OAUTH_COOKIE), SECRET)["next"] == "/"


def test_callback_rejects_bad_state_and_bad_code(client, env):
    _, exchanges = env
    _start(client)
    r = client.get("/api/auth/callback", params={"code": "good-code", "state": "forged"}, follow_redirects=False)
    assert r.status_code == 401 and _code(r) == "SIGN_IN_STATE_MISMATCH" and exchanges == []
    _, query = _start(client)
    r = client.get("/api/auth/callback", params={"code": "bad-code", "state": query["state"][0]}, follow_redirects=False)
    assert r.status_code == 401 and _code(r) == "SIGN_IN_REJECTED" and len(exchanges) == 1
    assert sessions.SESSION_COOKIE not in r.cookies


def test_callback_exchanges_code_verifies_me_and_opens_the_session(client, env):
    _, exchanges = env
    _, query = _start(client, "/cases")
    r = client.get("/api/auth/callback", params={"code": "good-code", "state": query["state"][0]}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/cases"
    assert parse_qs(exchanges[0].content.decode())["code_verifier"][0]
    session = sessions.verify(r.cookies.get(sessions.SESSION_COOKIE), SECRET)
    assert session["sub"] == OWNER and session["exp"] - session["iat"] == 8 * 3600
    # The client keeps the cookie: the person is signed in, the pending cookie is gone.
    assert client.get("/api/auth/me").json()["email"] == OWNER
    assert client.get("/api/config").status_code == 200
    assert OWNER in InMemoryStore.get_instance().users
    assert not client.cookies.get(sessions.OAUTH_COOKIE)


def test_tampered_or_expired_cookie_is_rejected(client):
    client.cookies.set(sessions.SESSION_COOKIE, "garbage.value")
    r = client.get("/api/auth/me")
    assert r.status_code == 401 and _code(r) == "SESSION_INVALID"
    client.cookies.set(sessions.SESSION_COOKIE, sessions.sign({"sub": OWNER, "iat": 1, "exp": int(time.time()) - 1}, SECRET))
    assert _code(client.get("/api/auth/me")) == "SESSION_INVALID"
    client.cookies.set(sessions.SESSION_COOKIE, sessions.new_session(OWNER, "another-secret", 8))
    assert _code(client.get("/api/auth/me")) == "SESSION_INVALID"


def test_writes_with_a_cookie_need_the_requested_with_header(client):
    client.cookies.set(sessions.SESSION_COOKIE, sessions.new_session(OWNER, SECRET, 8))
    r = client.post("/api/agent-tokens", json={"name": "x"})
    assert r.status_code == 403 and _code(r) == "CSRF_HEADER_REQUIRED"
    assert client.post("/api/agent-tokens", json={"name": "x"}, headers=CSRF).status_code == 201


def test_logout_clears_the_session(client):
    client.cookies.set(sessions.SESSION_COOKIE, sessions.new_session(OWNER, SECRET, 8))
    r = client.post("/api/auth/logout", headers=CSRF)
    assert r.status_code == 200 and r.json() == {"status": "signed_out"}
    assert 'gl_session=""' in r.headers["set-cookie"] or "gl_session=;" in r.headers["set-cookie"]
    client.cookies.clear()
    assert client.get("/api/auth/me").status_code == 403


def test_agent_token_is_bound_to_the_session_identity(client):
    client.cookies.set(sessions.SESSION_COOKIE, sessions.new_session(OWNER, SECRET, 8))
    glt = client.post("/api/agent-tokens", json={"name": "x"}, headers=CSRF).json()["token"]
    client.cookies.set(sessions.SESSION_COOKIE, sessions.new_session(OTHER, SECRET, 8))
    r = client.get("/api/investigations", headers={"X-Graphlagoon-Agent-Token": glt})
    assert r.status_code == 403 and _code(r) == "AGENT_TOKEN_IDENTITY_MISMATCH"
    client.cookies.clear()
    assert client.get("/api/investigations", headers={"X-Graphlagoon-Agent-Token": glt}).status_code == 200


def test_sign_in_is_404_in_header_mode_and_needs_a_session_secret(client, env):
    monkeypatch, _ = env
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_MODE", "header")
    get_settings.cache_clear()
    assert client.get("/api/auth/login", follow_redirects=False).status_code == 404
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_MODE", "databricks")
    monkeypatch.delenv("GRAPH_LAGOON_AUTH_SESSION_SECRET")
    get_settings.cache_clear()
    r = client.get("/api/auth/login", follow_redirects=False)
    assert r.status_code == 500 and _code(r) == "AUTH_MISCONFIGURED"


def test_public_config_announces_the_sign_in(client):
    client.cookies.set(sessions.SESSION_COOKIE, sessions.new_session(OWNER, SECRET, 8))
    body = client.get("/api/config").json()
    assert body["auth_mode"] == "databricks" and body["login_url"] == "/api/auth/login"
