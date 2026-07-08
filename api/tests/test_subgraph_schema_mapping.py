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
from graphlagoon.routers.graph import build_edge_named_struct  # noqa: E402
from graphlagoon.services.graph_operations import (  # noqa: E402
    process_graph_query_result,
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
