"""The QSA demo graph (graphlagoon.dev.qsa_demo): its shape, the SQL that loads
it, and that it can be built and queried in a test without a warehouse."""

import json
from types import SimpleNamespace

import pytest

from graphlagoon.dev.qsa_demo import (
    EDGE_TABLE,
    FIXTURE,
    NODE_TABLE,
    explorations,
    qsa_graph,
    table_statements,
)
from graphlagoon.models.schemas import Edge, ExpandRequest, NeighborSummaryRequest, Node


def _neighbours(graph):
    out = {}
    for e in graph["edges"]:
        out.setdefault(e["src"], set()).add(e["dst"])
        out.setdefault(e["dst"], set()).add(e["src"])
    return out


class TestGraph:
    def test_two_hubs_with_hundreds_of_leaves_and_a_few_linked_partners(self):
        g = qsa_graph()
        assert (len(g["nodes"]), len(g["edges"])) == (485, 509)
        nb = _neighbours(g)
        assert (len(nb["aurora"]), len(nb["boreal"])) == (380, 105)
        leaves = lambda hub: [n for n in nb[hub] if nb[n] == {hub}]  # noqa: E731
        assert (len(leaves("aurora")), len(leaves("boreal"))) == (356, 95)
        # 24 partners also hold a holding, 5 are partners of both companies.
        assert sum(1 for e in g["edges"] if e["edge_id"].startswith("x")) == 24
        assert sorted(e["src"] for e in g["edges"] if e["edge_id"].startswith("s")) == [f"p{i}" for i in range(375, 380)]

    def test_is_deterministic_and_sizable(self):
        assert qsa_graph() == qsa_graph()
        small = qsa_graph(aurora_partners=40, boreal_partners=10)
        assert len(small["nodes"]) == 55
        assert {e["dst"] for e in small["edges"] if e["edge_id"].startswith("s")} == {"boreal"}

    def test_the_frontend_fixture_is_this_graph(self):
        """frontend/src/__tests__/fixtures/qsa-demo.json feeds frontend tests and the
        documentation screenshots; regenerate it when the graph changes:
        ``.venv/bin/python -m graphlagoon.dev.qsa_demo --write-fixture``"""
        assert json.loads(FIXTURE.read_text()) == qsa_graph()


class TestTables:
    def test_statements_create_both_tables_with_one_row_per_item(self):
        g = qsa_graph(aurora_partners=20, boreal_partners=10)
        create_n, create_e = table_statements(g)
        # The dev warehouse refuses DROP: create only when missing (versioned names).
        assert create_n.startswith(f"CREATE TABLE IF NOT EXISTS {NODE_TABLE} ")
        assert create_e.startswith(f"CREATE TABLE IF NOT EXISTS {EDGE_TABLE} ")
        assert "DROP" not in create_n + create_e
        assert create_n.count("), (") == len(g["nodes"]) - 1
        assert create_e.count("), (") == len(g["edges"]) - 1
        assert "AS t(node_id, node_type, display_name, uf, qualificacao)" in create_n
        assert "('p1', 'Person', 'Socio 1', 'RJ', 'Diretor')" in create_n
        # The two companies have no role: NULL, not the string 'None'.
        assert "('aurora', 'Company', 'Banco Aurora SA', 'SP', NULL)" in create_n
        assert "('e1', 'p1', 'aurora', 'ADMINISTRA', 'Diretor', 5.0)" in create_e

    def test_quotes_are_escaped(self):
        g = {"nodes": [{"node_id": "a'b", "node_type": "T", "properties": {}}], "edges": []}
        assert "('a''b', 'T', NULL, NULL, NULL)" in table_statements(g)[0]


class TestExplorations:
    def test_one_per_setting_with_distinct_titles(self):
        ex = explorations()
        titles = [t for t, _, _ in ex]
        assert len(titles) == len(set(titles)) == 22
        assert all(t.startswith("Demo · QSA · ") for t in titles)
        by_title = {t: s for t, s, _ in ex}
        # The "automatic" ones set nothing: they show the defaults.
        auto = by_title["Demo · QSA · A1 Automatic (default): hubs arranged by themselves"]
        assert auto["behaviors"] == {"viewMode": "2d-proj"}
        assert "ringOrdering" not in by_title["Demo · QSA · A3 Ego, automatic sectors on the crowded ring"]["layout_mode_config"]["ego"]
        cluster = by_title["Demo · QSA · Ego 6 Three hops, Boreal's partners as one cluster"]["clusters"]["clusters"][0]
        assert len(cluster["node_ids"]) == 95


class TestInATestWithoutAWarehouse:
    """The file datasource walks a stored graph in memory: enough to exercise the
    hub operations on the demo graph in a unit test."""

    @pytest.fixture
    def datasource(self, monkeypatch):
        import graphlagoon.services.datasource.file as file_ds

        g = qsa_graph()
        nodes = [Node(node_id=n["node_id"], node_type=n["node_type"], properties=n["properties"]) for n in g["nodes"]]
        edges = [
            Edge(edge_id=e["edge_id"], src=e["src"], dst=e["dst"], relationship_type=e["relationship_type"], properties=e["properties"])
            for e in g["edges"]
        ]

        async def load(context):
            return nodes, edges

        monkeypatch.setattr(file_ds, "_load", load)
        return file_ds.FileDatasource()

    @pytest.mark.asyncio
    async def test_neighbor_summary_of_the_big_hub(self, datasource):
        s = await datasource.neighbor_summary(SimpleNamespace(id="qsa"), NeighborSummaryRequest(node_id="aurora"))
        assert s.total_edges == 380
        assert [(b.relationship_type, b.direction, b.edges) for b in s.buckets] == [
            ("SOCIO_DE", "in", 304),
            ("ADMINISTRA", "in", 76),
        ]

    @pytest.mark.asyncio
    async def test_expand_one_relationship_type(self, datasource):
        r = await datasource.expand(
            SimpleNamespace(id="qsa"),
            ExpandRequest(node_id="boreal", depth=1, edge_types=["ADMINISTRA"], edge_limit=1000),
        )
        assert len(r.edges) == 20
        assert {e.dst for e in r.edges} == {"boreal"}
