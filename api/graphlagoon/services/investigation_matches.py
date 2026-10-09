"""Entity matches of a case (F2.8, 03-arquitetura §3.5 and §6.2).

Suggestions come from the browser worker (``POST …/matches``) or from the
server port (MCP ``suggest_matches``); both land here as ``sugerido``. Nothing
is ever merged automatically: only a person's ``aceito`` (``PATCH``, or an
agent's ``match`` proposal a person accepts) makes the workspace alias the two
entities. Every decision needs a reason and goes to the journal.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.services.investigations import (
    InvestigationError,
    _ensure_not_decided,
    _session,
    append_event,
    load_case,
)

_MATCHES = "entity_matches"
DECISIONS = ("aceito", "recusado", "adiado")
# Suggestions still open for a decision; aceito and recusado are final.
OPEN = ("sugerido", "adiado")


def _serialize(m: Any) -> dict:
    return {
        "id": m.id,
        "left": m.left,
        "right": m.right,
        "score": m.score,
        "reasons": m.reasons or [],
        "status": m.status,
        "reason_text": m.reason_text,
        "decided_by": m.decided_by,
        "decided_at": m.decided_at,
        "created_at": m.created_at,
    }


async def _rows(session, investigation_id: UUID) -> list:
    if session is None:
        return get_memory_store().list_investigation_children(_MATCHES, investigation_id)
    from sqlalchemy import select

    from graphlagoon.db.models import EntityMatch

    result = await session.execute(
        select(EntityMatch).where(EntityMatch.investigation_id == investigation_id)
    )
    return list(result.scalars().all())


def _pair(left: dict, right: dict) -> frozenset:
    return frozenset((left.get("uid"), right.get("uid")))


async def list_matches(investigation_id: UUID, user_email: str) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        rows = await _rows(session, investigation_id)
        return [_serialize(m) for m in sorted(rows, key=lambda m: -m.score)]


async def add_suggestions(
    investigation_id: UUID, user_email: str, suggestions: list[dict]
) -> list[dict]:
    """Stores new pairs as ``sugerido`` (a pair already in the case, in any
    status, is skipped) and returns the created ones."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        seen = {_pair(m.left, m.right) for m in await _rows(session, investigation_id)}
        created = []
        for s in suggestions:
            pair = _pair(s["left"], s["right"])
            if len(pair) != 2 or None in pair or pair in seen:
                continue
            seen.add(pair)
            fields = {
                "id": uuid4(),
                "investigation_id": investigation_id,
                "left": s["left"],
                "right": s["right"],
                "score": float(s.get("score") or 0.0),
                "reasons": s.get("reasons") or [],
                "status": "sugerido",
                "created_at": datetime.now(),
            }
            if session is None:
                created.append(get_memory_store().add_investigation_child(_MATCHES, **fields))
            else:
                from graphlagoon.db.models import EntityMatch

                row = EntityMatch(**fields)
                session.add(row)
                created.append(row)
        if created:
            await append_event(
                session, investigation_id, user_email, "match.suggested",
                {"count": len(created)},
            )
            if session is not None:
                await session.commit()
        return [_serialize(m) for m in created]


async def decide_match(
    investigation_id: UUID,
    user_email: str,
    match_id: UUID,
    status: str,
    reason_text: str,
) -> dict:
    """Human decision (the route forbids agents; proposals call it on accept)."""
    reason_text = (reason_text or "").strip()
    if status not in DECISIONS:
        raise InvestigationError(
            422, "INVALID_MATCH_STATUS", f'"status" must be one of {", ".join(DECISIONS)}'
        )
    if not reason_text:
        raise InvestigationError(422, "REASON_REQUIRED", "Say why (it goes to the journal)")
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        m = next((r for r in await _rows(session, investigation_id) if r.id == match_id), None)
        if m is None:
            raise InvestigationError(404, "MATCH_NOT_FOUND", f"Match '{match_id}' not found")
        if m.status not in OPEN:
            raise InvestigationError(409, "MATCH_DECIDED", f"This match was already {m.status}")
        m.status, m.reason_text = status, reason_text
        m.decided_by, m.decided_at = user_email, datetime.now()
        await append_event(
            session, investigation_id, user_email, "match.decided",
            {"match_id": str(match_id), "status": status, "reason": reason_text,
             "left": m.left, "right": m.right, "score": m.score},
        )
        if session is not None:
            await session.commit()
            await session.refresh(m)
        return _serialize(m)
