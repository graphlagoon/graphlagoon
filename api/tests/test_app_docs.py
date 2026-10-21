"""API docs (OpenAPI + Swagger UI): behind ``api_docs_enabled`` and the same
login as the API, standalone or mounted under a prefix; an auth scheme for
Swagger's Authorize; one tag and a description on every case and org route;
readable, unique operation ids; the routes agents may not use say so."""

import collections
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

from graphlagoon.app import create_app, create_mountable_app  # noqa: E402
from graphlagoon.config import Settings, get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402

ME = {"X-Forwarded-Email": "ana@example.com"}


@pytest.fixture
def env(monkeypatch):
    def apply(dev_mode: bool, docs: str | None = None):
        monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true" if dev_mode else "false")
        if docs is None:
            monkeypatch.delenv("GRAPH_LAGOON_API_DOCS_ENABLED", raising=False)
        else:
            monkeypatch.setenv("GRAPH_LAGOON_API_DOCS_ENABLED", docs)
        get_settings.cache_clear()
        return get_settings()

    yield apply
    get_settings.cache_clear()
    InMemoryStore.reset()


def _standalone(settings: Settings) -> TestClient:
    return TestClient(create_app(settings=settings, include_frontend=False))


def _mounted(settings: Settings, prefix: str = "/x") -> tuple[TestClient, FastAPI]:
    host = FastAPI()
    host.add_middleware(AuthMiddleware)
    host.mount(prefix, create_mountable_app(settings=settings, include_frontend=False, mount_prefix=prefix))
    return TestClient(host), host


def test_on_in_dev_mode_off_otherwise_and_the_setting_wins(env):
    assert _standalone(env(dev_mode=True)).get("/docs").status_code == 200
    client = _standalone(env(dev_mode=False))
    assert [client.get(p, headers=ME).status_code for p in ("/docs", "/openapi.json", "/redoc")] == [404, 404, 404]
    client = _standalone(env(dev_mode=False, docs="true"))
    assert client.get("/openapi.json", headers=ME).status_code == 200
    assert _standalone(env(dev_mode=True, docs="false")).get("/docs").status_code == 404


def test_behind_the_same_login_as_the_api(env):
    client = _standalone(env(dev_mode=False, docs="true"))
    assert client.get("/docs").status_code in (401, 403)
    assert client.get("/openapi.json").status_code in (401, 403)
    assert client.get("/docs", headers=ME).status_code == 200


def test_mounted_under_a_prefix_the_ui_reads_the_prefixed_spec_and_the_host_docs_do_not_list_it(env):
    client, host = _mounted(env(dev_mode=False, docs="true"))
    page = client.get("/x/docs", headers=ME)
    assert page.status_code == 200 and "'/x/openapi.json'" in page.text
    spec = client.get("/x/openapi.json", headers=ME).json()
    assert "/api/investigations" in spec["paths"]
    assert not any(p.startswith("/x/api") or p.startswith("/api/") for p in host.openapi()["paths"])
    off, _ = _mounted(env(dev_mode=False, docs="false"))
    assert off.get("/x/docs", headers=ME).status_code == 404


def test_the_spec_explains_itself(env):
    spec = _standalone(env(dev_mode=True)).get("/openapi.json").json()
    assert set(spec["components"]["securitySchemes"]) == {"agentToken", "forwardedEmail"}
    assert spec["components"]["securitySchemes"]["agentToken"]["scheme"] == "bearer"
    ops = [(m, p, o) for p, items in spec["paths"].items() for m, o in items.items()]
    case_ops = [(m, p, o) for m, p, o in ops if p.startswith("/graphlagoon/api/investigations") or p.startswith("/graphlagoon/api/org")]
    undocumented = [f"{m.upper()} {p}" for m, p, o in case_ops if not o.get("description") or len(o.get("tags", [])) != 1]
    assert not undocumented, f"give these routes a docstring and one tag: {undocumented}"
    ids = collections.Counter(o["operationId"] for _, _, o in ops)
    assert not [i for i, n in ids.items() if n > 1]
    decide = spec["paths"]["/graphlagoon/api/investigations/{investigation_id}/decisions"]["post"]
    assert decide["operationId"] == "decisions_record_decision" and "**People only**" in decide["description"]
    assert "People only" not in spec["paths"]["/graphlagoon/api/investigations/{investigation_id}/annotations"]["post"]["description"]
    body = spec["components"]["schemas"]["InvestigationCreate"]
    assert body["examples"][0]["external_ref"]
