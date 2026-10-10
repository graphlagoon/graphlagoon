"""Decision, freeze and retention (F4.5): live sources frozen, a reproducible
frozen_hash, every mutation refused afterwards, retention on delete."""

import sys
from datetime import datetime, timedelta
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

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services import investigations as service  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"
READER = "reader@example.com"


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def ctx(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    store = InMemoryStore.get_instance()
    gc = store.create_graph_context("Pix", "e", "n", OWNER)
    exp = store.create_exploration(gc.id, "Contas mula", OWNER, {"nodes": []})
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)
    url = "/api/investigations/" + client.post(
        "/api/investigations", json={"title": "Golpe Pix"}, headers=h(OWNER)
    ).json()["id"]
    client.post(f"{url}/share", json={"email": READER}, headers=h(OWNER))
    r = client.post(f"{url}/sources", json={"exploration_id": str(exp.id)}, headers=h(OWNER))
    assert r.json()["mode"] == "live"
    client.post(
        f"{url}/evidence",
        json={"title": "KYC", "kind": "table", "params": {}, "snapshot": [{"a": 1}]},
        headers=h(OWNER),
    )
    yield client, url, store
    InMemoryStore.reset()
    get_settings.cache_clear()


DECISION = {"outcome": "comunicar", "actions": ["dict", "spa"], "rationale": "Conta de passagem."}


def _hash_now(store, url):
    import asyncio

    inv = store.get_investigation(UUID(url.rsplit("/", 1)[1]))
    return asyncio.run(service.compute_frozen_hash(None, inv))


def test_decision_freezes_sources_and_hash_is_reproducible(ctx):
    client, url, store = ctx
    assert client.post(f"{url}/decision", json=DECISION, headers=h(READER)).status_code == 403
    assert client.post(
        f"{url}/decision", json={**DECISION, "rationale": "  "}, headers=h(OWNER)
    ).status_code == 422

    r = client.post(f"{url}/decision", json=DECISION, headers=h(OWNER))
    assert r.status_code == 200, r.text
    inv = r.json()
    assert inv["status"] == "decidido" and inv["decision"]["decided_by"] == OWNER
    assert inv["decision"]["actions"] == ["dict", "spa"] and inv["frozen_at"]
    sources = client.get(f"{url}/sources", headers=h(OWNER)).json()
    assert [s["mode"] for s in sources] == ["frozen"] and sources[0]["frozen_sha256"]
    events = client.get(f"{url}/events", headers=h(OWNER)).json()
    assert events[-1]["kind"] == "decision.recorded"
    assert events[-1]["payload"]["frozen_sources"][0]["sha256"] == sources[0]["frozen_sha256"]

    # Reproducible: recomputing gives the stored hash, also after a later share
    # (journaled after the freeze point, so outside the hash).
    assert _hash_now(store, url) == inv["frozen_hash"]
    assert client.post(f"{url}/share", json={"email": "x@example.com"}, headers=h(OWNER)).status_code == 200
    assert _hash_now(store, url) == inv["frozen_hash"]
    # Tampering with frozen content is detected.
    row = store.list_investigation_children("investigation_evidence", UUID(url.rsplit("/", 1)[1]))[0]
    row.sha256 = "0" * 64
    assert _hash_now(store, url) != inv["frozen_hash"]

    actions = [e.action for e in store.usage_logs]
    assert "investigation.decide" in actions


def test_no_mutation_after_the_decision(ctx):
    client, url, store = ctx
    client.post(f"{url}/decision", json=DECISION, headers=h(OWNER))
    hyp = {"text": "x"}
    attempts = [
        ("patch", url, {"title": "y"}),
        ("patch", f"{url}/state", {"roles": {"n1": "mule"}}),
        ("post", f"{url}/notes", {"anchor": {"kind": "none"}, "body": "x"}),
        ("post", f"{url}/events", {"kind": "trace.run", "payload": {}}),
        ("post", f"{url}/evidence", {"title": "t", "kind": "table", "params": {}, "snapshot": []}),
        ("post", f"{url}/hypotheses", hyp),
        ("post", f"{url}/proposals", {"kind": "status", "payload": {"status": "analise"}, "rationale": "r"}),
        ("post", f"{url}/decision", DECISION),
        ("delete", url, None),
    ]
    for method, path, body in attempts:
        kwargs = {"json": body} if body is not None else {}
        r = getattr(client, method)(path, headers=h(OWNER), **kwargs)
        assert r.status_code == 409, (method, path, r.status_code, r.text)
    sid = client.get(f"{url}/sources", headers=h(OWNER)).json()[0]["id"]
    assert client.delete(f"{url}/sources/{sid}", headers=h(OWNER)).status_code == 409


def test_retention_lets_the_owner_delete_only_after_the_retention_years(ctx, monkeypatch):
    client, url, store = ctx
    client.post(f"{url}/decision", json=DECISION, headers=h(OWNER))
    assert client.delete(url, headers=h(OWNER)).status_code == 409
    later = datetime.now() + timedelta(days=365 * 11)
    monkeypatch.setattr(service, "_clock", lambda: later)
    assert client.delete(url, headers=h(OWNER)).status_code == 200
