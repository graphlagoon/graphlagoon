"""Tests for GET /api/graph-contexts/{id}/schema-drift (memory-store path)."""

import sys

import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and break
# test_transpile_options (this file is collected before it alphabetically).
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

from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.models.schemas import ColumnInfo, SchemaDiscoveryResponse  # noqa: E402

OWNER = "owner@example.com"


class FakeWarehouse:
    """Stub WarehouseClient — returns preconfigured schemas/discoveries.

    ``table_columns`` maps a bare table name (last dot-segment) to a list of
    (name, data_type) tuples; a table absent from the map, or mapped to None,
    simulates an unreachable/undescribable table.
    """

    def __init__(self, table_columns: dict, discovery: SchemaDiscoveryResponse = None):
        self.table_columns = table_columns
        self.discovery = discovery
        self.discover_calls = 0

    async def get_table_schema(self, table, database=None, catalog=None):
        from graphlagoon.models.schemas import TableSchema

        cols = self.table_columns.get(table)
        if cols is None:
            return TableSchema(
                table_name=table,
                database=database or "db",
                catalog=catalog or "cat",
                columns=[],
            )
        return TableSchema(
            table_name=table,
            database=database or "db",
            catalog=catalog or "cat",
            columns=[ColumnInfo(name=n, data_type=t) for n, t in cols],
        )

    async def discover_schema(self, edge_table, node_table, columns):
        self.discover_calls += 1
        if self.discovery is None:
            raise Exception("discovery failed")
        return self.discovery


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def context(store):
    return store.create_graph_context(
        title="ctx",
        edge_table_name="cat.db.edges",
        node_table_name="cat.db.nodes",
        owner_email=OWNER,
        node_structure={"node_id_col": "node_id", "node_type_col": "node_type"},
        edge_structure={
            "edge_id_col": "edge_id",
            "src_col": "src",
            "dst_col": "dst",
            "relationship_type_col": "relationship_type",
        },
        node_properties=[{"name": "name", "data_type": "string"}],
        edge_properties=[{"name": "weight", "data_type": "double"}],
        node_types=["Person"],
        relationship_types=["KNOWS"],
    )


def make_client(fake_warehouse):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from graphlagoon.routers import graph

    app = FastAPI()
    app.include_router(graph.router)
    app.dependency_overrides[graph.get_warehouse] = lambda: fake_warehouse
    return TestClient(app)


def _headers(email=OWNER):
    return {"X-Forwarded-Email": email}


CLEAN_NODE_COLS = [("node_id", "string"), ("node_type", "string"), ("name", "string")]
CLEAN_EDGE_COLS = [
    ("edge_id", "string"),
    ("src", "string"),
    ("dst", "string"),
    ("relationship_type", "string"),
    ("weight", "double"),
]


class TestSchemaDriftEndpoint:
    def test_clean_context_is_ok(self, context):
        warehouse = FakeWarehouse({"nodes": CLEAN_NODE_COLS, "edges": CLEAN_EDGE_COLS})
        client = make_client(warehouse)
        resp = client.get(
            f"/api/graph-contexts/{context.id}/schema-drift", headers=_headers()
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["findings"] == []
        assert body["types_checked"] is False

    def test_dropped_property_is_error_and_excluded_from_proposed(self, context):
        node_cols = [("node_id", "string"), ("node_type", "string")]  # 'name' dropped
        warehouse = FakeWarehouse({"nodes": node_cols, "edges": CLEAN_EDGE_COLS})
        client = make_client(warehouse)
        resp = client.get(
            f"/api/graph-contexts/{context.id}/schema-drift", headers=_headers()
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "error"
        assert body["counts"]["error"] == 1
        codes = [f["code"] for f in body["findings"]]
        assert "PROPERTY_COLUMN_MISSING" in codes
        proposed_names = [p["name"] for p in body["proposed"]["node_properties"]]
        assert "name" not in proposed_names

    def test_added_column_is_info_and_included_in_proposed(self, context):
        node_cols = CLEAN_NODE_COLS + [("bio", "string")]
        warehouse = FakeWarehouse({"nodes": node_cols, "edges": CLEAN_EDGE_COLS})
        client = make_client(warehouse)
        resp = client.get(
            f"/api/graph-contexts/{context.id}/schema-drift", headers=_headers()
        )
        body = resp.json()
        assert body["status"] == "info"
        codes = [f["code"] for f in body["findings"]]
        assert "PROPERTY_COLUMN_ADDED" in codes
        proposed_names = [p["name"] for p in body["proposed"]["node_properties"]]
        assert "bio" in proposed_names

    def test_check_types_false_never_calls_discovery(self, context):
        warehouse = FakeWarehouse(
            {"nodes": CLEAN_NODE_COLS, "edges": CLEAN_EDGE_COLS},
            discovery=SchemaDiscoveryResponse(
                node_types=["Person"], relationship_types=["KNOWS"]
            ),
        )
        client = make_client(warehouse)
        client.get(
            f"/api/graph-contexts/{context.id}/schema-drift?check_types=false",
            headers=_headers(),
        )
        assert warehouse.discover_calls == 0

    def test_check_types_true_invokes_discovery_once_and_surfaces_types(self, context):
        warehouse = FakeWarehouse(
            {"nodes": CLEAN_NODE_COLS, "edges": CLEAN_EDGE_COLS},
            discovery=SchemaDiscoveryResponse(
                node_types=["Person", "Company"], relationship_types=["KNOWS"]
            ),
        )
        client = make_client(warehouse)
        resp = client.get(
            f"/api/graph-contexts/{context.id}/schema-drift?check_types=true",
            headers=_headers(),
        )
        body = resp.json()
        assert warehouse.discover_calls == 1
        assert body["types_checked"] is True
        codes = [f["code"] for f in body["findings"]]
        assert "TYPE_VALUE_ADDED" in codes
        assert body["proposed"]["node_types"] == ["Person", "Company"]

    def test_unreachable_table_returns_200_with_table_not_found(self, context):
        warehouse = FakeWarehouse(
            {"edges": CLEAN_EDGE_COLS}
        )  # 'nodes' absent -> unreachable
        client = make_client(warehouse)
        resp = client.get(
            f"/api/graph-contexts/{context.id}/schema-drift", headers=_headers()
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "error"
        table_not_found = [
            f for f in body["findings"] if f["code"] == "TABLE_NOT_FOUND"
        ]
        assert len(table_not_found) == 1
        assert table_not_found[0]["side"] == "node"
        assert body["node_table"]["reachable"] is False

    def test_unknown_context_404(self):
        import uuid

        warehouse = FakeWarehouse({})
        client = make_client(warehouse)
        resp = client.get(
            f"/api/graph-contexts/{uuid.uuid4()}/schema-drift", headers=_headers()
        )
        assert resp.status_code == 404

    def test_discovery_failure_does_not_hide_column_findings(self, context):
        """Type discovery is best-effort — a failed discovery must not mask the
        (more actionable) column-level findings the DESCRIBE calls already found."""
        node_cols = [("node_id", "string"), ("node_type", "string")]  # 'name' dropped
        warehouse = FakeWarehouse(
            {"nodes": node_cols, "edges": CLEAN_EDGE_COLS}, discovery=None
        )
        client = make_client(warehouse)
        resp = client.get(
            f"/api/graph-contexts/{context.id}/schema-drift?check_types=true",
            headers=_headers(),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["types_checked"] is False
        codes = [f["code"] for f in body["findings"]]
        assert "PROPERTY_COLUMN_MISSING" in codes
