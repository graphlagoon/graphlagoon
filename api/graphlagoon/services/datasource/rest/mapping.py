"""Map a REST connection's response onto the normalized graph shapes.

The contract shape is::

    {"nodes": [{"id", "label", "properties"}, ...],
     "edges": [{"id", "source", "target", "label", "properties"}, ...]}

(after the spec's ``response_mapper`` ran, when one is declared). Everything
here is pure — no I/O — so contract violations and coercion edge cases are all
directly testable.

Strictness is deliberate and asymmetric:

* **Required identity fields are strict.** A node without ``id`` or an edge
  without ``source``/``target`` is reported as an invalid response naming the
  offending index. Connections are dev-configured; a malformed item is a dev
  bug, and dropping it silently would render a graph that quietly lies.
* **Optional fields are forgiving.** Missing ``label`` becomes ``""``, missing
  ``properties`` becomes ``{}``, ids are string-coerced, and a missing edge
  ``id`` is synthesized — remote APIs should not have to care about our
  internals to be usable.
"""

from __future__ import annotations

import json
from typing import Any

from graphlagoon.models.schemas import Edge, Node


class ResponseContractError(ValueError):
    """The response (or the mapper's output) does not match the contract."""


def _require_mapping(payload: Any) -> dict:
    if not isinstance(payload, dict):
        raise ResponseContractError(
            f"Expected a JSON object with 'nodes' and 'edges' lists, "
            f"got {type(payload).__name__}"
        )
    return payload


def _require_list(payload: dict, key: str) -> list:
    value = payload.get(key, [])
    if value is None:
        return []
    if not isinstance(value, list):
        raise ResponseContractError(
            f"'{key}' must be a list, got {type(value).__name__}"
        )
    return value


def _coerce_id(value: Any) -> str:
    """String-coerce an id; numbers are common and fine, structures are not."""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    raise ResponseContractError(f"id must be a string or number, got {value!r}")


def _coerce_properties(value: Any, where: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ResponseContractError(
            f"{where}: 'properties' must be an object, got {type(value).__name__}"
        )
    return value


def to_graph_payload(payload: Any) -> tuple[dict[str, Node], dict[str, Edge]]:
    """Contract JSON -> ``(nodes_by_id, edges_by_id)``.

    Duplicate node ids keep the richer copy (more properties), duplicate edge
    ids keep the first — same tie-breaking the Neptune mapper uses.
    """
    data = _require_mapping(payload)

    nodes: dict[str, Node] = {}
    for i, item in enumerate(_require_list(data, "nodes")):
        if not isinstance(item, dict):
            raise ResponseContractError(f"nodes[{i}]: expected an object")
        if "id" not in item:
            raise ResponseContractError(f"nodes[{i}]: missing required 'id'")
        node_id = _coerce_id(item["id"])
        node = Node(
            node_id=node_id,
            node_type=str(item.get("label") or ""),
            properties=_coerce_properties(item.get("properties"), f"nodes[{i}]"),
        )
        existing = nodes.get(node_id)
        if existing is None or len(node.properties or {}) > len(
            existing.properties or {}
        ):
            nodes[node_id] = node

    edges: dict[str, Edge] = {}
    for i, item in enumerate(_require_list(data, "edges")):
        if not isinstance(item, dict):
            raise ResponseContractError(f"edges[{i}]: expected an object")
        for required in ("source", "target"):
            if required not in item:
                raise ResponseContractError(
                    f"edges[{i}]: missing required '{required}'"
                )
        src = _coerce_id(item["source"])
        dst = _coerce_id(item["target"])
        label = str(item.get("label") or "")
        edge_id = (
            _coerce_id(item["id"]) if "id" in item else f"{src}->{dst}:{label}#{i}"
        )
        edges.setdefault(
            edge_id,
            Edge(
                edge_id=edge_id,
                src=src,
                dst=dst,
                relationship_type=label,
                properties=_coerce_properties(item.get("properties"), f"edges[{i}]"),
            ),
        )

    return nodes, edges


def dangling_endpoint_ids(nodes: dict[str, Node], edges: dict[str, Edge]) -> set[str]:
    """Endpoint ids referenced by edges but absent from the node set."""
    dangling: set[str] = set()
    for edge in edges.values():
        if edge.src not in nodes:
            dangling.add(edge.src)
        if edge.dst not in nodes:
            dangling.add(edge.dst)
    return dangling


def placeholder_node(node_id: str) -> Node:
    """A minimal stand-in for an endpoint the API never returned.

    Rendering an edge requires both endpoints; a placeholder keeps the graph
    drawable while making the gap visible (untyped, no properties) instead of
    silently dropping the edge.
    """
    return Node(node_id=node_id, node_type="", properties={})


def flatten_nodes_tabular(
    nodes: list[Node], row_limit: int
) -> tuple[list[str], list[list[Any]], bool]:
    """Nodes -> ``(columns, rows, truncated)`` for the query console.

    One row per node: identity columns first, then the union of property keys
    in first-seen order. Every cell is a string or None —
    ``TableQueryResponse.rows`` is typed ``list[list[Optional[str]]]`` — with
    containers JSON-serialized, the same choices the Neptune tabular path
    makes.
    """
    property_keys: list[str] = []
    seen: set[str] = set()
    for node in nodes:
        for key in node.properties or {}:
            if key not in seen:
                seen.add(key)
                property_keys.append(key)

    columns = ["node_id", "label", *property_keys]
    truncated = len(nodes) > row_limit

    rows: list[list[Any]] = []
    for node in nodes[:row_limit]:
        properties = node.properties or {}
        row: list[Any] = [node.node_id, node.node_type]
        for key in property_keys:
            value = properties.get(key)
            if value is None:
                row.append(None)
            elif isinstance(value, str):
                row.append(value)
            elif isinstance(value, (int, float, bool)):
                row.append(str(value))
            else:
                row.append(json.dumps(value, default=str))
        rows.append(row)

    return columns, rows, truncated
