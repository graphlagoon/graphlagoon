"""Enrichment files (bring your own data, part 2): a table whose rows add
properties to the nodes, or the edges, of a graph already on the canvas.

Two homes, one rule:

- in a case, a ``table`` item with ``mapping.as = "enrichment"`` applied to the
  unified case graph (``case_graph.case_graph``);
- in an exploration, an entry of its overlay, folded into the exploration's
  snapshot when a case reads it (``fold_overlay``).

The spec is ``FileEnrichmentSpec``. Values merge with ``case_graph.merge_props``:
a value already on the node wins and the losing one is recorded as a conflict,
unless the spec says ``overwrite``. Twin of the file part of
``frontend/src/utils/enrichment.ts``.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Optional

from graphlagoon.services import file_mapping
from graphlagoon.services.case_graph import _normalize, merge_props

WILDCARD = "*"
# A cell that reads as a plain number becomes one; leading zeros keep it a string ("00123").
_NUMBER = re.compile(r"-?(0|[1-9]\d*)(\.\d+)?")

Rows = dict[str, list[dict]]


# ---------------------------------------------------------------------------
# Reading the table
# ---------------------------------------------------------------------------


def table_of(data: bytes, content_type: str, spec: dict) -> tuple[list[str], list[list[Any]]]:
    """``(columns, rows)`` of an enrichment file: JSON tables (a query result, a
    promoted run) as they are; text by the spec's ``input`` (delimiter, header)."""
    if content_type.startswith("application/json"):
        from graphlagoon.services.case_tables import parse_table

        return parse_table(data, content_type)
    inp = spec.get("input") or {}
    delimiter = inp.get("delimiter") or ","
    text = file_mapping.decode(data, inp.get("encoding"))
    header = inp.get("header", True)
    columns, body = file_mapping._columns(
        {"delimiter": delimiter, "header": header, "columns": inp.get("columns") or []}, file_mapping._lines(text)
    )
    return columns, [file_mapping.parse_line(line, delimiter) for line in body]


def cell(value: Any) -> Any:
    """A table cell as a property value: empty is missing, a plain number is a number."""
    if not isinstance(value, str):
        return value
    text = value.strip()
    if text == "":
        return None
    if _NUMBER.fullmatch(text):
        return float(text) if "." in text else int(text)
    return text


def key_of(value: Any, spec: dict) -> Optional[str]:
    """A key (a row's or a node's) under the spec: normalized, then cut to the
    first ``key_digits`` digits when set."""
    key = _normalize(value, spec.get("normalize") or "none")
    if key is None:
        return None
    digits = spec.get("key_digits")
    if digits:
        key = re.sub(r"\D", "", key)[:digits] or None
    return key


def _by_endpoints(spec: dict) -> bool:
    return spec.get("target") == "edges" and (spec.get("edge_key") or {}).get("by") == "endpoints"


def _pair(src: str, dst: str, edge_type: Optional[str]) -> str:
    return f"{src}>{dst}" + (f">{edge_type}" if edge_type is not None else "")


def rows_by_key(columns: list[str], rows: list[list[Any]], spec: dict) -> Rows:
    """The rows by key, each with only ``spec.columns`` (values through ``cell``)."""
    at = {c: i for i, c in enumerate(columns)}

    def get(row: list[Any], col: Optional[str]) -> Any:
        i = at.get(col) if col else None
        return row[i] if i is not None and i < len(row) else None

    edge_key = spec.get("edge_key") or {}
    out: Rows = {}
    for row in rows:
        if _by_endpoints(spec):
            src, dst = key_of(get(row, edge_key.get("source_column")), spec), key_of(get(row, edge_key.get("target_column")), spec)
            if src is None or dst is None:
                continue
            type_col = edge_key.get("type_column")
            kind = get(row, type_col) if type_col else None
            key = _pair(src, dst, ("" if kind is None else str(kind)).strip() if type_col else None)
        else:
            key = key_of(get(row, spec.get("key_column")), spec)
            if key is None:
                continue
        out.setdefault(key, []).append({c: cell(get(row, c)) for c in spec.get("columns") or []})
    return out


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def types_match(types: Optional[list[str]], value: Any) -> bool:
    return not types or WILDCARD in types or value in types


def _node_keys(spec: dict, ids: Iterable[str], props: dict, entity_value: Optional[str]) -> list[str]:
    """A node's candidate keys: its id (each original id, when merged) or the
    ``match_source`` property; matching by id also tries the entity value of a
    node merged by identity key (``Person:12345678901`` → ``12345678901``)."""
    src = spec.get("match_source") or "node_id"
    raws: list[Any] = [props.get(src.get("name"))] if isinstance(src, dict) else [*ids, entity_value]
    keys = [k for k in (key_of(r, spec) for r in raws) if k is not None]
    return list(dict.fromkeys(keys))


def _edge_keys(spec: dict, edge_ids: list[str], edge_type: Any, src_keys: list[str], dst_keys: list[str]) -> list[str]:
    if not _by_endpoints(spec):
        return [k for k in (key_of(i, spec) for i in edge_ids) if k is not None]
    typed = (spec.get("edge_key") or {}).get("type_column")
    t = str(edge_type) if typed else None
    pairs = [_pair(s, d, t) for s in src_keys for d in dst_keys]
    return pairs + [_pair(d, s, t) for s in src_keys for d in dst_keys]  # either direction


def _first_row(rows: Rows, keys: list[str]) -> Optional[dict]:
    for k in keys:
        if rows.get(k):
            return rows[k][0]
    return None


def _entity_value(uid: str, entity: Optional[str]) -> Optional[str]:
    return uid[len(entity) + 1:] if entity and uid.startswith(f"{entity}:") else None


# ---------------------------------------------------------------------------
# Applying
# ---------------------------------------------------------------------------


def enrich_graph(graph: dict, spec: dict, rows: Rows, source_id: str) -> int:
    """Applies one file to a unified case graph (``case_graph.unify`` output:
    nodes with ``uid``/``sources``, edges with ``src``/``dst``/``source_id``).
    Returns how many nodes or edges had a row."""
    overwrite = bool(spec.get("overwrite"))
    nodes = graph.get("nodes") or []
    keys_of = {
        n["uid"]: _node_keys(
            spec, [o["node_id"] for o in n.get("sources") or []], n.get("properties") or {}, _entity_value(n["uid"], n.get("entity"))
        )
        for n in nodes
    }
    matched = 0
    if spec.get("target", "nodes") == "nodes":
        for n in nodes:
            row = _first_row(rows, keys_of[n["uid"]]) if types_match(spec.get("match_node_types"), n.get("type")) else None
            if row is not None:
                merge_props(n, row, source_id, overwrite)
                matched += 1
        return matched
    for e in graph.get("edges") or []:
        if not types_match(spec.get("match_edge_types"), e.get("type")):
            continue
        prefix = f"{e.get('source_id')}:"
        original = e["id"][len(prefix):] if str(e.get("id", "")).startswith(prefix) else e.get("id")
        keys = _edge_keys(spec, [str(original)], e.get("type"), keys_of.get(e["src"], []), keys_of.get(e["dst"], []))
        row = _first_row(rows, keys)
        if row is not None:
            merge_props(e, row, source_id, overwrite)
            matched += 1
    return matched


def enrich_snapshot(snapshot: dict, spec: dict, rows: Rows, source_id: str) -> int:
    """Applies one file to a snapshot (``{nodes:[{id,type,properties}],
    edges:[{id,source,target,type,properties}]}``) in place. A snapshot carries no
    conflicts: a value that loses is dropped. Returns how many nodes or edges had a row."""
    overwrite = bool(spec.get("overwrite"))
    nodes = snapshot.get("nodes") or []
    keys_of = {str(n.get("id")): _node_keys(spec, [str(n.get("id"))], n.get("properties") or {}, None) for n in nodes}
    matched = 0
    if spec.get("target", "nodes") == "nodes":
        targets = [(n, keys_of[str(n.get("id"))]) for n in nodes if types_match(spec.get("match_node_types"), n.get("type"))]
    else:
        targets = [
            (e, _edge_keys(spec, [str(e.get("id"))], e.get("type"), keys_of.get(str(e.get("source")), []), keys_of.get(str(e.get("target")), [])))
            for e in snapshot.get("edges") or []
            if types_match(spec.get("match_edge_types"), e.get("type"))
        ]
    for obj, keys in targets:
        row = _first_row(rows, keys)
        if row is None:
            continue
        # As the browser layer: an empty cell sets nothing.
        merge_props(obj, {k: v for k, v in row.items() if v is not None}, source_id, overwrite)
        obj.pop("conflicts", None)
        matched += 1
    return matched


def fold_overlay(snapshot: Optional[dict], overlay: dict) -> dict:
    """An exploration as its owner sees it: the snapshot with the user's layer on top
    (twin of ``applyOverlay`` in ``frontend/src/utils/graphOverlay.ts``). A layer node
    whose id is in the snapshot fills its missing properties; the others are added; a
    layer edge is kept when both endpoints are there; enrichment files apply in order.
    The input is not changed."""
    base = snapshot or {}
    out = {
        **base,
        "nodes": [{**n, "properties": dict(n.get("properties") or {})} for n in base.get("nodes") or []],
        "edges": [{**e, "properties": dict(e.get("properties") or {})} for e in base.get("edges") or []],
    }
    by_id = {str(n.get("id")): n for n in out["nodes"]}
    for o in overlay.get("nodes") or []:
        props = {k: v for k, v in (o.get("properties") or {}).items() if v is not None}
        existing = by_id.get(str(o.get("id")))
        if existing is not None:
            merge_props(existing, props, "overlay")
            existing.pop("conflicts", None)
            continue
        node = {"id": str(o.get("id")), "type": o.get("type"), "properties": props}
        out["nodes"].append(node)
        by_id[node["id"]] = node
    edge_ids = {str(e.get("id")) for e in out["edges"]}
    for o in overlay.get("edges") or []:
        eid, src, dst = str(o.get("id")), str(o.get("source")), str(o.get("target"))
        if eid in edge_ids or src not in by_id or dst not in by_id:
            continue
        out["edges"].append({"id": eid, "source": src, "target": dst, "type": o.get("type"), "properties": dict(o.get("properties") or {})})
        edge_ids.add(eid)
    for f in overlay.get("enrichments") or []:
        enrich_snapshot(out, f["spec"], f.get("rows") or {}, f"overlay:{f.get('id')}")
    return out


# ---------------------------------------------------------------------------
# Case items
# ---------------------------------------------------------------------------


def is_enrichment_item(item: Any) -> bool:
    if item.deleted_at or item.status == "rejected" or item.kind != "table":
        return False
    return bool(item.mapping) and item.mapping.get("as") == "enrichment" and bool(item.current_version)


async def item_rows(session, investigation_id, item: Any) -> Rows:
    """The rows of an enrichment item's latest version, by key."""
    from graphlagoon.services import investigation_storage as storage
    from graphlagoon.services.case_items import version_row

    spec = item.mapping["spec"]
    version = await version_row(session, investigation_id, item, None)
    data = await storage.load(version.blob_key)
    if data is None:
        return {}
    return rows_by_key(*table_of(data, version.content_type, spec), spec)
