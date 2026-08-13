"""Map Neptune openCypher JSON results onto the normalized graph shapes.

Neptune's openCypher HTTPS endpoint returns ``{"results": [ {var: value}, ... ]}``
where graph entities are JSON objects with tilde-prefixed system keys:

- node          ``{"~id", "~entityType": "node", "~labels": [...], "~properties": {}}``
- relationship  ``{"~id", "~entityType": "relationship", "~start", "~end",
                   "~type", "~properties": {}}``
- path          a JSON array alternating node / relationship objects

Everything here is pure — no I/O, no client — so the trickier cases (paths,
``collect()`` lists, multi-label nodes, relationships whose endpoints were not
projected) are all directly testable.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from graphlagoon.models.schemas import Edge, Node

ID = "~id"
ENTITY_TYPE = "~entityType"
LABELS = "~labels"
LABEL = "~label"
TYPE = "~type"
START = "~start"
END = "~end"
PROPERTIES = "~properties"


def is_node(value: Any) -> bool:
    """True for a Neptune node object.

    Falls back to a structural check because some Neptune versions omit
    ``~entityType`` — an object carrying an id and labels is a node either way.
    """
    if not isinstance(value, dict):
        return False
    if value.get(ENTITY_TYPE) == "node":
        return True
    return ID in value and (LABELS in value or LABEL in value) and START not in value


def is_relationship(value: Any) -> bool:
    """True for a Neptune relationship object."""
    if not isinstance(value, dict):
        return False
    if value.get(ENTITY_TYPE) == "relationship":
        return True
    return ID in value and START in value and END in value


def is_path(value: Any) -> bool:
    """True for a path — a list whose members are nodes/relationships."""
    if not isinstance(value, list) or not value:
        return False
    return any(is_node(item) or is_relationship(item) for item in value)


def _labels(obj: dict) -> list[str]:
    labels = obj.get(LABELS)
    if isinstance(labels, list):
        return [str(label) for label in labels if label]
    single = obj.get(LABEL)
    return [str(single)] if single else []


def to_node(obj: dict) -> Node:
    """Convert a Neptune node object into a normalized :class:`Node`.

    A node with several labels keeps the first as its ``node_type`` (the graph
    UI colours and filters by a single type) and exposes the full list as a
    ``~labels`` property, so nothing is silently dropped.
    """
    labels = _labels(obj)
    properties = dict(obj.get(PROPERTIES) or {})
    if len(labels) > 1:
        properties[LABELS] = labels

    return Node(
        node_id=str(obj.get(ID, "")),
        node_type=labels[0] if labels else "",
        properties=properties or None,
    )


def to_edge(obj: dict) -> Edge:
    """Convert a Neptune relationship object into a normalized :class:`Edge`."""
    properties = dict(obj.get(PROPERTIES) or {})
    return Edge(
        edge_id=str(obj.get(ID, "")),
        src=str(obj.get(START, "")),
        dst=str(obj.get(END, "")),
        relationship_type=str(obj.get(TYPE, "") or ""),
        properties=properties or None,
    )


def map_graph_results(
    results: list[dict],
) -> tuple[dict[str, Node], dict[str, Edge], set[str]]:
    """Walk every value in every row and collect the graph it describes.

    Recursive because entities arrive nested in ways the projection decides:
    bare (``RETURN n``), inside a path (``RETURN p``), inside a list from
    ``collect()``, or inside a map literal.

    Returns ``(nodes_by_id, edges_by_id, dangling_node_ids)`` where dangling ids
    are relationship endpoints with no matching node object anywhere in the
    result — the caller resolves those with one follow-up query, which is what
    lets ``MATCH ()-[r]->() RETURN r`` still draw a graph.
    """
    nodes: dict[str, Node] = {}
    edges: dict[str, Edge] = {}

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return
        if is_node(value):
            node = to_node(value)
            # Prefer the richest copy: the same node can appear in several
            # projections, some carrying fewer properties than others.
            existing = nodes.get(node.node_id)
            if existing is None or len(node.properties or {}) > len(
                existing.properties or {}
            ):
                nodes[node.node_id] = node
            return
        if is_relationship(value):
            edge = to_edge(value)
            edges.setdefault(edge.edge_id, edge)
            return
        # A plain map (e.g. RETURN {a: n, b: r}) — keep looking inside.
        for item in value.values():
            visit(item)

    for row in results:
        if isinstance(row, dict):
            for value in row.values():
                visit(value)
        else:
            visit(row)

    dangling: set[str] = set()
    for edge in edges.values():
        for endpoint in (edge.src, edge.dst):
            if endpoint and endpoint not in nodes:
                dangling.add(endpoint)

    return nodes, edges, dangling


def _stringify(value: Any) -> Any:
    """Render one tabular cell.

    Graph entities and containers become JSON text, matching what the warehouse
    path produces for NAMED_STRUCT columns — the frontend's data grid already
    JSON-decodes cells that start with ``{`` or ``[``, so entity cells stay
    inspectable there. Scalars pass through as strings, as they do from the
    statements API.
    """
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float)):
        return str(value)
    return value


def flatten_tabular(
    results: list[dict], row_limit: int
) -> tuple[list[str], list[list[Any]], bool]:
    """Flatten an arbitrary openCypher projection into (columns, rows, truncated).

    Column order follows the query's RETURN clause, which Neptune preserves in
    each row's key order. Later rows may introduce keys the first row lacked
    (an optional match returning null), so the column set is the union in
    first-seen order rather than just the first row's keys.
    """
    columns: list[str] = []
    seen: set[str] = set()
    for row in results:
        if not isinstance(row, dict):
            continue
        for key in row:
            if key not in seen:
                seen.add(key)
                columns.append(key)

    rows: list[list[Any]] = []
    for row in results[:row_limit]:
        if not isinstance(row, dict):
            continue
        rows.append([_stringify(row.get(col)) for col in columns])

    truncated = len(results) > row_limit or len(rows) >= row_limit
    return columns, rows, truncated


def extract_cypher_limit(query: str) -> Optional[int]:
    """Read a trailing ``LIMIT n`` out of a Cypher query, if there is one.

    Used only to decide whether a result should be flagged truncated; an
    unparseable or absent limit simply means "not truncated".
    """
    import re

    match = re.search(r"\bLIMIT\s+(\d+)\s*;?\s*$", query, re.IGNORECASE)
    return int(match.group(1)) if match else None
