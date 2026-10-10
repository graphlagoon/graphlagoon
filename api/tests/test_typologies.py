"""Typology badges (F4.3): parity with the vitest suite on the same fixture."""

import json
from datetime import datetime
from pathlib import Path

from graphlagoon.services.typologies import TYPOLOGIES, run_typologies

FIXTURE = json.loads(
    (
        Path(__file__).parents[2]
        / "frontend/src/__tests__/fixtures/typologies/small.json"
    ).read_text()
)
GRAPH = {
    "nodes": FIXTURE["nodes"],
    "edges": [
        {
            **e,
            "t": None
            if e["t"] is None
            else int(datetime.fromisoformat(e["t"]).timestamp() * 1000),
        }
        for e in FIXTURE["edges"]
    ],
}


def test_every_fixture_hit_matches_the_typescript_core():
    got = {r["id"]: r["hits"] for r in run_typologies(GRAPH, FIXTURE["params"])}
    assert list(got) == list(FIXTURE["expected"])
    for tid, hits in FIXTURE["expected"].items():
        assert got[tid] == hits, tid


def test_input_order_does_not_change_the_result():
    reversed_graph = {"nodes": GRAPH["nodes"][::-1], "edges": GRAPH["edges"][::-1]}
    assert run_typologies(reversed_graph, FIXTURE["params"]) == run_typologies(
        GRAPH, FIXTURE["params"]
    )


def test_every_badge_cites_cc_4001():
    assert all(t["normRef"].startswith("CC 4.001 ") for t in TYPOLOGIES)
