"""Tests for validate_context_tables and its wiring into create/update
graph-context endpoints (memory-store path)."""

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
from graphlagoon.services.schema_drift import (  # noqa: E402
    ContextValidationError,
    validate_context_tables,
)

OWNER = "owner@example.com"


class FakeWarehouse:
    def __init__(self, table_columns: dict, raise_on: set = frozenset()):
        self.table_columns = table_columns
        self.raise_on = raise_on

    async def get_table_schema(self, table, database=None, catalog=None):
        from graphlagoon.models.schemas import ColumnInfo, TableSchema

        if table in self.raise_on:
            raise Exception("connection refused")
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


NODE_STRUCTURE = {"node_id_col": "node_id", "node_type_col": "node_type"}
EDGE_STRUCTURE = {
    "edge_id_col": "edge_id",
    "src_col": "src",
    "dst_col": "dst",
    "relationship_type_col": "relationship_type",
}
CLEAN_NODE_COLS = [("node_id", "string"), ("node_type", "string")]
CLEAN_EDGE_COLS = [
    ("edge_id", "string"),
    ("src", "string"),
    ("dst", "string"),
    ("relationship_type", "string"),
]


class TestValidateContextTables:
    @pytest.mark.asyncio
    async def test_malformed_table_name_raises_table_invalid(self):
        warehouse = FakeWarehouse({})
        with pytest.raises(ContextValidationError) as exc_info:
            await validate_context_tables(
                warehouse,
                "not_a_valid_name",
                "cat.db.edges",
                NODE_STRUCTURE,
                EDGE_STRUCTURE,
            )
        assert exc_info.value.code == "CONTEXT_TABLE_INVALID"

    @pytest.mark.asyncio
    async def test_clean_tables_pass(self):
        warehouse = FakeWarehouse({"nodes": CLEAN_NODE_COLS, "edges": CLEAN_EDGE_COLS})
        await validate_context_tables(
            warehouse,
            "cat.db.nodes",
            "cat.db.edges",
            NODE_STRUCTURE,
            EDGE_STRUCTURE,
        )  # must not raise

    @pytest.mark.asyncio
    async def test_missing_structural_column_raises_structure_invalid(self):
        node_cols = [("node_id", "string")]  # node_type missing
        warehouse = FakeWarehouse({"nodes": node_cols, "edges": CLEAN_EDGE_COLS})
        with pytest.raises(ContextValidationError) as exc_info:
            await validate_context_tables(
                warehouse,
                "cat.db.nodes",
                "cat.db.edges",
                NODE_STRUCTURE,
                EDGE_STRUCTURE,
            )
        assert exc_info.value.code == "CONTEXT_STRUCTURE_INVALID"
        missing = exc_info.value.details["missing_columns"]
        assert any(m["column"] == "node_type" for m in missing)

    @pytest.mark.asyncio
    async def test_unreachable_table_skips_validation_not_failure(self):
        """A warehouse that can't describe a table must never lock out an edit."""
        warehouse = FakeWarehouse({"edges": CLEAN_EDGE_COLS}, raise_on={"nodes"})
        await validate_context_tables(
            warehouse, "cat.db.nodes", "cat.db.edges", NODE_STRUCTURE, EDGE_STRUCTURE
        )  # must not raise

    @pytest.mark.asyncio
    async def test_no_structure_provided_skips_column_check(self):
        warehouse = FakeWarehouse({})  # tables would fail if checked
        await validate_context_tables(
            warehouse, "cat.db.nodes", "cat.db.edges", None, None
        )  # must not raise -- only table-name shape is checked

    @pytest.mark.asyncio
    async def test_empty_structural_value_is_not_checked(self):
        """An empty edge_id_col ('' = no edge id column) is a legitimate value,
        not a missing column."""
        warehouse = FakeWarehouse({"nodes": CLEAN_NODE_COLS, "edges": CLEAN_EDGE_COLS})
        edge_structure = {**EDGE_STRUCTURE, "edge_id_col": ""}
        await validate_context_tables(
            warehouse, "cat.db.nodes", "cat.db.edges", NODE_STRUCTURE, edge_structure
        )  # must not raise


# --- Router wiring (memory-store path) --------------------------------------


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


def make_client(fake_warehouse):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from graphlagoon.routers import graph_contexts

    app = FastAPI()
    app.include_router(graph_contexts.router)
    app.dependency_overrides[graph_contexts.get_warehouse] = lambda: fake_warehouse
    return TestClient(app)


def _headers(email=OWNER):
    return {"X-Forwarded-Email": email}


class TestCreateEndpointValidation:
    def test_create_rejects_missing_structural_column(self):
        node_cols = [("node_id", "string")]  # node_type missing
        warehouse = FakeWarehouse({"nodes": node_cols, "edges": CLEAN_EDGE_COLS})
        client = make_client(warehouse)
        resp = client.post(
            "/api/graph-contexts",
            json={
                "title": "ctx",
                "edge_table_name": "cat.db.edges",
                "node_table_name": "cat.db.nodes",
            },
            headers=_headers(),
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "CONTEXT_STRUCTURE_INVALID"

    def test_create_succeeds_with_clean_tables(self):
        warehouse = FakeWarehouse({"nodes": CLEAN_NODE_COLS, "edges": CLEAN_EDGE_COLS})
        client = make_client(warehouse)
        resp = client.post(
            "/api/graph-contexts",
            json={
                "title": "ctx",
                "edge_table_name": "cat.db.edges",
                "node_table_name": "cat.db.nodes",
            },
            headers=_headers(),
        )
        assert resp.status_code == 200

    def test_create_succeeds_when_warehouse_unreachable(self):
        """Never lock the user out of creating a context because the
        warehouse happens to be down."""
        warehouse = FakeWarehouse({}, raise_on={"nodes", "edges"})
        client = make_client(warehouse)
        resp = client.post(
            "/api/graph-contexts",
            json={
                "title": "ctx",
                "edge_table_name": "cat.db.edges",
                "node_table_name": "cat.db.nodes",
            },
            headers=_headers(),
        )
        assert resp.status_code == 200


class TestUpdateEndpointValidation:
    @pytest.fixture
    def context(self, store):
        return store.create_graph_context(
            title="ctx",
            edge_table_name="cat.db.edges",
            node_table_name="cat.db.nodes",
            owner_email=OWNER,
            node_structure=NODE_STRUCTURE,
            edge_structure=EDGE_STRUCTURE,
        )

    def test_update_without_structure_skips_validation_entirely(self, context):
        """A cluster_programs-only PUT (the real production writer today) must
        never trigger a warehouse round-trip."""
        warehouse = FakeWarehouse({}, raise_on={"nodes", "edges"})
        client = make_client(warehouse)
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"cluster_programs": []},
            headers=_headers(),
        )
        assert resp.status_code == 200

    def test_update_rejects_structure_referencing_missing_column(self, context):
        warehouse = FakeWarehouse({"nodes": CLEAN_NODE_COLS, "edges": CLEAN_EDGE_COLS})
        client = make_client(warehouse)
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={
                "node_structure": {"node_id_col": "node_id", "node_type_col": "gone"}
            },
            headers=_headers(),
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "CONTEXT_STRUCTURE_INVALID"

    def test_update_validates_effective_structure_against_stored_when_only_edge_changes(
        self, context
    ):
        """Changing only edge_structure must still validate node_structure (the
        unchanged, stored one) against the existing node table."""
        node_cols_missing_type = [
            ("node_id", "string")
        ]  # stored node_type_col now gone
        warehouse = FakeWarehouse(
            {"nodes": node_cols_missing_type, "edges": CLEAN_EDGE_COLS}
        )
        client = make_client(warehouse)
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"edge_structure": EDGE_STRUCTURE},
            headers=_headers(),
        )
        assert resp.status_code == 400
        missing = resp.json()["detail"]["error"]["details"]["missing_columns"]
        assert any(m["side"] == "node" for m in missing)
