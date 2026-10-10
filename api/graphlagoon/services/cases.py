"""Cases (05-plano-v2 §1, §6, §7): access rules, CRUD, sharing, the append-only
journal and the decision, on PostgreSQL or the in-memory store.

Access:
- read: owner, assignee, any share, superuser;
- write: owner, assignee, editor share;
- manage (delete, share, assign): owner or superuser.

A case the caller cannot read is reported as 404, never 403, so its existence
does not leak (tipping-off). Shares are nominal e-mails only.

Writes record their author: a person writes ``confirmed``; an agent writes
``author_kind=agent`` and, for the kinds in ``settings.agent_suggest_kinds``,
``suggested`` (05 §6).
"""

from __future__ import annotations

import hashlib
import json
import math
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID, uuid4

from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.middleware.auth import get_current_actor
from graphlagoon.utils.authz import can_manage, is_superuser
from graphlagoon.utils.sharing import validate_owner_email


class InvestigationError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def _not_found(investigation_id: UUID) -> InvestigationError:
    return InvestigationError(
        404, "INVESTIGATION_NOT_FOUND", f"Investigation with id '{investigation_id}' not found"
    )


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------


def _shared(inv: Any, user_email: str, *, write: bool = False) -> bool:
    return any(
        s.email == user_email and (not write or s.role == "editor") for s in inv.shares
    )


def can_read_case(inv: Any, user_email: str) -> bool:
    actor = get_current_actor()  # a case-scoped token sees only its cases (05 §6)
    if actor and actor.get("scope") == "case":
        if str(inv.id) not in actor.get("investigation_ids", []):
            return False
    return (
        inv.owner_email == user_email
        or inv.assignee_email == user_email
        or is_superuser(user_email)
        or _shared(inv, user_email)
    )


def can_write_case(inv: Any, user_email: str) -> bool:
    return (
        inv.owner_email == user_email
        or inv.assignee_email == user_email
        or _shared(inv, user_email, write=True)
    )


def can_manage_case(inv: Any, user_email: str) -> bool:
    return can_manage(inv.owner_email, user_email)


def nominal_email(email: str) -> str:
    """A single named e-mail; wildcards are refused (tipping-off prohibition)."""
    candidate = (email or "").strip()
    if "*" in candidate:
        raise InvestigationError(
            422,
            "WILDCARD_SHARE_REFUSED",
            "Investigations can only be shared with named e-mails. Wildcards "
            '("*", "*@domain") are refused: the tipping-off prohibition '
            "(Lei 9.613/98 art. 11, LC 105/01) requires need-to-know access.",
        )
    ok, message = validate_owner_email(candidate)
    if not ok:
        raise InvestigationError(422, "INVALID_EMAIL", message)
    return candidate


# ---------------------------------------------------------------------------
# Authorship (05 §6)
# ---------------------------------------------------------------------------

DEFAULT_SUGGEST_KINDS = ("role", "tag", "hypothesis_status", "same_as", "status_change", "typology")


def author_fields(user_email: str) -> dict:
    """``author_kind``, ``author_email`` and ``agent_token_id`` of the current writer."""
    agent = get_current_actor()
    return {
        "author_kind": "agent" if agent else "human",
        "author_email": user_email,
        "agent_token_id": agent["token_id"] if agent else None,
    }


def write_status(inv: Any, kind: str) -> str:
    """``suggested`` when an agent writes one of the case's suggest kinds; else confirmed."""
    if not get_current_actor():
        return "confirmed"
    kinds = (inv.settings or {}).get("agent_suggest_kinds")
    if kinds is None:
        kinds = DEFAULT_SUGGEST_KINDS
    return "suggested" if kind in kinds else "confirmed"


# ---------------------------------------------------------------------------
# Status, deadlines (05 §3, §7)
# ---------------------------------------------------------------------------

KIND_PRESETS = ("credito", "garantia", "pix_med", "lavagem", "lojista", "fraude_sintetica", "livre")

# Vocabularies a preset suggests (05 §4b); never imposed, editable in the case's settings.
# Twin of ``frontend/src/utils/casePresets.ts``.
PRESET_DEFAULTS: dict[str, dict] = {
    "credito": {"roles": ["controlador", "coligada", "garantidor", "devedor"], "link_attributes": ["endereco", "telefone", "email"]},
    "garantia": {"roles": ["devedor", "adquirente", "cessionário", "bem"], "link_attributes": ["endereco", "email"]},
    "pix_med": {"roles": ["vítima", "mula", "beneficiário final", "ponto de saque"], "link_attributes": ["telefone", "device_id"]},
    "lavagem": {"roles": ["origem", "passagem", "destino", "laranja"], "link_attributes": ["endereco", "telefone"]},
    "lojista": {"roles": ["lojista", "sócio", "adquirente", "terminal"], "link_attributes": ["terminal", "endereco", "telefone"]},
    "fraude_sintetica": {
        "roles": ["identidade real", "identidade sintética", "mula", "ponto de cash-out"],
        "link_attributes": ["telefone", "email", "device_id", "endereco"],
    },
    "livre": {"roles": [], "link_attributes": []},
}


def preset_defaults(kind_preset: Optional[str]) -> dict:
    """``settings`` a new case starts with: the preset's vocabularies."""
    return {"vocabularies": dict(PRESET_DEFAULTS.get(kind_preset or "livre", PRESET_DEFAULTS["livre"]))}
STATUSES = ("open", "analysis", "decided", "archived")
PHASE_DAYS = 45
# Only Pix/MED has phases by default (Circ. 3.978: 45 + 45 days from the alert).
PRESET_PHASES: dict[str, dict[str, int]] = {"pix_med": {"open": PHASE_DAYS, "analysis": PHASE_DAYS}}

# Allowed status changes through PATCH. "decided" comes only from the decision
# route and leaves only through reopen (→ analysis) or archiving.
STATUS_TRANSITIONS: dict[str, frozenset[str]] = {
    "open": frozenset({"analysis", "archived"}),
    "analysis": frozenset({"open", "archived"}),
    "decided": frozenset({"archived"}),
    "archived": frozenset({"analysis"}),
}


def _clock() -> datetime:
    """Now, naive like the stored times; tests swap it (injectable clock)."""
    return datetime.now()


def check_transition(inv: Any, new_status: str) -> None:
    if new_status == inv.status:
        return
    if new_status not in STATUS_TRANSITIONS.get(inv.status, ()):
        raise InvestigationError(
            409, "INVALID_STATUS_TRANSITION", f"A case in '{inv.status}' cannot move to '{new_status}'"
        )


def deadline_of(inv: Any, now: Optional[datetime] = None) -> Optional[dict]:
    """``{phase, due_at, days_left}`` of an open case whose preset (or
    ``deadline_days`` override) has phases; None otherwise. Both phases count
    from ``alert_at`` (or creation): analysis is due open + analysis days later."""
    phases = inv.deadline_days or PRESET_PHASES.get(inv.kind_preset)
    start = inv.alert_at or inv.created_at
    if not phases or inv.status not in ("open", "analysis") or start is None:
        return None
    days = phases.get("open") or PHASE_DAYS
    if inv.status == "analysis":
        days += phases.get("analysis") or PHASE_DAYS
    now = now or _clock()
    if (start.tzinfo is None) != (now.tzinfo is None):  # naive DB times vs an aware clock
        start, now = start.replace(tzinfo=None), now.replace(tzinfo=None)
    due = start + timedelta(days=days)
    return {
        "phase": inv.status,
        "due_at": due,
        "days_left": math.ceil((due - now) / timedelta(days=1)),
    }


def serialize(inv: Any, user_email: str) -> dict:
    return {
        "id": inv.id,
        "title": inv.title,
        "description": inv.description,
        "kind_preset": inv.kind_preset,
        "status": inv.status,
        "owner_email": inv.owner_email,
        "assignee_email": inv.assignee_email,
        "occurred_at": inv.occurred_at,
        "alert_at": inv.alert_at,
        "deadline_days": inv.deadline_days,
        "deadline": deadline_of(inv),
        "tags": inv.tags or [],
        "settings": inv.settings or {},
        "state": inv.state or {},
        "decision": inv.decision,
        "frozen_hash": inv.frozen_hash,
        "frozen_at": inv.frozen_at,
        "created_at": inv.created_at,
        "updated_at": inv.updated_at,
        "shared_with": [{"email": s.email, "role": s.role} for s in inv.shares],
        "has_write_access": can_write_case(inv, user_email),
        "can_manage": can_manage_case(inv, user_email),
    }


# ---------------------------------------------------------------------------
# Storage helpers shared by the case services (DB or memory)
# ---------------------------------------------------------------------------

_MODELS = {
    "case_items": "CaseItem",
    "case_item_versions": "CaseItemVersion",
    "case_annotations": "CaseAnnotation",
    "investigation_events": "InvestigationEvent",
}


@asynccontextmanager
async def _session():
    """The DB session, or None in memory mode."""
    if is_database_available():
        async with get_session_maker()() as session:
            yield session
    else:
        yield None


def _model(table: str):
    from graphlagoon.db import models

    return getattr(models, _MODELS[table])


async def add_row(session, table: str, **fields: Any) -> Any:
    """Inserts a child row (the caller commits in DB mode)."""
    fields.setdefault("id", uuid4())
    if session is None:
        return get_memory_store().add_investigation_child(table, **fields)
    row = _model(table)(**fields)
    session.add(row)
    await session.flush()
    return row


async def get_row(session, table: str, row_id: UUID) -> Any:
    if session is None:
        return get_memory_store().get_investigation_child(table, row_id)
    return await session.get(_model(table), row_id)


async def list_rows(session, table: str, investigation_id: UUID) -> list:
    if session is None:
        return list(get_memory_store().list_investigation_children(table, investigation_id))
    from sqlalchemy import select

    model = _model(table)
    result = await session.execute(select(model).where(model.investigation_id == investigation_id))
    return list(result.scalars().all())


async def update_row(session, table: str, row: Any, **changes: Any) -> Any:
    if session is None:
        return get_memory_store().update_investigation_child(table, row.id, **changes)
    for key, value in changes.items():
        setattr(row, key, value)
    if hasattr(row, "updated_at"):
        row.updated_at = datetime.now()
    await session.flush()
    return row


async def delete_row(session, table: str, row: Any) -> None:
    if session is None:
        get_memory_store().delete_investigation_child(table, row.id)
    else:
        await session.delete(row)
        await session.flush()


async def commit(session) -> None:
    if session is not None:
        await session.commit()


async def _refresh(session, inv: Any) -> None:
    await session.refresh(inv)
    await session.refresh(inv, ["shares"])


async def _save_case(session, inv: Any, **changes: Any) -> None:
    if session is None:
        get_memory_store().update_investigation(inv.id, **changes)
    else:
        for key, value in changes.items():
            setattr(inv, key, value)
        await session.commit()
        await _refresh(session, inv)


async def load_case(session, investigation_id: UUID, user_email: str, need: str = "read") -> Any:
    """The case row if the caller has ``need`` ("read" | "write" | "manage")."""
    if session is None:
        inv = get_memory_store().get_investigation(investigation_id)
    else:
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from graphlagoon.db.models import Investigation

        result = await session.execute(
            select(Investigation)
            .options(selectinload(Investigation.shares))
            .where(Investigation.id == investigation_id)
        )
        inv = result.scalar_one_or_none()

    if inv is None or not can_read_case(inv, user_email):
        raise _not_found(investigation_id)
    if need == "write" and not can_write_case(inv, user_email):
        raise InvestigationError(403, "FORBIDDEN", "You don't have write access to this investigation")
    if need == "manage" and not can_manage_case(inv, user_email):
        raise InvestigationError(403, "FORBIDDEN", "Only the investigation owner can do this")
    return inv


async def ensure_case_access(investigation_id: UUID, user_email: str, need: str = "read") -> None:
    """``load_case`` for handlers that must check access before buffering a body."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email, need)


def under_retention(inv: Any) -> bool:
    """A decided case is kept ``investigation_retention_years`` from its freeze."""
    from graphlagoon.config import get_settings

    if inv.decision is None:
        return False
    if inv.frozen_at is None:
        return True
    years = get_settings().investigation_retention_years
    return _clock() < inv.frozen_at.replace(tzinfo=None) + timedelta(days=365.25 * years)


def ensure_not_decided(inv: Any) -> None:
    if inv.decision is not None:
        raise InvestigationError(
            409, "INVESTIGATION_DECIDED", "This investigation has a recorded decision and is read-only"
        )


# ---------------------------------------------------------------------------
# Journal: append-only (no chained hash; frozen_hash covers it at the decision)
# ---------------------------------------------------------------------------

_EVENTS = "investigation_events"
EVENT_PAYLOAD_MAX_BYTES = 16 * 1024
# Kinds the client may post; everything else is written by the server itself.
CLIENT_EVENT_KINDS = frozenset({"trace.run", "path.run", "nodes.promoted", "metric.saved"})


def canonical(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


async def _list_events(session, investigation_id: UUID) -> list:
    rows = await list_rows(session, _EVENTS, investigation_id)
    return sorted(rows, key=lambda e: (e.created_at, str(e.id)))


async def append_event(session, investigation_id: UUID, actor_email: str, kind: str, payload: dict) -> Any:
    """Adds one journal event (the caller commits); an agent's carries its token."""
    agent = get_current_actor()
    fields = {
        "investigation_id": investigation_id,
        "actor_email": actor_email,
        "kind": kind,
        "payload": json.loads(canonical(payload)),
        "created_at": datetime.now(),
    }
    if agent:  # "agent X on behalf of Y": Y stays actor_email
        fields.update(actor_kind="agent", agent_token_id=agent["token_id"], agent_name=agent["name"])
    return await add_row(session, _EVENTS, **fields)


def serialize_event(e: Any) -> dict:
    return {
        "id": e.id,
        "at": e.created_at,
        "actor_email": e.actor_email,
        "actor_kind": e.actor_kind or "human",
        "agent_token_id": e.agent_token_id,
        "agent_name": e.agent_name,
        "kind": e.kind,
        "payload": e.payload or {},
    }


async def list_events(
    investigation_id: UUID, user_email: str, after: Optional[UUID] = None, limit: int = 100
) -> list[dict]:
    """Oldest first; ``after`` is the id of the last event of the previous page."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        events = await _list_events(session, investigation_id)
        start = 0
        if after is not None:
            ids = [e.id for e in events]
            if after not in ids:
                raise InvestigationError(404, "EVENT_NOT_FOUND", f"Event with id '{after}' not found")
            start = ids.index(after) + 1
        return [serialize_event(e) for e in events[start : start + limit]]


async def post_client_event(investigation_id: UUID, user_email: str, kind: str, payload: dict) -> dict:
    if kind not in CLIENT_EVENT_KINDS:
        raise InvestigationError(
            422, "EVENT_KIND_NOT_ALLOWED", f"Clients may only post {sorted(CLIENT_EVENT_KINDS)}"
        )
    if len(canonical(payload).encode("utf-8")) > EVENT_PAYLOAD_MAX_BYTES:
        raise InvestigationError(422, "EVENT_PAYLOAD_TOO_LARGE", "Event payload is limited to 16 KB")
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        event = await append_event(session, investigation_id, user_email, kind, payload)
        await commit(session)
        return serialize_event(event)


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------


async def _counts(session, ids: list) -> dict:
    """{case id: (items, suggested)} for the queue, in one pass."""
    if not ids:
        return {}
    wanted = set(ids)
    items: dict = {i: 0 for i in ids}
    suggested: dict = {i: 0 for i in ids}
    if session is None:
        store = get_memory_store()
        rows = [r for r in store.case_items.values() if r.investigation_id in wanted]
        notes = [r for r in store.case_annotations.values() if r.investigation_id in wanted]
    else:
        from sqlalchemy import select

        from graphlagoon.db.models import CaseAnnotation, CaseItem

        rows = (await session.execute(select(CaseItem).where(CaseItem.investigation_id.in_(ids)))).scalars().all()
        notes = (
            await session.execute(select(CaseAnnotation).where(CaseAnnotation.investigation_id.in_(ids)))
        ).scalars().all()
    for r in rows:
        if r.deleted_at is None:
            items[r.investigation_id] += 1
            suggested[r.investigation_id] += r.status == "suggested"
    for a in notes:
        suggested[a.investigation_id] += a.status == "suggested"
    return {i: (items[i], suggested[i]) for i in ids}


async def list_investigations(
    user_email: str,
    status: Optional[str] = None,
    assignee: Optional[str] = None,
    kind_preset: Optional[str] = None,
    exploration_id: Optional[UUID] = None,
) -> list[dict]:
    """``exploration_id``: only cases that have that exploration as a graph item."""
    filters = {"status": status, "assignee_email": assignee, "kind_preset": kind_preset}
    filters = {k: v for k, v in filters.items() if v is not None}
    async with _session() as session:
        if session is None:
            store = get_memory_store()
            with_exp = {
                i.investigation_id
                for i in store.case_items.values()
                if i.exploration_id == exploration_id and i.deleted_at is None
            }
            rows = [
                inv
                for inv in store.list_investigations()
                if can_read_case(inv, user_email)
                and all(getattr(inv, k) == v for k, v in filters.items())
                and (exploration_id is None or inv.id in with_exp)
            ]
        else:
            from sqlalchemy import or_, select
            from sqlalchemy.orm import selectinload

            from graphlagoon.db.models import CaseItem, Investigation, InvestigationShare

            query = select(Investigation).options(selectinload(Investigation.shares))
            if not is_superuser(user_email):
                query = query.where(
                    or_(
                        Investigation.owner_email == user_email,
                        Investigation.assignee_email == user_email,
                        Investigation.id.in_(
                            select(InvestigationShare.investigation_id).where(
                                InvestigationShare.email == user_email
                            )
                        ),
                    )
                )
            for key, value in filters.items():
                query = query.where(getattr(Investigation, key) == value)
            if exploration_id is not None:
                query = query.where(
                    Investigation.id.in_(
                        select(CaseItem.investigation_id).where(
                            CaseItem.exploration_id == exploration_id, CaseItem.deleted_at.is_(None)
                        )
                    )
                )
            rows = (await session.execute(query.order_by(Investigation.updated_at.desc()))).scalars().all()
            rows = [inv for inv in rows if can_read_case(inv, user_email)]  # case-scoped tokens
        counts = await _counts(session, [inv.id for inv in rows])
        return [
            {**serialize(inv, user_email), "item_count": counts[inv.id][0], "suggested_count": counts[inv.id][1]}
            for inv in rows
        ]


async def _assignee_share(session, inv: Any, email: Optional[str]) -> None:
    """The assignee is an editor of the case automatically (05 §1)."""
    if not email or email == inv.owner_email or _shared(inv, email, write=True):
        return
    if session is None:
        get_memory_store().share_investigation(inv.id, email, "editor")
        return
    from graphlagoon.db.models import InvestigationShare

    existing = next((s for s in inv.shares if s.email == email), None)
    if existing is not None:
        existing.role = "editor"
    else:
        session.add(InvestigationShare(investigation_id=inv.id, email=email, role="editor"))
    await session.flush()


async def create_investigation(user_email: str, data: dict) -> dict:
    if data.get("assignee_email"):
        data["assignee_email"] = nominal_email(data["assignee_email"])
    data["settings"] = {**preset_defaults(data.get("kind_preset")), **(data.get("settings") or {})}
    async with _session() as session:
        if session is None:
            inv = get_memory_store().create_investigation(owner_email=user_email, **data)
        else:
            from graphlagoon.db.models import Investigation

            inv = Investigation(id=uuid4(), owner_email=user_email, **data)
            session.add(inv)
            await session.flush()
        await _assignee_share(session, inv, inv.assignee_email)
        await append_event(session, inv.id, user_email, "case.created", data)
        if session is not None:
            await session.commit()
            await _refresh(session, inv)
        return serialize(inv, user_email)


async def get_investigation(investigation_id: UUID, user_email: str) -> dict:
    async with _session() as session:
        return serialize(await load_case(session, investigation_id, user_email), user_email)


# Columns that are NOT NULL: an explicit null in a PATCH means "leave as is".
_REQUIRED_FIELDS = ("title", "status", "kind_preset", "tags", "settings", "state")


async def update_investigation(investigation_id: UUID, user_email: str, changes: dict) -> dict:
    changes = {k: v for k, v in changes.items() if v is not None or k not in _REQUIRED_FIELDS}
    if changes.get("assignee_email"):
        changes["assignee_email"] = nominal_email(changes["assignee_email"])
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        if "assignee_email" in changes and not can_manage_case(inv, user_email):
            raise InvestigationError(403, "FORBIDDEN", "Only who can share the case assigns it")
        # A decided case is read-only, except for closing it (status is outside the frozen hash).
        if set(changes) != {"status"} or changes["status"] != "archived":
            ensure_not_decided(inv)
        if "status" in changes:
            if get_current_actor() and write_status(inv, "status_change") == "suggested":
                # The agent suggests the change in place (05 §6); the case does not move.
                await add_row(
                    session,
                    "case_annotations",
                    investigation_id=investigation_id,
                    kind="status_change",
                    targets=[],
                    value={"from": inv.status, "to": changes["status"]},
                    status="suggested",
                    **author_fields(user_email),
                )
                await append_event(
                    session, investigation_id, user_email, "status_change.suggested", {"to": changes["status"]}
                )
                changes.pop("status")
            else:
                check_transition(inv, changes["status"])
        if changes:
            await append_event(session, investigation_id, user_email, "case.updated", changes)
        if session is None:
            get_memory_store().update_investigation(investigation_id, **changes)
        else:
            for key, value in changes.items():
                setattr(inv, key, value)
            await session.flush()
        await _assignee_share(session, inv, changes.get("assignee_email"))
        if session is not None:
            await session.commit()
            await _refresh(session, inv)
        return serialize(inv, user_email)


async def reopen_investigation(investigation_id: UUID, user_email: str) -> dict:
    """decided → analysis, people only (the route forbids agents). The decision
    and its hash leave the case but stay in the journal (``case.reopened``)."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        if inv.status != "decided":
            raise InvestigationError(409, "INVALID_STATUS_TRANSITION", "Only a decided case can be reopened")
        await append_event(
            session,
            investigation_id,
            user_email,
            "case.reopened",
            {"previous_frozen_hash": inv.frozen_hash, "previous_decision": inv.decision, "to": "analysis"},
        )
        await _save_case(session, inv, status="analysis", decision=None, frozen_hash=None, frozen_at=None)
        return serialize(inv, user_email)


async def delete_investigation(investigation_id: UUID, user_email: str, reason: Optional[str] = None) -> dict:
    """Deletes the case; returns audit metadata. A decided case is retained
    (409) unless a superuser gives a reason."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "manage")
        if under_retention(inv) and not (is_superuser(user_email) and (reason or "").strip()):
            raise InvestigationError(
                409,
                "INVESTIGATION_RETAINED",
                "A decided investigation is retained and cannot be deleted. Superusers may delete it with ?reason=.",
            )
        meta = {"title": inv.title, "owner": inv.owner_email}
        if reason:
            meta["reason"] = reason
        if session is None:
            get_memory_store().delete_investigation(investigation_id)
        else:
            await session.delete(inv)
            await session.commit()
        return meta


async def share_investigation(investigation_id: UUID, user_email: str, email: str, role: str) -> str:
    """Returns the normalized e-mail that was shared."""
    email = nominal_email(email)
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "manage")
        await append_event(session, investigation_id, user_email, "case.shared", {"with": email, "role": role})
        if session is None:
            get_memory_store().share_investigation(investigation_id, email, role)
        else:
            from graphlagoon.db.models import InvestigationShare

            existing = next((s for s in inv.shares if s.email == email), None)
            if existing is not None:
                existing.role = role
            else:
                session.add(InvestigationShare(investigation_id=investigation_id, email=email, role=role))
            await session.commit()
    return email


async def unshare_investigation(investigation_id: UUID, user_email: str, email: str) -> bool:
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "manage")
        share = next((s for s in inv.shares if s.email == email), None)
        if share is None:
            return False
        await append_event(session, investigation_id, user_email, "case.unshared", {"with": email})
        if session is None:
            return get_memory_store().unshare_investigation(investigation_id, email)
        await session.delete(share)
        await session.commit()
        return True


async def transfer_owner(investigation_id: UUID, admin_email: str, new_owner: str) -> dict:
    """Admin area: reassign the case. A share held by the new owner becomes
    redundant and is removed; the previous owner keeps no implicit access."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, admin_email)
        previous = inv.owner_email
        await append_event(
            session, investigation_id, admin_email, "case.transferred", {"from": previous, "to": new_owner}
        )
        inv.owner_email = new_owner
        if session is None:
            inv.shares = [s for s in inv.shares if s.email != new_owner]
        else:
            for share in list(inv.shares):
                if share.email == new_owner:
                    await session.delete(share)
            await session.commit()
        return {"from": previous, "title": inv.title}


# ---------------------------------------------------------------------------
# Decision (05 §7): human only; frozen_hash over the journal and the pinned
# versions, verified on export; every mutation afterwards answers 409.
# ---------------------------------------------------------------------------


async def frozen_document(session, inv: Any) -> dict:
    """The canonical record ``frozen_hash`` covers: the case and its decision,
    the pinned versions (evidence) and the journal up to ``decision.recorded``.
    Later journal lines (a share, a transfer) stay out, so the hash can be
    recomputed at any time; owner and status are out for the same reason."""
    events = await _list_events(session, inv.id)
    cut = next((i for i, e in enumerate(events) if e.kind == "decision.recorded"), len(events) - 1)
    versions = await list_rows(session, "case_item_versions", inv.id)
    return {
        "investigation": {
            "id": str(inv.id),
            "title": inv.title,
            "description": inv.description,
            "kind_preset": inv.kind_preset,
            "decision": inv.decision,
        },
        "pinned": sorted(
            (
                {
                    "item_id": str(v.item_id),
                    "version": v.version,
                    "sha256": v.sha256,
                    "pin_label": v.pin_label,
                    "pinned_by": v.pinned_by,
                }
                for v in versions
                if v.pinned_at is not None
            ),
            key=lambda v: (v["item_id"], v["version"]),
        ),
        "events": [
            {
                "id": str(e.id),
                "kind": e.kind,
                "actor_email": e.actor_email,
                "at": e.created_at.isoformat(),
                "payload": e.payload or {},
            }
            for e in events[: cut + 1]
        ],
    }


async def compute_frozen_hash(session, inv: Any) -> str:
    return hashlib.sha256(canonical(await frozen_document(session, inv)).encode("utf-8")).hexdigest()


async def verify_frozen_hash(investigation_id: UUID, user_email: str) -> Optional[bool]:
    """True if the stored ``frozen_hash`` still matches the case; None if undecided."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email)
        if inv.frozen_hash is None:
            return None
        return await compute_frozen_hash(session, inv) == inv.frozen_hash


async def record_decision(
    investigation_id: UUID, user_email: str, outcome: str, actions: list[str], rationale: str
) -> dict:
    """Records the decision (the route forbids agents and validates outcome and
    actions) and stores the case's ``frozen_hash``."""
    rationale = (rationale or "").strip()
    if not rationale:
        raise InvestigationError(422, "RATIONALE_REQUIRED", "A decision needs its rationale")
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_decided(inv)
        now = _clock()
        decision = {
            "outcome": outcome,
            "actions": list(dict.fromkeys(actions)),
            "rationale": rationale,
            "decided_by": user_email,
            "decided_at": now.isoformat(),
        }
        await append_event(session, investigation_id, user_email, "decision.recorded", decision)
        inv.decision = decision  # the hash covers the decision itself
        frozen_hash = await compute_frozen_hash(session, inv)
        await _save_case(
            session, inv, decision=decision, status="decided", frozen_hash=frozen_hash, frozen_at=now
        )
        return serialize(inv, user_email)
