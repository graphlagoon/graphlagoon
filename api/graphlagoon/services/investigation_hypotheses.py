"""Hypotheses of a case (03-arquitetura §2.2: ``state.hypotheses[]``, F4.2).

Each hypothesis is ``{id: "H1", text, status, evidence_for, evidence_against,
note, created_by, created_at}``; the evidence lists hold ids of the case's
frozen evidence. Ids are sequential and never reused: there is no delete (a
wrong hypothesis is refuted, which is itself part of the record). People add
and edit them in the dossier (T7); an agent proposes (kinds ``hypothesis`` and
``hypothesis_status``) and accepting calls these same functions.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.services.investigations import (
    InvestigationError,
    _ensure_not_decided,
    _refresh,
    _session,
    append_event,
    load_case,
    serialize,
)

STATUSES = ("aberta", "sustentada", "refutada")
EVIDENCE_FIELDS = ("evidence_for", "evidence_against")


async def _check_evidence(session, investigation_id: UUID, fields: dict) -> None:
    from graphlagoon.services.investigation_evidence import evidence_ids

    wanted = {str(i) for f in EVIDENCE_FIELDS for i in fields.get(f) or []}
    unknown = wanted - await evidence_ids(session, investigation_id) if wanted else set()
    if unknown:
        raise InvestigationError(
            422,
            "EVIDENCE_NOT_IN_CASE",
            f"Unknown evidence for this case: {', '.join(sorted(unknown))}",
        )


async def _save(session, inv, investigation_id: UUID, user_email: str, hypotheses, event):
    state = {**(inv.state or {}), "hypotheses": hypotheses}
    await append_event(session, investigation_id, user_email, *event)
    if session is None:
        get_memory_store().update_investigation(investigation_id, state=state)
    else:
        inv.state = state
        await session.commit()
        await _refresh(session, inv)
    return serialize(inv, user_email)


async def add_hypothesis(
    investigation_id: UUID,
    user_email: str,
    text: str,
    status: str = "aberta",
    evidence_for: Optional[list[str]] = None,
    evidence_against: Optional[list[str]] = None,
    note: Optional[str] = None,
) -> dict:
    text = (text or "").strip()
    if not text:
        raise InvestigationError(422, "INVALID_BODY", "Write the hypothesis")
    if status not in STATUSES:
        raise InvestigationError(422, "INVALID_BODY", f"status must be one of {STATUSES}")
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        hypothesis = {
            "text": text,
            "status": status,
            "evidence_for": [str(i) for i in evidence_for or []],
            "evidence_against": [str(i) for i in evidence_against or []],
            "note": note,
        }
        await _check_evidence(session, investigation_id, hypothesis)
        current = list((inv.state or {}).get("hypotheses") or [])
        hypothesis = {
            "id": f"H{len(current) + 1}",
            **hypothesis,
            "created_by": user_email,
            "created_at": datetime.now().isoformat(),
        }
        return await _save(
            session,
            inv,
            investigation_id,
            user_email,
            [*current, hypothesis],
            ("hypothesis.created", {k: hypothesis[k] for k in ("id", "text", "status", *EVIDENCE_FIELDS)}),
        )


async def update_hypothesis(
    investigation_id: UUID, user_email: str, hypothesis_id: str, changes: dict
) -> dict:
    """Merges ``text``, ``status``, ``evidence_for``, ``evidence_against`` or
    ``note`` (the evidence lists are replaced, not appended)."""
    changes = {
        k: v
        for k, v in changes.items()
        if k in ("text", "status", "note", *EVIDENCE_FIELDS) and v is not None
    }
    if "status" in changes and changes["status"] not in STATUSES:
        raise InvestigationError(422, "INVALID_BODY", f"status must be one of {STATUSES}")
    for f in EVIDENCE_FIELDS:
        if f in changes:
            changes[f] = [str(i) for i in changes[f]]
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        await _check_evidence(session, investigation_id, changes)
        current = list((inv.state or {}).get("hypotheses") or [])
        index = next((i for i, h in enumerate(current) if h.get("id") == hypothesis_id), None)
        if index is None:
            raise InvestigationError(
                404, "HYPOTHESIS_NOT_FOUND", f"Hypothesis '{hypothesis_id}' not found"
            )
        before = current[index]
        changes = {k: v for k, v in changes.items() if before.get(k) != v}
        if not changes:
            return serialize(inv, user_email)
        current[index] = {**before, **changes}
        return await _save(
            session,
            inv,
            investigation_id,
            user_email,
            current,
            (
                "hypothesis.updated",
                {"id": hypothesis_id, "text": before.get("text"), "from_status": before.get("status"), **changes},
            ),
        )
