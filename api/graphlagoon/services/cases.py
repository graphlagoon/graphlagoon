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
from graphlagoon.services import case_types
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
    """A single named e-mail; wildcards are refused (need-to-know)."""
    candidate = (email or "").strip()
    if "*" in candidate:
        raise InvestigationError(
            422,
            "WILDCARD_SHARE_REFUSED",
            "Investigations can only be shared with named e-mails. Wildcards "
            '("*", "*@domain") are refused: a case is need-to-know.',
        )
    ok, message = validate_owner_email(candidate)
    if not ok:
        raise InvestigationError(422, "INVALID_EMAIL", message)
    return candidate


# ---------------------------------------------------------------------------
# Authorship (05 §6)
# ---------------------------------------------------------------------------

DEFAULT_SUGGEST_KINDS = ("role", "tag", "hypothesis_status", "same_as", "status_change", "task")


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
# Status, deadlines (05 §3, 06 §1): SLA hours per phase, from the case type
# ---------------------------------------------------------------------------

STATUSES = ("open", "analysis", "closed")

# Allowed status changes through PATCH. "closed" comes only from a decision that
# closes the case (06 §1) and leaves only through reopen (→ analysis).
STATUS_TRANSITIONS: dict[str, frozenset[str]] = {
    "open": frozenset({"analysis"}),
    "analysis": frozenset({"open"}),
    "closed": frozenset(),
}
# Under this share of its SLA left, a case is urgent in the queue.
URGENT_SHARE = 0.2


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
    """``{phase, due_at, hours_left, days_left, total_hours, urgent, overdue}``
    of an open case with SLA hours; None otherwise. Both phases count from
    ``alert_at`` (else ``occurred_at``, else creation): analysis is due
    open + analysis hours after it."""
    sla = {k: int(v) for k, v in (inv.sla_hours or {}).items() if v}
    start = inv.alert_at or inv.occurred_at or inv.created_at
    if not sla or inv.status not in ("open", "analysis") or start is None:
        return None
    hours = sla.get("open", 0) + (sla.get("analysis", 0) if inv.status == "analysis" else 0)
    if not hours:
        return None
    now = now or _clock()
    if (start.tzinfo is None) != (now.tzinfo is None):  # naive DB times vs an aware clock
        start, now = start.replace(tzinfo=None), now.replace(tzinfo=None)
    due = start + timedelta(hours=hours)
    left = (due - now) / timedelta(hours=1)
    return {
        "phase": inv.status,
        "due_at": due,
        "hours_left": math.floor(left),
        "days_left": math.ceil(left / 24),
        "total_hours": hours,
        "urgent": left <= hours * URGENT_SHARE,
        "overdue": left < 0,
    }


def serialize(inv: Any, user_email: str) -> dict:
    return {
        "id": inv.id,
        "title": inv.title,
        "description": inv.description,
        "case_type": inv.case_type,
        "fields": inv.fields or {},
        "external_ref": inv.external_ref,
        "status": inv.status,
        "owner_email": inv.owner_email,
        "assignee_email": inv.assignee_email,
        "occurred_at": inv.occurred_at,
        "alert_at": inv.alert_at,
        "sla_hours": inv.sla_hours,
        "deadline": deadline_of(inv),
        "tags": inv.tags or [],
        "settings": inv.settings or {},
        "state": inv.state or {},
        "stage": inv.stage,
        "decisions": list(inv.decisions or []),
        # The decision that closed the case: its hash and when (06 §1).
        "frozen_hash": (closing := closing_decision(inv) if inv.status == "closed" else None) and closing["hash"],
        "frozen_at": closing and closing["closed_at"],
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
    "case_entities": "CaseEntity",
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


def closing_decision(inv: Any) -> Optional[dict]:
    """The approved decision that closed the case last, or None."""
    return next(
        (d for d in reversed(inv.decisions or []) if d.get("closes_case") and d.get("closed_at")),
        None,
    )


async def under_retention(inv: Any) -> bool:
    """A case closed by a decision is kept its type's ``retention_years`` (else
    ``investigation_retention_years``) from the last closing decision."""
    from graphlagoon.config import get_settings

    closing = closing_decision(inv)
    if closing is None:
        return False
    kind = await case_types.get_case_type(inv.case_type) or {}
    years = kind.get("retention_years")
    years = get_settings().investigation_retention_years if years is None else years
    closed_at = datetime.fromisoformat(closing["closed_at"]).replace(tzinfo=None)
    return _clock() < closed_at + timedelta(days=365.25 * years)


def ensure_not_closed(inv: Any) -> None:
    if inv.status == "closed":
        raise InvestigationError(
            409, "CASE_CLOSED", "This case was closed by a decision and is read-only; reopen it to change it"
        )


# ---------------------------------------------------------------------------
# Journal: append-only (no chained hash; each decision hashes the prefix up to itself)
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
        ensure_not_closed(inv)
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


QUEUE_SORTS = ("updated_at", "created_at", "title", "deadline")


def _field_filter(value: Any, expr: str) -> bool:
    """``eq:x`` (the default), ``gte:x``, ``lte:x`` or ``contains:x`` against one field value."""
    op, _, arg = expr.partition(":") if expr.split(":", 1)[0] in ("eq", "gte", "lte", "contains") else ("eq", "", expr)
    if value is None:
        return False
    if op == "contains":
        return arg.lower() in str(value).lower()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            target: Any = float(arg)
        except ValueError:
            return False
    else:
        value, target = str(value), arg
    return {"eq": value == target, "gte": value >= target, "lte": value <= target}[op]


def _sort_key(sort: str):
    key = sort.lstrip("-")
    if key.startswith("field."):
        fid = key[len("field."):]
        return lambda inv: (inv.fields or {}).get(fid)
    if key == "deadline":
        return lambda inv: d["due_at"].replace(tzinfo=None) if (d := deadline_of(inv)) else None
    if key == "title":
        return lambda inv: (inv.title or "").lower()
    if key not in QUEUE_SORTS:
        raise InvestigationError(422, "INVALID_SORT", f"sort is one of {', '.join(QUEUE_SORTS)} or field.<id>, with - for descending")
    return lambda inv: getattr(inv, key) or datetime.min


async def _readable_cases(session, user_email: str, exploration_id: Optional[UUID]) -> list:
    if session is None:
        store = get_memory_store()
        with_exp = {
            i.investigation_id
            for i in store.case_items.values()
            if i.exploration_id == exploration_id and i.deleted_at is None
        }
        return [
            inv
            for inv in store.investigations.values()
            if can_read_case(inv, user_email) and (exploration_id is None or inv.id in with_exp)
        ]
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
                    select(InvestigationShare.investigation_id).where(InvestigationShare.email == user_email)
                ),
            )
        )
    if exploration_id is not None:
        query = query.where(
            Investigation.id.in_(
                select(CaseItem.investigation_id).where(
                    CaseItem.exploration_id == exploration_id, CaseItem.deleted_at.is_(None)
                )
            )
        )
    rows = (await session.execute(query)).scalars().all()
    return [inv for inv in rows if can_read_case(inv, user_email)]  # case-scoped tokens


async def list_investigations(
    user_email: str,
    status: Optional[str] = None,
    assignee: Optional[str] = None,
    case_type: Optional[str] = None,
    exploration_id: Optional[UUID] = None,
    external_ref: Optional[str] = None,
    q: Optional[str] = None,
    deadline: Optional[str] = None,
    suggested: Optional[bool] = None,
    fields: Optional[dict[str, str]] = None,
    sort: str = "-updated_at",
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """A page of the queue (06 §2b): filters, then sort, then ``limit``/``offset``.
    ``exploration_id``: only cases with that exploration as a graph item;
    ``deadline``: ``urgent`` (incl. overdue) or ``overdue``; ``fields``: ``{id:
    "gte:100000"}``; ``status`` may list several (``open,analysis``). ``counts``
    are over every case the caller reads.

    shortcut: the filters run in Python over the readable cases (the browser
    gets one page); push them to SQL when an org reaches tens of thousands."""
    key = _sort_key(sort)
    async with _session() as session:
        rows = await _readable_cases(session, user_email, exploration_id)
        all_counts = await _counts(session, [inv.id for inv in rows])
        deadlines = {inv.id: deadline_of(inv) for inv in rows}
        counts = {s: sum(inv.status == s for inv in rows) for s in STATUSES}
        counts.update(
            total=len(rows),
            urgent=sum(bool(d and d["urgent"]) for d in deadlines.values()),
            overdue=sum(bool(d and d["overdue"]) for d in deadlines.values()),
            suggested=sum(all_counts[inv.id][1] > 0 for inv in rows),
        )
        needle = (q or "").strip().lower()
        statuses = {x for x in (status or "").split(",") if x}

        def keep(inv: Any) -> bool:
            d = deadlines[inv.id]
            return (
                (not statuses or inv.status in statuses)
                and (assignee is None or inv.assignee_email == assignee)
                and (case_type is None or inv.case_type == case_type)
                and (external_ref is None or inv.external_ref == external_ref)
                and (not needle or needle in (inv.title or "").lower() or needle in (inv.description or "").lower())
                and (deadline is None or bool(d and (d["overdue"] if deadline == "overdue" else d["urgent"])))
                and (suggested is None or (all_counts[inv.id][1] > 0) == suggested)
                and all(_field_filter((inv.fields or {}).get(fid), expr) for fid, expr in (fields or {}).items())
            )

        matched = [inv for inv in rows if keep(inv)]
        # A case without the sort value (no such field, no deadline) goes last whichever the direction.
        present = [inv for inv in matched if key(inv) is not None]
        matched = sorted(present, key=key, reverse=sort.startswith("-")) + [inv for inv in matched if key(inv) is None]
        page = matched[offset : offset + limit]
        return {
            "items": [
                {**serialize(inv, user_email), "item_count": all_counts[inv.id][0], "suggested_count": all_counts[inv.id][1]}
                for inv in page
            ],
            "total": len(matched),
            "limit": limit,
            "offset": offset,
            "counts": counts,
        }


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


async def _ensure_may_assign(user_email: str, assignee: Optional[str]) -> None:
    """Assigning shares the case as editor (``_assignee_share``), so it takes the
    ``investigation.share`` permission, as sharing does; assigning yourself does not."""
    from graphlagoon.services.permissions import check_permission

    if not assignee or assignee.lower() == (user_email or "").lower():
        return
    if not (await check_permission(user_email, "investigation.share")).allowed:
        raise InvestigationError(
            403, "PERMISSION_DENIED",
            'Assigning a case shares it with the assignee: you need the "Share investigations" permission',
        )


async def _by_external_ref(session, user_email: str, external_ref: str) -> Optional[Any]:
    """The case opened for ``external_ref`` that the caller reads (idempotent creation)."""
    for inv in await _readable_cases(session, user_email, None):
        if inv.external_ref == external_ref:
            return inv
    return None


async def create_investigation(user_email: str, data: dict) -> tuple[dict, bool]:
    """(the case, created?): a repeated ``external_ref`` returns the case the
    caller already reads instead of opening a second one."""
    actor = get_current_actor()
    if actor and actor.get("scope") == "case":
        # It could never read the case it opened (it is outside its investigation_ids).
        raise InvestigationError(403, "CASE_SCOPED_TOKEN", "A case-scoped token cannot open new cases")
    if actor and (data.get("assignee_email") or data.get("settings")):
        # Assigning shares the case; the settings say what an agent writes as a suggestion.
        raise InvestigationError(403, "AGENT_FORBIDDEN", "Assigning a case and its settings are reserved to people")
    if data.get("assignee_email"):
        data["assignee_email"] = nominal_email(data["assignee_email"])
        await _ensure_may_assign(user_email, data["assignee_email"])
    kind = await case_types.require_case_type(data.get("case_type"))
    defaults = case_types.case_defaults(kind)
    data["case_type"] = kind["slug"]
    data["fields"] = case_types.clean_fields(kind, data.get("fields") or {})
    data["settings"] = {**defaults["settings"], **(data.get("settings") or {})}
    data["sla_hours"] = data.get("sla_hours") or defaults["sla_hours"]
    async with _session() as session:
        if data.get("external_ref"):
            existing = await _by_external_ref(session, user_email, data["external_ref"])
            if existing is not None:
                return serialize(existing, user_email), False
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
    await _starter_queries(inv.id, user_email, kind)
    return await get_investigation(inv.id, user_email), True


async def _starter_queries(investigation_id: UUID, user_email: str, kind: dict) -> None:
    """The case type's starter queries become query items of the new case (06 §1);
    from there they are the case's own: edit them, run them, delete them."""
    from graphlagoon.services import case_items

    for q in kind.get("starter_queries") or []:
        await case_items.create_item(investigation_id, user_email, {
            "kind": "query",
            "subkind": q.get("language") or "sql",
            "title": q["title"],
            "description": q.get("description"),
            "query": {"text": q["query"], "language": q.get("language") or "sql",
                      "parameters": q.get("parameters") or [], "output": "table"},
            "provenance": {"tool": "case_type", "case_type": kind["slug"]},
        })


async def get_investigation(investigation_id: UUID, user_email: str) -> dict:
    async with _session() as session:
        return serialize(await load_case(session, investigation_id, user_email), user_email)


# What an agent's PATCH never changes (05 §6, 06 §1): who works the case, its
# type (decision catalog, four eyes, retention), what it writes as suggestions
# and the deadlines.
_PEOPLE_ONLY_CHANGES = {"assignee_email", "case_type", "settings", "sla_hours"}

# Columns that are NOT NULL: an explicit null in a PATCH means "leave as is".
_REQUIRED_FIELDS = ("title", "status", "case_type", "fields", "tags", "settings", "state")


async def update_investigation(investigation_id: UUID, user_email: str, changes: dict) -> dict:
    changes = {k: v for k, v in changes.items() if v is not None or k not in _REQUIRED_FIELDS}
    if changes.get("assignee_email"):
        changes["assignee_email"] = nominal_email(changes["assignee_email"])
    if get_current_actor() and _PEOPLE_ONLY_CHANGES & set(changes):
        raise InvestigationError(
            403, "AGENT_FORBIDDEN",
            f"{', '.join(sorted(_PEOPLE_ONLY_CHANGES & set(changes)))}: reserved to people",
        )
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        if "assignee_email" in changes and not can_manage_case(inv, user_email):
            raise InvestigationError(403, "FORBIDDEN", "Only who can share the case assigns it")
        if changes.get("assignee_email") != inv.assignee_email:
            await _ensure_may_assign(user_email, changes.get("assignee_email"))
        if changes.get("case_type") not in (None, inv.case_type) and inv.decisions:
            # The type holds the decision catalog (which outcome needs a second
            # person) and the retention: after a decision it no longer moves.
            raise InvestigationError(
                409, "CASE_TYPE_LOCKED", "The case already has a decision; its type no longer changes"
            )
        if "case_type" in changes or "fields" in changes:
            await _apply_case_type(inv, changes)
        ensure_not_closed(inv)
        if changes.get("stage") is not None:
            stages = (await case_types.require_case_type(changes.get("case_type") or inv.case_type))["stages"]
            if changes["stage"] not in stages:
                raise InvestigationError(422, "UNKNOWN_STAGE", f"The case type's stages are: {', '.join(stages) or 'none'}")
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


async def _apply_case_type(inv: Any, changes: dict) -> None:
    """A type change re-seeds the vocabularies, suggest kinds and SLA from the
    new type (unless the same PATCH sets them) and re-checks the fields."""
    moved = changes.get("case_type") not in (None, inv.case_type)
    kind = await case_types.require_case_type(changes.get("case_type") or inv.case_type)
    if moved:
        defaults = case_types.case_defaults(kind)
        changes.setdefault("settings", {**(inv.settings or {}), **defaults["settings"]})
        changes.setdefault("sla_hours", defaults["sla_hours"])
    changes["fields"] = case_types.clean_fields(kind, changes.get("fields") or {}, inv.fields)


async def reopen_investigation(investigation_id: UUID, user_email: str) -> dict:
    """closed → analysis, people only (the route forbids agents). The decisions
    stay; ``case.reopened`` names the one that had closed the case."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        if inv.status != "closed":
            raise InvestigationError(409, "INVALID_STATUS_TRANSITION", "Only a closed case can be reopened")
        closing = closing_decision(inv) or {}
        await append_event(
            session, investigation_id, user_email, "case.reopened",
            {"decision_id": closing.get("id"), "hash": closing.get("hash"), "to": "analysis"},
        )
        await _save_case(session, inv, status="analysis")
        return serialize(inv, user_email)


async def delete_investigation(investigation_id: UUID, user_email: str, reason: Optional[str] = None) -> dict:
    """Deletes the case; returns audit metadata. A decided case is retained
    (409) unless a superuser gives a reason."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "manage")
        if await under_retention(inv) and not (is_superuser(user_email) and (reason or "").strip()):
            raise InvestigationError(
                409,
                "INVESTIGATION_RETAINED",
                "A case closed by a decision is retained and cannot be deleted. Superusers may delete it with ?reason=.",
            )
        meta = {"title": inv.title, "owner": inv.owner_email}
        if reason:
            meta["reason"] = reason
        if session is None:
            get_memory_store().delete_investigation(investigation_id)
        else:
            await session.delete(inv)
            await session.commit()
    # Rows first (the retention check above is the gate), then every blob of the
    # case: item versions and their text extractions live under one prefix.
    from graphlagoon.services import investigation_storage

    await investigation_storage.get_store().delete_prefix(f"{investigation_id}/")
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
# Decisions (06 §1): human only and append-only. A case has as many as it needs;
# each carries the hash of the journal up to its own ``decision.recorded``
# event (pins, edits, earlier decisions and the tasks it created are all in
# there). Only an outcome that closes the case freezes it; with four eyes the
# case closes when another person approves.
# ---------------------------------------------------------------------------


def _event_doc(e: Any) -> dict:
    return {
        "id": str(e.id),
        "kind": e.kind,
        "actor_email": e.actor_email,
        "at": e.created_at.isoformat(),
        "payload": e.payload or {},
    }


async def decision_hash(session, inv: Any, decision_id: str) -> Optional[str]:
    """sha256 of the canonical journal up to and including the decision's
    ``decision.recorded`` event; None when there is no such event."""
    events = await _list_events(session, inv.id)
    cut = next(
        (i for i, e in enumerate(events) if e.kind == "decision.recorded" and (e.payload or {}).get("id") == decision_id),
        None,
    )
    if cut is None:
        return None
    doc = {"investigation_id": str(inv.id), "events": [_event_doc(e) for e in events[: cut + 1]]}
    return hashlib.sha256(canonical(doc).encode("utf-8")).hexdigest()


async def verify_decisions(investigation_id: UUID, user_email: str) -> list[dict]:
    """``[{id, hash, verified}]``: each decision's hash recomputed from the journal,
    and the versions it rests on still hold the bytes it saw (their sha256)."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email)
        stored = {(str(v.item_id), v.version): v.sha256 for v in await list_rows(session, "case_item_versions", investigation_id)}
        return [
            {
                "id": d["id"],
                "hash": d["hash"],
                "verified": await decision_hash(session, inv, d["id"]) == d["hash"]
                and all(stored.get((e["item_id"], e["version"])) == e["sha256"] for e in d.get("evidence") or []),
            }
            for d in inv.decisions or []
        ]


async def _pinned_evidence(session, investigation_id: UUID, wanted: Optional[list[dict]]) -> list[dict]:
    """The pinned versions a decision rests on: the given ones (each must be
    pinned) or, when omitted, every pinned version."""
    pinned = {
        (str(v.item_id), v.version): v.sha256
        for v in await list_rows(session, "case_item_versions", investigation_id)
        if v.pinned_at is not None
    }
    if wanted is None:
        keys = sorted(pinned)
    else:
        keys = [(str(w["item_id"]), int(w["version"])) for w in wanted]
        missing = [k for k in keys if k not in pinned]
        if missing:
            raise InvestigationError(422, "EVIDENCE_NOT_PINNED", f"Pin these versions first: {missing}")
    return [{"item_id": k[0], "version": k[1], "sha256": pinned[k]} for k in keys]


def _outcome(kind: dict, data: dict) -> tuple[Optional[str], str, bool, bool]:
    """(outcome id, label, closes_case, requires_review) from the type's catalog,
    or the free outcome of a type that has none."""
    if kind["outcomes"]:
        outcome = next((o for o in kind["outcomes"] if o["id"] == data.get("outcome")), None)
        if outcome is None:
            ids = ", ".join(o["id"] for o in kind["outcomes"])
            raise InvestigationError(422, "UNKNOWN_OUTCOME", f"The {kind['label']} type decides one of: {ids}")
        return outcome["id"], outcome["label"], outcome["closes_case"], outcome["requires_review"]
    label = (data.get("outcome_label") or "").strip()
    if not label:
        raise InvestigationError(422, "OUTCOME_REQUIRED", "This case type has no outcomes: name the decision (outcome_label)")
    return None, label, bool(data.get("closes_case")), False


async def record_decision(investigation_id: UUID, user_email: str, data: dict) -> dict:
    """Appends a decision (the route forbids agents). ``data``: outcome or
    outcome_label + closes_case, targets, tasks, rationale, evidence, reviewer_email."""
    rationale = (data.get("rationale") or "").strip()
    if not rationale:
        raise InvestigationError(422, "RATIONALE_REQUIRED", "A decision needs its rationale")
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        ensure_not_closed(inv)
        kind = await case_types.require_case_type(inv.case_type)
        outcome, label, closes, review = _outcome(kind, data)
        if any(d.get("review") == "pending" for d in inv.decisions or []):
            raise InvestigationError(409, "REVIEW_PENDING", "A decision waits for its review; approve or reject it first")
        reviewer = nominal_email(data["reviewer_email"]) if data.get("reviewer_email") else None
        if reviewer == user_email:
            raise InvestigationError(422, "FOUR_EYES", "The reviewer is another person")
        if reviewer and not can_write_case(inv, reviewer):
            # Else the decision would wait forever for someone who cannot open the case.
            raise InvestigationError(
                422, "REVIEWER_NO_ACCESS", f"{reviewer} cannot edit this case: share it with them as an editor first"
            )
        now = _clock()
        decision_id = str(uuid4())
        proposal = await _proposal(session, investigation_id, data.get("proposal_id"))
        targets = list(dict.fromkeys(data.get("targets") or []))
        task_ids = await _decision_tasks(session, inv, kind, decision_id, data.get("tasks") or [], targets, user_email, now)
        entry = {
            "id": decision_id,
            "outcome": outcome,
            "outcome_label": label,
            "closes_case": closes,
            "targets": targets,
            "task_ids": task_ids,
            "rationale": rationale,
            "evidence": await _pinned_evidence(session, investigation_id, data.get("evidence")),
            "reviewer_email": reviewer,
            "decided_by": user_email,
            "decided_at": now.isoformat(),
        }
        if proposal is not None:
            entry["proposal_id"] = str(proposal.id)
            entry["proposed_by"] = {"author_kind": proposal.author_kind, "author_email": proposal.author_email}
            await update_row(session, "case_annotations", proposal, status="confirmed", confirmed_by=user_email, confirmed_at=now)
            await append_event(session, investigation_id, user_email, "decision_proposal.confirmed",
                               {"annotation_id": str(proposal.id), "decision_id": decision_id})
        await append_event(session, investigation_id, user_email, "decision.recorded", entry)
        entry["hash"] = await decision_hash(session, inv, decision_id)
        entry["review"] = "pending" if review else None
        entry["closed_at"] = None
        status = inv.status
        if closes and not review:
            entry["closed_at"] = now.isoformat()
            status = "closed"
            await append_event(session, investigation_id, user_email, "case.closed", {"decision_id": decision_id})
        await _save_case(session, inv, decisions=[*(inv.decisions or []), entry], status=status)
        return serialize(inv, user_email)


async def _proposal(session, investigation_id: UUID, proposal_id: Any) -> Optional[Any]:
    """The pending decision_proposal a decision takes up, or None."""
    if not proposal_id:
        return None
    row = await get_row(session, "case_annotations", UUID(str(proposal_id)))
    if row is None or row.investigation_id != investigation_id or row.kind != "decision_proposal":
        raise InvestigationError(404, "PROPOSAL_NOT_FOUND", f"No decision proposal '{proposal_id}' in this case")
    if row.status != "suggested":
        raise InvestigationError(409, "NOT_SUGGESTED", "This proposal was already taken up or rejected")
    return row


async def review_decision(
    investigation_id: UUID, user_email: str, decision_id: str, approve: bool, note: Optional[str] = None
) -> dict:
    """Four eyes: another person approves (a closing outcome then closes the
    case) or rejects a pending decision; only the named reviewer, when there is
    one. The author may withdraw (reject) their own, never approve it."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        decisions = [dict(d) for d in inv.decisions or []]
        entry = next((d for d in decisions if d["id"] == decision_id), None)
        if entry is None:
            raise InvestigationError(404, "DECISION_NOT_FOUND", f"No decision '{decision_id}' in this case")
        if entry.get("review") != "pending":
            raise InvestigationError(409, "NOT_PENDING", "This decision is not waiting for a review")
        withdrawn = user_email == entry["decided_by"] and not approve
        if user_email == entry["decided_by"] and approve:
            raise InvestigationError(403, "FOUR_EYES", "Another person reviews a decision")
        if not withdrawn and entry.get("reviewer_email") and user_email != entry["reviewer_email"]:
            raise InvestigationError(403, "NOT_THE_REVIEWER", f"{entry['reviewer_email']} reviews this decision")
        now = _clock()
        entry.update(review="approved" if approve else "rejected", reviewed_by=user_email,
                     reviewed_at=now.isoformat(), review_note=(note or "").strip() or None)
        await append_event(session, investigation_id, user_email, f"decision.{entry['review']}",
                           {"decision_id": decision_id, "note": entry["review_note"]})
        status = inv.status
        if approve and entry["closes_case"]:
            entry["closed_at"] = now.isoformat()
            status = "closed"
            await append_event(session, investigation_id, user_email, "case.closed", {"decision_id": decision_id})
        await _save_case(session, inv, decisions=decisions, status=status)
        return serialize(inv, user_email)


async def _decision_tasks(session, inv: Any, kind: dict, decision_id: str, tasks: list[dict],
                          targets: list[str], user_email: str, now: datetime) -> list[str]:
    """The follow-up tasks of a decision (06 §1): one of the type's actions (its
    label is the title, ``due_hours`` the deadline) or a free one, on the
    decision's targets. Created before the decision's event so its hash covers them."""
    from graphlagoon.services import case_annotations

    actions = {a["id"]: a for a in kind["actions"]}
    for t in tasks:
        if t.get("action") and t["action"] not in actions:
            raise InvestigationError(422, "UNKNOWN_ACTION", f"No action '{t['action']}' in the {kind['label']} type")
    ids = []
    for t in tasks:
        action = actions.get(t.get("action") or "")
        due = t.get("due_at") or (
            (now + timedelta(hours=action["due_hours"])).isoformat() if action and action.get("due_hours") else None
        )
        value = {
            "title": (t.get("title") or "").strip() or action["label"],
            "state": "open",
            "assignee_kind": t.get("assignee_kind") or "human",
            "assignee": t.get("assignee"),
            "agent_name": t.get("agent_name"),
            "due_at": due,
            "action": t.get("action"),
            "decision_id": decision_id,
        }
        row = await case_annotations.add_task(session, inv, user_email, targets, value)
        ids.append(str(row.id))
    return ids
