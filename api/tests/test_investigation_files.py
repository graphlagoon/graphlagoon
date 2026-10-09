"""Case files (F2.3): sha256 computed on the server, content-addressed blob
reused, 413 above the limit, upload and content reads audited."""

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


def test_upload_hashes_lists_and_audits(ctx):
    client, url, root = ctx
    data = b"CODIGO\tVALOR\n1\t1000\n" * 50
    up = lambda name, role="graph": client.post(  # noqa: E731
        f"{url}/files",
        content=data,
        params={"filename": name, "role": role},
        headers={**h(OWNER), "Content-Type": "application/octet-stream"},
    )
    r = up("1_EXTRATO.TXT")
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["sha256"] == hashlib.sha256(data).hexdigest()
    assert f["size_bytes"] == len(data) and f["role"] == "graph"
    assert "blob_key" not in r.text

    # Same bytes again: a second row, the same blob on disk (never overwritten).
    assert up("copia.txt", "attachment").status_code == 201
    assert len([p for p in root.rglob("*") if p.is_file()]) == 1
    assert up("x.txt", "evidence").status_code == 422

    listed = client.get(f"{url}/files", headers=h(READER)).json()
    assert [x["filename"] for x in listed] == ["copia.txt", "1_EXTRATO.TXT"]
    content = client.get(f"{url}/files/{f['id']}/content", headers=h(READER))
    assert content.content == data
    assert content.headers["content-disposition"].startswith("attachment")
    # A read share may read files but not upload them.
    denied = client.post(
        f"{url}/files", content=b"x", params={"filename": "a.csv", "role": "graph"},
        headers=h(READER),
    )
    assert denied.status_code == 403

    actions = [e.action for e in InMemoryStore.get_instance().usage_logs]
    assert actions.count("investigation.file_upload") == 2
    assert actions.count("investigation.file_read") == 1
    kinds = [e["kind"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()]
    assert kinds.count("file.uploaded") == 2


def test_upload_over_the_limit_is_413(ctx, monkeypatch):
    client, url, root = ctx
    monkeypatch.setenv("GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES", "10")
    get_settings.cache_clear()
    r = client.post(
        f"{url}/files", content=b"x" * 11, params={"filename": "a.csv", "role": "graph"},
        headers=h(OWNER),
    )
    assert r.status_code == 413
    assert r.json()["detail"]["error"]["code"] == "FILE_TOO_LARGE"
    assert not [p for p in root.rglob("*") if p.is_file()]


# -- F2.5 file graph, F2.6 enrichment mapping --------------------------------

from pathlib import Path  # noqa: E402

from graphlagoon.services import snapshot  # noqa: E402
from graphlagoon.services.file_mapping_presets import SIMBA_V31  # noqa: E402
from graphlagoon.services.snapshot import LocalSnapshotService  # noqa: E402

SIMBA = Path(__file__).resolve().parents[2] / "frontend/src/__tests__/fixtures/fileMapping/simba-mini"


def _simba_upload(client, url):
    ids = []
    for p in sorted(SIMBA.glob("*.TXT")):
        r = client.post(
            f"{url}/files", content=p.read_bytes(),
            params={"filename": p.name, "role": "graph"}, headers=h(OWNER),
        )
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    return ids


@pytest.fixture
def snaps(monkeypatch, tmp_path):
    svc = LocalSnapshotService(str(tmp_path / "snaps"))
    monkeypatch.setattr(snapshot, "get_snapshot_service", lambda: svc)


def test_simba_file_becomes_a_case_source(ctx, snaps):
    if not SIMBA.is_dir():
        pytest.skip("frontend fixtures not checked out")
    client, url, _ = ctx
    first, *rest = _simba_upload(client, url)
    r = client.post(
        f"{url}/files/{first}/context",
        json={"mapping": SIMBA_V31, "file_ids": rest, "title": "Quebra CASO1"},
        headers=h(OWNER),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["source"]["kind"] == "file" and body["source"]["accessible"]
    assert body["report"]["truncated_edges"] == 0
    assert body["file"]["context_id"] == body["context_id"]

    ctx_json = client.get(f"/api/graph-contexts/{body['context_id']}", headers=h(OWNER)).json()
    assert ctx_json["datasource_type"] == "file"
    assert {k["node_type"] for k in ctx_json["identity_keys"]} == {"Conta", "Pessoa"}

    snap = client.get(
        f"{url}/sources/{body['source']['id']}/snapshot", headers=h(OWNER)
    ).json()["snapshot"]
    assert any(n["type"] == "Desconhecido" for n in snap["nodes"])
    assert len(snap["edges"]) > 0

    # The file datasource: no query language, expand walks the stored graph.
    gc = f"/api/graph-contexts/{body['context_id']}"
    assert client.post(f"{gc}/cypher", json={"query": "MATCH (a)-[r]->(b) RETURN a,r,b"},
                       headers=h(OWNER)).status_code == 400
    exp = client.post(f"{gc}/expand", json={"node_id": "1-1-12345", "depth": 1},
                      headers=h(OWNER)).json()
    assert len(exp["edges"]) > 0

    kinds = [e["kind"] for e in client.get(f"{url}/events", headers=h(OWNER)).json()]
    assert "source.added" in kinds
    # Already generated; a reader may not generate.
    assert client.post(f"{url}/files/{first}/context", json={"mapping": SIMBA_V31},
                       headers=h(OWNER)).status_code == 409
    assert client.post(f"{url}/files/{first}/context", json={"mapping": SIMBA_V31},
                       headers=h(READER)).status_code == 403
    # The public create route never makes a file context.
    assert client.post("/api/graph-contexts", json={"title": "x", "datasource_type": "file"},
                       headers=h(OWNER)).status_code == 422


def test_file_graph_is_capped_at_max_working_edges(ctx, snaps, monkeypatch):
    if not SIMBA.is_dir():
        pytest.skip("frontend fixtures not checked out")
    client, url, _ = ctx
    monkeypatch.setenv("GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES", "2")
    get_settings.cache_clear()
    first, *rest = _simba_upload(client, url)
    body = client.post(
        f"{url}/files/{first}/context",
        json={"mapping": SIMBA_V31, "file_ids": rest}, headers=h(OWNER),
    ).json()
    assert body["report"]["truncated_edges"] > 0
    snap = client.get(
        f"{url}/sources/{body['source']['id']}/snapshot", headers=h(OWNER)
    ).json()["snapshot"]
    assert len(snap["edges"]) == 2


def test_enrichment_file_mapping(ctx):
    client, url, _ = ctx
    f = client.post(
        f"{url}/files", content=b'"12345678";"2";"ANA"\n',
        params={"filename": "qsa.csv", "role": "enrichment"}, headers=h(OWNER),
    ).json()
    spec = {
        "name": "QSA",
        "input": {"delimiter": ";", "header": False, "columns": ["CNPJ_BASICO", "ID", "NOME"]},
        "key_column": "CNPJ_BASICO", "columns": ["NOME"],
        "match_node_types": ["Lojista"], "match_source": {"kind": "prop", "name": "cnpj"},
        "key_digits": 8,
    }
    r = client.patch(f"{url}/files/{f['id']}", json={"mapping": spec}, headers=h(OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["mapping"]["key_digits"] == 8
    bad = {**spec, "columns": ["NOPE"]}
    r = client.patch(f"{url}/files/{f['id']}", json={"mapping": bad}, headers=h(OWNER))
    assert r.status_code == 422
    assert client.patch(f"{url}/files/{f['id']}", json={"mapping": spec},
                        headers=h(READER)).status_code == 403
    # F2.6: the enrichment file stays in the case.
    stranger = h("stranger@example.com")
    assert client.get(f"{url}/files", headers=stranger).status_code == 404
    assert client.get(f"{url}/files/{f['id']}/content", headers=stranger).status_code == 404
