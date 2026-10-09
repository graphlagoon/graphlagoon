"""Case space artifacts (FA.2): versions never overwrite, html/svg download-only,
approval is human-only. Memory store, local blob store."""

import hashlib
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
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

OWNER = "owner@example.com"
READER = "reader@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def ctx(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_AGENTS_ENABLED", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)
    case = client.post("/api/investigations", json={"title": "Pix"}, headers=h(OWNER))
    url = f"/api/investigations/{case.json()['id']}"
    client.post(f"{url}/share", json={"email": READER}, headers=h(OWNER))
    yield client, url, tmp_path
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_versions_never_overwrite_and_are_journaled(ctx):
    client, url, root = ctx
    r = client.post(
        f"{url}/artifacts",
        json={"name": "Resumo do caso.md", "text": "# v1", "note": "first"},
        headers=h(OWNER),
    )
    assert r.status_code == 201, r.text
    art = r.json()
    assert art["kind"] == "doc" and art["current_version"] == 1
    v1 = art["versions"][0]
    assert v1["status"] == "draft" and v1["actor"] == {"kind": "human", "email": OWNER}
    assert v1["sha256"] == hashlib.sha256(b"# v1").hexdigest()

    r = client.post(
        f"{url}/artifacts/{art['id']}/versions",
        content=b"# v2",
        params={"name": "Resumo do caso.md", "note": "added E3"},
        headers={**h(OWNER), "Content-Type": "application/octet-stream"},
    )
    assert r.status_code == 201, r.text
    assert [v["version"] for v in r.json()["versions"]] == [2, 1]

    base = f"{url}/artifacts/{art['id']}/versions"
    one = client.get(f"{base}/1/content", headers=h(OWNER))
    assert one.content == b"# v1"
    assert one.headers["content-type"].startswith("text/markdown")
    assert one.headers["content-disposition"].startswith("inline")
    assert client.get(f"{base}/2/content", headers=h(OWNER)).content == b"# v2"
    # Two blobs on disk, one per version folder; no storage path in the API.
    assert len([p for p in root.rglob("*") if p.is_file()]) == 2
    assert "blob_key" not in str(r.json())

    # Type of a new version must match; unknown types are refused.
    bad = client.post(
        f"{base[: -len('/versions')]}/versions",
        content=b"x",
        params={"name": "other.pdf"},
        headers={**h(OWNER), "Content-Type": "application/pdf"},
    )
    assert bad.status_code == 422
    exe = client.post(
        f"{url}/artifacts", content=b"MZ", params={"name": "tool.exe"}, headers=h(OWNER)
    )
    assert exe.json()["detail"]["error"]["code"] == "ARTIFACT_TYPE_NOT_ALLOWED"
    # A read share sees the space but cannot write to it.
    assert client.get(f"{url}/artifacts", headers=h(READER)).status_code == 200
    denied = client.post(f"{url}/artifacts", json={"name": "a.txt", "text": "x"}, headers=h(READER))
    assert denied.status_code == 403

    kinds = [e["kind"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()]
    assert kinds.count("artifact.created") == 1
    assert kinds.count("artifact.version_added") == 1


def test_html_and_svg_are_download_only(ctx):
    client, url, _ = ctx
    for name in ("report.html", "chart.svg"):
        art = client.post(
            f"{url}/artifacts",
            json={"name": name, "text": "<script>alert(1)</script>"},
            headers=h(OWNER),
        ).json()
        assert art["download_only"] is True
        r = client.get(
            f"{url}/artifacts/{art['id']}/versions/1/content", headers=h(OWNER)
        )
        assert r.headers["content-disposition"].startswith("attachment")
        assert r.headers["content-type"] == "application/octet-stream"
        assert r.headers["x-content-type-options"] == "nosniff"


def test_agent_uploads_drafts_but_only_a_person_approves(ctx):
    client, url, _ = ctx
    token = client.post(
        "/api/agent-tokens",
        json={"name": "Claude", "scopes": ["read", "write"]},
        headers=h(OWNER),
    ).json()["token"]
    agent = {"Authorization": f"Bearer {token}"}

    art = client.post(
        f"{url}/artifacts",
        content=b"%PDF-1.4",
        params={"name": "Rastreio.pdf", "source_evidence_ids": ["E1", "E2"]},
        headers={**agent, "Content-Type": "application/pdf"},
    )
    assert art.status_code == 201, art.text
    v1 = art.json()["versions"][0]
    assert v1["actor"]["kind"] == "agent" and v1["actor"]["agent_name"] == "Claude"
    assert v1["source_evidence_ids"] == ["E1", "E2"]

    approve = f"{url}/artifacts/{art.json()['id']}/versions/1/approve"
    r = client.post(approve, headers=agent)
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "AGENT_FORBIDDEN"
    assert client.post(approve, headers=h(READER)).status_code == 403

    r = client.post(approve, headers=h(OWNER))
    assert r.status_code == 200, r.text
    v = r.json()["versions"][0]
    assert v["status"] == "approved" and v["approved_by"] == OWNER
    assert client.post(approve, headers=h(OWNER)).status_code == 409
