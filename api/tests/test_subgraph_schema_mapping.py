"""Regression tests for edge NAMED_STRUCT schema mapping.

Bug: the subgraph and expand endpoints built the edge NAMED_STRUCT with
hardcoded NORMALIZED keys ('src', 'dst', 'relationship_type', 'edge_id'), but
``process_graph_query_result`` reads the struct back through the context's OWN
column names (``item.get(column_config.src_col)`` etc.). For any context whose
schema uses non-default column names (e.g. ``source_node_id`` /
``target_node_id`` / ``edge_type``), every lookup missed: edges came back with
empty src/dst, no node ids were collected (empty graph), and the edge-type
dropdown was blank.

Fix: ``build_edge_named_struct`` keys the struct by the context's own column
names, so subgraph/expand stay consistent with the transpiled cypher path and
with the result processor for ANY schema.
"""

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock as _MagicMock

# Stub gsql2rsql package tree so graphlagoon.routers.graph can be imported
# without the heavy transpiler dependency. Only stub when the real package is
# genuinely unavailable — stubbing it in sys.modules while it IS installed
# poisons the import for test_transpile_options (see the same note in
# test_graph_error_handling.py).
try:
    import gsql2rsql  # noqa: F401
except ImportError:
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

from graphlagoon.models.schemas import ColumnConfig  # noqa: E402
from graphlagoon.routers.graph import (  # noqa: E402
    build_edge_named_struct,
    merge_column_config,
)
from graphlagoon.services.graph_operations import (  # noqa: E402
    _get_edge_id,
    process_graph_query_result,
    process_nodes_result,
)


# Schema matching the reported bug report.
CUSTOM_CONFIG = ColumnConfig(
    edge_id_col="edge_id",
    src_col="source_node_id",
    dst_col="target_node_id",
    relationship_type_col="edge_type",
    node_id_col="node_id",
    node_type_col="node_type",
)

# Every structure column renamed — including the id columns, which
# CUSTOM_CONFIG keeps at their defaults.
FULL_CUSTOM_CONFIG = ColumnConfig(
    edge_id_col="rel_id",
    src_col="from_id",
    dst_col="to_id",
    relationship_type_col="rel_type",
    node_id_col="vertex_id",
    node_type_col="vertex_type",
)


class TestBuildEdgeNamedStruct:
    def test_default_schema_uses_normalized_keys(self):
        sql = build_edge_named_struct(ColumnConfig())
        assert "'edge_id', `edge_id`" in sql
        assert "'src', `src`" in sql
        assert "'dst', `dst`" in sql
        assert "'relationship_type', `relationship_type`" in sql

    def test_custom_schema_keys_by_context_columns(self):
        """The struct KEY must be the context's own column name, not 'src'/'dst'."""
        sql = build_edge_named_struct(CUSTOM_CONFIG)
        assert "'source_node_id', `source_node_id`" in sql
        assert "'target_node_id', `target_node_id`" in sql
        assert "'edge_type', `edge_type`" in sql
        assert "'edge_id', `edge_id`" in sql
        # The hardcoded normalized keys must NOT be emitted for a custom schema.
        assert "'src'," not in sql
        assert "'dst'," not in sql
        assert "'relationship_type'," not in sql

    def test_table_alias_qualifies_columns(self):
        sql = build_edge_named_struct(CUSTOM_CONFIG, "e")
        assert "'source_node_id', e.`source_node_id`" in sql
        assert "'edge_type', e.`edge_type`" in sql

    def test_no_alias_leaves_columns_unqualified(self):
        sql = build_edge_named_struct(CUSTOM_CONFIG)
        assert "e.`" not in sql


class TestProcessCustomSchemaRoundTrip:
    """The struct produced by build_edge_named_struct must round-trip through
    process_graph_query_result under the same custom ColumnConfig."""

    def _row(self):
        # Emulates the NAMED_STRUCT the warehouse returns for CUSTOM_CONFIG:
        # keyed by the context's own column names.
        return {
            "edge_id": "e1",
            "source_node_id": "n1",
            "target_node_id": "n2",
            "edge_type": "OWNS",
        }

    def test_edges_map_src_dst_and_type(self):
        response, node_ids = process_graph_query_result(
            columns=["r"], rows=[[self._row()]], column_config=CUSTOM_CONFIG
        )
        assert len(response.edges) == 1
        edge = response.edges[0]
        assert edge.src == "n1"
        assert edge.dst == "n2"
        assert edge.relationship_type == "OWNS"
        assert edge.edge_id == "e1"

    def test_node_ids_collected_for_node_fetch(self):
        """Regression: node_ids must be non-empty so the node query runs and the
        graph is not left empty."""
        _, node_ids = process_graph_query_result(
            columns=["r"], rows=[[self._row()]], column_config=CUSTOM_CONFIG
        )
        assert node_ids == {"n1", "n2"}

    def test_structure_columns_not_leaked_into_properties(self):
        response, _ = process_graph_query_result(
            columns=["r"], rows=[[self._row()]], column_config=CUSTOM_CONFIG
        )
        # All four struct keys are structure columns → no bogus properties.
        assert response.edges[0].properties is None


class TestMergeColumnConfigFullyCustom:
    def test_custom_ids_survive_merge(self):
        context = SimpleNamespace(
            edge_structure={
                "edge_id_col": "rel_id",
                "src_col": "from_id",
                "dst_col": "to_id",
                "relationship_type_col": "rel_type",
            },
            node_structure={
                "node_id_col": "vertex_id",
                "node_type_col": "vertex_type",
            },
        )
        config = merge_column_config(context)
        assert config["edge_id_col"] == "rel_id"
        assert config["src_col"] == "from_id"
        assert config["dst_col"] == "to_id"
        assert config["relationship_type_col"] == "rel_type"
        assert config["node_id_col"] == "vertex_id"
        assert config["node_type_col"] == "vertex_type"

    def test_missing_keys_fall_back_to_defaults(self):
        config = merge_column_config(
            SimpleNamespace(edge_structure={}, node_structure={})
        )
        assert config["edge_id_col"] == "edge_id"
        assert config["src_col"] == "src"
        assert config["dst_col"] == "dst"
        assert config["relationship_type_col"] == "relationship_type"
        assert config["node_id_col"] == "node_id"
        assert config["node_type_col"] == "node_type"


class TestBuildEdgeNamedStructFullyCustom:
    def test_struct_keys_use_custom_edge_id(self):
        sql = build_edge_named_struct(FULL_CUSTOM_CONFIG)
        assert "'rel_id', `rel_id`" in sql
        assert "'edge_id'" not in sql

    def test_empty_edge_id_col_is_omitted(self):
        """edge_id_col='' (frontend 'None' option) must not emit an empty
        struct key — NAMED_STRUCT('', ``, ...) is invalid SQL. The processor
        generates composite ids via _get_edge_id instead."""
        config = ColumnConfig(
            edge_id_col="",
            src_col="src",
            dst_col="dst",
            relationship_type_col="relationship_type",
            node_id_col="node_id",
            node_type_col="node_type",
        )
        sql = build_edge_named_struct(config)
        assert "''" not in sql
        assert "``" not in sql
        assert "'src', `src`" in sql
        assert "'dst', `dst`" in sql
        assert "'relationship_type', `relationship_type`" in sql


class TestFullyCustomRoundTrip:
    """Struct rows keyed by fully-custom column names (including both id
    columns) must round-trip through process_graph_query_result."""

    def _row(self):
        return {
            "rel_id": "e1",
            "from_id": "n1",
            "to_id": "n2",
            "rel_type": "OWNS",
            "weight": 3,
        }

    def test_edge_fields_and_custom_edge_id(self):
        response, node_ids = process_graph_query_result(
            columns=["r"], rows=[[self._row()]], column_config=FULL_CUSTOM_CONFIG
        )
        assert len(response.edges) == 1
        edge = response.edges[0]
        assert edge.edge_id == "e1"
        assert edge.src == "n1"
        assert edge.dst == "n2"
        assert edge.relationship_type == "OWNS"
        assert node_ids == {"n1", "n2"}

    def test_structure_cols_not_leaked_property_kept(self):
        response, _ = process_graph_query_result(
            columns=["r"], rows=[[self._row()]], column_config=FULL_CUSTOM_CONFIG
        )
        assert response.edges[0].properties == {"weight": 3}

    def test_get_edge_id_prefers_custom_col(self):
        assert (
            _get_edge_id(self._row(), "rel_id", "from_id", "to_id", "rel_type")
            == "e1"
        )

    def test_get_edge_id_composite_when_none_or_empty(self):
        row = {"from_id": "n1", "to_id": "n2", "rel_type": "OWNS"}
        assert _get_edge_id(row, None, "from_id", "to_id", "rel_type") == "n1@OWNS@n2"
        assert _get_edge_id(row, "", "from_id", "to_id", "rel_type") == "n1@OWNS@n2"


class TestProcessNodesResultCustomNodeId:
    def test_nodes_mapped_via_custom_columns(self):
        nodes = process_nodes_result(
            columns=["vertex_id", "vertex_type", "name"],
            rows=[["n1", "Person", "Alice"]],
            column_config=FULL_CUSTOM_CONFIG,
        )
        assert len(nodes) == 1
        node = nodes[0]
        assert node.node_id == "n1"
        assert node.node_type == "Person"
        assert node.properties == {"name": "Alice"}
