"""Tests for nodeless (triple-store-only) sql_warehouse contexts.

A context may have only an edge/triple table and no node table
(``node_table_name=None``). The backend then derives a virtual node table
(node_id + constant 'Node' type) from the edge endpoints and substitutes it
everywhere the node table name used to be interpolated. These tests cover the
derivation helper, the validators, the datasource threading and the drift
skip. Transpiler coverage for the nodeless branch lives in
test_cypher_schema_provider.py (it needs the real gsql2rsql).
"""

import sys
from types import SimpleNamespace

import pytest

# Stub gsql2rsql package tree so graphlagoon modules can be imported without
# the transpiler dependency. Only stub when the real package is genuinely
# unavailable — stubbing while it IS installed poisons the import for
# test_transpile_options (see the same note in test_graph_error_handling.py).
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
        "gsql2rsql.common.exceptions",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from graphlagoon.models.schemas import (  # noqa: E402
    ColumnConfig,
    ExpandRequest,
    GraphContextCreate,
    SchemaDiscoveryRequest,
)
from graphlagoon.services.graph_operations import (  # noqa: E402
    build_node_query,
    derived_node_table_sql,
    merge_column_config,
    resolve_node_table,
)
from graphlagoon.services.schema_drift import compute_drift  # noqa: E402


def make_context(**overrides):
    """Fake context shaped like GraphContext/MemoryGraphContext."""
    base = dict(
        node_table_name=None,
        edge_table_name="cat.sch.triples",
        node_structure={"node_id_col": "node_id", "node_type_col": "node_type"},
        edge_structure={
            "edge_id_col": "",
            "src_col": "src",
            "dst_col": "dst",
            "relationship_type_col": "relationship_type",
        },
        node_properties=[],
        edge_properties=[],
        node_types=["Node"],
        relationship_types=["KNOWS"],
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class TestDerivedNodeTableSql:
    def test_default_columns(self):
        config = ColumnConfig()
        sql = derived_node_table_sql("cat.sch.triples", config)
        assert sql.startswith("(") and sql.endswith(")")
        assert "SELECT node_id AS `node_id`, 'Node' AS `node_type`" in sql
        assert "SELECT `src` AS node_id FROM cat.sch.triples" in sql
        assert "UNION" in sql
        assert "SELECT `dst` AS node_id FROM cat.sch.triples" in sql

    def test_custom_column_names(self):
        config = ColumnConfig(
            src_col="from_id",
            dst_col="to_id",
            node_id_col="vertex_id",
            node_type_col="vertex_type",
        )
        sql = derived_node_table_sql("db.edges", config)
        assert "AS `vertex_id`" in sql
        assert "'Node' AS `vertex_type`" in sql
        assert "`from_id` AS node_id" in sql
        assert "`to_id` AS node_id" in sql

    def test_no_trailing_alias(self):
        """Call sites append their own alias (``FROM {t} n``) — the fragment
        must end at the closing parenthesis."""
        sql = derived_node_table_sql("db.edges", ColumnConfig())
        assert sql.rstrip().endswith(")")

    def test_fragment_parses_in_node_query(self):
        sqlglot = pytest.importorskip("sqlglot")
        context = make_context()
        config = ColumnConfig(**merge_column_config(context))
        query = build_node_query(
            resolve_node_table(context), ["a", "b"], config
        )
        # Must be valid Spark SQL after slotting into FROM {t} n JOIN ...
        sqlglot.parse_one(query, dialect="spark")


class TestResolveNodeTable:
    def test_physical_table_passes_through(self):
        context = make_context(node_table_name="cat.sch.nodes")
        assert resolve_node_table(context) == "cat.sch.nodes"

    def test_nodeless_returns_fragment(self):
        context = make_context()
        sql = resolve_node_table(context)
        assert "UNION" in sql
        assert "cat.sch.triples" in sql

    def test_empty_string_treated_as_nodeless(self):
        context = make_context(node_table_name="")
        assert "UNION" in resolve_node_table(context)


class TestCreateValidation:
    def _payload(self, **overrides):
        base = dict(
            title="t",
            datasource_type="sql_warehouse",
            edge_table_name="cat.sch.triples",
        )
        base.update(overrides)
        return base

    def test_nodeless_create_is_accepted_and_normalized(self):
        data = GraphContextCreate(**self._payload())
        assert data.node_table_name is None
        assert data.node_properties == []
        assert data.node_types == ["Node"]

    def test_empty_node_table_normalized_to_none(self):
        data = GraphContextCreate(**self._payload(node_table_name=""))
        assert data.node_table_name is None
        assert data.node_types == ["Node"]

    def test_nodeless_drops_leftover_node_metadata(self):
        data = GraphContextCreate(
            **self._payload(
                node_properties=[{"name": "age", "data_type": "int"}],
                node_types=["Person"],
            )
        )
        assert data.node_properties == []
        assert data.node_types == ["Node"]

    def test_edge_table_still_required(self):
        with pytest.raises(ValueError, match="edge_table_name is required"):
            GraphContextCreate(title="t", datasource_type="sql_warehouse")

    def test_full_context_untouched(self):
        data = GraphContextCreate(
            **self._payload(
                node_table_name="cat.sch.nodes",
                node_types=["Person"],
                node_properties=[{"name": "age", "data_type": "int"}],
            )
        )
        assert data.node_table_name == "cat.sch.nodes"
        assert data.node_types == ["Person"]
        assert len(data.node_properties) == 1


class TestSchemaDiscoveryRequest:
    def test_edge_only_discovery_accepted(self):
        req = SchemaDiscoveryRequest(
            datasource_type="sql_warehouse", edge_table="cat.sch.triples"
        )
        assert req.node_table is None

    def test_edge_table_still_required(self):
        with pytest.raises(ValueError, match="edge_table is required"):
            SchemaDiscoveryRequest(datasource_type="sql_warehouse")


class TestValidateContextTables:
    @pytest.mark.asyncio
    async def test_none_node_table_skips_node_side(self):
        from graphlagoon.services.schema_drift import validate_context_tables

        class ExplodingWarehouse:
            async def get_table_schema(self, table, database=None, catalog=None):
                raise AssertionError(
                    f"should not describe any table here, got {table}"
                )

        # Shape check passes for the edge table; node side is skipped, and no
        # structure was supplied so no DESCRIBE happens at all.
        await validate_context_tables(
            ExplodingWarehouse(), None, "cat.sch.triples"
        )

    @pytest.mark.asyncio
    async def test_none_node_table_with_node_structure_never_describes_node(
        self,
    ):
        from graphlagoon.services.schema_drift import validate_context_tables

        described = []

        class RecordingWarehouse:
            async def get_table_schema(self, table, database=None, catalog=None):
                described.append(table)
                raise Exception("unreachable — best-effort skip")

        await validate_context_tables(
            RecordingWarehouse(),
            None,
            "cat.sch.triples",
            node_structure={"node_id_col": "node_id"},
            edge_structure={"src_col": "src"},
        )
        assert described == ["triples"]


class TestDatasourceThreading:
    def _datasource(self):
        from graphlagoon.services.datasource.sql_warehouse import (
            SqlWarehouseDatasource,
        )

        return SqlWarehouseDatasource(warehouse_client_getter=lambda: None)

    @pytest.mark.asyncio
    async def test_execute_coerces_nodes_mode_to_full(self, monkeypatch):
        import graphlagoon.services.datasource.sql_warehouse as sw

        captured = {}

        async def fake_execute(**kwargs):
            captured.update(kwargs)
            return "graph"

        monkeypatch.setattr(sw, "execute_graph_query_with_nodes", fake_execute)
        ds = self._datasource()
        result = await ds._execute(
            make_context(), "SELECT 1", limit=None, nodes_mode="types"
        )
        assert result == "graph"
        assert captured["nodes_mode"] == "full"
        assert "UNION" in captured["node_table"]

    @pytest.mark.asyncio
    async def test_execute_keeps_nodes_mode_with_physical_table(
        self, monkeypatch
    ):
        import graphlagoon.services.datasource.sql_warehouse as sw

        captured = {}

        async def fake_execute(**kwargs):
            captured.update(kwargs)
            return "graph"

        monkeypatch.setattr(sw, "execute_graph_query_with_nodes", fake_execute)
        ds = self._datasource()
        await ds._execute(
            make_context(node_table_name="cat.sch.nodes"),
            "SELECT 1",
            limit=None,
            nodes_mode="types",
        )
        assert captured["nodes_mode"] == "types"
        assert captured["node_table"] == "cat.sch.nodes"

    @pytest.mark.asyncio
    async def test_expand_depth2_seeds_with_literal_id(self, monkeypatch):
        ds = self._datasource()
        captured = {}

        async def fake_execute(context, query, **kwargs):
            captured["query"] = query
            return "graph"

        monkeypatch.setattr(ds, "_execute", fake_execute)
        await ds.expand(
            make_context(), ExpandRequest(node_id="n1", depth=2)
        )
        query = captured["query"]
        assert "'n1' AS node_id" in query
        assert "ARRAY('n1')" in query
        # The seed must not scan any node table (there is none).
        seed = query.split("UNION ALL")[0]
        assert "FROM" not in seed.split("WITH RECURSIVE")[1]

    @pytest.mark.asyncio
    async def test_expand_depth2_physical_table_keeps_table_seed(
        self, monkeypatch
    ):
        ds = self._datasource()
        captured = {}

        async def fake_execute(context, query, **kwargs):
            captured["query"] = query
            return "graph"

        monkeypatch.setattr(ds, "_execute", fake_execute)
        await ds.expand(
            make_context(node_table_name="cat.sch.nodes"),
            ExpandRequest(node_id="n1", depth=2),
        )
        # Table names are validated and backtick-quoted since the A4 fix.
        assert "FROM `cat`.`sch`.`nodes`" in captured["query"]

    def test_prefilter_nodes_placeholder_expands_to_fragment(self):
        ds = self._datasource()
        cte = (
            "MY_FINAL_EDGES AS (SELECT e.* FROM __EDGES__ e "
            "JOIN __NODES__ n ON e.src = n.node_id)"
        )
        sql = ds._apply_prefilter(
            make_context(), "SELECT * FROM cat.sch.triples", cte
        )
        assert "__NODES__" not in sql
        assert "UNION" in sql


class TestComputeDriftNodeless:
    def test_no_node_side_findings(self):
        result = compute_drift(
            make_context(),
            node_table_reachable=False,
            node_live_columns=None,
            edge_table_reachable=True,
            edge_live_columns=[],
        )
        assert all(f.side != "node" for f in result["findings"])
        assert result["proposed_node_properties"] == []

    def test_discovered_node_types_ignored(self):
        """Discovery returns [] for a nodeless context; comparing that against
        the stored ['Node'] must not produce type-drift findings."""
        result = compute_drift(
            make_context(),
            node_table_reachable=False,
            node_live_columns=None,
            edge_table_reachable=True,
            edge_live_columns=[],
            discovered_node_types=[],
            discovered_relationship_types=["KNOWS"],
        )
        assert all(f.side != "node" for f in result["findings"])

    def test_physical_table_still_reports_not_found(self):
        result = compute_drift(
            make_context(node_table_name="cat.sch.nodes"),
            node_table_reachable=False,
            node_live_columns=None,
            edge_table_reachable=True,
            edge_live_columns=[],
        )
        assert any(
            f.code == "TABLE_NOT_FOUND" and f.side == "node"
            for f in result["findings"]
        )
