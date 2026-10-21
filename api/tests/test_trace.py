"""Server flow trace (F3.8): parity with the vitest suite on the same fixture."""

import json
from datetime import datetime
from pathlib import Path

from graphlagoon.services.trace import edge_value, end_types, run_trace, to_trace_edges, trace_forward

FIXTURE = json.loads(
    (
        Path(__file__).parents[2] / "frontend/src/__tests__/fixtures/trace/flow-chain.json"
    ).read_text()
)
SEMANTICS = FIXTURE["edge_semantics"]
EDGES = to_trace_edges(
    [
        {"id": e["edge_id"], "src": e["src"], "dst": e["dst"],
         **dict(zip(("amount", "t"), edge_value(e["properties"], SEMANTICS)))}
        for e in FIXTURE["edges"]
    ]
)
TYPES = {n["node_id"]: n["node_type"] for n in FIXTURE["nodes"]}
SEED = FIXTURE["seed"]["edgeIds"]


def test_every_fixture_case_matches_the_typescript_core():
    for case in FIXTURE["cases"]:
        result = trace_forward(EDGES, TYPES, SEED, {**FIXTURE["params"], **case["params"]})
        method = result.pop("method")
        assert result == case["expected"], case["name"]
        assert method["seedEdgeIds"] == ["e2"]
        assert method["allocation"] == case["params"].get("allocation", "fifo")


def test_the_default_stops_are_the_types_where_value_only_ends():
    # The fixture's own stops, without a word of a domain: these types only receive.
    assert end_types(EDGES, TYPES, "forward") == ["Betting", "CashWithdrawal", "Exchange"]
    assert end_types(EDGES, TYPES, "backward") == ["ExternalBank"]


def test_input_order_does_not_change_the_result():
    params = FIXTURE["params"]
    assert trace_forward(EDGES[::-1], TYPES, SEED, params) == trace_forward(
        EDGES, TYPES, SEED, params
    )


def test_backward_lifo_walks_back_to_the_victim():
    def t(hhmm):
        return int(datetime.fromisoformat(f"2026-09-09T{hhmm}:00-03:00").timestamp() * 1000)

    window = [t("13:00"), t("15:05")]
    r = run_trace(
        EDGES,
        TYPES,
        ["e8"],
        {**FIXTURE["params"], "direction": "backward", "allocation": "lifo",
         "stopTypes": ["BancoExterno"], "window": window},
    )
    assert r["edgeTrace"] == {"e8": 1850, "e4": 1850, "e2": 1850}
    assert r["nodes"]["4471-0"]["layer"] == 2
    assert r["nodes"]["0001-9"]["retained"] == 1850
    assert r["method"]["window"] == window
