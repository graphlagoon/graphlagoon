"""apply_edit: one atomic batch on an exploration's snapshot and the person's layer."""

import copy

import pytest

from graphlagoon.services import exploration_graph as eg
from graphlagoon.services.exploration_graph import ExplorationEditError, apply_edit

SNAP = {
    "nodes": [
        {"id": "p1", "type": "Person", "properties": {"name": "Ana"}, "x": 1.0, "y": 2.0},
        {"id": "p2", "type": "Person", "properties": {"name": "Bia"}},
        {"id": "A1", "type": "Account", "properties": {}},
    ],
    "edges": [
        {"id": "e1", "source": "p1", "target": "A1", "type": "HOLDS", "properties": {}},
        {"id": "e2", "source": "p2", "target": "A1", "type": "HOLDS", "properties": {}},
    ],
    "snapshot_version": 1,
}
LAYER = {
    "version": 1,
    "nodes": [{"id": "x1", "type": "Device", "properties": {"os": "ios"}}, {"id": "p1", "type": "Person", "properties": {"city": "SP"}}],
    "edges": [{"id": "d1", "source": "p1", "target": "x1", "type": "USES", "properties": {}}],
    "enrichments": [],
    "imports": [{"id": "imp", "node_ids": ["x1"], "edge_ids": ["d1"]}],
}


def test_adds_nodes_and_edges_and_updates_an_existing_id_without_duplicating():
    snap, layer, report = apply_edit(SNAP, None, {
        "add_nodes": [{"id": "c9", "type": "Company", "properties": {"cnpj": "1"}},
                      {"id": "P2", "type": "Person", "properties": {"risk": "high"}}],
        "add_edges": [{"source": "p2", "target": "c9", "type": "OWNS"}],
    })
    assert layer is None
    assert report["added_nodes"] == 1 and report["updated_nodes"] == 1 and report["added_edges"] == 1
    p2 = next(n for n in snap["nodes"] if n["id"] == "p2")
    assert p2["properties"] == {"name": "Bia", "risk": "high"}  # P2 matched p2 case-insensitively
    assert {"id": "p2->c9:OWNS", "source": "p2", "target": "c9", "type": "OWNS", "properties": {}} in snap["edges"]
    assert (report["node_count"], report["edge_count"]) == (4, 3)
    assert SNAP["nodes"][1]["properties"] == {"name": "Bia"}  # inputs untouched


def test_removing_a_node_deletes_its_edges_from_the_snapshot_and_the_layer_and_its_imports():
    snap, layer, report = apply_edit(SNAP, LAYER, {"remove_node_ids": ["p1"], "remove_edge_ids": ["e2"]})
    assert [n["id"] for n in snap["nodes"]] == ["p2", "A1"]
    assert snap["edges"] == []
    assert [n["id"] for n in layer["nodes"]] == ["x1"] and layer["edges"] == []
    assert layer["imports"] == [{"id": "imp", "node_ids": ["x1"], "edge_ids": []}]
    assert (report["removed_nodes"], report["removed_edges"]) == (1, 3)


def test_an_edge_to_a_missing_node_fails_the_whole_batch():
    before = copy.deepcopy(SNAP)
    with pytest.raises(ExplorationEditError) as err:
        apply_edit(SNAP, None, {"add_nodes": [{"id": "n1", "type": "T"}], "add_edges": [{"source": "n1", "target": "ghost", "type": "R"}]})
    assert err.value.code == "INVALID_EDGE"
    with pytest.raises(ExplorationEditError) as err:
        apply_edit(SNAP, None, {"remove_node_ids": ["nope"]})
    assert err.value.code == "NODE_NOT_FOUND"
    assert SNAP == before


def test_replace_starts_a_new_graph_and_clears_the_layer():
    snap, layer, report = apply_edit(SNAP, LAYER, {"replace": True, "add_nodes": [{"id": "z", "type": "Z"}]})
    assert snap["nodes"] == [{"id": "z", "type": "Z", "properties": {}}] and snap["edges"] == []
    assert layer == {"version": 1, "nodes": [], "edges": [], "enrichments": [], "imports": []}
    assert (report["node_count"], report["edge_count"]) == (1, 0)


def test_set_properties_and_unset_win_over_the_layer_copy_of_the_same_node():
    snap, layer, _ = apply_edit(SNAP, LAYER, {"set_properties": [
        {"id": "p1", "properties": {"city": "RJ"}, "unset": ["name"]},
        {"id": "x1", "properties": {"os": "android"}},
        {"id": "e1", "kind": "edge", "properties": {"since": 2020}},
    ]})
    p1 = next(n for n in snap["nodes"] if n["id"] == "p1")
    assert p1["properties"] == {"city": "RJ"} and p1["x"] == 1.0
    assert next(n for n in layer["nodes"] if n["id"] == "p1")["properties"] == {}
    assert next(n for n in layer["nodes"] if n["id"] == "x1")["properties"] == {"os": "android"}
    assert next(e for e in snap["edges"] if e["id"] == "e1")["properties"] == {"since": 2020}
    graph = eg.effective_graph(snap, layer)
    assert next(n for n in graph["nodes"] if n["id"] == "p1")["properties"] == {"city": "RJ"}
    assert {n["id"]: n["origin"] for n in graph["nodes"]} == {"p1": "snapshot", "p2": "snapshot", "A1": "snapshot", "x1": "layer"}


def test_skip_existing_merges_an_answer_without_touching_what_is_there():
    _, _, report = apply_edit(SNAP, None, {
        "skip_existing": True,
        "add_nodes": [{"id": "p1", "type": "Other"}, {"id": "n", "type": "T"}],
        "add_edges": [{"id": "e1", "source": "p1", "target": "n", "type": "R"}],
    })
    assert (report["added_nodes"], report["updated_nodes"], report["added_edges"]) == (1, 0, 0)


def test_the_size_cap(monkeypatch):
    monkeypatch.setattr(eg, "MAX_NODES", 3)
    with pytest.raises(ExplorationEditError) as err:
        apply_edit(SNAP, None, {"add_nodes": [{"id": "n", "type": "T"}]})
    assert err.value.code == "GRAPH_TOO_LARGE"
