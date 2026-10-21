"""Case types (06 §1): what an organization investigates, as data. A type is a
``schemas.CaseTypeSpec``: vocabularies, the decision catalog (outcomes and the
actions they set in motion), the case's fields, SLA hours, a notice, the agent's
suggest kinds and playbook. Superusers write them in the admin area; everyone
reads them. ``general`` is built in: no rules, never stored.

A new case copies the type's defaults (vocabularies, suggest kinds, SLA) into
itself, where they stay editable; the catalog, the notice and the playbook are
read live.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store

GENERAL = "general"
GENERAL_SPEC: dict = {
    "label": "General",
    "description": "No rules: free vocabulary, a free-text decision, no deadline.",
}


def _error(status: int, code: str, message: str):
    from graphlagoon.services.cases import InvestigationError

    return InvestigationError(status, code, message)


def normalize(spec: dict) -> dict:
    """The spec with every default filled (the shape ``CaseTypeSpec`` dumps)."""
    from graphlagoon.models.schemas import CaseTypeSpec

    return CaseTypeSpec.model_validate(spec).model_dump()


def _entry(slug: str, spec: dict, updated_at: Optional[datetime], builtin: bool) -> dict:
    return {**normalize(spec), "slug": slug, "builtin": builtin, "updated_at": updated_at}


async def _stored_rows() -> list[tuple[str, dict, datetime]]:
    if not is_database_available():
        return [(r.slug, r.spec, r.updated_at) for r in get_memory_store().case_types.values()]
    from sqlalchemy import select

    from graphlagoon.db.models import CaseType

    async with get_session_maker()() as session:
        rows = (await session.execute(select(CaseType))).scalars().all()
        return [(r.slug, r.spec or {}, r.updated_at) for r in rows]


async def list_case_types() -> list[dict]:
    """``general`` first, then the stored types by label."""
    stored = [_entry(slug, spec, at, False) for slug, spec, at in await _stored_rows()]
    return [_entry(GENERAL, GENERAL_SPEC, None, True), *sorted(stored, key=lambda t: t["label"].lower())]


async def get_case_type(slug: Optional[str]) -> Optional[dict]:
    slug = slug or GENERAL
    if slug == GENERAL:
        return _entry(GENERAL, GENERAL_SPEC, None, True)
    if not is_database_available():
        row = get_memory_store().case_types.get(slug)
        return _entry(slug, row.spec, row.updated_at, False) if row else None
    from graphlagoon.db.models import CaseType

    async with get_session_maker()() as session:
        row = await session.get(CaseType, slug)
        return _entry(slug, row.spec or {}, row.updated_at, False) if row else None


async def require_case_type(slug: Optional[str]) -> dict:
    case_type = await get_case_type(slug)
    if case_type is None:
        raise _error(422, "UNKNOWN_CASE_TYPE", f"No case type '{slug}' (GET /api/org/case-types lists them)")
    return case_type


async def cases_of_type(slug: str) -> int:
    if not is_database_available():
        return sum(1 for i in get_memory_store().investigations.values() if i.case_type == slug)
    from sqlalchemy import func, select

    from graphlagoon.db.models import Investigation

    async with get_session_maker()() as session:
        return (await session.execute(select(func.count()).where(Investigation.case_type == slug))).scalar_one()


async def put_case_type(slug: str, spec: dict) -> dict:
    """Creates or replaces a type (the router validated ``spec``); the
    playbook and the report templates must be docs of the org library."""
    from graphlagoon.services import org_library

    if slug == GENERAL:
        raise _error(409, "CASE_TYPE_BUILTIN", "The general type is built in and cannot be edited")
    clean = normalize(spec)
    if clean.get("playbook") and await org_library.get_doc(clean["playbook"]) is None:
        raise _error(422, "UNKNOWN_PLAYBOOK", f"No org library doc '{clean['playbook']}'")
    for template in clean.get("report_templates") or []:
        doc = await org_library.get_doc(template)
        if doc is None or doc["kind"] != "template":
            raise _error(422, "UNKNOWN_TEMPLATE", f"No report template '{template}' in the org library")
    now = datetime.now()
    if not is_database_available():
        from graphlagoon.db.memory_store import MemoryCaseType

        get_memory_store().case_types[slug] = MemoryCaseType(slug=slug, spec=clean, updated_at=now)
        return _entry(slug, clean, now, False)
    from graphlagoon.db.models import CaseType

    async with get_session_maker()() as session:
        row = await session.get(CaseType, slug)
        if row is None:
            row = CaseType(slug=slug)
            session.add(row)
        row.spec, row.updated_at = clean, now
        await session.commit()
        return _entry(slug, clean, now, False)


async def delete_case_type(slug: str) -> None:
    if slug == GENERAL:
        raise _error(409, "CASE_TYPE_BUILTIN", "The general type is built in and cannot be deleted")
    if await get_case_type(slug) is None:
        raise _error(404, "CASE_TYPE_NOT_FOUND", f"No case type '{slug}'")
    in_use = await cases_of_type(slug)
    if in_use:
        raise _error(409, "CASE_TYPE_IN_USE", f"{in_use} case(s) use '{slug}'; move them to another type first")
    if not is_database_available():
        get_memory_store().case_types.pop(slug, None)
        return
    from graphlagoon.db.models import CaseType

    async with get_session_maker()() as session:
        row = await session.get(CaseType, slug)
        await session.delete(row)
        await session.commit()


# ---------------------------------------------------------------------------
# What a case takes from its type
# ---------------------------------------------------------------------------


def case_defaults(case_type: dict) -> dict:
    """``settings`` and ``sla_hours`` a case of this type starts with."""
    settings: dict[str, Any] = {"vocabularies": dict(case_type["vocabularies"])}
    if case_type.get("agent_suggest_kinds") is not None:
        settings["agent_suggest_kinds"] = list(case_type["agent_suggest_kinds"])
    sla = {k: v for k, v in (case_type.get("sla_hours") or {}).items() if v}
    return {"settings": settings, "sla_hours": sla or None}


def _field_value(field: dict, value: Any) -> Any:
    kind, fid = field["type"], field["id"]
    if kind == "text":
        text = str(value).strip()
        if len(text) > 1000:
            raise _error(422, "INVALID_FIELD", f"'{fid}' is limited to 1000 characters")
        return text
    if kind in ("number", "money"):
        if isinstance(value, bool):
            raise _error(422, "INVALID_FIELD", f"'{fid}' is a number")
        try:
            return float(value) if kind == "money" or not float(value).is_integer() else int(float(value))
        except (TypeError, ValueError):
            raise _error(422, "INVALID_FIELD", f"'{fid}' is a number") from None
    if kind == "date":
        try:
            return date.fromisoformat(str(value)[:10]).isoformat()
        except ValueError:
            raise _error(422, "INVALID_FIELD", f"'{fid}' is a date (YYYY-MM-DD)") from None
    if kind == "enum":
        if str(value) not in field["options"]:
            raise _error(422, "INVALID_FIELD", f"'{fid}' is one of {', '.join(field['options'])}")
        return str(value)
    return value


def clean_fields(case_type: dict, values: dict, current: Optional[dict] = None) -> dict:
    """``current`` merged with ``values`` (a null removes a field), checked
    against the type: unknown ids, wrong types and missing required fields are 422."""
    defs = {f["id"]: f for f in case_type["fields"]}
    out = {k: v for k, v in (current or {}).items() if k in defs}
    for key, value in (values or {}).items():
        if key not in defs:
            raise _error(422, "UNKNOWN_FIELD", f"'{key}' is not a field of the {case_type['label']} type")
        if value is None or value == "":
            out.pop(key, None)
        else:
            out[key] = _field_value(defs[key], value)
    missing = [f["label"] for f in case_type["fields"] if f["required"] and f["id"] not in out]
    if missing:
        raise _error(422, "FIELD_REQUIRED", f"The {case_type['label']} type needs: {', '.join(missing)}")
    return out
