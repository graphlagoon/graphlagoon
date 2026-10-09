"""Enrichment tables on graph contexts and their lookup (investigations F2.1)."""

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
from pydantic import ValidationError  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.models.schemas import (  # noqa: E402
    GraphContextUpdate,
    StatementResponse,
)
from graphlagoon.routers import graph_contexts  # noqa: E402
from graphlagoon.services import enrichment  # noqa: E402

OWNER = "owner@example.com"
WRITER = "writer@example.com"
READER = "reader@example.com"
DEVICES = {
    "name": "devices",
    "label": "Dispositivos",
    "table": "main.graphs.devices",
    "key_column": "account_id",
    "match_node_types": ["Conta"],
    "cardinality": "many",
    "columns": ["device_id", "ip"],
    "promote": {"node_type": "Dispositivo", "id_column": "device_id", "edge_type": "USOU"},
}


class TestValidation:
    @pytest.mark.parametrize(
        "change",
        [
            {"name": "Bad Name"},
            {"table": "main.graphs.devices; DROP TABLE x"},
            {"table": "devices"},
            {"columns": ["ip`, secret"]},
            {"columns": []},
            {"key_column": "a b"},
            {"promote": {"node_type": "D", "id_column": "other", "edge_type": "E"}},
        ],
    )
    def test_rejects(self, change):
        with pytest.raises(ValidationError):
            GraphContextUpdate(enrichment_tables=[{**DEVICES, **change}])

    def test_rejects_duplicate_names(self):
        with pytest.raises(ValidationError):
            GraphContextUpdate(enrichment_tables=[DEVICES, DEVICES])


class TestQuery:
    def test_identifiers_quoted_and_keys_parameterized(self):
        sql, params = enrichment.build_query(DEVICES, ["1' OR '1'='1", "2"], 11)
        assert sql == (
            "SELECT `account_id`, `device_id`, `ip` FROM `main`.`graphs`.`devices` "
            "WHERE `account_id` IN (:k0, :k1) LIMIT 11"
        )
        assert params[0] == {"name": "k0", "value": "1' OR '1'='1", "type": "STRING"}

    @pytest.mark.parametrize("keys", [[], [""], [{"a": 1}], ["x" * 201], [True]])
    def test_malformed_keys(self, keys):
        with pytest.raises(enrichment.EnrichmentError) as exc:
            enrichment.clean_keys(keys)
        assert exc.value.code == "INVALID_KEY"

    def test_key_limit(self, monkeypatch):
        monkeypatch.setenv("GRAPH_LAGOON_ENRICHMENT_MAX_KEYS", "2")
        get_settings.cache_clear()
        try:
            assert enrichment.clean_keys(["a", "a", "b"]) == ["a", "b"]
            with pytest.raises(enrichment.EnrichmentError) as exc:
                enrichment.clean_keys(["a", "b", "c"])
            assert exc.value.code == "TOO_MANY_KEYS"
        finally:
            get_settings.cache_clear()


class _Warehouse:
    """Answers with an extra undeclared column, which must not leave."""

    def __init__(self):
        self.calls = []

    async def execute_statement(self, statement, parameters=None, **_):
        self.calls.append((statement, parameters))
        rows = [["1", "d1", "10.0.0.1", "s3cr3t"], ["1", "d2", "10.0.0.2", "x"]]
        rows += [["2", "d3", "10.0.0.3", "y"]]
        names = ["account_id", "device_id", "ip", "password"]
        return StatementResponse(
            statement_id="s",
            status={"state": "SUCCEEDED"},
            manifest={
                "schema": {
                    "column_count": 4,
                    "columns": [
                        {"name": n, "type_name": "STRING", "type_text": "STRING", "position": i}
                        for i, n in enumerate(names)
                    ],
                },
                "total_row_count": len(rows),
            },
            result={"data_array": rows},
        )


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_CATALOG_SCHEMAS", "main.graphs")
    get_settings.cache_clear()
    InMemoryStore.reset()
    store = InMemoryStore.get_instance()
    warehouse = _Warehouse()
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(graph_contexts.router)
    app.dependency_overrides[graph_contexts.get_warehouse] = lambda: warehouse
    yield TestClient(app), store, warehouse
    InMemoryStore.reset()
    get_settings.cache_clear()


def _h(email):
    return {"X-Forwarded-Email": email}


def _restrict_context_create_to(store, *emails):
    group = store.create_group(
        "authors", members=[{"kind": "email", "value": e} for e in emails]
    )
    store.set_permission(
        "context.create", "restricted", [{"group_id": group.id, "effect": "allow"}]
    )


def test_writer_without_context_create_cannot_attach_but_can_remove(env):
    client, store, _ = env
    _restrict_context_create_to(store, OWNER)
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[DEVICES]
    )
    store.share_graph_context(ctx.id, WRITER, "write")
    url = f"/api/graph-contexts/{ctx.id}"
    added = [DEVICES, {**DEVICES, "name": "kyc"}]
    r = client.put(url, json={"enrichment_tables": added}, headers=_h(WRITER))
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "PERMISSION_DENIED"
    # Saving the context unchanged, or removing a table, needs no author.
    r = client.put(url, json={"enrichment_tables": [DEVICES]}, headers=_h(WRITER))
    assert r.status_code == 200, r.text
    r = client.put(url, json={"enrichment_tables": []}, headers=_h(WRITER))
    assert r.status_code == 200 and r.json()["enrichment_tables"] == []


def test_author_limited_to_the_allowlist(env):
    client, store, _ = env
    ctx = store.create_graph_context("pix", "main.graphs.e", "main.graphs.n", OWNER)
    url = f"/api/graph-contexts/{ctx.id}"
    outside = {**DEVICES, "table": "hr.private.salaries"}
    r = client.put(url, json={"enrichment_tables": [outside]}, headers=_h(OWNER))
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_SCOPE_DENIED"
    r = client.put(url, json={"enrichment_tables": [DEVICES]}, headers=_h(OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["enrichment_tables"][0]["promote"]["node_type"] == "Dispositivo"


def test_reader_without_context_create_looks_up_declared_columns_only(env):
    client, store, warehouse = env
    _restrict_context_create_to(store, OWNER)
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[DEVICES]
    )
    store.share_graph_context(ctx.id, READER, "read")
    url = f"/api/graph-contexts/{ctx.id}/enrichment/devices/lookup"
    r = client.post(url, json={"keys": ["1", "2"]}, headers=_h(READER))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows"]["1"] == [
        {"device_id": "d1", "ip": "10.0.0.1"},
        {"device_id": "d2", "ip": "10.0.0.2"},
    ]
    assert "s3cr3t" not in r.text and body["truncated"] is False
    assert warehouse.calls[0][1][1]["value"] == "2"
    entries = [e for e in store.usage_logs if e.action == "enrichment.read"]
    assert entries[0].log_metadata["rows"] == 3
    # Unknown table, and someone without access to the context.
    missing = f"/api/graph-contexts/{ctx.id}/enrichment/nope/lookup"
    assert client.post(missing, json={"keys": ["1"]}, headers=_h(READER)).status_code == 404
    assert client.post(url, json={"keys": ["1"]}, headers=_h(WRITER)).status_code == 403


def test_row_limit_truncates(env, monkeypatch):
    client, store, _ = env
    monkeypatch.setenv("GRAPH_LAGOON_ENRICHMENT_MAX_ROWS", "2")
    get_settings.cache_clear()
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[DEVICES]
    )
    url = f"/api/graph-contexts/{ctx.id}/enrichment/devices/lookup"
    body = client.post(url, json={"keys": ["1", "2"]}, headers=_h(OWNER)).json()
    assert body["truncated"] is True and "2" not in body["rows"]
