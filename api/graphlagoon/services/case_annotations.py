"""Case annotations (05 §1, §5, §6): role | tag | group | same_as | hypothesis |
hypothesis_status | typology | status_change over entities (unified ids) or
items. A person's are ``confirmed``; an agent's are ``suggested`` for the kinds
in ``settings.agent_suggest_kinds`` and confirmed or rejected in place.

Values by kind:
- role        targets=[entity], value={"role": "mula"}
- tag         targets=[entity…], value={"tag": "…"}
- group       targets=[entity…], value={"name", "color"?, "closed"?}
- same_as     targets=[keep, drop], value={"score"?, "reasons"?}
- hypothesis  targets=[], value={"text", "status": open|supported|refuted, "evidence_for"?: [item ids], "evidence_against"?: […]}
- hypothesis_status  targets=[hypothesis annotation id], value={"status"}
- typology    targets=[entity…], value={"typology", "norm_ref"?, "label"?, "hits"?, "params"?}
- status_change (written by cases.update_investigation for agents) value={"from", "to"}
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from graphlagoon.services.cases import (
    InvestigationError,
    _session,
    add_row,
    append_event,
    author_fields,
    commit,
    delete_row,
    ensure_not_decided,
    get_row,
    list_rows,
    load_case,
    update_row,
    write_status,
)

TABLE = "case_annotations"
KINDS = ("role", "tag", "group", "same_as", "hypothesis", "hypothesis_status", "typology", "status_change")
HYPOTHESIS_STATUSES = ("open", "supported", "refuted")


def _invalid(message: str) -> InvestigationError:
    return InvestigationError(422, "INVALID_ANNOTATION", message)


def validate(kind: str, targets: list, value: dict) -> None:
    if kind not in KINDS:
        raise _invalid(f"Unknown annotation kind '{kind}'")
    if kind == "role" and (len(targets) != 1 or not value.get("role")):
        raise _invalid("A role annotation targets one entity and names the role")
    if kind == "tag" and (not targets or not value.get("tag")):
        raise _invalid("A tag annotation targets entities and names the tag")
    if kind == "group" and (not targets or not value.get("name")):
        raise _invalid("A group targets entities and has a name")
    if kind == "same_as" and (len(targets) != 2 or targets[0] == targets[1]):
        raise _invalid("same_as targets exactly two different entities (keep, drop)")
    if kind == "hypothesis":
        if not (value.get("text") or "").strip():
            raise _invalid("A hypothesis needs its text")
        if value.get("status", "open") not in HYPOTHESIS_STATUSES:
            raise _invalid(f"hypothesis status must be one of {HYPOTHESIS_STATUSES}")
    if kind == "hypothesis_status" and (len(targets) != 1 or value.get("status") not in HYPOTHESIS_STATUSES):
        raise _invalid("hypothesis_status targets one hypothesis and gives open|supported|refuted")
    if kind == "typology" and not value.get("typology"):
        raise _invalid("A typology annotation names the typology")


def serialize(a: Any) -> dict:
    return {
        "id": a.id,
        "kind": a.kind,
        "targets": a.targets or [],
        "value": a.value or {},
        "reason": a.reason,
        "status": a.status,
        "author_kind": a.author_kind,
        "author_email": a.author_email,
        "agent_token_id": a.agent_token_id,
        "confirmed_by": a.confirmed_by,
        "confirmed_at": a.confirmed_at,
        "created_at": a.created_at,
    }


async def _row(session, investigation_id: UUID, annotation_id: UUID) -> Any:
    row = await get_row(session, TABLE, annotation_id)
    if row is None or row.investigation_id != investigation_id:
        raise InvestigationError(404, "ANNOTATION_NOT_FOUND", f"Annotation '{annotation_id}' not found")
    return row


async def list_annotations(
    investigation_id: UUID,
    user_email: str,
    kind: Optional[str] = None,
    status: Optional[str] = None,
    target: Optional[str] = None,
) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        rows = await list_rows(session, TABLE, investigation_id)
        return [
            serialize(a)
            for a in sorted(rows, key=lambda a: (a.created_at, str(a.id)))
            if (kind is None or a.kind == kind)
            and (status is None or a.status == status)
            and (target is None or target in (a.targets or []))
        ]


async def create_annotation(
    investigation_id: UUID,
    user_email: str,
    kind: str,
    targets: list,
    value: dict,
    reason: Optional[str] = None,
) -> dict:
    targets = [str(t) for t in targets or []]
    value = dict(value or {})
    if kind == "hypothesis":
        value.setdefault("status", "open")
    validate(kind, targets, value)
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        if kind == "hypothesis_status":
            target = await _row(session, investigation_id, UUID(targets[0]))
            if target.kind != "hypothesis":
                raise _invalid("hypothesis_status must target a hypothesis")
        status = write_status(inv, kind)
        if kind == "role" and status == "confirmed":
            # One confirmed role per entity: a new one replaces the previous.
            for old in await list_rows(session, TABLE, investigation_id):
                if old.kind == "role" and old.status == "confirmed" and old.targets == targets:
                    await delete_row(session, TABLE, old)
        row = await add_row(
            session,
            TABLE,
            investigation_id=investigation_id,
            kind=kind,
            targets=targets,
            value=value,
            reason=(reason or "").strip() or None,
            status=status,
            created_at=datetime.now(),
            **author_fields(user_email),
        )
        if kind == "hypothesis_status" and status == "confirmed":
            await _apply_hypothesis_status(session, investigation_id, row)
        await append_event(
            session,
            investigation_id,
            user_email,
            f"{kind}.{'suggested' if status == 'suggested' else 'set'}",
            {"annotation_id": str(row.id), "targets": targets, "value": value, **({"reason": row.reason} if row.reason else {})},
        )
        await commit(session)
        return serialize(row)


async def _apply_hypothesis_status(session, investigation_id: UUID, row: Any) -> None:
    hypothesis = await _row(session, investigation_id, UUID(row.targets[0]))
    await update_row(session, TABLE, hypothesis, value={**(hypothesis.value or {}), "status": row.value["status"]})


async def update_annotation(investigation_id: UUID, user_email: str, annotation_id: UUID, changes: dict) -> dict:
    """Edits value/targets/reason; the author, or an editor of the case."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        row = await _row(session, investigation_id, annotation_id)
        targets = [str(t) for t in changes.get("targets", row.targets) or []]
        value = {**(row.value or {}), **(changes.get("value") or {})}
        validate(row.kind, targets, value)
        await update_row(session, TABLE, row, targets=targets, value=value, reason=changes.get("reason", row.reason))
        await append_event(
            session, investigation_id, user_email, f"{row.kind}.updated",
            {"annotation_id": str(annotation_id), "targets": targets, "value": value},
        )
        await commit(session)
        return serialize(row)


async def delete_annotation(investigation_id: UUID, user_email: str, annotation_id: UUID) -> dict:
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        row = await _row(session, investigation_id, annotation_id)
        await delete_row(session, TABLE, row)
        await append_event(
            session, investigation_id, user_email, f"{row.kind}.removed",
            {"annotation_id": str(annotation_id), "targets": row.targets, "value": row.value},
        )
        await commit(session)
        return {"kind": row.kind}


async def set_status(investigation_id: UUID, user_email: str, annotation_id: UUID, status: str) -> dict:
    """confirm | reject a suggestion (people only; the route forbids agents).
    Confirming applies it: a role replaces the entity's previous one, a
    hypothesis_status moves its hypothesis, a status_change moves the case."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        row = await _row(session, investigation_id, annotation_id)
        if row.status != "suggested":
            raise InvestigationError(409, "NOT_SUGGESTED", "Only a suggestion is confirmed or rejected")
        now = datetime.now()
        await update_row(session, TABLE, row, status=status, confirmed_by=user_email, confirmed_at=now)
        if status == "confirmed":
            if row.kind == "role":
                for old in await list_rows(session, TABLE, investigation_id):
                    if old.kind == "role" and old.status == "confirmed" and old.targets == row.targets and old.id != row.id:
                        await delete_row(session, TABLE, old)
            elif row.kind == "hypothesis_status":
                await _apply_hypothesis_status(session, investigation_id, row)
            elif row.kind == "status_change":
                from graphlagoon.services.cases import check_transition

                check_transition(inv, row.value["to"])
                if session is None:
                    from graphlagoon.db.memory_store import get_memory_store

                    get_memory_store().update_investigation(investigation_id, status=row.value["to"])
                else:
                    inv.status = row.value["to"]
        await append_event(
            session, investigation_id, user_email, f"{row.kind}.{status}",
            {"annotation_id": str(annotation_id), "targets": row.targets, "value": row.value, "author_email": row.author_email},
        )
        await commit(session)
        return serialize(row)


# ---------------------------------------------------------------------------
# Views used by the graph, the exports and the MCP tools
# ---------------------------------------------------------------------------


async def confirmed(session, investigation_id: UUID, kind: str) -> list:
    return [a for a in await list_rows(session, TABLE, investigation_id) if a.kind == kind and a.status == "confirmed"]


async def roles_of(session, investigation_id: UUID) -> dict[str, str]:
    """{entity: role} from the confirmed role annotations."""
    return {a.targets[0]: a.value["role"] for a in await confirmed(session, investigation_id, "role") if a.targets}


async def aliases_of(session, investigation_id: UUID) -> list[tuple[str, str]]:
    """Confirmed same_as pairs as (keep, drop) for ``case_graph.apply_aliases``."""
    return [(a.targets[0], a.targets[1]) for a in await confirmed(session, investigation_id, "same_as")]
