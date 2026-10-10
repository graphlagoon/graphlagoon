"""Org vocabularies (05 §4b, §6): suggestions for roles, tags, typologies and
link attributes, per case preset, never imposed. The seed (the presets'
defaults and the CC 4.001 typologies) is the fallback for a kind nobody has
edited; ``PUT`` stores an override, ``DELETE`` restores the seed. The case
settings drawer and the ``list_vocabulary`` MCP tool read them."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.services.cases import KIND_PRESETS, PRESET_DEFAULTS
from graphlagoon.services.typologies import TYPOLOGIES

KINDS = ("role", "tag", "typology", "link_attribute")


def _from_presets(field: str) -> list[dict]:
    values: dict[str, list[str]] = {}
    for preset in KIND_PRESETS:
        for value in PRESET_DEFAULTS[preset].get(field, []):
            values.setdefault(value, []).append(preset)
    return [{"value": v, "presets": presets} for v, presets in values.items()]


SEED: dict[str, list[dict]] = {
    "role": _from_presets("roles"),
    "tag": [
        {"value": "dossie", "label": "Goes to the dossier", "presets": []},
        {"value": "prioridade", "label": "Priority", "presets": []},
        {"value": "descartado", "label": "Discarded", "presets": []},
    ],
    "typology": [
        {"value": t["id"], "label": t["label"], "norm_ref": t["normRef"], "presets": ["pix_med", "lavagem", "lojista", "fraude_sintetica"]}
        for t in TYPOLOGIES
    ],
    "link_attribute": _from_presets("link_attributes"),
}


def validate_values(values: Any) -> list[dict]:
    """``[{value, label?, presets?, norm_ref?}]``; a bare string is a value."""
    if not isinstance(values, list):
        raise ValueError("values must be a list")
    out, seen = [], set()
    for raw in values:
        entry = {"value": raw} if isinstance(raw, str) else dict(raw or {})
        value = str(entry.get("value") or "").strip()
        if not value or value in seen:
            raise ValueError("each entry needs a unique, non-empty value")
        seen.add(value)
        presets = [p for p in entry.get("presets") or [] if p in KIND_PRESETS]
        clean = {"value": value, "presets": presets}
        for key in ("label", "norm_ref"):
            if entry.get(key):
                clean[key] = str(entry[key]).strip()
        out.append(clean)
    return out


def _entry(kind: str, values: list, updated_at: Optional[datetime], seeded: bool) -> dict:
    return {"kind": kind, "values": values, "updated_at": updated_at, "seeded": seeded}


async def _stored(kind: str) -> Optional[dict]:
    if not is_database_available():
        row = get_memory_store().org_vocabularies.get(kind)
        return _entry(kind, list(row.values), row.updated_at, False) if row else None

    from graphlagoon.db.models import OrgVocabulary

    async with get_session_maker()() as session:
        row = await session.get(OrgVocabulary, kind)
        return _entry(kind, list(row.values or []), row.updated_at, False) if row else None


async def get_vocabulary(kind: str) -> Optional[dict]:
    if kind not in KINDS:
        return None
    return await _stored(kind) or _entry(kind, SEED[kind], None, True)


async def list_vocabularies() -> list[dict]:
    return [await get_vocabulary(kind) for kind in KINDS]


def values_for(vocabulary: dict, preset: Optional[str] = None) -> list[str]:
    """The plain values, those of ``preset`` first (entries with no preset apply to all)."""
    entries = vocabulary["values"]
    if not preset:
        return [e["value"] for e in entries]
    own = [e["value"] for e in entries if preset in (e.get("presets") or [])]
    rest = [e["value"] for e in entries if not e.get("presets")]
    return own + [v for v in rest if v not in own]


async def put_vocabulary(kind: str, values: Any) -> dict:
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    clean = validate_values(values)
    if not is_database_available():
        from graphlagoon.db.memory_store import MemoryOrgVocabulary

        row = MemoryOrgVocabulary(kind=kind, values=clean, updated_at=datetime.now())
        get_memory_store().org_vocabularies[kind] = row
        return _entry(kind, clean, row.updated_at, False)

    from graphlagoon.db.models import OrgVocabulary

    async with get_session_maker()() as session:
        row = await session.get(OrgVocabulary, kind)
        if row is None:
            row = OrgVocabulary(kind=kind)
            session.add(row)
        row.values, row.updated_at = clean, datetime.now()
        await session.commit()
        await session.refresh(row)
        return _entry(kind, list(row.values), row.updated_at, False)


async def delete_vocabulary(kind: str) -> bool:
    """Drops the override (the seed shows again). False when none was stored."""
    if not is_database_available():
        return get_memory_store().org_vocabularies.pop(kind, None) is not None

    from graphlagoon.db.models import OrgVocabulary

    async with get_session_maker()() as session:
        row = await session.get(OrgVocabulary, kind)
        if row is None:
            return False
        await session.delete(row)
        await session.commit()
        return True
