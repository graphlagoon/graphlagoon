"""The investigations dev seed, run in-process against the whole API (memory mode)."""

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

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.dev.seed import ADMIN_EMAIL, run_seed  # noqa: E402
from graphlagoon.dev.seed_investigations import MARKER, run_seed_investigations  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402


@pytest.fixture
def in_process(monkeypatch, tmp_path):
    for key, value in {
        "GRAPH_LAGOON_DEV_MODE": "true",
        "GRAPH_LAGOON_AGENTS_ENABLED": "true",
        "GRAPH_LAGOON_SUPERUSER_EMAILS": ADMIN_EMAIL,
        "GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS": "example.com",
    }.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    transport = httpx.ASGITransport(app=app)
    original = httpx.AsyncClient.__init__

    def patched(self, *args, **kwargs):
        kwargs["transport"] = transport
        original(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_seeds_every_status_artifacts_and_proposals_then_resets(in_process):
    store = in_process
    quiet = lambda *_: None  # noqa: E731
    await run_seed(
        "http://testserver", users=5, contexts=10, explorations=30, graphs=1, seed=1,
        no_graphs=True, log=quiet,
    )
    regular = {i.id for i in store.investigations.values()}

    stats = await run_seed_investigations("http://testserver", cases=6, log=quiet)

    seeded = [i for i in store.investigations.values() if MARKER in (i.description or "")]
    assert len(seeded) == 6
    assert {i.status for i in seeded} == {"selecao", "analise", "arquivado", "decidido"}
    assert {i.decision["outcome"] for i in seeded if i.decision} == {"comunicar", "arquivar"}
    artifacts = store.list_investigation_children("investigation_artifacts", seeded[0].id)
    assert stats.artifacts >= 6 and len(artifacts) == 5
    versions = [
        v for i in seeded for v in store.list_investigation_children("investigation_artifact_versions", i.id)
    ]
    assert len(versions) == stats.versions and {v.status for v in versions} == {"draft", "approved"}
    assert all(v.actor["kind"] == "agent" for v in versions)
    assert set(stats.proposals) == {"accepted", "pending", "rejected"}
    assert {"aceito", "recusado", "adiado", "sugerido"} <= set(stats.matches)
    assert stats.live_sources >= 2 and stats.badges >= 1
    # The flagship SIMBA case has a trace evidence with money reaching an exit.
    flagship = next(i for i in seeded if i.title.startswith("Golpe Pix · falsa central"))
    trace = next(
        e for e in store.list_investigation_children("investigation_evidence", flagship.id) if e.kind == "trace"
    )
    assert trace is not None and stats.flagship.endswith(str(flagship.id))

    again = await run_seed_investigations("http://testserver", cases=2, reset=True, log=quiet)
    assert again.deleted == 6
    left = [i for i in store.investigations.values() if MARKER in (i.description or "")]
    assert len(left) == 2
    assert regular <= set(store.investigations)  # the regular seed's cases are untouched
