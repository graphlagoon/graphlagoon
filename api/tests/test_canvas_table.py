"""Canvas tables for agents (``services.canvas_table``): the neighborhood walk
gives the same rows as the browser's ``neighborhoodTable`` on the fixture both
test suites share."""

import json
from pathlib import Path

import pytest

from graphlagoon.services.canvas_table import (
    canvas_table_actions,
    cell,
    from_case_graph,
    neighborhood_table,
    with_values,
)

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "frontend/src/utils/__tests__/fixtures/canvasTable.json").read_text()
)


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=[c["name"] for c in FIXTURE["cases"]])
def test_same_rows_as_the_browser(case):
    kwargs = {"row_limit": case["rowLimit"]} if "rowLimit" in case else {}
    assert neighborhood_table(FIXTURE["graph"], case["item"], case["spec"], **kwargs) == case["expected"]


def test_helpers():
    assert with_values({"hops": 2, "direction": "out"}, {"hops": "9", "direction": "x"}) == {"hops": 5, "direction": "out"}
    assert [cell(v) for v in (None, True, 3.0, 2.5, {"a": [1]})] == [None, "true", "3", "2.5", '{"a":[1]}']
    graph = from_case_graph({
        "nodes": [{"uid": "a@c", "type": "Account", "properties": {"x": 1}}],
        "edges": [{"id": "i:e", "src": "a@c", "dst": "a@c", "type": "T"}],
    })
    assert graph["nodes"][0]["node_id"] == "a@c" and graph["edges"][0]["relationship_type"] == "T"

    class Ctx:
        context_menu_actions = [
            {"id": "a", "kind": "show-table", "source": {"type": "neighborhood"}},
            {"id": "b", "kind": "show-table", "enabled": False, "source": {"type": "neighborhood"}},
            {"id": "c", "kind": "show-table"},
            {"id": "d", "kind": "open-url"},
        ]

    assert [a["id"] for a in canvas_table_actions(Ctx())] == ["a"]
