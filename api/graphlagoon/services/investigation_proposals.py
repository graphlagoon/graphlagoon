"""Proposals (03-arquitetura §8.4): an agent proposes, a person decides.

Accepting applies the change through the **same** service the UI action calls
(``update_state`` for a role, ``update_investigation`` for status and
typology), so it is journaled exactly like the manual action, and then records
``proposal.accepted`` with who proposed and who accepted. Rejecting needs a
reason. Match and hypothesis proposals wait for their features (F2.8, F4.2).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID, uuid4

from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.services import investigations as cases
from graphlagoon.services.investigations import (
    ROLES,
    InvestigationError,
    _ensure_not_decided,
    _session,
    append_event,
    current_actor,
    load_case,
)

_PROPOSALS = "investigation_proposals"
# Status a proposal may set; "decidido" only comes from the decision (F4.5).
CASE_STATUSES = ("selecao", "analise", "arquivado")
SUPPORTED_KINDS = ("role", "status", "typology")


def _invalid(message: str) -> InvestigationError:
    return InvestigationError(422, "INVALID_PROPOSAL", message)


def validate(kind: str, payload: dict) -> dict:
    """The payload the accept step will apply, normalized."""
    if kind == "role":
        entity, role = payload.get("entity"), payload.get("role")
        if not isinstance(entity, str) or not entity:
            raise _invalid('A role proposal needs "entity" (the unified node id)')
        if role is not None and role not in ROLES:
            raise _invalid(f'"role" must be one of {", ".join(ROLES)} or null')
        return {"entity": entity, "role": role}
    if kind == "status":
        if payload.get("status") not in CASE_STATUSES:
            raise _invalid(f'"status" must be one of {", ".join(CASE_STATUSES)}')
        return {"status": payload["status"]}
    if kind == "typology":
        typology = payload.get("typology")
        if not isinstance(typology, str) or not typology.strip() or len(typology) > 100:
            raise _invalid('A typology proposal needs "typology" (≤ 100 characters)')
        return {"typology": typology.strip()}
    raise InvestigationError(
        422,
        "PROPOSAL_KIND_UNSUPPORTED",
        f"Proposals of kind '{kind}' are not supported yet "
        f"(supported: {', '.join(SUPPORTED_KINDS)})",
    )


def _serialize(p: Any) -> dict:
    return {
        "id": p.id,
        "kind": p.kind,
        "payload": p.payload or {},
        "rationale": p.rationale,
        "actor": p.actor or {},
        "status": p.status,
        "created_at": p.created_at,
        "decided_by": p.decided_by,
        "decided_at": p.decided_at,
        "decision_note": p.decision_note,
    }


async def _get(session, investigation_id: UUID, proposal_id: UUID) -> Any:
    if session is None:
        p = get_memory_store().get_investigation_child(_PROPOSALS, proposal_id)
    else:
        from graphlagoon.db.models import InvestigationProposal

        p = await session.get(InvestigationProposal, proposal_id)
    if p is None or p.investigation_id != investigation_id:
        raise InvestigationError(
            404, "PROPOSAL_NOT_FOUND", f"Proposal with id '{proposal_id}' not found"
        )
    return p


async def list_proposals(
    investigation_id: UUID, user_email: str, status: Optional[str] = None
) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        if session is None:
            rows = get_memory_store().list_investigation_children(
                _PROPOSALS, investigation_id
            )
        else:
            from sqlalchemy import select

            from graphlagoon.db.models import InvestigationProposal

            result = await session.execute(
                select(InvestigationProposal).where(
                    InvestigationProposal.investigation_id == investigation_id
                )
            )
            rows = result.scalars().all()
        rows = [p for p in rows if status is None or p.status == status]
        return [_serialize(p) for p in sorted(rows, key=lambda p: p.created_at)]


async def create_proposal(
    investigation_id: UUID,
    user_email: str,
    kind: str,
    payload: dict,
    rationale: Optional[str],
) -> dict:
    payload = validate(kind, payload)
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        fields = {
            "id": uuid4(),
            "investigation_id": investigation_id,
            "kind": kind,
            "payload": payload,
            "rationale": rationale,
            "actor": current_actor(user_email),
            "status": "pending",
            "created_at": datetime.now(),
        }
        await append_event(
            session,
            investigation_id,
            user_email,
            "proposal.created",
            {
                "proposal_id": str(fields["id"]),
                "kind": kind,
                "payload": payload,
                "rationale": rationale,
            },
        )
        if session is None:
            proposal = get_memory_store().add_investigation_child(_PROPOSALS, **fields)
        else:
            from graphlagoon.db.models import InvestigationProposal

            proposal = InvestigationProposal(**fields)
            session.add(proposal)
            await session.commit()
        return _serialize(proposal)


async def _pending(investigation_id: UUID, user_email: str, proposal_id: UUID):
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        p = await _get(session, investigation_id, proposal_id)
        if p.status != "pending":
            raise InvestigationError(
                409, "PROPOSAL_DECIDED", f"This proposal was already {p.status}"
            )
        return p.kind, dict(p.payload or {})


async def _decide(
    investigation_id: UUID,
    user_email: str,
    proposal_id: UUID,
    status: str,
    note: Optional[str],
) -> dict:
    async with _session() as session:
        p = await _get(session, investigation_id, proposal_id)
        p.status = status
        p.decided_by = user_email
        p.decided_at = datetime.now()
        p.decision_note = note
        await append_event(
            session,
            investigation_id,
            user_email,
            f"proposal.{status}",
            {
                "proposal_id": str(proposal_id),
                "kind": p.kind,
                "payload": p.payload,
                "proposed_by": p.actor,
                "reason": note,
            },
        )
        if session is not None:
            await session.commit()
        return _serialize(p)


async def accept_proposal(
    investigation_id: UUID, user_email: str, proposal_id: UUID
) -> dict:
    """Human only (the route forbids agents).

    shortcut: check-then-apply in two sessions; two people accepting at once
    both apply (idempotent for these kinds). Lock the row if that matters.
    """
    kind, payload = await _pending(investigation_id, user_email, proposal_id)
    if kind == "role":
        await cases.update_state(
            investigation_id, user_email, {payload["entity"]: payload["role"]}, None
        )
    else:  # status | typology: the same PATCH the case header uses
        await cases.update_investigation(investigation_id, user_email, payload)
    return await _decide(investigation_id, user_email, proposal_id, "accepted", None)


async def reject_proposal(
    investigation_id: UUID, user_email: str, proposal_id: UUID, reason: str
) -> dict:
    reason = (reason or "").strip()
    if not reason:
        raise InvestigationError(
            422, "REASON_REQUIRED", "Say why the proposal is rejected"
        )
    await _pending(investigation_id, user_email, proposal_id)
    return await _decide(investigation_id, user_email, proposal_id, "rejected", reason)
