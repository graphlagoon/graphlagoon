"""Investigations: access rules and storage (PostgreSQL or the in-memory store).

Access (03-arquitetura §7):
- read: owner, assignee, any share, superuser;
- write: owner, assignee, write share;
- manage (delete, share): owner or superuser.

A case the caller cannot read is reported as 404, never 403, so its existence
does not leak (tipping-off). Shares are nominal e-mails only.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, Optional
from uuid import UUID

from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store
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
        404,
        "INVESTIGATION_NOT_FOUND",
        f"Investigation with id '{investigation_id}' not found",
    )


def _shared(inv: Any, user_email: str, *, write: bool = False) -> bool:
    return any(
        s.shared_with_email == user_email and (not write or s.permission == "write")
        for s in inv.shares
    )


def can_read_case(inv: Any, user_email: str) -> bool:
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


def serialize(inv: Any, user_email: str) -> dict:
    return {
        "id": inv.id,
        "title": inv.title,
        "description": inv.description,
        "owner_email": inv.owner_email,
        "assignee_email": inv.assignee_email,
        "status": inv.status,
        "typology": inv.typology,
        "origin": inv.origin,
        "selected_at": inv.selected_at,
        "state": inv.state or {},
        "decision": inv.decision,
        "frozen_hash": inv.frozen_hash,
        "frozen_at": inv.frozen_at,
        "created_at": inv.created_at,
        "updated_at": inv.updated_at,
        "shared_with": [
            {"email": s.shared_with_email, "permission": s.permission}
            for s in inv.shares
        ],
        "has_write_access": can_write_case(inv, user_email),
        "can_manage": can_manage_case(inv, user_email),
    }


@asynccontextmanager
async def _session():
    """The DB session, or None in memory mode."""
    if is_database_available():
        async with get_session_maker()() as session:
            yield session
    else:
        yield None


async def _refresh(session, inv: Any) -> None:
    await session.refresh(inv)
    await session.refresh(inv, ["shares"])


async def load_case(
    session, investigation_id: UUID, user_email: str, need: str = "read"
) -> Any:
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
        raise InvestigationError(
            403, "FORBIDDEN", "You don't have write access to this investigation"
        )
    if need == "manage" and not can_manage_case(inv, user_email):
        raise InvestigationError(
            403, "FORBIDDEN", "Only the investigation owner can do this"
        )
    return inv


def _ensure_not_decided(inv: Any) -> None:
    if inv.decision is not None:
        raise InvestigationError(
            409,
            "INVESTIGATION_DECIDED",
            "This investigation has a recorded decision and is read-only",
        )


async def list_investigations(
    user_email: str,
    status: Optional[str] = None,
    assignee: Optional[str] = None,
    typology: Optional[str] = None,
) -> list[dict]:
    filters = {"status": status, "assignee_email": assignee, "typology": typology}
    filters = {k: v for k, v in filters.items() if v is not None}

    async with _session() as session:
        if session is None:
            rows = [
                inv
                for inv in get_memory_store().list_investigations()
                if can_read_case(inv, user_email)
                and all(getattr(inv, k) == v for k, v in filters.items())
            ]
        else:
            from sqlalchemy import or_, select
            from sqlalchemy.orm import selectinload

            from graphlagoon.db.models import Investigation, InvestigationShare

            query = select(Investigation).options(selectinload(Investigation.shares))
            if not is_superuser(user_email):
                query = query.where(
                    or_(
                        Investigation.owner_email == user_email,
                        Investigation.assignee_email == user_email,
                        Investigation.id.in_(
                            select(InvestigationShare.investigation_id).where(
                                InvestigationShare.shared_with_email == user_email
                            )
                        ),
                    )
                )
            for key, value in filters.items():
                query = query.where(getattr(Investigation, key) == value)
            result = await session.execute(
                query.order_by(Investigation.updated_at.desc())
            )
            rows = result.scalars().all()
        counts = await _source_counts(session, [inv.id for inv in rows])
        return [
            {**serialize(inv, user_email), "source_count": counts.get(inv.id, 0)}
            for inv in rows
        ]


async def _source_counts(session, ids: list) -> dict:
    """Sources per case, for the queue (one grouped query, not one per case)."""
    if not ids:
        return {}
    if session is None:
        store = get_memory_store()
        return {
            i: len(store.list_investigation_children(_SOURCES, i)) for i in ids
        }
    from sqlalchemy import func, select

    from graphlagoon.db.models import InvestigationSource

    result = await session.execute(
        select(InvestigationSource.investigation_id, func.count())
        .where(InvestigationSource.investigation_id.in_(ids))
        .group_by(InvestigationSource.investigation_id)
    )
    return dict(result.all())


async def create_investigation(user_email: str, data: dict) -> dict:
    if data.get("assignee_email"):
        data["assignee_email"] = nominal_email(data["assignee_email"])

    async with _session() as session:
        if session is None:
            inv = get_memory_store().create_investigation(
                owner_email=user_email, **data
            )
            await append_event(session, inv.id, user_email, "case.created", data)
        else:
            from uuid import uuid4

            from graphlagoon.db.models import Investigation

            inv = Investigation(id=uuid4(), owner_email=user_email, state={}, **data)
            session.add(inv)
            await append_event(session, inv.id, user_email, "case.created", data)
            await session.commit()
            await _refresh(session, inv)
        return serialize(inv, user_email)


async def get_investigation(investigation_id: UUID, user_email: str) -> dict:
    async with _session() as session:
        return serialize(
            await load_case(session, investigation_id, user_email), user_email
        )


# Columns that are NOT NULL: an explicit null in a PATCH means "leave as is".
_REQUIRED_FIELDS = ("title", "status", "state")


async def update_investigation(
    investigation_id: UUID, user_email: str, changes: dict
) -> dict:
    changes = {
        k: v for k, v in changes.items() if v is not None or k not in _REQUIRED_FIELDS
    }
    if changes.get("assignee_email"):
        changes["assignee_email"] = nominal_email(changes["assignee_email"])

    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        await append_event(
            session,
            investigation_id,
            user_email,
            "case.updated",
            {k: v for k, v in changes.items() if k != "state"}
            | ({"state": "changed"} if "state" in changes else {}),
        )
        if session is None:
            get_memory_store().update_investigation(investigation_id, **changes)
        else:
            for key, value in changes.items():
                setattr(inv, key, value)
            await session.commit()
            await _refresh(session, inv)
        return serialize(inv, user_email)


async def delete_investigation(
    investigation_id: UUID, user_email: str, reason: Optional[str] = None
) -> dict:
    """Deletes the case; returns audit metadata. A decided case is retained
    (409) unless a superuser gives a reason."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "manage")
        if inv.decision is not None and not (
            is_superuser(user_email) and (reason or "").strip()
        ):
            raise InvestigationError(
                409,
                "INVESTIGATION_RETAINED",
                "A decided investigation is retained and cannot be deleted. "
                "Superusers may delete it with ?reason=.",
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


async def share_investigation(
    investigation_id: UUID, user_email: str, email: str, permission: str
) -> str:
    """Returns the normalized e-mail that was shared."""
    email = nominal_email(email)
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "manage")
        await append_event(
            session,
            investigation_id,
            user_email,
            "case.shared",
            {"with": email, "permission": permission},
        )
        if session is None:
            get_memory_store().share_investigation(investigation_id, email, permission)
        else:
            from graphlagoon.db.models import InvestigationShare

            existing = next(
                (s for s in inv.shares if s.shared_with_email == email), None
            )
            if existing is not None:
                existing.permission = permission
            else:
                session.add(
                    InvestigationShare(
                        investigation_id=investigation_id,
                        shared_with_email=email,
                        permission=permission,
                    )
                )
            await session.commit()
    return email


async def unshare_investigation(
    investigation_id: UUID, user_email: str, email: str
) -> bool:
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "manage")
        share = next((s for s in inv.shares if s.shared_with_email == email), None)
        if share is None:
            return False
        await append_event(
            session, investigation_id, user_email, "case.unshared", {"with": email}
        )
        if session is None:
            return get_memory_store().unshare_investigation(investigation_id, email)
        await session.delete(share)
        await session.commit()
        return True


# ---------------------------------------------------------------------------
# Sources (03-arquitetura §3.2): explorations from any context, redacted per caller
# ---------------------------------------------------------------------------

_SOURCES = "investigation_sources"
_store_singleton = None


def _blob_store():
    """Case storage (03 §2.3): `investigations/` under the snapshot volume or dir.

    shortcut: reuses the snapshot service's volume and auth; FA.2 adds the
    `investigations_volume_path` setting and its own configure step.
    """
    global _store_singleton
    if _store_singleton is None:
        import os

        from graphlagoon.config import get_settings
        from graphlagoon.services import snapshot
        from graphlagoon.services.named_store import build_blob_store

        settings = snapshot._snapshot_settings or get_settings()
        volume = settings.databricks_volume_path
        _store_singleton = build_blob_store(
            local_dir=os.path.join(
                settings.exploration_snapshots_dir, "investigations"
            ),
            volume_path=f"{volume.rstrip('/')}/investigations" if volume else None,
            databricks_host=settings.databricks_host,
            databricks_token=settings.databricks_token,
            header_provider=snapshot._snapshot_header_provider,
            what="investigation",
        )
    return _store_singleton


async def _context_readable(context_id: Optional[UUID], user_email: str) -> bool:
    from fastapi import HTTPException

    from graphlagoon.utils.context_access import get_context_with_access

    if context_id is None:
        return False
    try:
        await get_context_with_access(context_id, user_email)
        return True
    except HTTPException:
        return False


async def _get_row(session, model_name: str, row_id: Optional[UUID]) -> Any:
    """Exploration or GraphContext by id, from the DB or the memory store."""
    if row_id is None:
        return None
    if session is None:
        store = get_memory_store()
        return (
            store.get_exploration(row_id)
            if model_name == "Exploration"
            else store.get_graph_context(row_id)
        )
    from graphlagoon.db import models

    return await session.get(getattr(models, model_name), row_id)


async def _list_sources(session, investigation_id: UUID) -> list:
    if session is None:
        rows = get_memory_store().list_investigation_children(
            _SOURCES, investigation_id
        )
    else:
        from sqlalchemy import select

        from graphlagoon.db.models import InvestigationSource

        result = await session.execute(
            select(InvestigationSource).where(
                InvestigationSource.investigation_id == investigation_id
            )
        )
        rows = result.scalars().all()
    return sorted(rows, key=lambda s: s.position)


async def _serialize_source(session, source: Any, user_email: str) -> dict:
    exploration = await _get_row(session, "Exploration", source.exploration_id)
    context = await _get_row(session, "GraphContext", source.context_id)
    base = {
        "id": source.id,
        "kind": source.kind,
        "position": source.position,
        "title_snapshot": source.title_snapshot,
        "context_title": context.title if context else None,
        "owner_email": exploration.owner_email if exploration else source.added_by,
    }
    if not await _context_readable(source.context_id, user_email):
        return {**base, "accessible": False}
    return {
        **base,
        "accessible": True,
        "exploration_id": source.exploration_id,
        "context_id": source.context_id,
        "mode": source.mode,
        "frozen_sha256": source.frozen_sha256,
        "added_by": source.added_by,
        "added_at": source.added_at,
    }


async def list_sources(investigation_id: UUID, user_email: str) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        return [
            await _serialize_source(session, s, user_email)
            for s in await _list_sources(session, investigation_id)
        ]


async def _exploration_payload(exploration: Any) -> dict:
    """What a source shows: the exploration's state plus its saved snapshot."""
    from graphlagoon.services.snapshot import decompress_snapshot, get_snapshot_service

    snapshot = None
    if (exploration.state or {}).get("has_snapshot"):
        raw = await get_snapshot_service().load(exploration.id)
        snapshot = decompress_snapshot(raw) if raw else None
    return {
        "exploration": {
            "id": str(exploration.id),
            "title": exploration.title,
            "graph_context_id": str(exploration.graph_context_id),
            "owner_email": exploration.owner_email,
            "state": exploration.state or {},
        },
        "snapshot": snapshot,
    }


async def add_source(
    investigation_id: UUID,
    user_email: str,
    exploration_id: UUID,
    mode: str,
) -> dict:
    import gzip
    import hashlib
    import json
    from uuid import uuid4

    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        exploration = await _get_row(session, "Exploration", exploration_id)
        if exploration is None:
            raise InvestigationError(
                404,
                "EXPLORATION_NOT_FOUND",
                f"Exploration with id '{exploration_id}' not found",
            )
        # Reading the context covers every way to read the exploration
        # (ownership, exploration share, context share, superuser).
        if not await _context_readable(exploration.graph_context_id, user_email):
            raise InvestigationError(
                403,
                "FORBIDDEN",
                "You need read access to the exploration and its graph context",
            )
        existing = await _list_sources(session, investigation_id)
        if any(s.exploration_id == exploration_id for s in existing):
            raise InvestigationError(
                409,
                "SOURCE_EXISTS",
                "This exploration is already a source of the investigation",
            )

        source_id = uuid4()
        fields = {
            "id": source_id,
            "investigation_id": investigation_id,
            "kind": "exploration",
            "exploration_id": exploration_id,
            "context_id": exploration.graph_context_id,
            "mode": mode,
            "title_snapshot": exploration.title,
            "added_by": user_email,
            "position": len(existing),
        }
        if mode == "frozen":
            payload = await _exploration_payload(exploration)
            # mtime=0 keeps the bytes (and so the hash) a pure function of content.
            data = gzip.compress(
                json.dumps(payload, sort_keys=True, default=str).encode("utf-8"),
                mtime=0,
            )
            key = f"{investigation_id}/sources/{source_id}.json.gz"
            await _blob_store().save(key, data)
            fields["frozen_blob_key"] = key
            fields["frozen_sha256"] = hashlib.sha256(data).hexdigest()

        await append_event(
            session,
            investigation_id,
            user_email,
            "source.added",
            {
                "source_id": str(source_id),
                "exploration_id": str(exploration_id),
                "title": exploration.title,
                "mode": mode,
                "sha256": fields.get("frozen_sha256"),
            },
        )
        if session is None:
            source = get_memory_store().add_investigation_child(_SOURCES, **fields)
        else:
            from graphlagoon.db.models import InvestigationSource

            source = InvestigationSource(**fields)
            session.add(source)
            await session.commit()
            await session.refresh(source)
        return await _serialize_source(session, source, user_email)


async def _get_source(session, investigation_id: UUID, source_id: UUID) -> Any:
    if session is None:
        source = get_memory_store().get_investigation_child(_SOURCES, source_id)
    else:
        from graphlagoon.db.models import InvestigationSource

        source = await session.get(InvestigationSource, source_id)
    if source is None or source.investigation_id != investigation_id:
        raise InvestigationError(
            404, "SOURCE_NOT_FOUND", f"Source with id '{source_id}' not found"
        )
    return source


async def remove_source(
    investigation_id: UUID, user_email: str, source_id: UUID
) -> dict:
    """Removes the source row; a frozen blob stays (deleted only by retention)."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        source = await _get_source(session, investigation_id, source_id)
        meta = {
            "title": source.title_snapshot,
            "exploration_id": str(source.exploration_id),
        }
        await append_event(
            session,
            investigation_id,
            user_email,
            "source.removed",
            {"source_id": str(source_id), **meta},
        )
        if session is None:
            get_memory_store().delete_investigation_child(_SOURCES, source_id)
        else:
            await session.delete(source)
            await session.commit()
        return meta


async def source_snapshot(
    investigation_id: UUID, user_email: str, source_id: UUID
) -> dict:
    """The frozen copy, or the live exploration, if the caller reads its context."""
    import gzip
    import json

    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        source = await _get_source(session, investigation_id, source_id)
        if not await _context_readable(source.context_id, user_email):
            raise InvestigationError(
                403, "SOURCE_RESTRICTED", "You don't have access to this source"
            )
        if source.mode == "frozen":
            raw = await _blob_store().load(source.frozen_blob_key)
            if raw is None:
                raise InvestigationError(
                    404, "SOURCE_SNAPSHOT_MISSING", "Frozen copy not found"
                )
            return json.loads(gzip.decompress(raw))
        exploration = await _get_row(session, "Exploration", source.exploration_id)
        if exploration is None:
            raise InvestigationError(
                404, "EXPLORATION_NOT_FOUND", "The source exploration was deleted"
            )
        return await _exploration_payload(exploration)


# ---------------------------------------------------------------------------
# Journal (03-arquitetura §3.4): immutable, hash-chained events
# ---------------------------------------------------------------------------

_EVENTS = "investigation_events"
_NOTES = "investigation_notes"
EVENT_PAYLOAD_MAX_BYTES = 16 * 1024
# Kinds the client may post; everything else is written by the server itself.
CLIENT_EVENT_KINDS = frozenset(
    {"trace.run", "path.run", "typology.accepted", "nodes.promoted", "metric.saved"}
)
ROLES = ("victim", "mule", "exit", "discarded")


def _canonical(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


async def _list_events(session, investigation_id: UUID) -> list:
    if session is None:
        rows = get_memory_store().list_investigation_children(
            _EVENTS, investigation_id
        )
    else:
        from sqlalchemy import select

        from graphlagoon.db.models import InvestigationEvent

        result = await session.execute(
            select(InvestigationEvent).where(
                InvestigationEvent.investigation_id == investigation_id
            )
        )
        rows = result.scalars().all()
    return sorted(rows, key=lambda e: (e.at, str(e.id)))


async def append_event(
    session, investigation_id: UUID, actor_email: str, kind: str, payload: dict
) -> Any:
    """Adds one journal event (the caller commits). ``hash`` chains to the
    previous event: sha256(prev_hash + canonical json of this one).

    shortcut: prev_hash is read without a lock, so two concurrent writers can
    fork the chain; serialize per case if the chain must be verifiable.
    """
    import hashlib
    from datetime import datetime
    from uuid import uuid4

    events = await _list_events(session, investigation_id)
    prev_hash = events[-1].hash if events else None
    at = datetime.now()
    body = _canonical(
        {
            "investigation_id": str(investigation_id),
            "at": at.isoformat(),
            "actor_email": actor_email,
            "kind": kind,
            "payload": payload,
        }
    )
    fields = {
        "id": uuid4(),
        "investigation_id": investigation_id,
        "at": at,
        "actor_email": actor_email,
        "kind": kind,
        "payload": json.loads(_canonical(payload)),
        "prev_hash": prev_hash,
        "hash": hashlib.sha256(((prev_hash or "") + body).encode("utf-8")).hexdigest(),
    }
    if session is None:
        return get_memory_store().add_investigation_child(_EVENTS, **fields)
    from graphlagoon.db.models import InvestigationEvent

    event = InvestigationEvent(**fields)
    session.add(event)
    await session.flush()
    return event


def _serialize_event(e: Any) -> dict:
    return {
        "id": e.id,
        "at": e.at,
        "actor_email": e.actor_email,
        "kind": e.kind,
        "payload": e.payload or {},
        "prev_hash": e.prev_hash,
        "hash": e.hash,
    }


async def list_events(
    investigation_id: UUID,
    user_email: str,
    after: Optional[UUID] = None,
    limit: int = 100,
) -> list[dict]:
    """Oldest first; ``after`` is the id of the last event of the previous page."""
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        events = await _list_events(session, investigation_id)
        start = 0
        if after is not None:
            ids = [e.id for e in events]
            if after not in ids:
                raise InvestigationError(
                    404, "EVENT_NOT_FOUND", f"Event with id '{after}' not found"
                )
            start = ids.index(after) + 1
        return [_serialize_event(e) for e in events[start : start + limit]]


async def post_client_event(
    investigation_id: UUID, user_email: str, kind: str, payload: dict
) -> dict:
    if kind not in CLIENT_EVENT_KINDS:
        raise InvestigationError(
            422,
            "EVENT_KIND_NOT_ALLOWED",
            f"Clients may only post {sorted(CLIENT_EVENT_KINDS)}",
        )
    if len(_canonical(payload).encode("utf-8")) > EVENT_PAYLOAD_MAX_BYTES:
        raise InvestigationError(
            422, "EVENT_PAYLOAD_TOO_LARGE", "Event payload is limited to 16 KB"
        )
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        event = await append_event(
            session, investigation_id, user_email, kind, payload
        )
        if session is not None:
            await session.commit()
        return _serialize_event(event)


# ---------------------------------------------------------------------------
# Case state: roles and pins by unified node id (03 §5.1)
# ---------------------------------------------------------------------------


async def update_state(
    investigation_id: UUID,
    user_email: str,
    roles: Optional[dict[str, Optional[str]]],
    pins: Optional[dict[str, bool]],
) -> dict:
    """Merges role/pin changes into ``state``; one journal event per change."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        state = dict(inv.state or {})
        cur_roles = dict(state.get("roles") or {})
        cur_pins = list(state.get("pins") or [])
        events = []
        for entity, role in (roles or {}).items():
            before = cur_roles.get(entity)
            if role == before:
                continue
            if role is None:
                cur_roles.pop(entity, None)
            else:
                cur_roles[entity] = role
            events.append(("role.changed", {"entity": entity, "from": before, "to": role}))
        for entity, pinned in (pins or {}).items():
            if pinned == (entity in cur_pins):
                continue
            cur_pins = [*cur_pins, entity] if pinned else [p for p in cur_pins if p != entity]
            events.append(("pin.changed", {"entity": entity, "pinned": pinned}))
        state["roles"] = cur_roles
        state["pins"] = cur_pins
        for kind, payload in events:
            await append_event(session, investigation_id, user_email, kind, payload)
        if session is None:
            get_memory_store().update_investigation(investigation_id, state=state)
        else:
            inv.state = state
            await session.commit()
            await _refresh(session, inv)
        return serialize(inv, user_email)


# ---------------------------------------------------------------------------
# Notes (03 §3.5): anyone with write access adds; only the author edits/deletes
# ---------------------------------------------------------------------------


def _serialize_note(n: Any) -> dict:
    return {
        "id": n.id,
        "anchor": n.anchor or {},
        "body": n.body,
        "author_email": n.author_email,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
    }


async def list_notes(investigation_id: UUID, user_email: str) -> list[dict]:
    async with _session() as session:
        await load_case(session, investigation_id, user_email)
        if session is None:
            rows = get_memory_store().list_investigation_children(
                _NOTES, investigation_id
            )
        else:
            from sqlalchemy import select

            from graphlagoon.db.models import InvestigationNote

            result = await session.execute(
                select(InvestigationNote).where(
                    InvestigationNote.investigation_id == investigation_id
                )
            )
            rows = result.scalars().all()
        return [_serialize_note(n) for n in sorted(rows, key=lambda n: n.created_at)]


async def _get_note(session, investigation_id: UUID, note_id: UUID) -> Any:
    if session is None:
        note = get_memory_store().get_investigation_child(_NOTES, note_id)
    else:
        from graphlagoon.db.models import InvestigationNote

        note = await session.get(InvestigationNote, note_id)
    if note is None or note.investigation_id != investigation_id:
        raise InvestigationError(
            404, "NOTE_NOT_FOUND", f"Note with id '{note_id}' not found"
        )
    return note


def _ensure_author(note: Any, user_email: str) -> None:
    if note.author_email != user_email:
        raise InvestigationError(
            403, "FORBIDDEN", "Only the author can change or delete a note"
        )


async def create_note(
    investigation_id: UUID, user_email: str, anchor: dict, body: str
) -> dict:
    from datetime import datetime
    from uuid import uuid4

    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        now = datetime.now()
        fields = {
            "id": uuid4(),
            "investigation_id": investigation_id,
            "anchor": anchor,
            "body": body,
            "author_email": user_email,
            "created_at": now,
            "updated_at": now,
        }
        await append_event(
            session,
            investigation_id,
            user_email,
            "note.created",
            {"note_id": str(fields["id"]), "anchor": anchor, "body": body},
        )
        if session is None:
            note = get_memory_store().add_investigation_child(_NOTES, **fields)
        else:
            from graphlagoon.db.models import InvestigationNote

            note = InvestigationNote(**fields)
            session.add(note)
            await session.commit()
            await session.refresh(note)
        return _serialize_note(note)


async def update_note(
    investigation_id: UUID, user_email: str, note_id: UUID, changes: dict
) -> dict:
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        note = await _get_note(session, investigation_id, note_id)
        _ensure_author(note, user_email)
        await append_event(
            session,
            investigation_id,
            user_email,
            "note.updated",
            {"note_id": str(note_id), **changes},
        )
        if session is None:
            get_memory_store().update_investigation_child(_NOTES, note_id, **changes)
        else:
            for key, value in changes.items():
                setattr(note, key, value)
            await session.commit()
            await session.refresh(note)
        return _serialize_note(note)


async def delete_note(investigation_id: UUID, user_email: str, note_id: UUID) -> None:
    async with _session() as session:
        inv = await load_case(session, investigation_id, user_email, "write")
        _ensure_not_decided(inv)
        note = await _get_note(session, investigation_id, note_id)
        _ensure_author(note, user_email)
        # The journal keeps the text: deleting a note never erases what was said.
        await append_event(
            session,
            investigation_id,
            user_email,
            "note.deleted",
            {"note_id": str(note_id), "body": note.body},
        )
        if session is None:
            get_memory_store().delete_investigation_child(_NOTES, note_id)
        else:
            await session.delete(note)
            await session.commit()


async def transfer_owner(
    investigation_id: UUID, admin_email: str, new_owner: str
) -> dict:
    """Admin area: reassign the case. A share held by the new owner becomes
    redundant and is removed; the previous owner keeps no implicit access."""
    async with _session() as session:
        inv = await load_case(session, investigation_id, admin_email)
        previous = inv.owner_email
        await append_event(
            session,
            investigation_id,
            admin_email,
            "case.transferred",
            {"from": previous, "to": new_owner},
        )
        if session is None:
            inv.owner_email = new_owner
            inv.shares = [s for s in inv.shares if s.shared_with_email != new_owner]
        else:
            inv.owner_email = new_owner
            for share in list(inv.shares):
                if share.shared_with_email == new_owner:
                    await session.delete(share)
            await session.commit()
        return {"from": previous, "title": inv.title}
