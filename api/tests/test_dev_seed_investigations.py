"""The investigations dev seed, run in-process against the whole API (memory mode)."""

import json
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
from graphlagoon.dev.seed import ADMIN_EMAIL  # noqa: E402
from graphlagoon.dev.seed_investigations import MARKER, run_seed_investigations  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import case_items, investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from graphlagoon.services.case_graph import case_graph  # noqa: E402


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
async def test_seeds_the_four_scenarios_on_items_and_annotations_then_resets(in_process):
    store = in_process
    quiet = lambda *_: None  # noqa: E731
    stats = await run_seed_investigations("http://testserver", cases=6, log=quiet)

    seeded = [i for i in store.investigations.values() if MARKER in (i.description or "")]
    assert len(seeded) == 6 and stats.agent
    assert {i.kind_preset for i in seeded} >= {"credito", "garantia", "pix_med", "fraude_sintetica"}
    assert {i.status for i in seeded} == {"open", "analysis", "decided", "archived"}
    assert {i.decision["outcome"] for i in seeded if i.decision} == {"comunicar", "arquivar"}
    assert not store.graph_contexts and not store.explorations  # no context per upload (05 §1)
    items = list(store.case_items.values())
    assert {i.kind for i in items} == {"table", "query", "document", "note"}
    assert stats.items["table"] >= 8 and stats.pinned >= 2 and stats.suggested >= 5
    assert {i.author_kind for i in items} == {"human", "agent"}
    annotations = list(store.case_annotations.values())
    assert {a.kind for a in annotations} >= {"role", "group", "tag", "hypothesis", "hypothesis_status", "same_as", "typology"}
    assert any(a.status == "suggested" and a.author_kind == "agent" for a in annotations)

    # Every scenario puts a graph on the canvas from a mapped table, no context involved.
    for inv in seeded:
        graph = await case_graph(inv.id, inv.owner_email)
        assert graph["nodes"], inv.title
    synthetic = next(i for i in seeded if i.kind_preset == "fraude_sintetica")
    types = {n["type"] for n in (await case_graph(synthetic.id, synthetic.owner_email))["nodes"]}
    assert types >= {"Pessoa", "Telefone", "Email", "Dispositivo", "IP", "Cartao", "Terminal", "Endereco"}
    credito = next(i for i in seeded if i.kind_preset == "credito")
    kinds = {(i.kind, i.subkind) for i in items if i.investigation_id == credito.id}
    assert {("query", "sql"), ("document", "brief"), ("table", "csv")} <= kinds

    # The flagship Pix/MED case: the T5 golpe-pix scenario as SIMBA, trace saved and pinned.
    flagship = next(i for i in seeded if i.title.startswith("Golpe Pix · falsa central"))
    assert stats.flagship.endswith(str(flagship.id))
    trace_item = next(i for i in items if i.investigation_id == flagship.id and (i.provenance or {}).get("tool") == "trace")
    data, version, _ = await case_items.get_content(flagship.id, flagship.owner_email, trace_item.id)
    trace = json.loads(data)
    assert version["pinned_at"] and (sorted(trace["exits"].values()), trace["coverage"]) == ([880, 1550, 2000], 0.9097)
    brief = await case_items.get_brief(flagship.id, flagship.owner_email)
    assert brief["item"]["author_kind"] == "agent" and "FIFO" in brief["text"]

    again = await run_seed_investigations("http://testserver", cases=2, reset=True, log=quiet)
    assert again.deleted == 6
    assert len([i for i in store.investigations.values() if MARKER in (i.description or "")]) == 2
