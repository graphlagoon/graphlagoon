"""auth_mode=databricks: every identity is verified with the workspace, and an
agent token is bound to its owner's login (memory store, mocked workspace)."""

import asyncio
import logging
import sys

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

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import HTMLResponse  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.app import create_api_router, create_mountable_app  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import identity_verification as idv  # noqa: E402
from graphlagoon.services.identity_verification import (  # noqa: E402
    DatabricksIdentityVerifier,
    StubIdentityVerifier,
    set_identity_verifier,
)

OWNER = "owner@example.com"
OTHER = "other@example.com"
SP = "sp@example.com"
SUPERUSER = "admin@example.com"
TOKENS = {"tok-owner": OWNER, "tok-other": OTHER, "tok-sp": SP, "tok-admin": SUPERUSER}


def _me(email):
    return {"userName": email, "emails": [{"value": email, "primary": True}]}


def _verifier(handler, ttl=300, stale=3600):
    return DatabricksIdentityVerifier("dbx.example", ttl, stale, transport=httpx.MockTransport(handler))


class TestVerifier:
    def test_me_match_verifies_once_and_caches(self):
        calls = []

        def handler(request):
            calls.append(request)
            return httpx.Response(200, json=_me("Ana@Example.com"))

        v = _verifier(handler)
        first = asyncio.run(v.verify("tok"))
        second = asyncio.run(v.verify("tok"))
        assert (first.status, first.email, first.source) == ("verified", "Ana@Example.com", "fresh")
        assert second.source == "cache"
        assert len(calls) == 1
        assert calls[0].url.path.endswith("/api/2.0/preview/scim/v2/Me")
        assert calls[0].url.host == "dbx.example" and calls[0].url.scheme == "https"
        assert calls[0].headers["authorization"] == "Bearer tok"

    def test_primary_email_fallback_matches_service_principal(self):
        def handler(request):
            return httpx.Response(200, json={"userName": "9b1d-app-id", "emails": [{"value": SP, "primary": True}]})

        assert asyncio.run(_verifier(handler).verify("t")).email == SP
        assert idv.email_of_me({"userName": "9b1d-app-id"}) == "9b1d-app-id"

    def test_databricks_401_is_invalid_and_cached(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(401, json={"error_code": "PERMISSION_DENIED"})

        v = _verifier(handler)
        assert asyncio.run(v.verify("bad")).status == "invalid"
        assert asyncio.run(v.verify("bad")).status == "invalid"
        assert len(calls) == 1

    def test_transient_error_serves_stale_until_cap_then_unavailable(self, monkeypatch):
        state = {"ok": True, "now": 1000.0}

        def handler(request):
            if state["ok"]:
                return httpx.Response(200, json=_me(OWNER))
            raise httpx.ConnectError("boom")

        monkeypatch.setattr(idv.time, "time", lambda: state["now"])
        v = _verifier(handler, ttl=10, stale=100)
        assert asyncio.run(v.verify("tok")).source == "fresh"
        state["ok"] = False
        state["now"] = 1050.0  # past the TTL, inside the stale window
        stale = asyncio.run(v.verify("tok"))
        assert (stale.status, stale.email, stale.source) == ("verified", OWNER, "stale")
        assert stale.error and "ConnectError" in stale.error
        state["now"] = 1200.0  # past the stale cap
        assert asyncio.run(v.verify("tok")).status == "unavailable"

    def test_transient_error_on_cold_cache_is_unavailable(self):
        def handler(request):
            raise httpx.ReadTimeout("slow")

        verdict = asyncio.run(_verifier(handler).verify("tok"))
        assert verdict.status == "unavailable" and verdict.email is None

    def test_token_never_appears_in_cache_keys_status_or_logs(self, caplog):
        def handler(request):
            raise httpx.ConnectError("boom")

        v = _verifier(handler)
        with caplog.at_level(logging.INFO, logger="graphlagoon.services.identity_verification"):
            asyncio.run(v.verify("tok-super-secret"))
            good = _verifier(lambda r: httpx.Response(200, json=_me(OWNER)))
            asyncio.run(good.verify("tok-super-secret"))
        assert "tok-super-secret" not in caplog.text
        assert all(len(k) == 64 and int(k, 16) >= 0 for k in good._cache)
        assert "tok-super-secret" not in str(v.status()) + str(good.status())


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "false")
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_MODE", "databricks")
    monkeypatch.setenv("GRAPH_LAGOON_DATABRICKS_HOST", "dbx.example")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE", "100000")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    stub = StubIdentityVerifier(TOKENS)
    set_identity_verifier(stub)
    yield monkeypatch, stub
    set_identity_verifier(None)
    auth.configure_auth(None)
    InMemoryStore.reset()
    get_settings.cache_clear()


def _app():
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())

    @app.get("/", response_class=HTMLResponse)
    async def spa():
        return "<html>sign in</html>"

    return app


@pytest.fixture
def client(env):
    return TestClient(_app())


def forwarded(email, token=None):
    headers = {"X-Forwarded-Email": email}
    if token:
        headers["X-Forwarded-Access-Token"] = token
    return headers


def _code(response):
    return response.json()["detail"]["error"]["code"]


def test_header_mode_is_unchanged(env):
    monkeypatch, stub = env
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_MODE", "header")
    get_settings.cache_clear()
    client = TestClient(_app())
    r = client.get("/api/config", headers=forwarded(OWNER))
    assert r.status_code == 200 and stub.calls == []


def test_databricks_mode_requires_access_token(client):
    r = client.get("/api/config", headers=forwarded(OWNER))
    assert r.status_code == 401 and _code(r) == "IDENTITY_TOKEN_REQUIRED"


def test_databricks_mode_verified_person_passes(client):
    r = client.get("/api/config", headers=forwarded(OWNER, "tok-owner"))
    assert r.status_code == 200 and r.json()["auth_mode"] == "databricks"
    assert OWNER in InMemoryStore.get_instance().users
    r = client.get("/api/auth/me", headers=forwarded(OWNER, "tok-owner"))
    assert r.json() == {"email": OWNER, "auth_mode": "databricks", "actor": "person"}


def test_mismatch_is_401_and_registers_no_user(client):
    r = client.get("/api/config", headers=forwarded(SUPERUSER, "tok-owner"))
    assert r.status_code == 401 and _code(r) == "IDENTITY_MISMATCH"
    assert SUPERUSER not in InMemoryStore.get_instance().users
    assert OWNER not in InMemoryStore.get_instance().users


def test_invalid_token_is_401_and_outage_is_503(client, env):
    _, stub = env
    r = client.get("/api/config", headers=forwarded(OWNER, "tok-unknown"))
    assert r.status_code == 401 and _code(r) == "IDENTITY_TOKEN_INVALID"
    stub.unavailable_tokens.add("tok-owner")
    r = client.get("/api/config", headers=forwarded(OWNER, "tok-owner"))
    assert r.status_code == 503 and _code(r) == "IDENTITY_VERIFICATION_UNAVAILABLE"


def test_outside_the_proxy_is_403_unless_dev_mode(client, env):
    monkeypatch, _ = env
    r = client.get("/api/config")
    assert r.status_code == 403 and _code(r) == "FORBIDDEN" and "Sign in" in r.text
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    r = client.get("/api/auth/me")
    assert r.status_code == 200 and r.json()["email"] == auth.DEV_DEFAULT_EMAIL


def test_spa_html_is_served_without_identity_but_the_api_is_not(client):
    assert client.get("/", headers={"Accept": "text/html,*/*"}).status_code == 200
    assert client.get("/api/config", headers={"Accept": "text/html,*/*"}).status_code == 403


def test_bearer_databricks_token_identifies_cli_user(client):
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer tok-owner"})
    assert r.status_code == 200 and r.json()["email"] == OWNER
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer tok-nope"})
    assert r.status_code == 401 and _code(r) == "IDENTITY_TOKEN_INVALID"


def _mint(client, headers, name="claude"):
    r = client.post("/api/agent-tokens", json={"name": name}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["token"]


def test_agent_token_bound_to_proxy_identity(client):
    glt = _mint(client, forwarded(OWNER, "tok-owner"))
    other = {"Authorization": "Bearer tok-other", "X-Graphlagoon-Agent-Token": glt}
    r = client.get("/api/investigations", headers=other)
    assert r.status_code == 403 and _code(r) == "AGENT_TOKEN_IDENTITY_MISMATCH"
    r = client.get("/api/investigations", headers={**forwarded(OTHER, "tok-other"), "X-Graphlagoon-Agent-Token": glt})
    assert r.status_code == 403 and _code(r) == "AGENT_TOKEN_IDENTITY_MISMATCH"
    mine = {"Authorization": "Bearer tok-owner", "X-Graphlagoon-Agent-Token": glt}
    assert client.get("/api/investigations", headers=mine).status_code == 200
    r = client.post("/api/investigations", json={"title": "by agent"}, headers=mine)
    assert r.status_code == 201 and r.json()["owner_email"] == OWNER
    # Still an agent: the human-only routes stay closed.
    r = client.delete(f"/api/investigations/{r.json()['id']}", headers=mine)
    assert r.status_code == 403 and _code(r) == "AGENT_FORBIDDEN"


def test_agent_token_under_proxy_without_access_token_is_401(client):
    glt = _mint(client, forwarded(OWNER, "tok-owner"))
    r = client.get("/api/investigations", headers={**forwarded(OWNER), "Authorization": f"Bearer {glt}"})
    assert r.status_code == 401 and _code(r) == "IDENTITY_TOKEN_REQUIRED"


def test_agent_token_alone_outside_proxy_still_works(client):
    glt = _mint(client, forwarded(OWNER, "tok-owner"))
    assert client.get("/api/investigations", headers={"Authorization": f"Bearer {glt}"}).status_code == 200


def test_service_principal_mints_and_uses_own_token(client):
    glt = _mint(client, {"Authorization": "Bearer tok-sp"}, name="nightly")
    headers = {"Authorization": "Bearer tok-sp", "X-Graphlagoon-Agent-Token": glt}
    assert client.get("/api/investigations", headers=headers).status_code == 200


def test_raising_user_provider_is_401_not_header_fallthrough(client):
    def provider(request):
        raise RuntimeError("idp down")

    auth.configure_auth(provider)
    r = client.get("/api/config", headers=forwarded(OWNER, "tok-owner"))
    assert r.status_code == 401 and _code(r) == "AUTH_PROVIDER_FAILED"


def test_bare_router_never_downgrades_a_token_or_the_mode(env):
    app = FastAPI()
    app.include_router(create_api_router())
    bare = TestClient(app)
    r = bare.get("/api/investigations", headers={"Authorization": "Bearer glt_whatever"})
    assert r.status_code == 500 and _code(r) == "AUTH_MISCONFIGURED"
    r = bare.get("/api/config", headers=forwarded(OWNER))
    assert r.status_code == 500 and _code(r) == "AUTH_MISCONFIGURED"


def test_mountable_app_installs_auth_middleware(env):
    app = create_mountable_app(include_frontend=False)
    assert any(m.cls is auth.AuthMiddleware for m in app.user_middleware)
    app = create_mountable_app(include_frontend=False, install_auth_middleware=False)
    assert not any(m.cls is auth.AuthMiddleware for m in app.user_middleware)


def test_databricks_mode_needs_the_workspace_host(env):
    monkeypatch, _ = env
    monkeypatch.delenv("GRAPH_LAGOON_DATABRICKS_HOST")
    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="DATABRICKS_HOST"):
        idv.configure_identity_verification(get_settings())


def test_startup_warning_when_dev_and_header_mode_on_databricks(env, caplog):
    monkeypatch, _ = env
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_MODE", "header")
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_DATABRICKS_MODE", "true")
    get_settings.cache_clear()
    with caplog.at_level(logging.WARNING, logger="graphlagoon.middleware.auth"):
        auth.log_auth_posture(get_settings())
    assert "GRAPH_LAGOON_AUTH_MODE=databricks" in caplog.text and "dev_mode" in caplog.text
    caplog.clear()
    monkeypatch.setenv("GRAPH_LAGOON_AUTH_MODE", "databricks")
    get_settings.cache_clear()
    with caplog.at_level(logging.WARNING, logger="graphlagoon.middleware.auth"):
        auth.log_auth_posture(get_settings())
    assert caplog.text == ""


def test_overview_reports_forwarded_header_presence_not_values(client):
    headers = {**forwarded(SUPERUSER, "tok-admin"), "X-Real-Ip": "10.0.0.9"}
    r = client.get("/api/admin/overview", headers=headers)
    assert r.status_code == 200, r.text
    reported = r.json()["auth"]
    assert reported["mode"] == "databricks" and reported["verification"]["mode"] == "stub"
    assert reported["forwarded_headers"]["x-forwarded-access-token"] is True
    assert reported["forwarded_headers"]["x-forwarded-user"] is False
    assert "tok-admin" not in r.text and "10.0.0.9" not in r.text
