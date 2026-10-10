"""Entity resolution (03-arquitetura §6.2): match suggestions between entities of
the unified case graph. Server port of ``frontend/src/utils/entityResolution.ts``;
both are checked against ``frontend/src/__tests__/fixtures/er/matches.json``.

Only pair (b) is a suggestion: the 6 central CPF digits equal and at least one
side masked. A full document is already an identity key (§2.1), and nothing
here ever merges: a person accepts each match.

shortcut: no shared-attribute edges (phone, e-mail, address; §6.2 c) and only
node properties (enrichment rows are not entities until promoted).
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any, Optional

from graphlagoon.services.case_graph import _normalize

THRESHOLD = 0.85
_STOPWORDS = frozenset({"DE", "DA", "DO", "DOS", "DAS", "E"})
_MASK = re.compile(r"[*•xX]")


def _round4(x: float) -> float:
    """Half-up, the same float ops as the TS ``round4`` (``round`` is half-even)."""
    return math.floor(x * 1e4 + 0.5) / 1e4


def _key(name: str) -> str:
    return strip_accents(name).lower()


def strip_accents(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn"
    )


def normalize_name(value: Any) -> str:
    text = strip_accents(str(value or "")).upper()
    words = re.sub(r"[^A-Z0-9]+", " ", text).split()
    return " ".join(w for w in words if w not in _STOPWORDS)


def middle_six(value: Any) -> Optional[tuple[str, bool]]:
    """(the 6 central CPF digits, masked?) or None. A CNPJ (has "/" or 14 digits)
    is out: the masked CNPJ shows other digits."""
    raw = str(value or "")
    if "/" in raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if _MASK.search(raw):
        return (digits, True) if len(digits) == 6 else None
    return (digits[3:9], False) if len(digits) == 11 else None


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


def _prop(props: dict, test) -> Any:
    for k, v in props.items():
        if v not in (None, "") and test(_key(k)):
            return v
    return None


def _features(node: dict) -> Optional[dict]:
    props = node.get("properties") or {}
    doc = _prop(props, lambda k: "cpf" in k or k in ("documento", "document", "doc"))
    six = middle_six(doc)
    if six is None:
        return None
    name = _prop(props, lambda k: "nome" in k or k in ("name", "razao_social"))
    cep = re.sub(r"\D", "", str(_prop(props, lambda k: "cep" in k or "zip" in k) or ""))
    return {
        "uid": node["uid"],
        "six": six[0],
        "masked": six[1],
        "name": normalize_name(name),
        "cep5": cep[:5] if len(cep) >= 5 else None,
    }


def suggest(nodes: list[dict]) -> list[dict]:
    """``nodes``: ``{uid, properties}``. Suggestions ``{left, right, score,
    reasons}`` with ``score ≥ THRESHOLD``, best first."""
    blocks: dict[str, list[dict]] = {}
    for node in nodes:
        f = _features(node)
        if f is not None:
            blocks.setdefault(f["six"], []).append(f)
    out = []
    for block in blocks.values():
        for i, a in enumerate(block):
            for b in block[i + 1 :]:
                if a["uid"] == b["uid"] or not (a["masked"] or b["masked"]):
                    continue
                jw = _round4(jaro_winkler(a["name"], b["name"]))
                same_cep = 1 if a["cep5"] and a["cep5"] == b["cep5"] else 0
                score = _round4(0.5 * jw + 0.3 + 0.2 * same_cep)
                if score < THRESHOLD:
                    continue
                out.append(
                    {
                        "left": {"uid": a["uid"]},
                        "right": {"uid": b["uid"]},
                        "score": score,
                        "reasons": [
                            {"term": "name", "weight": 0.5, "value": jw,
                             "left": a["name"], "right": b["name"]},
                            {"term": "cpf_middle6", "weight": 0.3, "value": 1,
                             "masked": True},
                            {"term": "cep5", "weight": 0.2, "value": same_cep},
                        ],
                    }
                )
    out.sort(key=lambda m: (-m["score"], m["left"]["uid"], m["right"]["uid"]))
    return out


# ---------------------------------------------------------------------------
# Shared attributes (05 §4b): Vínculos. Twin of ``sharedAttributeLinks`` in
# ``utils/entityResolution.ts`` (fixture ``er/shared-attributes.json``).
# ---------------------------------------------------------------------------


# How a property value is normalized before comparing, by attribute name (twin of the TS map).
ATTRIBUTE_NORMALIZERS = {
    "telefone": "phone", "phone": "phone", "celular": "phone",
    "email": "email", "e-mail": "email",
    "device_id": "device_id", "dispositivo": "device_id", "device": "device_id",
    "ip": "ip",
    "endereco": "address", "address": "address", "logradouro": "address",
    "cartao": "card", "card": "card",
    "terminal": "terminal_id", "terminal_id": "terminal_id",
    "cpf": "cpf_cnpj", "cnpj": "cpf_cnpj", "cpf_cnpj": "cpf_cnpj", "documento": "cpf_cnpj",
    "conta": "account", "account": "account",
    "chave_pix": "pix_key", "pix_key": "pix_key",
}


def shared_attribute_links(
    graph: dict,
    attributes: list[str],
    min_shared: int = 1,
    max_entities: Optional[int] = None,
    entity_types: Optional[list[str]] = None,
) -> dict:
    """``graph``: ``{nodes: [{uid, type, properties}], edges: [{src, dst}]}``.
    Links entities sharing attribute values read from their properties or from
    attribute nodes they connect to; returns ``{edges, pairs}`` with
    ``compartilha_<attr>`` edges between unified ids."""
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
            normalized = _normalize(props.get(key) if key is not None else None, ATTRIBUTE_NORMALIZERS.get(lower, "lower"))
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
                    "type": f"compartilha_{attribute}",
                    "properties": {"attribute": attribute, "value": value, "shared_by": count},
                }
            )
    return {"edges": edges, "pairs": pairs}
