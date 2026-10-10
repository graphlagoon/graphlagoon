"""Paths between two nodes on the server (investigations F3.8, 03 §6.3).

Port of ``frontend/src/utils/paths.ts`` with the same tie-breaking, checked by
``tests/test_paths.py`` against ``frontend/src/__tests__/fixtures/paths/small.json``:
parallel edges collapse to the lightest arc (then the smallest edge id);
neighbours by node id; Dijkstra settles by (distance, node id) and keeps the
first predecessor; Yen orders candidates by (cost, node sequence); costs are
summed from the source in path order.

``run_case_paths`` runs it on a case's unified graph (route and MCP tool).
"""

from __future__ import annotations

import heapq
import math
from typing import Any, Optional
from uuid import UUID

MAX_K = 10
MODES = ("shortest", "weighted", "k-shortest", "earliest")


def _adjacency(edges: list[dict], directed: bool, weight: str) -> dict[str, list[tuple]]:
    """node → [(to, edge id, w)] sorted by ``to``."""
    best: dict[str, dict[str, tuple]] = {}

    def put(frm: str, to: str, edge: str, w: float) -> None:
        cur = best.setdefault(frm, {}).get(to)
        if cur is None or w < cur[2] or (w == cur[2] and edge < cur[1]):
            best[frm][to] = (to, edge, w)

    for e in edges:
        if e["src"] == e["dst"]:
            continue
        w = 1
        if weight == "inverse-amount":
            if e.get("amount") is None or not e["amount"] > 0:
                continue
            w = 1 / e["amount"]
        put(e["src"], e["dst"], e["id"], w)
        if not directed:
            put(e["dst"], e["src"], e["id"], w)
    return {frm: sorted(m.values()) for frm, m in best.items()}


def _path_of(adj: dict, nodes: list[str]) -> dict:
    edges, cost = [], 0
    for a, b in zip(nodes, nodes[1:]):
        arc = next(arc for arc in adj[a] if arc[0] == b)
        edges.append(arc[1])
        cost += arc[2]
    return {"nodes": nodes, "edges": edges, "cost": cost}


def _unwind(pred: dict, source: str, target: str) -> list[str]:
    nodes = [target]
    while nodes[0] != source:
        nodes.insert(0, pred[nodes[0]])
    return nodes


def bfs(adj: dict, source: str, target: str) -> Optional[dict]:
    """Fewest hops."""
    pred = {source: source}
    frontier = [source]
    while frontier and target not in pred:
        nxt = []
        for u in frontier:
            for to, _, _ in adj.get(u, []):
                if to in pred:
                    continue
                pred[to] = u
                nxt.append(to)
        frontier = nxt
    if target not in pred:
        return None
    return _path_of(adj, _unwind(pred, source, target))


def dijkstra(
    adj: dict,
    source: str,
    target: str,
    blocked_nodes: frozenset = frozenset(),
    blocked_arcs: frozenset = frozenset(),
) -> Optional[dict]:
    """Lightest path, avoiding ``blocked_nodes`` and the (from, to) ``blocked_arcs``."""
    dist = {source: 0}
    pred: dict[str, str] = {}
    done: set[str] = set()
    heap = [(0, source)]
    while heap:
        d, u = heapq.heappop(heap)
        if u in done:
            continue
        done.add(u)
        if u == target:
            break
        for to, _, w in adj.get(u, []):
            if to in done or to in blocked_nodes or (u, to) in blocked_arcs:
                continue
            nd = d + w
            if nd < dist.get(to, math.inf):
                dist[to] = nd
                pred[to] = u
                heapq.heappush(heap, (nd, to))
    if target not in done:
        return None
    return _path_of(adj, _unwind(pred, source, target))


def yen(adj: dict, source: str, target: str, k: int) -> list[dict]:
    """Yen's k loopless lightest paths, lightest first."""
    first = dijkstra(adj, source, target)
    if first is None:
        return []
    found, candidates = [first], []
    seen = {tuple(first["nodes"])}
    while len(found) < min(k, MAX_K):
        prev = found[-1]["nodes"]
        for i in range(len(prev) - 1):
            root = prev[: i + 1]
            blocked_arcs = frozenset(
                (p["nodes"][i], p["nodes"][i + 1])
                for p in found
                if p["nodes"][: i + 1] == root
            )
            spur = dijkstra(adj, root[i], target, frozenset(root[:i]), blocked_arcs)
            if spur is None:
                continue
            nodes = root[:i] + spur["nodes"]
            if tuple(nodes) in seen:
                continue
            seen.add(tuple(nodes))
            candidates.append(_path_of(adj, nodes))
        if not candidates:
            break
        candidates.sort(key=lambda p: (p["cost"], p["nodes"]))
        found.append(candidates.pop(0))
    return found


def earliest_arrival(
    edges: list[dict],
    source: str,
    target: str,
    t0: Optional[float],
    max_dwell_ms: Optional[float],
) -> Optional[dict]:
    """Earliest arrival over time-respecting edges: one pass by (t, id). Δ binds
    only intermediate nodes (the source holds the money since t0)."""
    timed = sorted(
        (e for e in edges if e.get("t") is not None and e["src"] != e["dst"]),
        key=lambda e: (e["t"], e["id"]),
    )
    arrival = {source: -math.inf if t0 is None else t0}
    pred: dict[str, dict] = {}
    for e in timed:
        au = arrival.get(e["src"])
        if au is None or e["t"] < au:
            continue
        if max_dwell_ms is not None and e["src"] != source and e["t"] - au > max_dwell_ms:
            continue
        if e["t"] < arrival.get(e["dst"], math.inf):
            arrival[e["dst"]] = e["t"]
            pred[e["dst"]] = e
    if target == source or target not in pred:
        return None
    nodes, ids = [target], []
    while nodes[0] != source:
        e = pred[nodes[0]]
        ids.insert(0, e["id"])
        nodes.insert(0, e["src"])
    return {"nodes": nodes, "edges": ids, "cost": arrival[target]}


def find_paths(edges: list[dict], source: str, target: str, params: dict) -> list[dict]:
    """The paths ``params["mode"]`` asks for (TS-shaped params), best first."""
    if source == target:
        return []
    mode = params["mode"]
    if mode == "earliest":
        p = earliest_arrival(edges, source, target, params["t0"], params["maxDwellMs"])
        return [p] if p else []
    adj = _adjacency(
        edges, params["directed"], "hops" if mode == "shortest" else params["weight"]
    )
    if mode == "k-shortest":
        return yen(adj, source, target, params["k"])
    p = bfs(adj, source, target) if mode == "shortest" else dijkstra(adj, source, target)
    return [p] if p else []


async def run_case_paths(
    investigation_id: UUID, user_email: str, req: Any, graph: Optional[dict] = None
) -> dict:
    """Paths on the case's unified graph and a ``path.run`` journal event. The
    method stamp holds every parameter."""
    from graphlagoon.services import investigations as service
    from graphlagoon.services.case_graph import case_graph, journal_analysis
    from graphlagoon.services.trace import HOUR_MS, parse_time

    if graph is None:
        graph = await case_graph(investigation_id, user_email)
    uids = {n["uid"] for n in graph["nodes"]}
    for uid in (req.source, req.target):
        if uid not in uids:
            raise service.InvestigationError(
                404, "ENTITY_NOT_FOUND", f"No entity '{uid}' in this case"
            )
    t0 = parse_time(req.t0) if req.t0 is not None else None
    if req.t0 is not None and t0 is None:
        raise service.InvestigationError(422, "INVALID_BODY", "t0 is not a readable time")
    params = {
        "mode": req.mode,
        "directed": req.directed,
        "weight": req.weight,
        "k": req.k,
        "t0": t0,
        "maxDwellMs": req.max_dwell_hours * HOUR_MS if req.max_dwell_hours else None,
    }
    paths = find_paths(graph["edges"], req.source, req.target, params)
    method = {
        **params,
        "source": req.source,
        "target": req.target,
        "engine": "server",
        "restrictedSources": graph["restricted_sources"],
    }
    await journal_analysis(
        investigation_id, user_email, "path.run", {**method, "found": len(paths)}
    )
    return {"paths": paths, "method": method}
