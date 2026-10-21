"""Entity resolution (03-arquitetura §6.2): match suggestions between entities of
the unified case graph, on the server only (``/analysis/er`` and the MCP
``run_analysis`` kind ``er``).

Blocking: two entities are candidates when they share the normalized value of
a blocking attribute (``block_on``: e-mail, phone, document number, date of
birth, …; any property name works). Score: ``0.5·name + 0.3 + 0.2·corroborated``
where ``name`` is the Jaro-Winkler similarity of the normalized names and
``corroborated`` is 1 when a second blocking attribute also agrees; a pair needs
``THRESHOLD``. An identity key already merges exact matches (§2.1), and nothing
here ever merges: a person accepts each match (a suggested ``same_as``).
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any, Optional

from graphlagoon.services.case_graph import _normalize

THRESHOLD = 0.85
# Properties read as the entity's name and blocked on when the caller names none.
NAME_KEYS = ("name", "full_name", "display_name", "legal_name", "title", "label")
DEFAULT_BLOCK_ON = ("email", "phone", "document", "document_number", "national_id", "tax_id", "date_of_birth", "dob")


def _round4(x: float) -> float:
    """Half-up, the same float ops as a TS ``round4`` would (``round`` is half-even)."""
    return math.floor(x * 1e4 + 0.5) / 1e4


def strip_accents(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn"
    )


def normalize_name(value: Any) -> str:
    """Accentless uppercase words of letters and digits."""
    return " ".join(re.sub(r"[^A-Z0-9]+", " ", strip_accents(str(value or "")).upper()).split())


def jaro_winkler(a: str, b: str) -> float:
    if a == b:
        return 1.0 if a else 0.0
    if not a or not b:
        return 0.0
    window = max(max(len(a), len(b)) // 2 - 1, 0)
    a_hit, b_hit = [False] * len(a), [False] * len(b)
    matches = 0
    for i, ch in enumerate(a):
        for j in range(max(0, i - window), min(len(b), i + window + 1)):
            if not b_hit[j] and b[j] == ch:
                a_hit[i] = b_hit[j] = True
                matches += 1
                break
    if matches == 0:
        return 0.0
    a_seq = [c for c, hit in zip(a, a_hit) if hit]
    b_seq = [c for c, hit in zip(b, b_hit) if hit]
    transpositions = sum(x != y for x, y in zip(a_seq, b_seq)) / 2
    jaro = (matches / len(a) + matches / len(b) + (matches - transpositions) / matches) / 3
    prefix = 0
    for x, y in zip(a[:4], b[:4]):
        if x != y:
            break
        prefix += 1
    return jaro + prefix * 0.1 * (1 - jaro)


def _value(props: dict, name: str) -> Any:
    """The property ``name`` (case-insensitive), or None when missing or empty."""
    key = next((k for k in props if k.lower() == name.lower()), None)
    value = props.get(key) if key is not None else None
    return None if value in (None, "") else value


def suggest(nodes: list[dict], block_on: Optional[list[str]] = None, name_keys: Optional[list[str]] = None) -> list[dict]:
    """``nodes``: ``{uid, properties}``. Suggestions ``{left, right, score,
    reasons}`` with ``score ≥ THRESHOLD``, best first."""
    attributes = [a for a in (block_on or DEFAULT_BLOCK_ON) if a]
    names = list(name_keys or NAME_KEYS)
    features: dict[str, dict] = {}
    blocks: dict[str, list[str]] = {}
    for node in nodes:
        props = node.get("properties") or {}
        name = normalize_name(next((v for v in (_value(props, k) for k in names) if v is not None), ""))
        if not name:
            continue
        values = {}
        for attribute in attributes:
            normalized = _normalize(_value(props, attribute), ATTRIBUTE_NORMALIZERS.get(attribute.lower(), "lower"))
            if normalized is not None:
                values[attribute] = normalized
                blocks.setdefault(f"{attribute}\0{normalized}", []).append(node["uid"])
        if values:
            features[node["uid"]] = {"name": name, "values": values}
    seen: set[tuple[str, str]] = set()
    out = []
    for members in blocks.values():
        for i, left in enumerate(members):
            for right in members[i + 1 :]:
                pair = tuple(sorted((left, right)))
                if left == right or pair in seen:
                    continue
                seen.add(pair)
                a, b = features[pair[0]], features[pair[1]]
                agreed = sorted(k for k, v in a["values"].items() if b["values"].get(k) == v)
                jw = _round4(jaro_winkler(a["name"], b["name"]))
                corroborated = 1 if len(agreed) >= 2 else 0
                score = _round4(0.5 * jw + 0.3 + 0.2 * corroborated)
                if score < THRESHOLD:
                    continue
                out.append(
                    {
                        "left": {"uid": pair[0]},
                        "right": {"uid": pair[1]},
                        "score": score,
                        "reasons": [
                            {"term": "name", "weight": 0.5, "value": jw, "left": a["name"], "right": b["name"]},
                            {"term": "shared", "weight": 0.3, "value": 1, "attributes": agreed},
                            {"term": "corroborated", "weight": 0.2, "value": corroborated},
                        ],
                    }
                )
    out.sort(key=lambda m: (-m["score"], m["left"]["uid"], m["right"]["uid"]))
    return out


# ---------------------------------------------------------------------------
# Shared attributes (05 §4b): links. Twin of ``sharedAttributeLinks`` in
# ``utils/sharedLinks.ts`` (fixture ``er/shared-attributes.json``).
# ---------------------------------------------------------------------------


# How a property value is normalized before comparing, by attribute name (twin of
# the TS map); anything else is lowercased, and ``normalize`` overrides per call.
ATTRIBUTE_NORMALIZERS = {
    "phone": "phone", "mobile": "phone", "telephone": "phone",
    "email": "email", "e-mail": "email",
    "device_id": "device_id", "device": "device_id",
    "ip": "ip", "ip_address": "ip",
    "address": "address", "street": "address",
    "card": "card", "card_number": "card",
    "terminal": "terminal_id", "terminal_id": "terminal_id", "serial_number": "terminal_id",
    "account": "account", "account_number": "account",
    "document": "digits", "document_number": "digits", "national_id": "digits", "tax_id": "digits", "ssn": "digits",
}


def shared_attribute_links(
    graph: dict,
    attributes: list[str],
    min_shared: int = 1,
    max_entities: Optional[int] = None,
    entity_types: Optional[list[str]] = None,
    normalize: Optional[dict[str, str]] = None,
) -> dict:
    """``graph``: ``{nodes: [{uid, type, properties}], edges: [{src, dst}]}``.
    Links entities sharing attribute values read from their properties or from
    attribute nodes they connect to; returns ``{edges, pairs}`` with
    ``shares_<attr>`` edges between unified ids. ``normalize`` names the
    normalizer of an attribute (``{"telefone": "phone"}``)."""
    how = {k.lower(): v for k, v in (normalize or {}).items()}
    attributes = [a for a in attributes if a]
    min_shared = max(1, min_shared)
    attr_types = {a.lower() for a in attributes}
    by_uid = {n["uid"]: n for n in graph["nodes"]}
    types = set(entity_types or [])

    def is_entity(n: dict) -> bool:
        return n["type"] in types if types else n["type"].lower() not in attr_types

    neighbours: dict[str, list[dict]] = {}
    for e in graph.get("edges") or []:
        for a, b in ((e["src"], e["dst"]), (e["dst"], e["src"])):
            n = by_uid.get(b)
            if n and n["type"].lower() in attr_types:
                neighbours.setdefault(a, []).append(n)

    shared: dict[tuple[str, str], dict] = {}
    for attribute in attributes:
        lower = attribute.lower()
        groups: dict[str, set[str]] = {}
        for n in graph["nodes"]:
            if not is_entity(n):
                continue
            values: set[str] = set()
            props = n.get("properties") or {}
            key = next((k for k in props if k.lower() == lower), None)
            normalized = _normalize(
                props.get(key) if key is not None else None, how.get(lower) or ATTRIBUTE_NORMALIZERS.get(lower, "lower")
            )
            if normalized is not None:
                values.add(normalized)
            for m in neighbours.get(n["uid"], []):
                if m["type"].lower() == lower:
                    values.add(m["uid"])
            for value in values:
                groups.setdefault(value, set()).add(n["uid"])
        for value, members in groups.items():
            if len(members) < 2 or (max_entities is not None and len(members) > max_entities):
                continue
            ids = sorted(members)
            for i, left in enumerate(ids):
                for right in ids[i + 1 :]:
                    pair = shared.setdefault((left, right), {})
                    pair.setdefault(attribute, (value, len(members)))

    pairs, edges = [], []
    for (left, right), attrs in sorted(shared.items()):
        if len(attrs) < min_shared:
            continue
        names = sorted(attrs)
        pairs.append({"left": left, "right": right, "shared": names})
        for attribute in names:
            value, count = attrs[attribute]
            edges.append(
                {
                    "id": f"link:{attribute}:{left}:{right}",
                    "src": left,
                    "dst": right,
                    "type": f"shares_{attribute}",
                    "properties": {"attribute": attribute, "value": value, "shared_by": count},
                }
            )
    return {"edges": edges, "pairs": pairs}
