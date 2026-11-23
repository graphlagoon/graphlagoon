"""Canvas tables for agents: the no-code neighborhood source of a ``show-table``
context-menu action, run on a case's unified graph.

A port of ``frontend/src/utils/canvasTable.ts`` (``neighborhoodTable``): the
browser runs it on the graph on the canvas, an agent on the same case graph
(``services.case_graph``), with the same uids and the same rows. The fixture
``frontend/src/utils/__tests__/fixtures/canvasTable.json`` is checked by both
test suites. Program sources (JavaScript) run only in the browser's sandboxed
worker: there is no JavaScript on the server.

Metric columns (``metric:<ref>``) are session values of a browser and come back
empty here.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any, Iterable, Optional

MAX_NEIGHBORHOOD_HOPS = 5
MAX_CANVAS_ROWS = 100_000
MAX_CANVAS_COLUMNS = 200
MAX_AUTO_COLUMNS = 50


def canvas_table_actions(context) -> list[dict]:
    """The context's enabled ``show-table`` actions."""
    return [
        a
        for a in (getattr(context, "context_menu_actions", None) or [])
        if isinstance(a, dict) and a.get("kind") == "show-table" and a.get("enabled", True)
        and isinstance(a.get("source"), dict)
    ]


def from_case_graph(graph: dict) -> dict:
    """The case graph (``uid``/``type``, ``id``/``type``) in the canvas shape."""
    return {
        "nodes": [
            {"node_id": str(n["uid"]), "node_type": n.get("type") or "", "properties": n.get("properties") or {}}
            for n in graph.get("nodes", [])
        ],
        "edges": [
            {"edge_id": str(e["id"]), "src": str(e["src"]), "dst": str(e["dst"]),
             "relationship_type": e.get("type") or "", "properties": e.get("properties") or {}}
            for e in graph.get("edges", [])
        ],
    }


def cell(value: Any) -> Optional[str]:
    """One cell as the browser writes it: text, or None."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    try:
        return json.dumps(value, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        return str(value)


def clamp_hops(hops: Any) -> int:
    try:
        n = int(float(hops))
    except (TypeError, ValueError):
        return 1
    return max(1, min(n, MAX_NEIGHBORHOOD_HOPS))


def with_values(spec: dict, values: dict[str, str]) -> dict:
    """The spec with the editable inputs (hops, direction) applied, as the modal does."""
    direction = values.get("direction")
    return {
        **spec,
        "hops": clamp_hops(values.get("hops", spec.get("hops", 1))),
        "direction": direction if direction in ("any", "out", "in") else spec.get("direction") or "any",
    }


def neighborhood_params(spec: dict) -> list[dict]:
    return [
        {"id": "hops", "label": "Hops", "type": "select",
         "options": [str(i + 1) for i in range(MAX_NEIGHBORHOOD_HOPS)],
         "value": str(clamp_hops(spec.get("hops", 1))), "required": True},
        {"id": "direction", "label": "Direction", "type": "select", "options": ["any", "out", "in"],
         "value": spec.get("direction") or "any", "required": True},
    ]


def _type_set(types: Optional[Iterable[str]]) -> Optional[set[str]]:
    kept = {t for t in (types or []) if t}
    return kept or None


def _index(graph: dict):
    nodes = {str(n["node_id"]): n for n in graph["nodes"]}
    out: dict[str, list[dict]] = {}
    inn: dict[str, list[dict]] = {}
    for e in graph["edges"]:
        out.setdefault(str(e["src"]), []).append(e)
        inn.setdefault(str(e["dst"]), []).append(e)
    return nodes, out, inn


def _walk(out, inn, seeds: list[str], hops: int, direction: str, edge_types) -> dict[str, int]:
    allowed = _type_set(edge_types)
    dist: dict[str, int] = {}
    frontier: list[str] = []
    for s in seeds:
        if s not in dist:
            dist[s] = 0
            frontier.append(s)
    for depth in range(1, hops + 1):
        if not frontier:
            break
        nxt = []
        for node_id in frontier:
            steps = []
            if direction != "in":
                steps += [(e, str(e["dst"])) for e in out.get(node_id, [])]
            if direction != "out":
                steps += [(e, str(e["src"])) for e in inn.get(node_id, [])]
            for e, other in steps:
                if allowed and e["relationship_type"] not in allowed:
                    continue
                if other not in dist:
                    dist[other] = depth
                    nxt.append(other)
        frontier = nxt
    return dist


def _property_columns(items: list[dict]) -> list[str]:
    seen: dict[str, None] = {}
    for it in items:
        for key in (it.get("properties") or {}):
            if len(seen) >= MAX_AUTO_COLUMNS:
                return list(seen)
            seen.setdefault(key, None)
    return list(seen)


def _read(column: str, properties: Optional[dict]) -> Optional[str]:
    if column.startswith("metric:"):
        return None
    return cell((properties or {}).get(column))


def neighborhood_table(graph: dict, item: dict, spec: dict, row_limit: int = MAX_CANVAS_ROWS) -> dict:
    """Walk from the item; list the nodes reached (not the clicked node) or the
    edges touching the listed nodes (the clicked node counts). ``{columns, rows,
    truncated}`` exactly as the browser's ``neighborhoodTable``."""
    nodes, out, inn = _index(graph)
    seeds = [str(item["node_id"])] if item["type"] == "node" else [str(item["src"]), str(item["dst"])]
    dist = _walk(out, inn, seeds, clamp_hops(spec.get("hops", 1)), spec.get("direction") or "any", spec.get("edgeTypes"))
    wanted = _type_set(spec.get("nodeTypes"))
    listed = [(i, h) for i, h in dist.items() if i in nodes and (not wanted or nodes[i]["node_type"] in wanted)]
    columns_wanted = spec.get("columns") or []

    if spec.get("list") == "edges":
        allowed = _type_set(spec.get("listEdgeTypes"))
        hop_of = dict(listed)
        found: list[tuple[dict, int]] = []
        seen: set[str] = set()
        for node_id, _ in listed:
            for e in out.get(node_id, []) + inn.get(node_id, []):
                if e["edge_id"] in seen or (allowed and e["relationship_type"] not in allowed):
                    continue
                seen.add(e["edge_id"])
                inf = float("inf")
                found.append((e, min(hop_of.get(str(e["src"]), inf), hop_of.get(str(e["dst"]), inf))))
        found.sort(key=lambda pair: pair[1])
        props = columns_wanted or _property_columns([e for e, _ in found])
        columns = (["edge_id", "relationship_type", "src", "dst", "hop"] + props)[:MAX_CANVAS_COLUMNS]
        rows = [
            ([e["edge_id"], e["relationship_type"], str(e["src"]), str(e["dst"]), str(int(hop))]
             + [_read(c, e.get("properties")) for c in props])[:MAX_CANVAS_COLUMNS]
            for e, hop in found[:row_limit]
        ]
        return {"columns": columns, "rows": rows, "truncated": len(found) > row_limit}

    clicked = set(seeds) if item["type"] == "node" else set()
    reached = sorted(((nodes[i], h) for i, h in listed if i not in clicked), key=lambda pair: pair[1])
    props = columns_wanted or _property_columns([n for n, _ in reached])
    columns = (["node_id", "node_type", "hop"] + props)[:MAX_CANVAS_COLUMNS]
    rows = [
        ([str(n["node_id"]), n["node_type"], str(hop)] + [_read(c, n.get("properties")) for c in props])[:MAX_CANVAS_COLUMNS]
        for n, hop in reached[:row_limit]
    ]
    return {"columns": columns, "rows": rows, "truncated": len(reached) > row_limit}
