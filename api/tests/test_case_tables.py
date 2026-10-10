"""Operations between tables (05 §3, F3): join by key with provenance, compare
two tables or two runs by key, promote in bulk to enrichment or the graph."""

import sys

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

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.app import create_api_router  # noqa: E402
from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware import auth  # noqa: E402
from graphlagoon.services import investigation_storage  # noqa: E402
from graphlagoon.services.blob_storage import LocalBlobStore  # noqa: E402
from graphlagoon.services.case_tables import join_rows, parse_table  # noqa: E402

OWNER = "owner@example.com"
H = {"X-Forwarded-Email": OWNER}


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    InMemoryStore.reset()
    auth._agent_request_times.clear()
    monkeypatch.setattr(investigation_storage, "_store", LocalBlobStore(str(tmp_path)))
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)
    app.include_router(create_api_router())
    client = TestClient(app)
    inv = client.post("/api/investigations", json={"title": "Caso"}, headers=H).json()
    yield client, f"/api/investigations/{inv['id']}"
    InMemoryStore.reset()
    get_settings.cache_clear()


def _table(client, url, title, columns, rows):
    r = client.post(
        f"{url}/items",
        json={"kind": "table", "subkind": "result", "title": title, "content_json": {"columns": columns, "rows": rows}},
        headers=H,
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_parse_and_join_rows_outer_join_with_suffixed_conflicts():
    cols, rows = parse_table(b"cpf;nome\n1;Ana\n2;Bia\n", "text/csv")
    assert (cols, rows) == (["cpf", "nome"], [["1", "Ana"], ["2", "Bia"]])
    out_cols, out_rows = join_rows([("KYC", cols, rows), ("Exposição", ["CPF", "valor", "nome"], [["2", "10", "B."], ["3", "5", "C."]])], "cpf")
    assert out_cols == ["cpf", "nome (KYC)", "valor", "nome (Exposição)"]
    assert out_rows == [["1", "Ana", None, None], ["2", "Bia", "10", "B."], ["3", None, "5", "C."]]


def test_join_creates_a_table_with_parent_provenance(env):
    client, url = env
    kyc = _table(client, url, "KYC", ["cpf", "nome"], [["1", "Ana"], ["2", "Bia"]])
    exp = _table(client, url, "Exposição", ["cpf", "valor"], [["2", 10], ["3", 5]])
    r = client.post(f"{url}/items/join", json={"item_ids": [kyc["id"], exp["id"]]}, headers=H)
    assert r.status_code == 201, r.text
    joined = r.json()
    assert joined["kind"] == "table" and joined["title"] == "KYC + Exposição por cpf"
    assert joined["provenance"] == {"tool": "join", "parent_item_ids": [kyc["id"], exp["id"]], "key_column": "cpf"}
    content = client.get(f"{url}/items/{joined['id']}/content", headers=H).json()
    assert content["columns"] == ["cpf", "nome", "valor"] and content["rows"][1] == ["2", "Bia", 10]
    bad = client.post(f"{url}/items/join", json={"item_ids": [kyc["id"], exp["id"]], "key_column": "zzz"}, headers=H)
    assert bad.status_code == 422 and bad.json()["detail"]["error"]["code"] == "INVALID_TABLE_OP"


def test_compare_two_tables_and_two_runs_by_key(env):
    client, url = env
    a = _table(client, url, "A", ["cpf", "valor"], [["1", 10], ["2", 20], ["3", 30]])
    b = _table(client, url, "B", ["cpf", "valor"], [["2", 20], ["3", 99], ["4", 40]])
    r = client.post(f"{url}/items/compare", json={"left": {"item_id": a["id"]}, "right": {"item_id": b["id"]}}, headers=H)
    assert r.status_code == 200, r.text
    diff = r.json()
    assert diff["key_column"] == "cpf"
    assert diff["counts"] == {"left": 3, "right": 3, "only_left": 1, "only_right": 1, "changed": 1, "same": 1}
    assert diff["changed"] == [{"key": "3", "fields": {"valor": {"left": 30, "right": 99}}}]
    # Two runs of one query: a second version of the same item.
    q = client.post(
        f"{url}/items",
        json={"kind": "query", "subkind": "sql", "title": "Q", "query": {"text": "SELECT 1", "language": "sql"},
              "content_json": {"columns": ["cpf", "v"], "rows": [["1", 1]]}},
        headers=H,
    ).json()
    client.post(f"{url}/items/{q['id']}/versions", json={"content_json": {"columns": ["cpf", "v"], "rows": [["1", 2]]}}, headers=H)
    r = client.post(
        f"{url}/items/compare",
        json={"left": {"item_id": q["id"], "version": 1}, "right": {"item_id": q["id"], "version": 2}},
        headers=H,
    )
    assert r.json()["counts"]["changed"] == 1 and r.json()["left"]["version"] == 1 and r.json()["right"]["version"] == 2


def test_promote_in_bulk_to_enrichment_and_a_run_to_the_graph(env):
    client, url = env
    ids = [_table(client, url, t, ["cpf", f"col_{t}"], [["1", "x"]])["id"] for t in ("T1", "T2", "T3")]
    r = client.post(
        f"{url}/items/promote",
        json={"item_ids": ids, "as": "enrichment", "options": {"key_column": "cpf", "match_node_types": ["Pessoa"]}},
        headers=H,
    )
    assert r.status_code == 200, r.text
    specs = [i["mapping"]["spec"] for i in r.json()]
    assert all(s["key_column"] == "cpf" and s["match_node_types"] == ["Pessoa"] for s in specs)
    assert [s["columns"] for s in specs] == [["col_T1"], ["col_T2"], ["col_T3"]]
    # A query's latest run becomes a table item mapped to the graph and reaches the canvas.
    q = client.post(
        f"{url}/items",
        json={"kind": "query", "subkind": "sql", "title": "Pix", "query": {"text": "SELECT 1", "language": "sql"},
              "content_json": {"columns": ["origem", "destino", "valor"], "rows": [["111", "222", 50]]}},
        headers=H,
    ).json()
    r = client.post(
        f"{url}/items/promote",
        json={"item_ids": [q["id"]], "as": "graph",
              "options": {"source_column": "origem", "target_column": "destino", "source_type": "Conta", "edge_type": "PIX", "amount_prop": "valor"}},
        headers=H,
    )
    assert r.status_code == 200, r.text
    [item] = r.json()
    assert item["kind"] == "table" and item["provenance"]["query_item_id"] == q["id"] and item["mapping"]["as"] == "graph"
    graph = client.get(f"{url}/graph", headers=H).json()
    assert sorted((n["type"], n["uid"].split("@")[0]) for n in graph["nodes"]) == [("Conta", "111"), ("Conta", "222")]
    assert graph["edges"][0]["amount"] == 50.0
