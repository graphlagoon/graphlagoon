"""Neighbour summary (count before expand) and the depth-1 expand order.

The SQL is checked as text (no warehouse here); Neptune runs against the
mocked HTTP transport of test_neptune_datasource; the file datasource against
a stubbed snapshot loader.
"""

import sys
from types import SimpleNamespace

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
        "gsql2rsql.common.exceptions",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from graphlagoon.models.schemas import (  # noqa: E402
    Edge,
    ExpandRequest,
    NeighborSummaryRequest,
)
from graphlagoon.services.datasource.base import summary_from_rows  # noqa: E402
from graphlagoon.services.datasource.sql_warehouse import (  # noqa: E402
    SqlWarehouseDatasource,
)


def make_context(rel_col="relationship_type"):
    return SimpleNamespace(
        node_table_name="cat.sch.nodes",
        edge_table_name="cat.sch.edges",
        node_structure={"node_id_col": "node_id", "node_type_col": "node_type"},
        edge_structure={
            "edge_id_col": "",
            "src_col": "src",
            "dst_col": "dst",
            "relationship_type_col": rel_col,
        },
        node_properties=[],
        edge_properties=[],
        node_types=["Node"],
        relationship_types=["KNOWS"],
    )


def _ds():
    return SqlWarehouseDatasource(warehouse_client_getter=lambda: None)


class TestSummaryFromRows:
    def test_largest_first_drops_empty_and_totals(self):
        s = summary_from_rows(
            [("ADMINISTRA", "in", 12), ("SOCIO_DE", "in", 380), ("X", "out", 0)]
        )
        assert s.supported is True
        assert s.total_edges == 392
        assert [(b.relationship_type, b.direction, b.edges) for b in s.buckets] == [
            ("SOCIO_DE", "in", 380),
            ("ADMINISTRA", "in", 12),
        ]


class TestSqlWarehouse:
    def test_summary_groups_by_type_and_direction_for_the_node(self):
        sql = _ds().neighbor_summary_sql(make_context(), NeighborSummaryRequest(node_id="a'b"))
        assert "GROUP BY 1, 2" in sql
        assert "e.`relationship_type` AS relationship_type" in sql
        assert "WHEN e.`src` = 'a''b' THEN 'out'" in sql  # quote escaped
        assert "WHERE e.`src` = 'a''b' OR e.`dst` = 'a''b'" in sql
        assert "FROM `cat`.`sch`.`edges` e" in sql

    def test_summary_without_type_column_uses_the_constant(self):
        sql = _ds().neighbor_summary_sql(make_context(rel_col=""), NeighborSummaryRequest(node_id="n1"))
        assert "'RELATED_TO' AS relationship_type" in sql

    @pytest.mark.asyncio
    async def test_summary_parses_rows(self):
        result = SimpleNamespace(
            status=SimpleNamespace(state="SUCCEEDED", error=None),
            result=SimpleNamespace(data_array=[["SOCIO_DE", "in", "300"], ["ADMINISTRA", "out", "2"]]),
        )

        async def fake_execute_statement(statement, **_):
            return result

        ds = SqlWarehouseDatasource(
            warehouse_client_getter=lambda: SimpleNamespace(execute_statement=fake_execute_statement)
        )
        s = await ds.neighbor_summary(make_context(), NeighborSummaryRequest(node_id="n1"))
        assert s.total_edges == 302
        assert s.buckets[0].relationship_type == "SOCIO_DE"

    @pytest.mark.asyncio
    async def test_expand_depth1_returns_the_nodes_own_edges_first(self, monkeypatch):
        ds = _ds()
        captured = {}

        async def fake_execute(context, query, **kwargs):
            captured["query"] = query
            return "graph"

        monkeypatch.setattr(ds, "_execute", fake_execute)
        await ds.expand(make_context(), ExpandRequest(node_id="n1", depth=1, edge_limit=10))
        query = captured["query"]
        order = query.index("ORDER BY")
        assert "e.`src` = 'n1' OR e.`dst` = 'n1' THEN 0 ELSE 1" in query[order:]
        assert order < query.index("LIMIT 10")


class TestNeptune:
    @pytest.mark.asyncio
    async def test_counts_out_then_in_without_double_counting_self_loops(self):
        from tests.test_neptune_datasource import CONTEXT, FakeNeptune, build

        def results(query):
            if "->(m)" in query:
                return [{"t": "OWNS", "n": 3}]
            return [{"t": "SOCIO_DE", "n": 120}]

        fake = FakeNeptune(results=results)
        s = await build(fake).neighbor_summary(CONTEXT, NeighborSummaryRequest(node_id="n1"))
        assert s.total_edges == 123
        assert [(b.relationship_type, b.direction) for b in s.buckets] == [("SOCIO_DE", "in"), ("OWNS", "out")]
        assert "id(m) <> id(s)" in fake.requests[1]["query"]
        assert fake.requests[0]["parameters"] == {"node_id": "n1"}


class TestFile:
    @pytest.mark.asyncio
    async def test_counts_from_the_loaded_graph(self, monkeypatch):
        import graphlagoon.services.datasource.file as file_ds

        edges = [
            Edge(edge_id=f"e{i}", src=f"p{i}", dst="hub", relationship_type="SOCIO_DE", properties={})
            for i in range(5)
        ] + [Edge(edge_id="x", src="hub", dst="other", relationship_type="OWNS", properties={})]

        async def fake_load(context):
            return [], edges

        monkeypatch.setattr(file_ds, "_load", fake_load)
        ds = file_ds.FileDatasource()
        s = await ds.neighbor_summary(SimpleNamespace(id="c"), NeighborSummaryRequest(node_id="hub"))
        assert s.total_edges == 6
        assert (s.buckets[0].relationship_type, s.buckets[0].direction, s.buckets[0].edges) == ("SOCIO_DE", "in", 5)


class TestNodeDegrees:
    def test_sql_counts_both_ends_once_per_edge(self):
        from graphlagoon.models.schemas import NodeDegreesRequest

        sql = _ds().node_degrees_sql(make_context(), NodeDegreesRequest(node_ids=["a'b", "c", "c"]))
        assert "IN ('a''b', 'c')" in sql  # deduplicated, quoted
        assert "e.`dst` <> e.`src`" in sql  # a self-loop counts once
        assert "GROUP BY node_id" in sql

    def test_request_is_capped(self):
        from pydantic import ValidationError

        from graphlagoon.models.schemas import MAX_DEGREE_IDS, NodeDegreesRequest

        with pytest.raises(ValidationError):
            NodeDegreesRequest(node_ids=[str(i) for i in range(MAX_DEGREE_IDS + 1)])

    @pytest.mark.asyncio
    async def test_file_datasource(self, monkeypatch):
        import graphlagoon.services.datasource.file as file_ds
        from graphlagoon.models.schemas import NodeDegreesRequest

        edges = [
            Edge(edge_id="1", src="a", dst="hub", relationship_type="R", properties={}),
            Edge(edge_id="2", src="a", dst="other", relationship_type="R", properties={}),
            Edge(edge_id="3", src="b", dst="hub", relationship_type="R", properties={}),
            Edge(edge_id="4", src="b", dst="b", relationship_type="R", properties={}),
        ]

        async def fake_load(context):
            return [], edges

        monkeypatch.setattr(file_ds, "_load", fake_load)
        r = await file_ds.FileDatasource().node_degrees(SimpleNamespace(id="c"), NodeDegreesRequest(node_ids=["a", "b", "zz"]))
        assert r.degrees == {"a": 2, "b": 2}
