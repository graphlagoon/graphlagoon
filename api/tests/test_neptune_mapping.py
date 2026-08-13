"""Neptune openCypher result mapping (pure, no I/O)."""

from graphlagoon.services.datasource.neptune.mapping import (
    extract_cypher_limit,
    flatten_tabular,
    is_node,
    is_path,
    is_relationship,
    map_graph_results,
    to_edge,
    to_node,
)


def node(node_id, labels, props=None):
    return {
        "~id": node_id,
        "~entityType": "node",
        "~labels": labels,
        "~properties": props or {},
    }


def rel(edge_id, start, end, rel_type, props=None):
    return {
        "~id": edge_id,
        "~entityType": "relationship",
        "~start": start,
        "~end": end,
        "~type": rel_type,
        "~properties": props or {},
    }


class TestEntityDetection:
    def test_recognizes_node_and_relationship(self):
        assert is_node(node("n1", ["Person"]))
        assert not is_relationship(node("n1", ["Person"]))
        assert is_relationship(rel("e1", "n1", "n2", "KNOWS"))
        assert not is_node(rel("e1", "n1", "n2", "KNOWS"))

    def test_recognizes_entities_without_entity_type_key(self):
        """Some Neptune versions omit ~entityType; the shape still identifies it."""
        assert is_node({"~id": "n1", "~labels": ["Person"], "~properties": {}})
        assert is_relationship(
            {"~id": "e1", "~start": "n1", "~end": "n2", "~type": "KNOWS"}
        )

    def test_scalars_are_not_entities(self):
        for value in ("text", 42, None, [], {}):
            assert not is_node(value)
            assert not is_relationship(value)

    def test_path_is_a_list_of_entities(self):
        assert is_path([node("n1", ["P"]), rel("e1", "n1", "n2", "K")])
        assert not is_path([1, 2, 3])
        assert not is_path([])


class TestConversion:
    def test_node_maps_id_label_and_properties(self):
        result = to_node(node("n1", ["Person"], {"name": "Alice", "age": 30}))
        assert result.node_id == "n1"
        assert result.node_type == "Person"
        assert result.properties == {"name": "Alice", "age": 30}

    def test_node_without_properties_reports_none(self):
        assert to_node(node("n1", ["Person"])).properties is None

    def test_multi_label_node_keeps_first_and_preserves_the_rest(self):
        result = to_node(node("n1", ["Person", "Employee"], {"name": "Alice"}))
        assert result.node_type == "Person"
        assert result.properties["~labels"] == ["Person", "Employee"]

    def test_unlabeled_node_has_empty_type(self):
        assert to_node({"~id": "n1", "~labels": [], "~properties": {}}).node_type == ""

    def test_edge_maps_endpoints_and_type(self):
        result = to_edge(rel("e1", "n1", "n2", "KNOWS", {"since": 2020}))
        assert (result.edge_id, result.src, result.dst) == ("e1", "n1", "n2")
        assert result.relationship_type == "KNOWS"
        assert result.properties == {"since": 2020}


class TestMapGraphResults:
    def test_extracts_nodes_and_edges_from_a_row(self):
        rows = [
            {
                "a": node("n1", ["Person"]),
                "r": rel("e1", "n1", "n2", "KNOWS"),
                "b": node("n2", ["Person"]),
            }
        ]
        nodes, edges, dangling = map_graph_results(rows)
        assert set(nodes) == {"n1", "n2"}
        assert set(edges) == {"e1"}
        assert dangling == set()

    def test_dedupes_entities_across_rows(self):
        rows = [
            {"a": node("n1", ["Person"]), "r": rel("e1", "n1", "n2", "KNOWS")},
            {"a": node("n1", ["Person"]), "r": rel("e1", "n1", "n2", "KNOWS")},
        ]
        nodes, edges, _ = map_graph_results(rows)
        assert len(nodes) == 1 and len(edges) == 1

    def test_prefers_the_copy_carrying_more_properties(self):
        rows = [
            {"a": node("n1", ["Person"])},
            {"a": node("n1", ["Person"], {"name": "Alice"})},
        ]
        nodes, _, _ = map_graph_results(rows)
        assert nodes["n1"].properties == {"name": "Alice"}

    def test_reports_endpoints_that_were_never_projected(self):
        """RETURN r alone names two nodes the result does not contain."""
        rows = [{"r": rel("e1", "n1", "n2", "KNOWS")}]
        nodes, edges, dangling = map_graph_results(rows)
        assert nodes == {}
        assert set(edges) == {"e1"}
        assert dangling == {"n1", "n2"}

    def test_walks_into_paths(self):
        path = [node("n1", ["P"]), rel("e1", "n1", "n2", "K"), node("n2", ["P"])]
        nodes, edges, dangling = map_graph_results([{"p": path}])
        assert set(nodes) == {"n1", "n2"}
        assert set(edges) == {"e1"}
        assert dangling == set()

    def test_walks_into_collected_lists_and_map_literals(self):
        rows = [
            {"ns": [node("n1", ["P"]), node("n2", ["P"])]},
            {"m": {"edge": rel("e1", "n1", "n2", "K")}},
        ]
        nodes, edges, _ = map_graph_results(rows)
        assert set(nodes) == {"n1", "n2"}
        assert set(edges) == {"e1"}

    def test_ignores_scalar_projections(self):
        nodes, edges, dangling = map_graph_results([{"name": "Alice", "count": 3}])
        assert (nodes, edges, dangling) == ({}, {}, set())

    def test_empty_result_is_an_empty_graph(self):
        assert map_graph_results([]) == ({}, {}, set())


class TestFlattenTabular:
    def test_preserves_projection_order(self):
        rows = [{"name": "Alice", "count": 3}, {"name": "Bob", "count": 5}]
        columns, out, truncated = flatten_tabular(rows, 100)
        assert columns == ["name", "count"]
        assert out == [["Alice", "3"], ["Bob", "5"]]
        assert truncated is False

    def test_unions_columns_introduced_by_later_rows(self):
        rows = [{"a": 1}, {"a": 2, "b": 3}]
        columns, out, _ = flatten_tabular(rows, 100)
        assert columns == ["a", "b"]
        assert out == [["1", None], ["2", "3"]]

    def test_serializes_entities_as_json(self):
        rows = [{"n": node("n1", ["Person"], {"name": "Alice"})}]
        _, out, _ = flatten_tabular(rows, 100)
        assert out[0][0].startswith("{")
        assert '"~id": "n1"' in out[0][0]

    def test_truncates_at_the_row_limit(self):
        rows = [{"a": i} for i in range(10)]
        _, out, truncated = flatten_tabular(rows, 5)
        assert len(out) == 5
        assert truncated is True

    def test_null_stays_null(self):
        _, out, _ = flatten_tabular([{"a": None}], 100)
        assert out == [[None]]


class TestExtractCypherLimit:
    def test_reads_a_trailing_limit(self):
        assert extract_cypher_limit("MATCH (n) RETURN n LIMIT 25") == 25
        assert extract_cypher_limit("MATCH (n) RETURN n limit 5;") == 5

    def test_absent_limit_is_none(self):
        assert extract_cypher_limit("MATCH (n) RETURN n") is None
        # A LIMIT that is not the final clause is not the result cap.
        assert extract_cypher_limit("MATCH (n) WITH n LIMIT 10 RETURN n") is None
