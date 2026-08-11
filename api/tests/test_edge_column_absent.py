"""Tests for the stale-structural-column guard in process_graph_query_result.

Before this guard, a renamed src_col/dst_col produced a full edge list with
src="", dst="" and an empty node_ids set: HTTP 200, empty canvas, no error
anywhere. These tests lock in that it now raises a classified error instead —
and, just as importantly, that legitimate cases (NULL values, partial misses)
are left alone.
"""

from graphlagoon.models.schemas import ColumnConfig
from graphlagoon.services.graph_operations import (
    QueryExecutionError,
    process_graph_query_result,
)
from graphlagoon.services.warehouse_errors import STALE_SCHEMA_CODE

import pytest


def _rows(*structs: dict) -> list[list]:
    """Wrap edge structs the way the warehouse returns the 'r' NAMED_STRUCT column."""
    return [[s] for s in structs]


CONFIG = ColumnConfig(
    edge_id_col="edge_id",
    src_col="src",
    dst_col="dst",
    relationship_type_col="relationship_type",
)


class TestEdgeColumnAbsentGuard:
    def test_raises_when_every_item_lacks_src_and_dst_keys(self):
        """The renamed-structural-column case: src_col/dst_col simply absent."""
        rows = _rows(
            {"source_node": "a", "target_node": "b", "relationship_type": "KNOWS"},
            {"source_node": "b", "target_node": "c", "relationship_type": "KNOWS"},
        )
        with pytest.raises(QueryExecutionError) as exc_info:
            process_graph_query_result(["r"], rows, CONFIG)
        assert exc_info.value.code == STALE_SCHEMA_CODE
        assert "src" in exc_info.value.message
        assert "dst" in exc_info.value.message

    def test_does_not_raise_when_key_present_but_null(self):
        """Present-but-NULL is legitimate data (e.g. a dangling edge), not drift."""
        rows = _rows(
            {"edge_id": "e1", "src": None, "dst": "b", "relationship_type": "KNOWS"},
        )
        response, node_ids = process_graph_query_result(["r"], rows, CONFIG)
        assert len(response.edges) == 1
        assert response.edges[0].src == ""

    def test_does_not_raise_on_partial_miss(self):
        """Mixed struct shapes across rows are legal — only ALL-missing is drift."""
        rows = _rows(
            {"edge_id": "e1", "src": "a", "dst": "b", "relationship_type": "KNOWS"},
            {"source_node": "b", "target_node": "c", "relationship_type": "KNOWS"},
        )
        response, node_ids = process_graph_query_result(["r"], rows, CONFIG)
        assert len(response.edges) == 2
        assert node_ids == {"a", "b"}

    def test_clean_result_unaffected(self):
        rows = _rows(
            {"edge_id": "e1", "src": "a", "dst": "b", "relationship_type": "KNOWS"},
        )
        response, node_ids = process_graph_query_result(["r"], rows, CONFIG)
        assert len(response.edges) == 1
        assert node_ids == {"a", "b"}

    def test_empty_rows_unaffected(self):
        response, node_ids = process_graph_query_result(["r"], [], CONFIG)
        assert response.edges == []
        assert node_ids == set()
