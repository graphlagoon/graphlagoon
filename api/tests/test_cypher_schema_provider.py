"""Regression tests for build_schema_provider column-name mapping.

Bug: the edge property list in ``build_schema_provider`` hardcoded the
property name ``"edge_id"`` instead of reading the context's
``edge_structure.edge_id_col``. For a context whose edge id column has a
custom name (e.g. ``rel_id``), the transpiler schema declared a nonexistent
``edge_id`` column and omitted the real one, so Cypher queries touching the
edge id rendered SQL that failed at the warehouse — while the subgraph/expand
SQL path (which honors ``edge_id_col``) worked fine.

These tests need the REAL gsql2rsql package: with a MagicMock stub the
``EntityProperty.property_name`` assertions would be meaningless. Do NOT add
the sys.modules stub here — and skip if an earlier-collected module left one
behind (see the stub-poisoning note in test_subgraph_schema_mapping.py).
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

gsql2rsql = pytest.importorskip("gsql2rsql")
if isinstance(gsql2rsql, MagicMock):
    pytest.skip(
        "gsql2rsql stubbed by an earlier test module; real package unavailable",
        allow_module_level=True,
    )

from graphlagoon.services.cypher import build_schema_provider  # noqa: E402


def make_context(**overrides):
    """Fake GraphContextModel with fully-custom structure column names."""
    base = dict(
        node_structure={"node_id_col": "vertex_id", "node_type_col": "vertex_type"},
        edge_structure={
            "edge_id_col": "rel_id",
            "src_col": "from_id",
            "dst_col": "to_id",
            "relationship_type_col": "rel_type",
        },
        node_properties=[{"name": "name", "data_type": "string"}],
        edge_properties=[{"name": "weight", "data_type": "double"}],
        node_types=["Person"],
        relationship_types=["OWNS"],
        node_table_name="cat.sch.nodes",
        edge_table_name="cat.sch.edges",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _edge_property_names(schema):
    edge = schema.get_edge_definition("OWNS", "Person", "Person")
    assert edge is not None
    return {p.property_name for p in edge.properties}


class TestEdgeSchemaColumns:
    def test_edge_schema_uses_configured_edge_id_col(self):
        """The edge id property must be the context's edge_id_col, not 'edge_id'."""
        schema = build_schema_provider(make_context())
        names = _edge_property_names(schema)
        assert "rel_id" in names
        assert "edge_id" not in names

    def test_edge_schema_uses_configured_src_dst_rel_cols(self):
        schema = build_schema_provider(make_context())
        edge = schema.get_edge_definition("OWNS", "Person", "Person")
        names = {p.property_name for p in edge.properties}
        assert {"from_id", "to_id", "rel_type", "weight"} <= names
        assert edge.source_id_property.property_name == "from_id"
        assert edge.sink_id_property.property_name == "to_id"

    def test_empty_edge_id_col_omits_edge_id_property(self):
        """The frontend's 'None' option stores edge_id_col='' — no id property."""
        schema = build_schema_provider(
            make_context(
                edge_structure={
                    "edge_id_col": "",
                    "src_col": "from_id",
                    "dst_col": "to_id",
                    "relationship_type_col": "rel_type",
                }
            )
        )
        names = _edge_property_names(schema)
        assert "edge_id" not in names
        assert "" not in names

    def test_missing_edge_id_col_defaults_to_edge_id(self):
        schema = build_schema_provider(
            make_context(
                edge_structure={
                    "src_col": "from_id",
                    "dst_col": "to_id",
                    "relationship_type_col": "rel_type",
                }
            )
        )
        assert "edge_id" in _edge_property_names(schema)


class TestNodeSchemaColumns:
    def test_node_schema_uses_configured_node_id_col(self):
        schema = build_schema_provider(make_context())
        node = schema.get_node_definition("Person")
        assert node is not None
        assert node.node_id_property.property_name == "vertex_id"
        names = {p.property_name for p in node.properties}
        assert {"vertex_id", "vertex_type", "name"} <= names
        assert "node_id" not in names
