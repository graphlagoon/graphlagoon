"""Tests for typeless type-columns on sql_warehouse contexts.

A context whose node table has no type column (``node_type_col=""``) and/or
whose edge table has no relationship type column (``relationship_type_col=""``)
is normalized to constant types: every node is ``'Node'``, every edge is
``'RELATED_TO'``. The empty column name itself is stored verbatim ("" means
"absent") and constants are injected at the read boundary. Transpiler coverage
lives in test_cypher_schema_provider.py (needs the real gsql2rsql).
"""

import sys
from types import SimpleNamespace

import pytest

# Stub gsql2rsql only when genuinely unavailable — see the note in
# test_graph_error_handling.py.
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
    SubgraphRequest,
)
from graphlagoon.services.graph_operations import (  # noqa: E402
    DEFAULT_NODE_TYPE,
    DEFAULT_RELATIONSHIP_TYPE,
    _get_edge_id,
    derived_node_table_sql,
    merge_column_config,
    process_graph_query_result,
    process_nodes_result,
    resolve_node_table,
)
from graphlagoon.services.schema_drift import compute_drift  # noqa: E402


def make_context(**overrides):
    base = dict(
        node_table_name="cat.sch.nodes",
        edge_table_name="cat.sch.edges",
        node_structure={"node_id_col": "node_id", "node_type_col": ""},
        edge_structure={
            "edge_id_col": "edge_id",
            "src_col": "src",
            "dst_col": "dst",
            "relationship_type_col": "",
        },
        node_properties=[],
        edge_properties=[],
        node_types=["Node"],
        relationship_types=["RELATED_TO"],
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class TestMergeColumnConfig:
    def test_empty_type_cols_survive_verbatim(self):
        """"" is semantic (column absent) — never defaulted away."""
        merged = merge_column_config(make_context())
        assert merged["node_type_col"] == ""
        assert merged["relationship_type_col"] == ""


class TestReadPathConstants:
    def test_process_nodes_result_injects_node_constant(self):
        config = ColumnConfig(node_type_col="")
        nodes = process_nodes_result(
            ["node_id", "name"], [["n1", "Ada"]], config
        )
        assert nodes[0].node_type == DEFAULT_NODE_TYPE
        assert nodes[0].properties == {"name": "Ada"}

    def test_configured_col_with_null_still_empty(self):
        """Only an ABSENT column injects the constant — a configured column
        with NULL values keeps the existing '' behavior."""
        config = ColumnConfig()
        nodes = process_nodes_result(
            ["node_id", "node_type"], [["n1", None]], config
        )
        assert nodes[0].node_type == ""

    def _edge_row(self):
        return (
            ["r"],
            [
                [
                    {
                        "edge_id": "e1",
                        "src": "a",
                        "dst": "b",
                    }
                ]
            ],
        )

    def test_process_graph_query_result_injects_edge_constant(self):
        config = ColumnConfig(relationship_type_col="")
        columns, rows = self._edge_row()
        response, node_ids = process_graph_query_result(columns, rows, config)
        assert response.edges[0].relationship_type == DEFAULT_RELATIONSHIP_TYPE
        assert node_ids == {"a", "b"}

    def test_composite_edge_id_stays_src_dst(self):
        """With no rel type col AND no edge id col the composite is src@@dst
        (both query paths omit the column, so ids stay consistent)."""
        edge_id = _get_edge_id(
            {"src": "a", "dst": "b"}, None, "src", "dst", ""
        )
        assert edge_id == "a@@b"


class TestDerivedFragmentTypeless:
    def test_typeless_fragment_is_single_column(self):
        config = ColumnConfig(node_type_col="")
        sql = derived_node_table_sql("cat.sch.edges", config)
        assert "``" not in sql
        assert DEFAULT_NODE_TYPE not in sql
        assert "AS `node_id`" in sql

    def test_typeless_fragment_parses(self):
        sqlglot = pytest.importorskip("sqlglot")
        from graphlagoon.services.graph_operations import build_node_query

        context = make_context(node_table_name=None)
        config = ColumnConfig(**merge_column_config(context))
        query = build_node_query(resolve_node_table(context), ["a"], config)
        sqlglot.parse_one(query, dialect="spark")

    def test_typed_fragment_unchanged(self):
        sql = derived_node_table_sql("db.edges", ColumnConfig())
        assert f"'{DEFAULT_NODE_TYPE}' AS `node_type`" in sql


class TestCreateNormalization:
    def _payload(self, **overrides):
        base = dict(
            title="t",
            datasource_type="sql_warehouse",
            edge_table_name="cat.sch.edges",
            node_table_name="cat.sch.nodes",
        )
        base.update(overrides)
        return base

    def test_empty_node_type_col_forces_constant_types(self):
        data = GraphContextCreate(
            **self._payload(
                node_structure={"node_id_col": "node_id", "node_type_col": ""},
                node_types=["Person", "Company"],
                node_properties=[{"name": "name", "data_type": "string"}],
            )
        )
        assert data.node_types == [DEFAULT_NODE_TYPE]
        # Properties are real columns of a real table — preserved.
        assert len(data.node_properties) == 1
        assert data.node_structure.node_type_col == ""

    def test_empty_rel_type_col_forces_constant_types(self):
        data = GraphContextCreate(
            **self._payload(
                edge_structure={
                    "edge_id_col": "edge_id",
                    "src_col": "src",
                    "dst_col": "dst",
                    "relationship_type_col": "",
                },
                relationship_types=["KNOWS"],
            )
        )
        assert data.relationship_types == [DEFAULT_RELATIONSHIP_TYPE]
        assert data.edge_structure.relationship_type_col == ""

    def test_both_typeless(self):
        data = GraphContextCreate(
            **self._payload(
                node_structure={"node_id_col": "node_id", "node_type_col": ""},
                edge_structure={
                    "edge_id_col": "",
                    "src_col": "src",
                    "dst_col": "dst",
                    "relationship_type_col": "",
                },
            )
        )
        assert data.node_types == [DEFAULT_NODE_TYPE]
        assert data.relationship_types == [DEFAULT_RELATIONSHIP_TYPE]

    def test_nodeless_plus_typeless_idempotent(self):
        data = GraphContextCreate(
            **self._payload(
                node_table_name=None,
                node_structure={"node_id_col": "node_id", "node_type_col": ""},
            )
        )
        assert data.node_table_name is None
        assert data.node_types == [DEFAULT_NODE_TYPE]
        assert data.node_properties == []

    def test_typed_cols_untouched(self):
        data = GraphContextCreate(
            **self._payload(node_types=["Person"], relationship_types=["KNOWS"])
        )
        assert data.node_types == ["Person"]
        assert data.relationship_types == ["KNOWS"]


class TestUpdateNormalization:
    def _update(self, data_kwargs, context):
        from graphlagoon.models.schemas import GraphContextUpdate
        from graphlagoon.routers.graph_contexts import _normalize_typeless_types

        data = GraphContextUpdate(**data_kwargs)
        _normalize_typeless_types(data, context)
        return data

    def test_clearing_col_overrides_stale_types_in_payload(self):
        data = self._update(
            {
                "node_structure": {"node_id_col": "node_id", "node_type_col": ""},
                "node_types": ["Person"],
            },
            make_context(
                node_structure={
                    "node_id_col": "node_id",
                    "node_type_col": "node_type",
                },
                datasource_type="sql_warehouse",
            ),
        )
        assert data.node_types == [DEFAULT_NODE_TYPE]

    def test_structure_free_patch_reforces_from_stored(self):
        """A cluster-programs-only PATCH against an already-typeless context
        re-forces the constants (self-healing, idempotent)."""
        data = self._update(
            {"cluster_programs": []},
            make_context(datasource_type="sql_warehouse"),
        )
        assert data.node_types == [DEFAULT_NODE_TYPE]
        assert data.relationship_types == [DEFAULT_RELATIONSHIP_TYPE]

    def test_typed_stored_structure_leaves_types_alone(self):
        data = self._update(
            {"node_types": ["Person"]},
            make_context(
                node_structure={
                    "node_id_col": "node_id",
                    "node_type_col": "node_type",
                },
                edge_structure={
                    "edge_id_col": "edge_id",
                    "src_col": "src",
                    "dst_col": "dst",
                    "relationship_type_col": "relationship_type",
                },
                datasource_type="sql_warehouse",
            ),
        )
        assert data.node_types == ["Person"]
        assert data.relationship_types is None

    def test_non_warehouse_untouched(self):
        data = self._update(
            {"node_types": ["Person"]},
            make_context(datasource_type="rest"),
        )
        assert data.node_types == ["Person"]


class TestSqlFilterGates:
    def _datasource(self):
        from graphlagoon.services.datasource.sql_warehouse import (
            SqlWarehouseDatasource,
        )

        return SqlWarehouseDatasource(warehouse_client_getter=lambda: None)

    @pytest.mark.asyncio
    async def test_subgraph_skips_type_filter_without_col(self, monkeypatch):
        ds = self._datasource()
        captured = {}

        async def fake_execute(context, query, **kwargs):
            captured["query"] = query
            return "graph"

        monkeypatch.setattr(ds, "_execute", fake_execute)
        await ds.get_subgraph(
            make_context(),
            SubgraphRequest(edge_types=[DEFAULT_RELATIONSHIP_TYPE]),
        )
        assert "IN (" not in captured["query"]
        assert "WHERE" not in captured["query"]

    @pytest.mark.asyncio
    async def test_expand_skips_type_filter_without_col(self, monkeypatch):
        ds = self._datasource()
        captured = {}

        async def fake_execute(context, query, **kwargs):
            captured["query"] = query
            return "graph"

        monkeypatch.setattr(ds, "_execute", fake_execute)
        await ds.expand(
            make_context(),
            ExpandRequest(node_id="n1", edge_types=[DEFAULT_RELATIONSHIP_TYPE]),
        )
        # The visited_nodes IN-subqueries are structural; only the type
        # filter must be absent.
        assert f"IN ('{DEFAULT_RELATIONSHIP_TYPE}')" not in captured["query"]

    @pytest.mark.asyncio
    async def test_subgraph_keeps_filter_with_col(self, monkeypatch):
        ds = self._datasource()
        captured = {}

        async def fake_execute(context, query, **kwargs):
            captured["query"] = query
            return "graph"

        monkeypatch.setattr(ds, "_execute", fake_execute)
        await ds.get_subgraph(
            make_context(
                edge_structure={
                    "edge_id_col": "edge_id",
                    "src_col": "src",
                    "dst_col": "dst",
                    "relationship_type_col": "relationship_type",
                }
            ),
            SubgraphRequest(edge_types=["KNOWS"]),
        )
        assert "`relationship_type` IN ('KNOWS')" in captured["query"]


class TestDiscovery:
    class _Warehouse:
        """discover_schema host that records executed statements."""

        def __init__(self):
            self.statements = []
            from graphlagoon.services.warehouse import WarehouseClient

            self._discover = WarehouseClient.discover_schema

        async def execute_statement(self, statement):
            self.statements.append(statement)
            raise AssertionError(f"unexpected query: {statement}")

        async def discover_schema(self, edge_table, node_table, columns):
            return await self._discover(self, edge_table, node_table, columns)

    @pytest.mark.asyncio
    async def test_typeless_cols_skip_distinct_and_return_constants(self):
        wh = self._Warehouse()
        result = await wh.discover_schema(
            "cat.sch.edges",
            "cat.sch.nodes",
            ColumnConfig(node_type_col="", relationship_type_col=""),
        )
        assert result.node_types == [DEFAULT_NODE_TYPE]
        assert result.relationship_types == [DEFAULT_RELATIONSHIP_TYPE]
        assert wh.statements == []

    @pytest.mark.asyncio
    async def test_nodeless_still_returns_empty_node_types(self):
        wh = self._Warehouse()
        result = await wh.discover_schema(
            "cat.sch.edges",
            None,
            ColumnConfig(relationship_type_col=""),
        )
        assert result.node_types == []
        assert result.relationship_types == [DEFAULT_RELATIONSHIP_TYPE]


class TestDriftTypeless:
    def test_no_findings_for_absent_type_roles(self):
        """Empty structural roles are skipped — an absent type column is
        configuration, not drift (and the live column, if any, shows up as an
        added property, which is correct)."""
        result = compute_drift(
            make_context(),
            node_table_reachable=True,
            node_live_columns=[],
            edge_table_reachable=True,
            edge_live_columns=[],
        )
        # The id/src/dst roles DO fire against empty live tables (correct);
        # the absent type roles must not.
        assert not any(
            f.code == "STRUCTURAL_COLUMN_MISSING"
            and f.role in ("node_type_col", "relationship_type_col")
            for f in result["findings"]
        )
