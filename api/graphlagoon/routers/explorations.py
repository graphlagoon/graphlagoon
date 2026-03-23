from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from uuid import UUID
from typing import TYPE_CHECKING, Union

if TYPE_CHECKING:
    from graphlagoon.db.models import Exploration

from graphlagoon.db.database import is_database_available, get_session_maker
from graphlagoon.db.memory_store import (
    get_memory_store,
    MemoryExploration,
    MemoryGraphContext,
)
from graphlagoon.models.schemas import (
    ExplorationCreate,
    ExplorationUpdate,
    ExplorationResponse,
    ExplorationState,
    GraphSnapshot,
    ShareRequest,
)
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.utils.sharing import (
    user_has_share_access,
    user_has_write_access,
    validate_share_email,
)
from graphlagoon.config import get_settings

router = APIRouter(tags=["explorations"])


# ---------------------------------------------------------------------------
# Snapshot helpers
# ---------------------------------------------------------------------------

async def _persist_snapshot(exploration_id: UUID, snapshot: GraphSnapshot) -> None:
    """Compress and save a snapshot file.

    Raises:
        HTTPException 400: misconfiguration (missing volume path).
        HTTPException 403: Databricks permission denied.
        HTTPException 504: upstream timeout.
        HTTPException 502: network/connection error.
        HTTPException 500: unexpected storage error.
    """
    from graphlagoon.services.snapshot import (
        get_snapshot_service,
        compress_snapshot,
    )

    try:
        svc = get_snapshot_service()
        await svc.save(exploration_id, compress_snapshot(snapshot.model_dump()))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except (ConnectionError, OSError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Unexpected snapshot save error for %s: %s", exploration_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Snapshot storage error: {exc}") from exc


async def _delete_snapshot_if_exists(state: dict, exploration_id: UUID) -> None:
    """Delete snapshot file when exploration is deleted. Logs but never raises."""
    if not state.get("has_snapshot"):
        return
    try:
        from graphlagoon.services.snapshot import get_snapshot_service

        svc = get_snapshot_service()
        await svc.delete(exploration_id)
    except Exception as exc:
        logger.warning(
            "Could not delete snapshot for exploration %s: %s",
            exploration_id,
            exc,
        )


def exploration_to_response(
    exploration: Union["Exploration", MemoryExploration],
    user_email: str = "",
) -> ExplorationResponse:
    """Convert Exploration model to response schema."""
    shared_with = [share.shared_with_email for share in exploration.shares]
    state_data = exploration.state
    has_write = exploration.owner_email == user_email or user_has_write_access(
        user_email, exploration.shares
    )
    return ExplorationResponse(
        id=exploration.id,
        graph_context_id=exploration.graph_context_id,
        title=exploration.title,
        owner_email=exploration.owner_email,
        shared_with=shared_with,
        has_write_access=has_write,
        state=ExplorationState(**state_data)
        if isinstance(state_data, dict)
        else state_data,
        created_at=exploration.created_at,
        updated_at=exploration.updated_at,
    )


async def check_context_access_db(session, context_id: UUID, user_email: str):
    """Check if user has access to a graph context (database mode).

    Access granted via context ownership, context share, or exploration share.
    """
    from sqlalchemy import select, or_
    from sqlalchemy.orm import selectinload
    from graphlagoon.db.models import GraphContext, Exploration, ExplorationShare
    from graphlagoon.utils.sharing import extract_domain

    result = await session.execute(
        select(GraphContext)
        .options(selectinload(GraphContext.shares))
        .where(GraphContext.id == context_id)
    )
    context = result.scalar_one_or_none()

    if context is None:
        raise HTTPException(status_code=404, detail="Graph context not found")

    if context.owner_email == user_email:
        return context

    if user_has_share_access(user_email, context.shares):
        return context

    # Check exploration-level shares
    user_domain = extract_domain(user_email)
    share_conditions = [ExplorationShare.shared_with_email == user_email]
    if user_domain:
        share_conditions.append(
            ExplorationShare.shared_with_email == f"*@{user_domain}"
        )

    exp_share_result = await session.execute(
        select(ExplorationShare.id)
        .join(Exploration, ExplorationShare.exploration_id == Exploration.id)
        .where(
            Exploration.graph_context_id == context_id,
            or_(*share_conditions),
        )
        .limit(1)
    )
    if exp_share_result.scalar_one_or_none() is not None:
        return context

    raise HTTPException(status_code=403, detail="No access to this context")


def check_context_access_memory(
    context_id: UUID, user_email: str
) -> MemoryGraphContext:
    """Check if user has access to a graph context (memory mode).

    Access granted via context ownership, context share, or exploration share.
    """
    store = get_memory_store()
    context = store.get_graph_context(context_id)

    if context is None:
        raise HTTPException(status_code=404, detail="Graph context not found")

    if context.owner_email == user_email:
        return context

    if user_has_share_access(user_email, context.shares):
        return context

    # Check exploration-level shares
    for exp in store.explorations.values():
        if exp.graph_context_id == context_id and user_has_share_access(
            user_email, exp.shares
        ):
            return context

    raise HTTPException(status_code=403, detail="No access to this context")


@router.get("/api/explorations", response_model=list[ExplorationResponse])
async def list_all_explorations(request: Request):
    """List all explorations the user has access to.

    Includes explorations from contexts the user owns/has context-level shares,
    plus explorations directly shared with the user via ExplorationShare.
    """
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select, or_
        from sqlalchemy.orm import selectinload
        from graphlagoon.db.models import (
            Exploration,
            GraphContext,
            GraphContextShare,
            ExplorationShare,
        )
        from graphlagoon.utils.sharing import extract_domain

        user_domain = extract_domain(user_email)
        wildcard_pattern = f"*@{user_domain}" if user_domain else ""

        session_maker = get_session_maker()
        async with session_maker() as session:
            # Get all context IDs the user has access to (via ownership or context share)
            ctx_share_conditions = [
                GraphContextShare.shared_with_email == user_email,
            ]
            if wildcard_pattern:
                ctx_share_conditions.append(
                    GraphContextShare.shared_with_email == wildcard_pattern,
                )

            contexts_result = await session.execute(
                select(GraphContext.id)
                .outerjoin(GraphContextShare)
                .where(
                    or_(
                        GraphContext.owner_email == user_email,
                        *ctx_share_conditions,
                    )
                )
            )
            accessible_context_ids = [row[0] for row in contexts_result.fetchall()]

            # Get exploration IDs directly shared with the user
            exp_share_conditions = [ExplorationShare.shared_with_email == user_email]
            if wildcard_pattern:
                exp_share_conditions.append(
                    ExplorationShare.shared_with_email == wildcard_pattern,
                )

            direct_exp_result = await session.execute(
                select(ExplorationShare.exploration_id).where(
                    or_(*exp_share_conditions)
                )
            )
            direct_exploration_ids = [row[0] for row in direct_exp_result.fetchall()]

            if not accessible_context_ids and not direct_exploration_ids:
                return []

            # Build combined query: explorations from accessible contexts + directly shared
            conditions = []
            if accessible_context_ids:
                conditions.append(
                    Exploration.graph_context_id.in_(accessible_context_ids)
                )
            if direct_exploration_ids:
                conditions.append(Exploration.id.in_(direct_exploration_ids))

            result = await session.execute(
                select(Exploration)
                .options(selectinload(Exploration.shares))
                .where(or_(*conditions))
                .order_by(Exploration.updated_at.desc())
            )
            explorations = result.scalars().all()
            return [exploration_to_response(e, user_email) for e in explorations]
    else:
        store = get_memory_store()
        # Get accessible context IDs (via ownership or context share)
        accessible_context_ids = set()
        for ctx in store.graph_contexts.values():
            if ctx.owner_email == user_email:
                accessible_context_ids.add(ctx.id)
            elif user_has_share_access(user_email, ctx.shares):
                accessible_context_ids.add(ctx.id)

        # Collect explorations: from accessible contexts + directly shared
        seen_ids = set()
        explorations = []
        for e in store.explorations.values():
            if e.graph_context_id in accessible_context_ids:
                explorations.append(e)
                seen_ids.add(e.id)
            elif e.id not in seen_ids and user_has_share_access(user_email, e.shares):
                explorations.append(e)
                seen_ids.add(e.id)

        explorations.sort(key=lambda e: e.updated_at, reverse=True)
        return [exploration_to_response(e, user_email) for e in explorations]


@router.get(
    "/api/graph-contexts/{context_id}/explorations",
    response_model=list[ExplorationResponse],
)
async def list_explorations(context_id: UUID, request: Request):
    """List all explorations for a graph context (user must have context access)."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload
        from graphlagoon.db.models import Exploration

        session_maker = get_session_maker()
        async with session_maker() as session:
            # Check context access
            await check_context_access_db(session, context_id, user_email)

            # Return ALL explorations for this context
            result = await session.execute(
                select(Exploration)
                .options(selectinload(Exploration.shares))
                .where(Exploration.graph_context_id == context_id)
                .order_by(Exploration.updated_at.desc())
            )
            explorations = result.scalars().all()
            return [exploration_to_response(e, user_email) for e in explorations]
    else:
        # Check context access
        check_context_access_memory(context_id, user_email)

        store = get_memory_store()
        explorations = [
            e for e in store.explorations.values() if e.graph_context_id == context_id
        ]
        explorations.sort(key=lambda e: e.updated_at, reverse=True)
        return [exploration_to_response(e, user_email) for e in explorations]


@router.post(
    "/api/graph-contexts/{context_id}/explorations", response_model=ExplorationResponse
)
async def create_exploration(
    context_id: UUID, data: ExplorationCreate, request: Request
):
    """Create a new exploration for a graph context."""
    user_email = get_current_user(request)

    # Build state dict, marking has_snapshot if a snapshot is provided
    state_dict = data.state.model_dump()
    if data.snapshot is not None:
        state_dict["has_snapshot"] = True

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import Exploration

        session_maker = get_session_maker()
        async with session_maker() as session:
            # Check context access
            await check_context_access_db(session, context_id, user_email)

            # Check for duplicate name in this context
            existing = await session.execute(
                select(Exploration)
                .where(Exploration.graph_context_id == context_id)
                .where(Exploration.title == data.title)
            )
            existing_exploration = existing.scalar_one_or_none()

            if existing_exploration:
                raise HTTPException(
                    status_code=409,
                    detail=f"An exploration named '{data.title}' already exists in this context",
                )

            exploration = Exploration(
                graph_context_id=context_id,
                title=data.title,
                owner_email=user_email,
                state=state_dict,
            )
            session.add(exploration)
            await session.commit()
            await session.refresh(exploration)
            await session.refresh(exploration, ["shares"])

            if data.snapshot is not None:
                await _persist_snapshot(exploration.id, data.snapshot)

            return exploration_to_response(exploration, user_email)
    else:
        # Check context access
        check_context_access_memory(context_id, user_email)

        store = get_memory_store()

        # Check for duplicate name
        for exp in store.explorations.values():
            if exp.graph_context_id == context_id and exp.title == data.title:
                raise HTTPException(
                    status_code=409,
                    detail=f"An exploration named '{data.title}' already exists in this context",
                )

        exploration = store.create_exploration(
            graph_context_id=context_id,
            title=data.title,
            owner_email=user_email,
            state=state_dict,
        )

        if data.snapshot is not None:
            await _persist_snapshot(exploration.id, data.snapshot)

        return exploration_to_response(exploration, user_email)


@router.get("/api/explorations/{exploration_id}", response_model=ExplorationResponse)
async def get_exploration(exploration_id: UUID, request: Request):
    """Get a specific exploration.

    Access granted if user has context access OR a direct ExplorationShare.
    """
    user_email = get_current_user(request)

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
                raise HTTPException(status_code=404, detail="Exploration not found")

            # Allow if user owns the exploration or has a direct share
            if exploration.owner_email == user_email or user_has_share_access(
                user_email, exploration.shares
            ):
                return exploration_to_response(exploration, user_email)

            # Otherwise check context-level access
            await check_context_access_db(
                session, exploration.graph_context_id, user_email
            )
            return exploration_to_response(exploration, user_email)
    else:
        store = get_memory_store()
        exploration = store.get_exploration(exploration_id)

        if exploration is None:
            raise HTTPException(status_code=404, detail="Exploration not found")

        # Allow if user owns the exploration or has a direct share
        if exploration.owner_email == user_email or user_has_share_access(
            user_email, exploration.shares
        ):
            return exploration_to_response(exploration, user_email)

        # Otherwise check context-level access
        check_context_access_memory(exploration.graph_context_id, user_email)
        return exploration_to_response(exploration, user_email)


@router.put("/api/explorations/{exploration_id}", response_model=ExplorationResponse)
async def update_exploration(
    exploration_id: UUID, data: ExplorationUpdate, request: Request
):
    """Update an exploration (only owner can update)."""
    user_email = get_current_user(request)

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
                raise HTTPException(status_code=404, detail="Exploration not found")

            has_write = exploration.owner_email == user_email or user_has_write_access(
                user_email, exploration.shares
            )
            if not has_write:
                raise HTTPException(
                    status_code=403,
                    detail="No write access to update exploration",
                )

            # Check for duplicate name if title is being changed
            if data.title is not None and data.title != exploration.title:
                existing = await session.execute(
                    select(Exploration)
                    .where(Exploration.graph_context_id == exploration.graph_context_id)
                    .where(Exploration.title == data.title)
                    .where(Exploration.id != exploration_id)
                )
                if existing.scalar_one_or_none():
                    raise HTTPException(
                        status_code=409,
                        detail=f"An exploration named '{data.title}' already exists in this context",
                    )
                exploration.title = data.title

            if data.state is not None:
                new_state = data.state.model_dump()
                if data.snapshot is not None:
                    new_state["has_snapshot"] = True
                exploration.state = new_state
            elif data.snapshot is not None:
                # snapshot-only update: patch has_snapshot in existing state
                current = dict(exploration.state or {})
                current["has_snapshot"] = True
                exploration.state = current

            await session.commit()
            await session.refresh(exploration)
            await session.refresh(exploration, ["shares"])

            if data.snapshot is not None:
                await _persist_snapshot(exploration.id, data.snapshot)

            return exploration_to_response(exploration, user_email)
    else:
        store = get_memory_store()
        exploration = store.get_exploration(exploration_id)

        if exploration is None:
            raise HTTPException(status_code=404, detail="Exploration not found")

        has_write = exploration.owner_email == user_email or user_has_write_access(
            user_email, exploration.shares
        )
        if not has_write:
            raise HTTPException(
                status_code=403,
                detail="No write access to update exploration",
            )

        updates = {}

        # Check for duplicate name if title is being changed
        if data.title is not None and data.title != exploration.title:
            for exp in store.explorations.values():
                if (
                    exp.graph_context_id == exploration.graph_context_id
                    and exp.title == data.title
                    and exp.id != exploration_id
                ):
                    raise HTTPException(
                        status_code=409,
                        detail=f"An exploration named '{data.title}' already exists in this context",
                    )
            updates["title"] = data.title

        if data.state is not None:
            new_state = data.state.model_dump()
            if data.snapshot is not None:
                new_state["has_snapshot"] = True
            updates["state"] = new_state
        elif data.snapshot is not None:
            # snapshot-only update: patch has_snapshot in existing state
            current = dict(exploration.state or {})
            current["has_snapshot"] = True
            updates["state"] = current

        exploration = store.update_exploration(exploration_id, **updates)

        if data.snapshot is not None:
            await _persist_snapshot(exploration.id, data.snapshot)

        return exploration_to_response(exploration, user_email)


@router.delete("/api/explorations/{exploration_id}")
async def delete_exploration(exploration_id: UUID, request: Request):
    """Delete an exploration."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import Exploration

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(Exploration).where(Exploration.id == exploration_id)
            )
            exploration = result.scalar_one_or_none()

            if exploration is None:
                raise HTTPException(status_code=404, detail="Exploration not found")

            if exploration.owner_email != user_email:
                raise HTTPException(status_code=403, detail="Only owner can delete")

            state = exploration.state or {}
            await session.delete(exploration)
            await session.commit()

        await _delete_snapshot_if_exists(state, exploration_id)
    else:
        store = get_memory_store()
        exploration = store.get_exploration(exploration_id)

        if exploration is None:
            raise HTTPException(status_code=404, detail="Exploration not found")

        if exploration.owner_email != user_email:
            raise HTTPException(status_code=403, detail="Only owner can delete")

        state = exploration.state or {}
        store.delete_exploration(exploration_id)
        await _delete_snapshot_if_exists(state, exploration_id)

    return {"status": "deleted"}


@router.get("/api/explorations/{exploration_id}/snapshot")
async def get_exploration_snapshot(exploration_id: UUID, request: Request):
    """Return the graph snapshot (nodes + edges) for an exploration.

    Returns 404 if the exploration has no snapshot or the file is missing.
    Access control mirrors get_exploration.
    """
    user_email = get_current_user(request)

    # Resolve the exploration and check access (reuses existing logic)
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
                raise HTTPException(status_code=404, detail="Exploration not found")

            if exploration.owner_email != user_email and not user_has_share_access(
                user_email, exploration.shares
            ):
                await check_context_access_db(
                    session, exploration.graph_context_id, user_email
                )

            state = exploration.state or {}
    else:
        store = get_memory_store()
        exploration = store.get_exploration(exploration_id)
        if exploration is None:
            raise HTTPException(status_code=404, detail="Exploration not found")

        if exploration.owner_email != user_email and not user_has_share_access(
            user_email, exploration.shares
        ):
            check_context_access_memory(exploration.graph_context_id, user_email)

        state = exploration.state or {}

    if not state.get("has_snapshot"):
        raise HTTPException(
            status_code=404, detail="This exploration has no snapshot"
        )

    from graphlagoon.services.snapshot import get_snapshot_service, decompress_snapshot

    try:
        svc = get_snapshot_service()
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    data = await svc.load(exploration_id)
    if data is None:
        raise HTTPException(
            status_code=404,
            detail="Snapshot file not found (may have been deleted)",
        )

    return decompress_snapshot(data)


@router.post("/api/explorations/{exploration_id}/share")
async def share_exploration(exploration_id: UUID, data: ShareRequest, request: Request):
    """Share an exploration with another user."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload
        from graphlagoon.db.models import Exploration, ExplorationShare

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(Exploration)
                .options(selectinload(Exploration.shares))
                .where(Exploration.id == exploration_id)
            )
            exploration = result.scalar_one_or_none()

            if exploration is None:
                raise HTTPException(status_code=404, detail="Exploration not found")

            if exploration.owner_email != user_email:
                raise HTTPException(status_code=403, detail="Only owner can share")

            # Validate email/wildcard
            settings = get_settings()
            is_valid, error_msg = validate_share_email(
                data.email,
                settings.allowed_share_domain_list,
            )
            if not is_valid:
                raise HTTPException(status_code=400, detail=error_msg)

            # Check if already shared
            for share in exploration.shares:
                if share.shared_with_email == data.email:
                    share.permission = data.permission
                    await session.commit()
                    return {"status": "updated"}

            # Create new share
            share = ExplorationShare(
                exploration_id=exploration_id,
                shared_with_email=data.email,
                permission=data.permission,
            )
            session.add(share)
            await session.commit()
    else:
        store = get_memory_store()
        exploration = store.get_exploration(exploration_id)

        if exploration is None:
            raise HTTPException(status_code=404, detail="Exploration not found")

        if exploration.owner_email != user_email:
            raise HTTPException(status_code=403, detail="Only owner can share")

        # Validate email/wildcard
        settings = get_settings()
        is_valid, error_msg = validate_share_email(
            data.email,
            settings.allowed_share_domain_list,
        )
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg)

        store.share_exploration(exploration_id, data.email, data.permission)

    return {"status": "shared"}


@router.delete("/api/explorations/{exploration_id}/share/{email}")
async def unshare_exploration(exploration_id: UUID, email: str, request: Request):
    """Remove sharing for an exploration."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import Exploration, ExplorationShare

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(Exploration).where(Exploration.id == exploration_id)
            )
            exploration = result.scalar_one_or_none()

            if exploration is None:
                raise HTTPException(
                    status_code=404,
                    detail="Exploration not found",
                )

            if exploration.owner_email != user_email:
                raise HTTPException(
                    status_code=403,
                    detail="Only owner can manage sharing",
                )

            result = await session.execute(
                select(ExplorationShare).where(
                    ExplorationShare.exploration_id == exploration_id,
                    ExplorationShare.shared_with_email == email,
                )
            )
            share = result.scalar_one_or_none()

            if share:
                await session.delete(share)
                await session.commit()
    else:
        store = get_memory_store()
        exploration = store.get_exploration(exploration_id)

        if exploration is None:
            raise HTTPException(
                status_code=404,
                detail="Exploration not found",
            )

        if exploration.owner_email != user_email:
            raise HTTPException(
                status_code=403,
                detail="Only owner can manage sharing",
            )

        store.unshare_exploration(exploration_id, email)

    return {"status": "removed"}
