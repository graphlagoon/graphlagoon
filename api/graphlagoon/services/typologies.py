"""Typology badges (F4.3, 03-arquitetura §6.4): port of
frontend/src/utils/typologies.ts, same hits on
``frontend/src/__tests__/fixtures/typologies/small.json``. Used by the
``…/analysis/typologies`` route and the MCP tool ``run_typologies``.

Input: ``{"nodes": [{"id", "type"}], "edges": [{"id", "src", "dst", "amount",
"t"}]}`` (t in epoch ms). Badges only suggest; a person accepts one in the
workspace and that writes ``typology.accepted``.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Optional
from uuid import UUID

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS
CYCLE_STEP_LIMIT = 200_000  # shortcut: same ceiling as the TS core


def _money(x: float) -> str:
    return f"{x:.2f}"


def _num(x: float) -> str:
    """Integers bare ("7"), others with 2 decimals, like the TS ``num``."""
    return str(int(x)) if float(x).is_integer() else f"{x:.2f}"


def _sum(es: list) -> float:
    total = 0.0
    for e in es:  # left to right, like Array.reduce
        total += e["amount"]
    return total


def _ids(es: list) -> list[str]:
    return sorted({e["id"] for e in es})


def _by_time(e: dict):
    return (e["t"], e["id"])


def _money_edges(g: dict) -> list[dict]:
    return [
        e for e in g["edges"]
        if e["src"] != e["dst"] and e.get("amount") is not None and e["amount"] > 0
    ]


def _group_by(edges: list, key: str) -> list[tuple[str, list]]:
    groups: dict[str, list] = {}
    for e in edges:
        groups.setdefault(e[key], []).append(e)
    return sorted(groups.items())


def _first_window(edges: list, window_ms: float, ok: Callable[[list], bool]) -> Optional[list]:
    timed = sorted((e for e in edges if e.get("t") is not None), key=_by_time)
    untimed = [e for e in edges if e.get("t") is None]
    if not timed:
        return untimed if ok(untimed) else None
    for i, first in enumerate(timed):
        w = list(untimed)
        for e in timed[i:]:
            if e["t"] > first["t"] + window_ms:
                break
            w.append(e)
        if ok(w):
            return w
    return None


def _distinct_ends(key: str, what: str):
    def detect(g: dict, p: dict) -> list[dict]:
        def count(w):
            return len({e[key] for e in w})

        hits = []
        for node_id, edges in _group_by(_money_edges(g), "dst" if key == "src" else "src"):
            w = _first_window(edges, p["windowDays"] * DAY_MS, lambda es: count(es) >= p["minDistinct"])
            if w is not None:
                hits.append({
                    "nodeId": node_id,
                    "evidenceEdgeIds": _ids(w),
                    "explanation": f"{count(w)} distinct {what} within {_num(p['windowDays'])} d",
                })
        return hits

    return detect


def _passagem(g: dict, p: dict) -> list[dict]:
    edges = [e for e in _money_edges(g) if e.get("t") is not None]
    outs = dict(_group_by(edges, "src"))
    hits = []
    for node_id, ins in _group_by(edges, "dst"):
        out = sorted(outs.get(node_id, []), key=_by_time)
        left = {o["id"]: o["amount"] for o in out}
        passed, used, sent = [], {}, 0.0
        # FIFO: each inflow draws on what is left of the outflows in its window [t, t + Δ].
        for e in sorted(ins, key=_by_time):
            takes, covered = [], 0.0
            for o in out:
                if covered >= e["amount"]:
                    break
                if not (e["t"] <= o["t"] <= e["t"] + p["deltaHours"] * HOUR_MS) or not left[o["id"]] > 0:
                    continue
                take = min(left[o["id"]], e["amount"] - covered)
                takes.append((o, take))
                covered += take
            if covered < p["minOutRatio"] * e["amount"]:
                continue
            passed.append(e)
            sent += covered
            for o, take in takes:
                left[o["id"]] -= take
                used[o["id"]] = o
        if not passed:
            continue
        hits.append({
            "nodeId": node_id,
            "evidenceEdgeIds": _ids(passed + list(used.values())),
            "explanation": (
                f"{len(passed)} inflow(s) of {_money(_sum(passed))} passed on within "
                f"{_num(p['deltaHours'])} h ({_money(sent)} out)"
            ),
        })
    return hits


def _fracionamento(g: dict, p: dict) -> list[dict]:
    by_node: dict[str, dict[str, list]] = {}
    for e in _money_edges(g):
        for node, side in ((e["dst"], "in"), (e["src"], "out")):
            by_node.setdefault(node, {"in": [], "out": []})[side].append(e)
    hits = []
    for node_id in sorted(by_node):
        evidence, parts = [], []
        for side, verb in (("in", "received"), ("out", "sent")):
            below = [e for e in by_node[node_id][side] if e["amount"] < p["limit"]]
            w = _first_window(
                below,
                p["windowDays"] * DAY_MS,
                lambda es: len(es) >= p["minCount"] and _sum(es) >= p["limit"],
            )
            if w is not None:
                evidence += w
                parts.append(
                    f"{verb} {len(w)} below {_num(p['limit'])} summing {_money(_sum(w))} "
                    f"within {_num(p['windowDays'])} d"
                )
            near = [e for e in below if e["amount"] >= p["nearRatio"] * p["limit"]]
            if near:
                evidence += near
                parts.append(f"{verb} {len(near)} just below {_num(p['limit'])}")
        if parts:
            hits.append({"nodeId": node_id, "evidenceEdgeIds": _ids(evidence), "explanation": "; ".join(parts)})
    return hits


def _ciclo_temporal(g: dict, p: dict) -> list[dict]:
    out: dict[str, list] = {}
    for e in _money_edges(g):
        if e.get("t") is not None:
            out.setdefault(e["src"], []).append(e)
    for lst in out.values():
        lst.sort(key=_by_time)
    steps = 0
    reported: set[str] = set()
    hits = []
    for start in sorted(out):
        path: list = []
        seen = {start}

        def walk(node: str) -> Optional[list]:
            nonlocal steps
            for e in out.get(node, []):
                steps += 1
                if steps > CYCLE_STEP_LIMIT:
                    return None
                if path and e["t"] < path[-1]["t"]:
                    continue
                if e["dst"] == start:
                    cycle = path + [e]
                    key = "|".join(_ids(cycle))
                    if (
                        len(cycle) >= p["minLength"]
                        and e["amount"] >= p["minReturnRatio"] * cycle[0]["amount"]
                        and key not in reported
                    ):
                        reported.add(key)
                        return cycle
                    continue
                if e["dst"] in seen or len(path) + 1 >= p["maxLength"]:
                    continue
                seen.add(e["dst"])
                path.append(e)
                found = walk(e["dst"])
                path.pop()
                seen.discard(e["dst"])
                if found:
                    return found
            return None

        cycle = walk(start)
        if not cycle:
            continue
        hits.append({
            "nodeId": start,
            "evidenceEdgeIds": _ids(cycle),
            "explanation": (
                f"{len(cycle)}-hop cycle in time order returned "
                f"{_money(cycle[-1]['amount'])} of {_money(cycle[0]['amount'])}"
            ),
        })
    return hits


def _hub_atributo(g: dict, p: dict) -> list[dict]:
    type_of = {n["id"]: n["type"] for n in g["nodes"]}
    linked: set[tuple[str, str]] = set()
    links: dict[str, dict[str, str]] = {}
    for e in g["edges"]:
        if e["src"] == e["dst"]:
            continue
        linked.update({(e["src"], e["dst"]), (e["dst"], e["src"])})
        if e.get("amount") is not None and e["amount"] > 0:
            continue  # money is a flow, not a shared element
        for a, b in ((e["src"], e["dst"]), (e["dst"], e["src"])):
            m = links.setdefault(a, {})
            if b not in m or e["id"] < m[b]:
                m[b] = e["id"]
    hits = []
    for hub in sorted(links):
        by_type: dict[str, list[str]] = {}
        for n in sorted(links[hub]):
            t = type_of.get(n, "")
            if t == type_of.get(hub, ""):
                continue
            by_type.setdefault(t, []).append(n)
        groups = sorted(
            (t, [m for m in ms if not any(o != m and (m, o) in linked for o in ms)])
            for t, ms in by_type.items()
        )
        groups = [(t, ms) for t, ms in groups if len(ms) >= p["minShared"]]
        if not groups:
            continue
        hits.append({
            "nodeId": hub,
            "evidenceEdgeIds": sorted(links[hub][m] for _, ms in groups for m in ms),
            "explanation": "shared by " + ", ".join(f"{len(ms)} unrelated {t}" for t, ms in groups),
        })
    return hits


def _dormente_reativada(g: dict, p: dict) -> list[dict]:
    by_node: dict[str, list] = {}
    for e in _money_edges(g):
        if e.get("t") is not None:
            for node in (e["src"], e["dst"]):
                by_node.setdefault(node, []).append(e)
    hits = []
    for node_id in sorted(by_node):
        es = sorted(by_node[node_id], key=_by_time)
        for i in range(1, len(es)):
            gap = es[i]["t"] - es[i - 1]["t"]
            if gap < p["dormantDays"] * DAY_MS:
                continue
            burst = [e for e in es if es[i]["t"] <= e["t"] <= es[i]["t"] + p["windowDays"] * DAY_MS]
            if _sum(burst) < p["minVolume"]:
                continue
            hits.append({
                "nodeId": node_id,
                "evidenceEdgeIds": _ids(burst),
                "explanation": (
                    f"idle {math.floor(gap / DAY_MS)} d, then {_money(_sum(burst))} "
                    f"within {_num(p['windowDays'])} d"
                ),
            })
            break
    return hits


# Same order, labels, references and defaults as TYPOLOGIES in typologies.ts.
TYPOLOGIES: list[dict[str, Any]] = [
    {"id": "passagem", "label": "Pass-through account: money in, ≥ 90% out within Δ",
     "normRef": "CC 4.001 IV-k, IV-ad", "params": {"deltaHours": 24, "minOutRatio": 0.9},
     "detect": _passagem},
    {"id": "concentracao_entradas", "label": "Many unrelated origins pay in",
     "normRef": "CC 4.001 I-h, IV-n", "params": {"minDistinct": 10, "windowDays": 7},
     "detect": _distinct_ends("src", "origins")},
    {"id": "dispersao_saidas", "label": "Pays out to many destinations",
     "normRef": "CC 4.001 IV-o, IV-p", "params": {"minDistinct": 10, "windowDays": 7},
     "detect": _distinct_ends("dst", "destinations")},
    {"id": "fracionamento", "label": "Structuring: split below the limit",
     "normRef": "CC 4.001 I-d, I-e, I-k, I-m, IV-b",
     "params": {"limit": 50000, "minCount": 3, "windowDays": 7, "nearRatio": 0.9},
     "detect": _fracionamento},
    {"id": "ciclo_temporal", "label": "Money comes back in a time-ordered cycle",
     "normRef": "CC 4.001 (layering)",
     "params": {"minLength": 2, "maxLength": 6, "minReturnRatio": 0.5},
     "detect": _ciclo_temporal},
    {"id": "hub_atributo",
     "label": "Unrelated parties share an element (device, IP, phone, address, account, partner)",
     "normRef": "CC 4.001 III-f, III-i, III-k, III-l", "params": {"minShared": 3},
     "detect": _hub_atributo},
    {"id": "dormente_reativada", "label": "Dormant account reactivated with volume",
     "normRef": "CC 4.001 IV-e, IV-f",
     "params": {"dormantDays": 180, "minVolume": 10000, "windowDays": 30},
     "detect": _dormente_reativada},
]
TYPOLOGY_IDS = tuple(t["id"] for t in TYPOLOGIES)


def run_typologies(
    graph: dict, params: Optional[dict] = None, only: Optional[list[str]] = None
) -> list[dict]:
    """Every typology (or ``only``) with the defaults overridden by ``params[id]``."""
    params = params or {}
    results = []
    for t in TYPOLOGIES:
        if only is not None and t["id"] not in only:
            continue
        merged = {**t["params"], **(params.get(t["id"]) or {})}
        results.append({
            "id": t["id"], "label": t["label"], "normRef": t["normRef"], "params": merged,
            "hits": t["detect"](graph, merged),
        })
    return results


async def run_case_typologies(
    investigation_id: UUID,
    user_email: str,
    only: Optional[list[str]] = None,
    params: Optional[dict] = None,
    graph: Optional[dict] = None,
) -> dict:
    """Typologies on the case's unified graph (restricted sources are left out
    and counted). Read-only: nothing is journaled until a person accepts a badge."""
    from graphlagoon.services import investigations as service
    from graphlagoon.services.case_graph import case_graph

    unknown = sorted(set(only or []) - set(TYPOLOGY_IDS))
    if unknown:
        raise service.InvestigationError(
            422, "UNKNOWN_TYPOLOGY", f"Unknown typologies {unknown}; known: {list(TYPOLOGY_IDS)}"
        )
    if graph is None:
        graph = await case_graph(investigation_id, user_email)
    g = {
        "nodes": [{"id": n["uid"], "type": n.get("type") or ""} for n in graph["nodes"]],
        "edges": [
            {"id": e["id"], "src": e["src"], "dst": e["dst"], "amount": e["amount"], "t": e["t"]}
            for e in graph["edges"]
        ],
    }
    return {
        "typologies": run_typologies(g, params, only),
        "method": {"engine": "server", "restrictedSources": graph["restricted_sources"]},
    }
