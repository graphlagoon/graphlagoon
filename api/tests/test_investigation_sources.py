"""Investigation sources (F1.3): multi-context, redaction by access, frozen hash."""

import gzip
import hashlib
import sys
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

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.routers import investigations  # noqa: E402
from graphlagoon.services import investigations as service  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

OWNER = "owner@example.com"
FRAUD = "fraud@example.com"  # owns context B
READER = "reader@example.com"  # reads the case and context A only
WRITER = "writer@example.com"  # writes the case, reads context A only
OUTSIDER = "outsider@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", "admin@example.com")
    get_settings.cache_clear()
    InMemoryStore.reset()
    blob = LocalBlobStore(str(tmp_path))
    monkeypatch.setattr(service, "_blob_store", lambda: blob)
    store = InMemoryStore.get_instance()

    ctx_a = store.create_graph_context("Pix", "e", "n", OWNER)
    ctx_b = store.create_graph_context("Adquirência", "e", "n", FRAUD)
    for email in (READER, WRITER):
        store.share_graph_context(ctx_a.id, email)
    store.share_graph_context(ctx_b.id, OWNER)
    exp_a = store.create_exploration(ctx_a.id, "Contas mula", OWNER, {"nodes": []})
    exp_b = store.create_exploration(ctx_b.id, "Lojistas", FRAUD, {"nodes": []})

    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(investigations.router)
    client = TestClient(app)
    inv = client.post(
        "/api/investigations", json={"title": "Caso"}, headers=h(OWNER)
    ).json()
    for email, perm in ((READER, "read"), (WRITER, "write")):
        client.post(
            f"/api/investigations/{inv['id']}/share",
            json={"email": email, "permission": perm},
            headers=h(OWNER),
        )
    yield {
        "client": client,
        "store": store,
        "blob": blob,
        "url": f"/api/investigations/{inv['id']}/sources",
        "exp_a": exp_a,
        "exp_b": exp_b,
    }
    InMemoryStore.reset()
    get_settings.cache_clear()


def _add(env, exp, mode="live", who=OWNER):
    return env["client"].post(
        env["url"],
        json={"kind": "exploration", "exploration_id": str(exp.id), "mode": mode},
        headers=h(who),
    )


def test_two_contexts_in_one_case(env):
    assert _add(env, env["exp_a"]).status_code == 201
    assert _add(env, env["exp_b"], "frozen").status_code == 201
    sources = env["client"].get(env["url"], headers=h(OWNER)).json()
    assert [(s["title_snapshot"], s["accessible"]) for s in sources] == [
        ("Contas mula", True),
        ("Lojistas", True),
    ]
    assert len({s["context_id"] for s in sources}) == 2
    assert _add(env, env["exp_a"]).status_code == 409  # already a source
    # The queue counts sources per case.
    queue = env["client"].get("/api/investigations", headers=h(OWNER)).json()
    assert [c["source_count"] for c in queue] == [2]


def test_restricted_source_is_a_placeholder(env):
    _add(env, env["exp_a"])
    b = _add(env, env["exp_b"]).json()
    sources = env["client"].get(env["url"], headers=h(READER)).json()
    restricted = next(s for s in sources if s["id"] == b["id"])
    assert restricted["accessible"] is False
    assert restricted["title_snapshot"] == "Lojistas"
    assert restricted["context_title"] == "Adquirência"
    assert restricted["owner_email"] == FRAUD
    assert restricted["context_id"] is None and restricted["exploration_id"] is None

    snap = f"{env['url']}/{b['id']}/snapshot"
    assert env["client"].get(snap, headers=h(READER)).status_code == 403
    assert env["client"].get(snap, headers=h(OWNER)).status_code == 200


def test_add_requires_case_write_and_context_read(env):
    assert _add(env, env["exp_a"], who=READER).status_code == 403  # read-only case
    assert _add(env, env["exp_b"], who=WRITER).status_code == 403  # no context B
    assert _add(env, env["exp_a"], who=WRITER).status_code == 201
    assert _add(env, env["exp_a"], who=OUTSIDER).status_code == 404
    assert env["client"].get(env["url"], headers=h(OUTSIDER)).status_code == 404


@pytest.mark.asyncio
async def test_frozen_copy_and_hash(env):
    src = _add(env, env["exp_a"], "frozen").json()
    row = env["store"].get_investigation_child("investigation_sources", UUID(src["id"]))
    data = await env["blob"].load(row.frozen_blob_key)
    assert hashlib.sha256(data).hexdigest() == src["frozen_sha256"]
    assert row.frozen_blob_key.endswith(f"/sources/{src['id']}.json.gz")
    assert gzip.decompress(data)  # valid gzip

    # The frozen copy does not follow later edits of the exploration.
    env["store"].update_exploration(env["exp_a"].id, title="Renomeada")
    body = env["client"].get(f"{env['url']}/{src['id']}/snapshot", headers=h(OWNER))
    assert body.json()["exploration"]["title"] == "Contas mula"


def test_remove_is_audited(env):
    src = _add(env, env["exp_a"]).json()
    r = env["client"].delete(f"{env['url']}/{src['id']}", headers=h(OWNER))
    assert r.status_code == 200
    assert env["client"].get(env["url"], headers=h(OWNER)).json() == []
    actions = [e.action for e in env["store"].usage_logs]
    assert actions[-2:] == ["investigation.source_add", "investigation.source_remove"]
