"""Frozen evidence (F4.1): gz + sha256 covering params and author, immutable."""

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

import asyncio  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.routers import investigations  # noqa: E402
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

OWNER = "owner@example.com"
READER = "reader@example.com"
METHOD = {"direction": "forward", "allocation": "fifo", "maxHops": 3, "seedEdgeIds": ["s:e2"]}


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    blob = LocalBlobStore(str(tmp_path))
    monkeypatch.setattr(investigation_storage, "_store", blob)
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(investigations.router)
    client = TestClient(app)
    inv = client.post("/api/investigations", json={"title": "Pix"}, headers=h(OWNER)).json()
    client.post(
        f"/api/investigations/{inv['id']}/share",
        json={"email": READER, "permission": "read"},
        headers=h(OWNER),
    )
    yield client, f"/api/investigations/{inv['id']}", blob
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_evidence_freezes_snapshot_params_and_author_under_its_hash(env):
    client, url, blob = env
    body = {"title": "E1 · Trace FIFO", "kind": "trace", "params": METHOD,
            "snapshot": {"exits": {"saque": 2000}}}
    assert client.post(f"{url}/evidence", json=body, headers=h(READER)).status_code == 403
    r = client.post(f"{url}/evidence", json=body, headers=h(OWNER))
    assert r.status_code == 201, r.text
    ev = r.json()
    assert ev["created_by"] == OWNER and ev["params"] == METHOD

    # The stored gz is what the hash covers: snapshot, params and author together.
    raw = blob._base.joinpath(url.rsplit("/", 1)[1], "evidence", f"{ev['id']}.json.gz").read_bytes()
    assert hashlib.sha256(raw).hexdigest() == ev["sha256"]
    doc = json.loads(gzip.decompress(raw))
    assert (doc["snapshot"], doc["params"], doc["created_by"]) == (body["snapshot"], METHOD, OWNER)

    got = client.get(f"{url}/evidence/{ev['id']}", headers=h(READER)).json()
    assert got["snapshot"] == body["snapshot"] and got["sha256"] == ev["sha256"]
    assert [e["id"] for e in client.get(f"{url}/evidence", headers=h(READER)).json()] == [ev["id"]]
    events = client.get(f"{url}/events", headers=h(OWNER)).json()
    assert events[-1]["kind"] == "evidence.created"
    assert events[-1]["payload"]["sha256"] == ev["sha256"]


def test_evidence_is_immutable(env):
    client, url, blob = env
    body = {"title": "E1", "kind": "graph_state", "snapshot": {"nodes": []}}
    ev = client.post(f"{url}/evidence", json=body, headers=h(OWNER)).json()
    item = f"{url}/evidence/{ev['id']}"
    for method in (client.put, client.patch):
        assert method(item, json=body, headers=h(OWNER)).status_code == 405
    assert client.delete(item, headers=h(OWNER)).status_code == 405

    # The blob is written once; a tampered copy is refused on read.
    key = investigation_storage.evidence_key(url.rsplit("/", 1)[1], ev["id"])
    with pytest.raises(FileExistsError):
        asyncio.run(investigation_storage.save_new(key, b"other"))
    asyncio.run(blob.save(key, gzip.compress(b'{"snapshot": "forged"}')))
    r = client.get(item, headers=h(OWNER))
    assert r.json()["detail"]["error"]["code"] == "EVIDENCE_HASH_MISMATCH"
