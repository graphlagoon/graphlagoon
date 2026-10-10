"""Server paths (F3.8): parity with the vitest suite on the same fixture."""

import json
from pathlib import Path

from graphlagoon.services.paths import find_paths

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "frontend/src/__tests__/fixtures/paths/small.json").read_text()
)


def _run(case, edges=FIXTURE["edges"]):
    return find_paths(
        edges, case["source"], case["target"], {**FIXTURE["base"], **case["params"]}
    )


def test_every_fixture_case_matches_the_typescript_core():
    for case in FIXTURE["cases"]:
        got = _run(case)
        if "expected" in case:
            rounded = [{**p, "cost": round(p["cost"], 9)} for p in got]
            assert rounded == case["expected"], case["name"]
        else:
            assert len(got) == case["expectedCount"], case["name"]


def test_input_order_does_not_change_the_paths():
    for case in FIXTURE["cases"]:
        assert _run(case, FIXTURE["edges"][::-1]) == _run(case), case["name"]
