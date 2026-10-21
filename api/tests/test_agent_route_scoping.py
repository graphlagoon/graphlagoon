"""F0 (05 §6): an agent token reaches only the allowlisted routes. Walks every
API route with a valid token of a superuser owner (so permissions never hide
the verdict) and expects 403 AGENT_FORBIDDEN outside the allowlist."""

import re
import sys
from uuid import uuid4

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

SUPERUSER = "admin@example.com"
# Tags of the routers an agent may use at all (05 §6).
# The case routes carry one tag per group (cases, case items, annotations & tasks,
# decisions, graph & analysis) for the OpenAPI reference.
AGENT_TAGS = {
    "cases", "case items", "annotations & tasks", "decisions", "graph & analysis",
    "explorations", "graph", "config", "graph-contexts", "org",
}


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE", "100000")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield app
    InMemoryStore.reset()
    get_settings.cache_clear()


def _routes(routes):
    """Leaf routes of ``app.routes``; FastAPI nests included routers."""
    for r in routes:
        if getattr(r, "methods", None) and getattr(r, "path", None):
            yield r
        else:
            inner = getattr(r, "original_router", None)
            yield from _routes(inner.routes if inner is not None else [])


def _url(path: str) -> str:
    return re.sub(r"\{(\w+)(?::\w+)?\}", lambda m: str(uuid4()), path)


def test_every_route_outside_the_allowlist_is_403_for_an_agent(app):
    client = TestClient(app)
    human = {"X-Forwarded-Email": SUPERUSER}
    token = client.post(
        "/api/agent-tokens", json={"name": "all", "scopes": ["read", "write"]}, headers=human
    ).json()["token"]
    agent = {"Authorization": f"Bearer {token}"}

    routes = [r for r in _routes(app.routes) if r.path.startswith("/api")]
    assert len(routes) > 100
    allowed, forbidden, leaks = [], [], []
    for route in routes:
        for method in route.methods:
            url = _url(route.path)
            if auth.agent_path_allowed(url):
                allowed.append((method, route.path, route.tags))
                continue
            forbidden.append((method, route.path))
            r = client.request(method, url, json={}, headers=agent)
            code = r.json().get("detail", {}).get("error", {}).get("code") if r.status_code == 403 else None
            if code != "AGENT_FORBIDDEN":
                leaks.append((method, route.path, r.status_code))
    assert not leaks, f"routes reachable with an agent token: {leaks}"
    assert forbidden, "nothing outside the allowlist?"
    # The allowlist stays the plan's: cases, explorations, graph queries, config, org reads.
    assert {t for *_, tags in allowed for t in tags} <= AGENT_TAGS
    assert all(
        path.startswith(("/api/investigations", "/api/explorations", "/api/config", "/api/org/"))
        or "/api/graph-contexts/{context_id}/" in path
        for _, path, _ in allowed
    )
    assert ("GET", "/api/graph-contexts") in forbidden
    assert ("POST", "/api/agent-tokens") in forbidden
    assert ("GET", "/api/admin/overview") in forbidden


def test_case_token_is_403_on_another_case_and_on_creating_cases(app):
    client = TestClient(app)
    human = {"X-Forwarded-Email": SUPERUSER}
    mine = client.post("/api/investigations", json={"title": "A"}, headers=human).json()["id"]
    other = client.post("/api/investigations", json={"title": "B"}, headers=human).json()["id"]
    token = client.post(
        "/api/agent-tokens",
        json={"name": "a", "scopes": ["read"], "scope": "case", "investigation_ids": [mine]},
        headers=human,
    ).json()["token"]
    agent = {"Authorization": f"Bearer {token}"}
    case_routes = [r for r in _routes(app.routes) if "{investigation_id}" in r.path]
    for route in case_routes:
        for method in route.methods:
            url = _url(route.path.replace("{investigation_id}", other))
            r = client.request(method, url, json={}, headers=agent)
            assert r.status_code == 403, (method, route.path, r.status_code)
            assert r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
    assert client.get(f"/api/investigations/{mine}", headers=agent).status_code == 200
    assert client.post("/api/investigations", json={"title": "C"}, headers=agent).status_code == 403
    assert client.get("/api/investigations", headers=agent).status_code == 200


def test_a_token_reads_the_org_over_rest_and_the_org_routes_stay_read_only(app):
    """/api/org is on the allowlist as a prefix: the REST twins of get_case_type and
    get_playbook, so an integration can read a type's required fields. It must
    stay read-only; the org's writes live under /api/admin (superusers, no agents)."""
    client = TestClient(app)
    human = {"X-Forwarded-Email": SUPERUSER}
    token = client.post("/api/agent-tokens", json={"name": "alerts"}, headers=human).json()["token"]
    agent = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/org/case-types/general", headers=agent).json()["slug"] == "general"
    assert client.get("/api/org/library", headers=agent).status_code == 200
    assert client.get("/api/org/authoring", headers=agent).status_code == 200
    org = [(m, r.path) for r in _routes(app.routes) if r.path.startswith("/api/org") for m in r.methods]
    assert org and all(m in ("GET", "HEAD") for m, _ in org), org
