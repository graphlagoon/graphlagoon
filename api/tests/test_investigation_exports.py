"""Exports (05 §7): the package reads the pinned versions and the tables flagged
for the dossier, ``integrity`` recomputes the frozen hash (reproducible, and
tampering with an event or a pinned version is detected), the CSV goes through
``utils.csv_safe`` and every format carries the verification."""

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

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import cases as service  # noqa: E402
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402

OWNER = "owner@example.com"
H = {"X-Forwarded-Email": OWNER}
DECISION = {"outcome_label": "Report", "closes_case": True, "rationale": "Pass-through account."}


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    yield TestClient(app)
    InMemoryStore.reset()
    get_settings.cache_clear()


def _item(client, url, **body):
    r = client.post(f"{url}/items", json=body, headers=H)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def case(client):
    """A case with a pinned document, a table flagged for the dossier and a plain note."""
    r = client.post("/api/investigations", json={"title": "=Mule network"}, headers=H)
    assert r.status_code == 201, r.text
    url = f"/api/investigations/{r.json()['id']}"
    doc = _item(client, url, kind="document", subkind="markdown", title="KYC", content="# KYC\nincome 1800")
    assert client.post(f"{url}/items/{doc['id']}/pin", json={"label": "E1"}, headers=H).status_code == 200
    table = _item(
        client, url, kind="table", subkind="result", title="Exposure by customer", tags=["dossier"],
        content_json={"columns": ["customer", "amount"], "rows": [["1", 10]]},
    )
    _item(client, url, kind="note", subkind="free", content="not pinned")
    return url, doc, table


def _package(client, url):
    r = client.get(f"{url}/export?format=json", headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def _hash_now(url, decision_id):
    import asyncio

    inv = InMemoryStore.get_instance().get_investigation(UUID(url.rsplit("/", 1)[1]))
    return asyncio.run(service.decision_hash(None, inv, decision_id))


def test_package_reads_pinned_versions_and_dossier_tables(client, case):
    url, doc, table = case
    p = _package(client, url)
    assert p["integrity"] == {"decisions": [], "verified": None}  # nothing decided yet
    assert [(e["item_id"], e["pin_label"], e["version"]) for e in p["evidence"]] == [(doc["id"], "E1", 1)]
    [d] = p["dossier"]
    assert (d["item_id"], d["title"], d["version"]) == (table["id"], "Exposure by customer", 1)
    assert d["sha256"] == table["latest"]["sha256"]
    assert len(p["items"]) == 3  # the note is in the record but is neither evidence nor dossier


def test_decision_hashes_are_reproducible_and_tampering_is_detected(client, case):
    url, doc, _ = case
    partial = client.post(f"{url}/decisions", json={**DECISION, "closes_case": False}, headers=H).json()["decisions"][0]
    decided = client.post(f"{url}/decisions", json=DECISION, headers=H).json()
    final = decided["decisions"][1]
    assert decided["frozen_hash"] == final["hash"] != partial["hash"]
    assert _hash_now(url, partial["id"]) == partial["hash"] and _hash_now(url, final["id"]) == final["hash"]
    ok = {"decisions": [{"id": d["id"], "hash": d["hash"], "verified": True} for d in (partial, final)], "verified": True}
    assert _package(client, url)["integrity"] == ok
    # Later journal lines (a share) stay outside the hash.
    assert client.post(f"{url}/share", json={"email": "x@example.com"}, headers=H).status_code == 200
    assert _package(client, url)["integrity"] == ok

    store = InMemoryStore.get_instance()
    event = next(e for e in store.investigation_events.values() if e.kind == "item.pinned")
    original = dict(event.payload)
    event.payload = {**original, "label": "E9"}  # tampered journal: before both decisions
    assert [c["verified"] for c in _package(client, url)["integrity"]["decisions"]] == [False, False]
    event.payload = original
    assert _package(client, url)["integrity"]["verified"] is True

    version = next(v for v in store.case_item_versions.values() if v.item_id == UUID(doc["id"]))
    version.sha256 = "0" * 64  # tampered evidence
    p = _package(client, url)
    assert p["integrity"]["verified"] is False and p["case"]["frozen_hash"] == final["hash"]
    # Formats the platform does not own are report templates, not exports (06 §1).
    assert client.get(f"{url}/export?format=simba", headers=H).status_code == 422


def test_csv_is_formula_safe_and_lists_every_section(client, case):
    url, doc, table = case
    r = client.get(f"{url}/export?format=csv", headers=H)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    text = r.content.decode("utf-8-sig")
    lines = text.split("\r\n")
    assert lines[0] == "section,id,title,kind,sha256,detail,actor,at"
    assert lines[1].startswith(f"case,{url.rsplit('/', 1)[1]},'=Mule network,")  # neutralized formula
    sections = [line.split(",", 1)[0] for line in lines[1:] if line]
    assert {"case", "item", "evidence", "dossier", "event"} <= set(sections)
    dossier = next(line for line in lines if line.startswith("dossier,"))
    assert dossier.startswith(f"dossier,{table['id']},Exposure by customer,v1,{table['latest']['sha256']}")
