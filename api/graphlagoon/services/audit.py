"""Audit trail for privileged and destructive actions.

Writes to ``usage_logs`` (DB mode) or to ``InMemoryStore.usage_logs`` (memory
mode) — the table has existed since migration 001 but nothing wrote to it
before the admin area. Recording never raises: an audit failure is logged and
the request that triggered it proceeds, because losing one log line is
preferable to failing a user's delete halfway through.

Which routes must call ``record`` is governed by
``routers.admin_registry.AUDITED_ROUTES`` and enforced by
``tests/test_admin_registry.py``.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store

logger = logging.getLogger(__name__)


class AuditAction:
    """Canonical action names. ``<resource>.<verb>``; filterable in the admin UI."""

    CONTEXT_DELETE = "context.delete"
    CONTEXT_SHARE = "context.share"
    CONTEXT_UNSHARE = "context.unshare"
    CONTEXT_TRANSFER = "context.transfer"
    EXPLORATION_DELETE = "exploration.delete"
    EXPLORATION_SHARE = "exploration.share"
    EXPLORATION_UNSHARE = "exploration.unshare"
    EXPLORATION_TRANSFER = "exploration.transfer"
    PRECOMPUTED_PUBLISH = "precomputed.publish"
    PRECOMPUTED_DELETE = "precomputed.delete"
    PRESET_DELETE = "preset.delete"
    ADMIN_CLEAR_ALL = "admin.clear_all"
    GROUP_CREATE = "group.create"
    GROUP_UPDATE = "group.update"
    GROUP_DELETE = "group.delete"
    PERMISSION_UPDATE = "permission.update"

    @classmethod
    def all(cls) -> list[str]:
        return sorted(
            v for k, v in vars(cls).items() if k.isupper() and isinstance(v, str)
        )


# Metadata is free-form JSON supplied by handlers; cap it so an audit entry
# can never become a storage vector (e.g. a 200 MB precomputed name list).
MAX_METADATA_BYTES = 4096
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


def _bounded_metadata(metadata: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not metadata:
        return None
    try:
        encoded = json.dumps(metadata, default=str)
    except (TypeError, ValueError):
        return {"_error": "metadata not serialisable"}
    if len(encoded) <= MAX_METADATA_BYTES:
        return json.loads(encoded)
    return {
        "_truncated": True,
        "_preview": encoded[: MAX_METADATA_BYTES - 64],
    }


async def record(
    user_email: str,
    action: str,
    *,
    resource_type: Optional[str] = None,
    resource_id: Optional[UUID] = None,
    metadata: Optional[dict[str, Any]] = None,
    session=None,
) -> None:
    """Append one audit entry. Safe to call from any handler; never raises.

    ``session``: in DB mode, pass the handler's session to write the entry in
    the same transaction as the change it describes (so a rolled-back delete
    leaves no orphan log line). Without it a short-lived session is used —
    that is the right choice *after* a destructive step such as clear-all.
    """
    bounded = _bounded_metadata(metadata)
    try:
        if is_database_available():
            from graphlagoon.db.models import UsageLog

            entry = UsageLog(
                user_email=user_email,
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                log_metadata=bounded,
            )
            if session is not None:
                session.add(entry)
                await session.flush()
            else:
                session_maker = get_session_maker()
                async with session_maker() as own:
                    own.add(entry)
                    await own.commit()
        else:
            get_memory_store().record_usage(
                user_email=user_email,
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                log_metadata=bounded,
            )
    except Exception as exc:  # pragma: no cover - defensive by design
        logger.warning("audit record failed (%s by %s): %s", action, user_email, exc)


def _serialise(
    entry_id: UUID,
    user_email: str,
    action: str,
    resource_type: Optional[str],
    resource_id: Optional[UUID],
    metadata: Optional[dict],
    created_at: Optional[datetime],
) -> dict[str, Any]:
    return {
        "id": str(entry_id),
        "user_email": user_email,
        "action": action,
        "resource_type": resource_type,
        "resource_id": str(resource_id) if resource_id else None,
        "metadata": metadata or {},
        "created_at": created_at.isoformat() if created_at else None,
    }


async def list_entries(
    *,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
    user_email: Optional[str] = None,
    action: Optional[str] = None,
) -> dict[str, Any]:
    """Newest-first page of audit entries with optional user/action filters."""
    page = max(1, page)
    page_size = max(1, min(page_size, MAX_PAGE_SIZE))
    offset = (page - 1) * page_size

    if is_database_available():
        from sqlalchemy import func, select

        from graphlagoon.db.models import UsageLog

        session_maker = get_session_maker()
        async with session_maker() as session:
            query = select(UsageLog)
            count_query = select(func.count()).select_from(UsageLog)
            if user_email:
                query = query.where(UsageLog.user_email == user_email)
                count_query = count_query.where(UsageLog.user_email == user_email)
            if action:
                query = query.where(UsageLog.action == action)
                count_query = count_query.where(UsageLog.action == action)
            total = (await session.execute(count_query)).scalar_one()
            rows = (
                (
                    await session.execute(
                        query.order_by(UsageLog.created_at.desc(), UsageLog.id.desc())
                        .offset(offset)
                        .limit(page_size)
                    )
                )
                .scalars()
                .all()
            )
            items = [
                _serialise(
                    r.id,
                    r.user_email,
                    r.action,
                    r.resource_type,
                    r.resource_id,
                    r.log_metadata,
                    r.created_at,
                )
                for r in rows
            ]
    else:
        store = get_memory_store()
        entries = list(store.usage_logs)
        if user_email:
            entries = [e for e in entries if e.user_email == user_email]
        if action:
            entries = [e for e in entries if e.action == action]
        entries.reverse()  # deque is oldest-first
        total = len(entries)
        items = [
            _serialise(
                e.id,
                e.user_email,
                e.action,
                e.resource_type,
                e.resource_id,
                e.log_metadata,
                e.created_at,
            )
            for e in entries[offset : offset + page_size]
        ]

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "actions": AuditAction.all(),
    }
