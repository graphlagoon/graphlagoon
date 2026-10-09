"""AI-first coverage (FA.6, 03 §8.7): every investigation route has an MCP tool
or a recorded reason, and human-only routes reject agent tokens."""

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
from graphlagoon.mcp.registry import (  # noqa: E402
    AGENT_EXEMPT_ROUTES,
    AGENT_TOOL_ROUTES,
    human_only_routes,
)
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.routers import agent_tokens, graph_contexts, investigations  # noqa: E402

SUPERUSER = "admin@example.com"
COVERED_ROUTERS = (investigations.router, agent_tokens.router)


def _routes(router) -> dict[tuple[str, str], object]:
    return {(m, r.path): r for r in router.routes for m in r.methods}


ALL_ROUTES = {k: v for router in COVERED_ROUTERS for k, v in _routes(router).items()}
# Of the graph-context routes, only the enrichment ones are case tooling (F2.1).
ALL_ROUTES |= {
    k: v for k, v in _routes(graph_contexts.router).items() if "/enrichment/" in k[1]
}


def _forbids_agents(route) -> bool:
    deps = [d.call for d in route.dependant.dependencies]
    return any(getattr(c, "forbids_agents", False) for c in deps)


def test_every_route_has_a_tool_or_a_reason():
    tools, exempt = set(AGENT_TOOL_ROUTES), set(AGENT_EXEMPT_ROUTES)
    assert not tools & exempt, f"both a tool and an exemption: {tools & exempt}"
    missing = set(ALL_ROUTES) - tools - exempt
    assert not missing, (
        f"routes without an MCP tool or a reason in mcp/registry.py: {sorted(missing)}"
    )
    stale = (tools | exempt) - set(ALL_ROUTES)
    assert not stale, f"registry entries for routes that no longer exist: {sorted(stale)}"
    assert all(why.strip() for why in AGENT_EXEMPT_ROUTES.values())


def test_registered_tools_exist_and_human_only_actions_have_none():
    pytest.importorskip("mcp")
    from graphlagoon.mcp.server import build_server

    names = {t.name for t in build_server()._tool_manager.list_tools()}
    unknown = set(AGENT_TOOL_ROUTES.values()) - names
    assert not unknown, f"registry names tools the MCP server lacks: {unknown}"
    assert not [n for n in names if re.search(r"delete|share|approve|accept|reject|decide|decision|token", n)]


def test_human_only_routes_declare_forbid_agents_and_only_they_do():
    human = human_only_routes()
    open_ = {k for k in human if k in ALL_ROUTES and not _forbids_agents(ALL_ROUTES[k])}
    assert not open_, f"human-only routes without forbid_agents: {open_}"
    forbidding = {k for k, r in ALL_ROUTES.items() if _forbids_agents(r)}
    assert forbidding <= human, (
        f"forbid_agents routes not registered as human-only: {forbidding - human}"
    )


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app)
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_human_only_routes_reject_an_agent_token_even_for_a_superuser(client):
    human = {"X-Forwarded-Email": SUPERUSER}
    case_id = client.post("/api/investigations", json={"title": "x"}, headers=human).json()["id"]
    token = client.post(
        "/api/agent-tokens",
        json={"name": "all", "scopes": ["read", "analyze", "write", "propose"]},
        headers=human,
    ).json()["token"]
    params = {"investigation_id": case_id, "email": "a@example.com", "version": "1"}
    for method, path in sorted(human_only_routes()):
        url = re.sub(r"\{(\w+)\}", lambda m: params.get(m[1], str(uuid4())), path)
        r = client.request(
            method, url, json={}, headers={"Authorization": f"Bearer {token}"}
        )
        assert r.status_code == 403, (method, path, r.status_code, r.text)
        assert r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN", (method, path)
