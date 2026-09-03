"""Admin area API — superuser only.

Every route on this router inherits ``require_superuser`` through the
router-level ``dependencies`` argument, so a handler added here cannot forget
the gate (``tests/test_admin.py`` walks ``router.routes`` and asserts 403 for
a non-superuser on each). Identity is resolved with ``get_current_user``, which
works with or without ``AuthMiddleware`` (mounted deployments).

The area *shows* the environment and *fixes ownership*; it does not edit
settings, datasources or the superuser list — those are process-start
configuration by design (see docs/dev/admin-area.md).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from graphlagoon.config import Settings, get_settings
from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.models.schemas import (
    AdminConfigEntry,
    AdminCounts,
    AdminHealth,
    AdminOverview,
    AdminStorage,
    AdminUser,
    AdminUserPage,
    AuditPage,
    ClearEnvironmentRequest,
    ClearEnvironmentResponse,
    TransferOwnershipRequest,
    TransferOwnershipResponse,
)
from graphlagoon.routers.admin_registry import CONFIG_FIELD_KINDS
from graphlagoon.services import audit
from graphlagoon.services.audit import AuditAction
from graphlagoon.services.environment import (
    alembic_version,
    clear_environment,
    database_health,
    persistence_backend,
    probe_warehouse,
)
from graphlagoon.services.public_config import app_version, build_public_config
from graphlagoon.services.users import touch_user
from graphlagoon.utils.authz import is_superuser, require_superuser
from graphlagoon.utils.sharing import validate_owner_email

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(require_superuser)],
)

CLEAR_CONFIRMATION = "CLEAR ALL"
MAX_PAGE_SIZE = 200


def _error(status: int, code: str, message: str, details: dict | None = None):
    return HTTPException(
        status_code=status,
        detail={"error": {"code": code, "message": message, "details": details or {}}},
    )


# ---------------------------------------------------------------------------
# Overview / config
# ---------------------------------------------------------------------------


async def _counts() -> AdminCounts:
    if is_database_available():
        from sqlalchemy import func, select

        from graphlagoon.db.models import (
            Exploration,
            GraphContext,
            Group,
            QueryTemplate,
            UsageLog,
            User,
        )

        session_maker = get_session_maker()
        async with session_maker() as session:

            async def count(model) -> int:
                return (
                    await session.execute(select(func.count()).select_from(model))
                ).scalar_one()

            return AdminCounts(
                users=await count(User),
                contexts=await count(GraphContext),
                explorations=await count(Exploration),
                query_templates=await count(QueryTemplate),
                audit_entries=await count(UsageLog),
                groups=await count(Group),
            )
    store = get_memory_store()
    return AdminCounts(
        users=len(store.users),
        contexts=len(store.graph_contexts),
        explorations=len(store.explorations),
        query_templates=len(store.query_templates),
        audit_entries=len(store.usage_logs),
        groups=len(store.groups),
    )


def _storage(settings: Settings) -> AdminStorage:
    return AdminStorage(
        exploration_snapshots=(
            settings.databricks_volume_path
            if settings.databricks_mode and settings.databricks_volume_path
            else settings.exploration_snapshots_dir
        ),
        precomputed_graphs=(
            settings.precomputed_graphs_volume_path_effective
            or settings.precomputed_graphs_dir
        ),
        style_presets=(
            settings.style_presets_volume_path_effective or settings.style_presets_dir
        ),
    )


@router.get("/overview", response_model=AdminOverview)
async def get_overview(user_email: str = Depends(require_superuser)):
    """Environment at a glance. Cheap: no warehouse call (see /health/warehouse)."""
    settings = get_settings()
    return AdminOverview(
        version=app_version(),
        dev_mode=settings.dev_mode,
        databricks_mode=settings.databricks_mode,
        persistence_backend=persistence_backend(settings),
        alembic_version=await alembic_version(),
        counts=await _counts(),
        superusers=settings.superuser_email_list,
        storage=_storage(settings),
        public_config=await build_public_config(user_email, settings),
        health={"database": AdminHealth(**await database_health())},
    )


@router.post("/health/warehouse", response_model=AdminHealth)
async def warehouse_health():
    """On-demand warehouse probe (may wake a stopped SQL warehouse)."""
    return AdminHealth(**await probe_warehouse())


@router.get("/config", response_model=list[AdminConfigEntry])
async def get_config():
    """Effective settings, by allowlist: secrets only as set / not set."""
    settings = get_settings()
    prefix = Settings.model_config.get("env_prefix", "")
    entries: list[AdminConfigEntry] = []
    for key in type(settings).model_fields:
        kind = CONFIG_FIELD_KINDS.get(key, "hidden")
        if kind == "hidden":
            continue
        raw = getattr(settings, key)
        if kind == "secret":
            value: Any = "set" if raw not in (None, "") else "not set"
        else:
            value = raw
        entries.append(
            AdminConfigEntry(
                key=key, env_var=f"{prefix}{key}".upper(), value=value, kind=kind
            )
        )
    return entries


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


@router.get("/users", response_model=AdminUserPage)
async def list_users(
    q: Optional[str] = Query(default=None, max_length=255),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=MAX_PAGE_SIZE),
):
    """Known users (auto-registered on first request) with ownership counts."""
    needle = (q or "").strip().lower()
    rows: list[dict[str, Any]] = []

    if is_database_available():
        from sqlalchemy import func, select

        from graphlagoon.db.models import Exploration, GraphContext, User

        session_maker = get_session_maker()
        async with session_maker() as session:
            ctx_counts = dict(
                (
                    await session.execute(
                        select(GraphContext.owner_email, func.count()).group_by(
                            GraphContext.owner_email
                        )
                    )
                ).all()
            )
            exp_counts = dict(
                (
                    await session.execute(
                        select(Exploration.owner_email, func.count()).group_by(
                            Exploration.owner_email
                        )
                    )
                ).all()
            )
            users = (await session.execute(select(User))).scalars().all()
            for u in users:
                rows.append(
                    {
                        "email": u.email,
                        "display_name": u.display_name,
                        "created_at": u.created_at,
                        "last_seen_at": u.last_seen_at,
                        "contexts_owned": ctx_counts.get(u.email, 0),
                        "explorations_owned": exp_counts.get(u.email, 0),
                    }
                )
    else:
        store = get_memory_store()
        ctx_counts: dict[str, int] = {}
        for c in store.graph_contexts.values():
            ctx_counts[c.owner_email] = ctx_counts.get(c.owner_email, 0) + 1
        exp_counts: dict[str, int] = {}
        for e in store.explorations.values():
            exp_counts[e.owner_email] = exp_counts.get(e.owner_email, 0) + 1
        # Owners of resources are users even if they never logged in again.
        known = set(store.users) | set(ctx_counts) | set(exp_counts)
        for email in known:
            u = store.users.get(email)
            rows.append(
                {
                    "email": email,
                    "display_name": u.display_name if u else email.split("@")[0],
                    "created_at": u.created_at if u else None,
                    "last_seen_at": u.last_seen_at if u else None,
                    "contexts_owned": ctx_counts.get(email, 0),
                    "explorations_owned": exp_counts.get(email, 0),
                }
            )

    if needle:
        rows = [
            r
            for r in rows
            if needle in r["email"].lower()
            or needle in (r["display_name"] or "").lower()
        ]

    def _sort_key(r: dict[str, Any]):
        seen = (
            r["last_seen_at"]
            or r["created_at"]
            or datetime.min.replace(tzinfo=timezone.utc)
        )
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        return (seen, r["email"])

    rows.sort(key=_sort_key, reverse=True)
    total = len(rows)
    start = (page - 1) * page_size
    items = [
        AdminUser(is_superuser=is_superuser(r["email"]), **r)
        for r in rows[start : start + page_size]
    ]
    return AdminUserPage(items=items, total=total, page=page, page_size=page_size)


# ---------------------------------------------------------------------------
# Ownership transfer
# ---------------------------------------------------------------------------


def _validated_owner(email: str) -> str:
    ok, message = validate_owner_email(email)
    if not ok:
        raise _error(422, "INVALID_OWNER", message)
    return email.strip()


@router.post(
    "/contexts/{context_id}/transfer", response_model=TransferOwnershipResponse
)
async def transfer_context(
    context_id: UUID,
    data: TransferOwnershipRequest,
    admin_email: str = Depends(require_superuser),
):
    """Reassign a context to another user (e.g. the owner left the company).

    A share held by the new owner becomes redundant and is removed; the old
    owner keeps no implicit access — grant a share explicitly if needed.
    """
    new_owner = _validated_owner(data.new_owner_email)

    if is_database_available():
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from graphlagoon.db.models import GraphContext

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(GraphContext)
                .options(selectinload(GraphContext.shares))
                .where(GraphContext.id == context_id)
            )
            context = result.scalar_one_or_none()
            if context is None:
                raise _error(404, "NOT_FOUND", "Graph context not found")
            previous = context.owner_email
            context.owner_email = new_owner
            for share in list(context.shares):
                if share.shared_with_email == new_owner:
                    await session.delete(share)
            await touch_user(new_owner, session=session)
            await audit.record(
                admin_email,
                AuditAction.CONTEXT_TRANSFER,
                resource_type="graph_context",
                resource_id=context_id,
                metadata={"from": previous, "to": new_owner, "title": context.title},
                session=session,
            )
            await session.commit()
    else:
        store = get_memory_store()
        context = store.get_graph_context(context_id)
        if context is None:
            raise _error(404, "NOT_FOUND", "Graph context not found")
        previous = context.owner_email
        context.owner_email = new_owner
        context.shares = [s for s in context.shares if s.shared_with_email != new_owner]
        context.updated_at = datetime.now()
        await touch_user(new_owner)
        await audit.record(
            admin_email,
            AuditAction.CONTEXT_TRANSFER,
            resource_type="graph_context",
            resource_id=context_id,
            metadata={"from": previous, "to": new_owner, "title": context.title},
        )

    return TransferOwnershipResponse(
        id=context_id, previous_owner_email=previous, owner_email=new_owner
    )


@router.post(
    "/explorations/{exploration_id}/transfer",
    response_model=TransferOwnershipResponse,
)
async def transfer_exploration(
    exploration_id: UUID,
    data: TransferOwnershipRequest,
    admin_email: str = Depends(require_superuser),
):
    """Reassign an exploration to another user."""
    new_owner = _validated_owner(data.new_owner_email)

    if is_database_available():
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload

        from graphlagoon.db.models import Exploration

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(Exploration)
                .options(selectinload(Exploration.shares))
                .where(Exploration.id == exploration_id)
            )
            exploration = result.scalar_one_or_none()
            if exploration is None:
                raise _error(404, "NOT_FOUND", "Exploration not found")
            previous = exploration.owner_email
            exploration.owner_email = new_owner
            for share in list(exploration.shares):
                if share.shared_with_email == new_owner:
                    await session.delete(share)
            await touch_user(new_owner, session=session)
            await audit.record(
                admin_email,
                AuditAction.EXPLORATION_TRANSFER,
                resource_type="exploration",
                resource_id=exploration_id,
                metadata={
                    "from": previous,
                    "to": new_owner,
                    "title": exploration.title,
                },
                session=session,
            )
            await session.commit()
    else:
        store = get_memory_store()
        exploration = store.get_exploration(exploration_id)
        if exploration is None:
            raise _error(404, "NOT_FOUND", "Exploration not found")
        previous = exploration.owner_email
        exploration.owner_email = new_owner
        exploration.shares = [
            s for s in exploration.shares if s.shared_with_email != new_owner
        ]
        exploration.updated_at = datetime.now()
        await touch_user(new_owner)
        await audit.record(
            admin_email,
            AuditAction.EXPLORATION_TRANSFER,
            resource_type="exploration",
            resource_id=exploration_id,
            metadata={"from": previous, "to": new_owner, "title": exploration.title},
        )

    return TransferOwnershipResponse(
        id=exploration_id, previous_owner_email=previous, owner_email=new_owner
    )


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------


@router.get("/audit", response_model=AuditPage)
async def list_audit(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=MAX_PAGE_SIZE),
    user: Optional[str] = Query(default=None, max_length=255),
    action: Optional[str] = Query(default=None, max_length=100),
):
    """Newest-first audit trail with user / action filters."""
    return AuditPage(
        **await audit.list_entries(
            page=page, page_size=page_size, user_email=user, action=action
        )
    )


# ---------------------------------------------------------------------------
# Danger zone
# ---------------------------------------------------------------------------


@router.post("/environment/clear", response_model=ClearEnvironmentResponse)
async def clear_environment_endpoint(
    data: ClearEnvironmentRequest, admin_email: str = Depends(require_superuser)
):
    """Wipe every user resource and the warehouse tables. Dev mode only.

    POST (not DELETE-with-body: proxies drop DELETE bodies). Needs the
    literal confirmation string on top of the superuser gate. The audit entry
    is written *after* the wipe because ``usage_logs`` is preserved and the
    entry must survive.
    """
    settings = get_settings()
    if not settings.dev_mode:
        raise _error(
            403,
            "FORBIDDEN",
            "Clearing the environment is only available in dev mode.",
        )
    if data.confirm != CLEAR_CONFIRMATION:
        raise _error(
            400,
            "CONFIRMATION_REQUIRED",
            f'Type "{CLEAR_CONFIRMATION}" to confirm.',
        )

    from graphlagoon.services.warehouse import get_warehouse_client

    result = await clear_environment(warehouse=get_warehouse_client())
    await audit.record(
        admin_email,
        AuditAction.ADMIN_CLEAR_ALL,
        resource_type="environment",
        metadata={"cleared": result["cleared"]},
    )
    return ClearEnvironmentResponse(
        status="cleared", cleared=result["cleared"], warehouse=result["warehouse"]
    )

