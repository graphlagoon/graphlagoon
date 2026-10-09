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
