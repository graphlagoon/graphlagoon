"""Temporal flow trace on the server (investigations F3.8, 03 §6.1).

Port of ``frontend/src/utils/trace.ts`` (and of ``edgeValue`` in
``utils/edgeSemantics.ts``): same rules, same tie-breaking, same rounding, so
``tests/test_trace.py`` checks it against the very fixture the vitest suite uses
(``frontend/src/__tests__/fixtures/trace/flow-chain.json``). Params and results
keep the TS keys (``maxHops``, ``edgeTrace``…) so a server run and a browser run
stamp the same method (F4.1 evidence). The readings of §6.1 are in the TS module
header and the F3.3 decision log entry.

``run_case_trace`` runs it on a case's unified graph (route and MCP tool).
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

ALLOCATIONS = ("fifo", "lifo", "proportional", "libr", "total")
# FIFO and LIBR lose their meaning on reversed edges (F3.4 decision log).
BACKWARD_ALLOCATIONS = ("lifo", "proportional", "total")
HOUR_MS = 3_600_000

_INF = math.inf


# ---------------------------------------------------------------------------
# Amount and time of an edge (port of utils/edgeSemantics.ts)
# ---------------------------------------------------------------------------


def parse_amount(raw: Any, unit: str = "units") -> Optional[float]:
    """``12.34`` or ``"12.34"`` → number; else None. A comma is never read:
    locale-formatted text goes through a file mapping's ``decimal_comma``."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        n = float(raw)
    elif isinstance(raw, str) and raw.strip():
        s = raw.strip()
        if "_" in s or "," in s:  # Python's float() takes 1_000, JS Number() does not
            return None
        try:
            n = float(s)
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(n):
        return None
    return n / 100 if unit == "cents" else n


def parse_time(raw: Any) -> Optional[int]:
    """ISO date/datetime, epoch s or ms → epoch ms (other layouts go through a
    file mapping's ``date:`` converter)."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        if not math.isfinite(raw):
            return None
        return int(raw * 1000) if raw < 1e11 else int(raw)
    if not isinstance(raw, str) or not raw.strip():
        return None
    s = raw.strip()
    if s.isdigit():
        return parse_time(int(s))
    try:
        # A bare date or a datetime without offset is local time, as in the browser.
        return round(datetime.fromisoformat(s).timestamp() * 1000)
    except ValueError:
        return None


def semantics_for(relationship_type: Any, by_type: Optional[dict], fallback: Optional[dict]) -> Optional[dict]:
    """The case's per-type override (``*`` = any type), else the context's semantics."""
    if by_type:
        return by_type.get(relationship_type) or by_type.get("*") or fallback
    return fallback


def edge_value(properties: dict, semantics: Optional[dict]) -> tuple:
    """(amount, t) of an edge read through its context's ``edge_semantics``; a
    generic relation's ``weight_prop``/``timestamp_prop`` stand in (05 §4b)."""
    if not semantics:
        return None, None
    props = properties or {}
    amount_prop = semantics.get("amount_prop") or semantics.get("weight_prop")
    time_prop = semantics.get("time_prop") or semantics.get("timestamp_prop")
    amount = (
        parse_amount(props.get(amount_prop), semantics.get("amount_unit") or "units")
        if amount_prop
        else None
    )
    t = parse_time(props.get(time_prop)) if time_prop else None
    return amount, t


def to_trace_edges(edges: list[dict]) -> list[dict]:
    """Edges with a positive ``amount`` and a time ``t`` (unified-graph tags)."""
    return [
        {"id": e["id"], "src": e["src"], "dst": e["dst"], "amount": e["amount"], "t": e["t"]}
        for e in edges
        if e.get("amount") is not None and e["amount"] > 0 and e.get("t") is not None
    ]


# ---------------------------------------------------------------------------
# Core (port of utils/trace.ts)
# ---------------------------------------------------------------------------


def _allocate(lots: list, a: float, rule: str) -> float:
    """Takes ``a`` out of ``lots`` by the rule and returns x, its traced part."""
    B = sum(lot["amount"] for lot in lots)
    T = sum(lot["traced"] for lot in lots)
    if B <= 0:
        return 0
    if rule == "proportional":
        x = T if a >= B else (a * T) / B
        if a >= B:
            lots.clear()
        else:
            for lot in lots:
                lot["traced"] -= (a * lot["traced"]) / B
                lot["amount"] -= (a * lot["amount"]) / B
        return x
    if rule == "libr":
        # Untraced leaves first (oldest first), then traced (oldest first).
        need = a
        for lot in lots:
            take = min(max(0, lot["amount"] - lot["traced"]), need)
            lot["amount"] -= take
            need -= take
        x = 0
        for lot in lots:
            take = min(lot["traced"], need)
            lot["amount"] -= take
            lot["traced"] -= take
            x += take
            need -= take
        lots[:] = [lot for lot in lots if lot["amount"] > 0]
        return x
    # FIFO/LIFO; total contamination drains the balance like FIFO but reports all of a.
    lifo = rule == "lifo"
    need, x = a, 0
    while need > 0 and lots:
        lot = lots[-1] if lifo else lots[0]
        if lot["amount"] <= need:
            x += lot["traced"]
            need -= lot["amount"]
            lots.pop(-1 if lifo else 0)
        else:
            tr = (lot["traced"] * need) / lot["amount"]
            x += tr
            lot["traced"] -= tr
            lot["amount"] -= need
            need = 0
    if rule == "total":
        return a if T > 0 else 0
    return x


def _cents(v: float) -> float:
    return math.floor(v * 100 + 0.5) / 100  # JS Math.round: half up, not to even


def trace_forward(
    edges: list[dict], node_types: dict, seed_edge_ids: list[str], params: dict
) -> dict:
    window = params.get("window")
    t0, t1 = window if window else (-_INF, _INF)
    seeds = set(seed_edge_ids)
    stop_types, stop_nodes = set(params["stopTypes"]), set(params["stopNodes"])
    max_dwell, min_amount, max_hops = params["maxDwellMs"], params["minAmount"], params["maxHops"]

    ordered = sorted((e for e in edges if e["t"] <= t1), key=lambda e: (e["t"], e["id"]))
    lots: dict[str, list] = {}
    nodes: dict[str, dict] = {}
    edge_trace: dict[str, float] = {}
    exits: dict[str, float] = {}
    frontier: list[dict] = []
    below_min = expired = seed_total = 0
    used_seeds: list[str] = []

    for e in ordered:
        is_seed = e["id"] in seeds and e["t"] >= t0
        if is_seed:
            x, hop_u = e["amount"], 0
            seed_total += x
            used_seeds.append(e["id"])
        else:
            u_lots = lots.get(e["src"], [])
            if max_dwell is not None:
                for lot in u_lots:
                    if lot["traced"] > 0 and e["t"] - lot["arrivedAt"] > max_dwell:
                        expired += lot["traced"]
                        lot["traced"] = 0
            x = _allocate(u_lots, e["amount"], params["allocation"])
            hop_u = nodes[e["src"]]["layer"] if e["src"] in nodes else 0
            if x > 0:
                nodes[e["src"]]["tracedOut"] += x
        if x > 0:
            edge_trace[e["id"]] = x
        if 0 < x < min_amount:
            below_min += x
            x = 0
        if hop_u >= max_hops:
            if x > 0:
                frontier.append({"edgeId": e["id"], "amount": x})
            continue
        if x > 0:
            v = nodes.setdefault(
                e["dst"], {"layer": hop_u + 1, "tracedIn": 0, "tracedOut": 0, "retained": 0}
            )
            v["layer"] = min(v["layer"], hop_u + 1)
            v["tracedIn"] += x
        if e["dst"] in stop_nodes or node_types.get(e["dst"]) in stop_types:
            if x > 0:
                exits[e["dst"]] = exits.get(e["dst"], 0) + x
            continue
        lots.setdefault(e["dst"], []).append(
            {"amount": e["amount"], "traced": x, "arrivedAt": e["t"]}
        )

    out_nodes = {}
    for node_id, n in nodes.items():
        retained = sum(lot["traced"] for lot in lots.get(node_id, []))
        out_nodes[node_id] = {
            "layer": n["layer"],
            "tracedIn": _cents(n["tracedIn"]),
            "tracedOut": _cents(n["tracedOut"]),
            "retained": _cents(retained),
        }
    exit_total = sum(exits.values())
    return {
        "edgeTrace": {k: _cents(v) for k, v in edge_trace.items()},
        "nodes": out_nodes,
        "exits": {k: _cents(v) for k, v in exits.items()},
        "frontier": [{"edgeId": f["edgeId"], "amount": _cents(f["amount"])} for f in frontier],
        "discarded": {"belowMin": _cents(below_min), "expired": _cents(expired)},
        "seedTotal": _cents(seed_total),
        "exitTotal": _cents(exit_total),
        "coverage": math.floor(exit_total / seed_total * 1e4 + 0.5) / 1e4 if seed_total > 0 else 0,
        "method": {**params, "seedEdgeIds": used_seeds},
    }


def orient_edges(edges: list[dict], direction: str) -> list[dict]:
    """The edges as the trace walks them: backward = reversed and in negated time."""
    if direction != "backward":
        return edges
    return [{**e, "src": e["dst"], "dst": e["src"], "t": -e["t"]} for e in edges]


def trace_backward(
    edges: list[dict], node_types: dict, seed_edge_ids: list[str], params: dict
) -> dict:
    """Backward = forward on reversed edges in negated time (``exits`` are the
    origins reached)."""
    w = params.get("window")
    r = trace_forward(
        orient_edges(edges, "backward"),
        node_types,
        seed_edge_ids,
        {**params, "window": [-w[1], -w[0]] if w else None},
    )
    r["method"]["window"] = w
    return r


def run_trace(edges: list[dict], node_types: dict, seed_edge_ids: list[str], params: dict) -> dict:
    run = trace_backward if params["direction"] == "backward" else trace_forward
    return run(edges, node_types, seed_edge_ids, params)


# ---------------------------------------------------------------------------
# On a case (POST …/analysis/trace and the MCP tool trace_money)
# ---------------------------------------------------------------------------


def end_types(edges: list[dict], node_types: dict, direction: str = "forward") -> list[str]:
    """Node types where value only ends (forward: they receive, none of them
    sends; backward: they send, none receives): the default stops when the
    request names none. Twin of ``endTypes`` in ``composables/useCaseAnalyses.ts``."""
    into, out = ("dst", "src") if direction == "forward" else ("src", "dst")
    reached = {node_types.get(e[into]) for e in edges}
    leaving = {node_types.get(e[out]) for e in edges}
    return sorted(t for t in reached - leaving if t)


def trace_params(req: Any, edges: list[dict], seed_ids: list[str], node_types: dict) -> dict:
    """TS-shaped params from a ``TraceRequest``, with the defaults: window
    seed → +Δ (backward −Δ → seed) and the types where value only ends as stops."""
    direction = req.direction
    span = (req.max_dwell_hours or 24) * HOUR_MS
    window = None
    if req.window:
        window = [parse_time(v) for v in req.window]
        if None in window:
            raise ValueError("window holds an unreadable time")
    else:
        times = [e["t"] for e in edges if e["id"] in set(seed_ids)]
        window = (
            [min(times), max(times) + span]
            if direction == "forward"
            else [min(times) - span, max(times)]
        )
    stop_types = req.stop_types if req.stop_types is not None else end_types(edges, node_types, direction)
    return {
        "direction": direction,
        "maxHops": req.max_hops,
        "maxDwellMs": req.max_dwell_hours * HOUR_MS if req.max_dwell_hours else None,
        "minAmount": req.min_amount or 0,
        "window": window,
        "allocation": req.allocation or ("fifo" if direction == "forward" else "lifo"),
        "stopTypes": list(stop_types),
        "stopNodes": list(req.stop_nodes),
    }


async def _type_defaults(investigation_id: UUID, user_email: str, req: Any) -> Any:
    """The case type's ``analysis_defaults.trace`` for what the request left unset."""
    from graphlagoon.services import case_types
    from graphlagoon.services import cases as service

    if not hasattr(req, "model_fields_set"):
        return req
    case = await service.get_investigation(investigation_id, user_email)
    kind = await case_types.get_case_type(case["case_type"]) or {}
    defaults = ((kind.get("analysis_defaults") or {}).get("trace") or {})
    update = {k: v for k, v in defaults.items() if v is not None and k not in req.model_fields_set}
    return req.model_copy(update=update) if update else req


async def run_case_trace(
    investigation_id: UUID, user_email: str, req: Any, graph: Optional[dict] = None
) -> dict:
    """Trace on the case's unified graph (the sources the caller reads) and
    journal ``trace.run``. ``graph`` lets the MCP tool reuse the one it built."""
    from graphlagoon.services import cases as service
    from graphlagoon.services.case_graph import case_graph, journal_analysis

    req = await _type_defaults(investigation_id, user_email, req)
    if graph is None:
        graph = await case_graph(investigation_id, user_email)
    edges = to_trace_edges(graph["edges"])
    types = {n["uid"]: n["type"] for n in graph["nodes"]}
    if req.seed_node is not None:
        side = "src" if req.direction == "forward" else "dst"
        seed_ids = [e["id"] for e in edges if e[side] == req.seed_node]
    else:
        valued = {e["id"] for e in edges}
        seed_ids = [i for i in req.seed_edge_ids if i in valued]
    if not seed_ids:
        raise service.InvestigationError(
            422,
            "TRACE_SEED_EMPTY",
            "The seed has no edge with an amount and a time (see the context's "
            "edge_semantics)",
        )
    try:
        params = trace_params(req, edges, seed_ids, types)
    except ValueError as exc:
        raise service.InvestigationError(422, "INVALID_BODY", str(exc)) from exc
    result = run_trace(edges, types, seed_ids, params)
    result["method"].update(engine="server", restrictedSources=graph["restricted_sources"])
    await journal_analysis(
        investigation_id,
        user_email,
        "trace.run",
        {
            **result["method"],
            "seedEdgeIds": result["method"]["seedEdgeIds"][:100],
            "seedTotal": result["seedTotal"],
            "exitTotal": result["exitTotal"],
            "coverage": result["coverage"],
        },
    )
    return result
