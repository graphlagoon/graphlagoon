from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from uuid import UUID
from typing import TYPE_CHECKING, Union

if TYPE_CHECKING:
    from graphlagoon.db.models import GraphContext

from graphlagoon.db.database import is_database_available, get_session_maker
from graphlagoon.db.memory_store import get_memory_store, MemoryGraphContext
from graphlagoon.models.schemas import (
    GraphContextCreate,
    GraphContextUpdate,
    GraphContextResponse,
    ShareRequest,
    EdgeStructure,
    NodeStructure,
    PropertyColumn,
)
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.utils.sharing import (
    extract_domain,
    user_has_share_access,
    user_has_write_access,
    validate_share_email,
)
from graphlagoon.config import get_settings

router = APIRouter(prefix="/api/graph-contexts", tags=["graph-contexts"])


def context_to_response(
    context: Union["GraphContext", MemoryGraphContext],
    user_email: str = "",
) -> GraphContextResponse:
    """Convert GraphContext model to response schema."""
    shared_with = [share.shared_with_email for share in context.shares]
    has_write = context.owner_email == user_email or user_has_write_access(
        user_email, context.shares
    )

    # Parse structure configs from JSON/dict
    edge_struct = context.edge_structure or {}
    node_struct = context.node_structure or {}

    # Parse property columns from JSON/list
    edge_props_raw = context.edge_properties or []
    node_props_raw = context.node_properties or []

    # Handle both dict and PropertyColumn objects
    edge_props = [
        PropertyColumn(**p) if isinstance(p, dict) else p for p in edge_props_raw
    ]
    node_props = [
        PropertyColumn(**p) if isinstance(p, dict) else p for p in node_props_raw
    ]

    return GraphContextResponse(
        id=context.id,
        title=context.title,
        description=context.description,
        tags=context.tags or [],
        edge_table_name=context.edge_table_name,
        node_table_name=context.node_table_name,
        edge_structure=EdgeStructure(**edge_struct)
        if isinstance(edge_struct, dict)
        else edge_struct,
        node_structure=NodeStructure(**node_struct)
        if isinstance(node_struct, dict)
        else node_struct,
        edge_properties=edge_props,
        node_properties=node_props,
        node_types=context.node_types or [],
        relationship_types=context.relationship_types or [],
        owner_email=context.owner_email,
        shared_with=shared_with,
        has_write_access=has_write,
        created_at=context.created_at,
        updated_at=context.updated_at,
    )


@router.get("", response_model=list[GraphContextResponse])
async def list_graph_contexts(request: Request):
    """List graph contexts the user has access to.

    Returns contexts where the user:
    - Owns the context, OR
    - Has a context-level share (GraphContextShare), OR
    - Has an exploration-level share (ExplorationShare) for any exploration in the context
    """
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select, or_
        from sqlalchemy.orm import selectinload
        from graphlagoon.db.models import (
            GraphContext,
            GraphContextShare,
            Exploration,
            ExplorationShare,
        )

        user_domain = extract_domain(user_email)
        ctx_share_conditions = [GraphContextShare.shared_with_email == user_email]
        exp_share_conditions = [ExplorationShare.shared_with_email == user_email]
        if user_domain:
            ctx_share_conditions.append(
                GraphContextShare.shared_with_email == f"*@{user_domain}"
            )
            exp_share_conditions.append(
                ExplorationShare.shared_with_email == f"*@{user_domain}"
            )

        session_maker = get_session_maker()
        async with session_maker() as session:
            # Context IDs shared directly with user
            ctx_share_q = select(GraphContextShare.graph_context_id).where(
                or_(*ctx_share_conditions)
            )
            # Context IDs accessible via exploration shares
            exp_share_q = (
                select(Exploration.graph_context_id)
                .join(
                    ExplorationShare, ExplorationShare.exploration_id == Exploration.id
                )
                .where(or_(*exp_share_conditions))
            )

            result = await session.execute(
                select(GraphContext)
                .options(selectinload(GraphContext.shares))
                .where(
                    or_(
                        GraphContext.owner_email == user_email,
                        GraphContext.id.in_(ctx_share_q),
                        GraphContext.id.in_(exp_share_q),
                    )
                )
                .order_by(GraphContext.updated_at.desc())
            )
            contexts = result.scalars().all()
            return [context_to_response(ctx, user_email) for ctx in contexts]
    else:
        store = get_memory_store()
        accessible = []
        for ctx in store.graph_contexts.values():
            if ctx.owner_email == user_email:
                accessible.append(ctx)
                continue
            if user_has_share_access(user_email, ctx.shares):
                accessible.append(ctx)
                continue
            # Check exploration-level shares
            for exp in store.explorations.values():
                if exp.graph_context_id == ctx.id and user_has_share_access(
                    user_email, exp.shares
                ):
                    accessible.append(ctx)
                    break

        accessible.sort(key=lambda c: c.updated_at, reverse=True)
        return [context_to_response(ctx, user_email) for ctx in accessible]


@router.post("", response_model=GraphContextResponse)
async def create_graph_context(request: Request, data: GraphContextCreate):
    """Create a new graph context."""
    user_email = get_current_user(request)

    if is_database_available():
        from graphlagoon.db.models import GraphContext

        session_maker = get_session_maker()
        async with session_maker() as session:
            context = GraphContext(
                title=data.title,
                description=data.description,
                tags=data.tags,
                edge_table_name=data.edge_table_name,
                node_table_name=data.node_table_name,
                edge_structure=data.edge_structure.model_dump(),
                node_structure=data.node_structure.model_dump(),
                edge_properties=[p.model_dump() for p in data.edge_properties],
                node_properties=[p.model_dump() for p in data.node_properties],
                node_types=data.node_types,
                relationship_types=data.relationship_types,
                owner_email=user_email,
            )
            session.add(context)
            await session.commit()
            await session.refresh(context)
            await session.refresh(context, ["shares"])
            return context_to_response(context, user_email)
    else:
        store = get_memory_store()
        context = store.create_graph_context(
            title=data.title,
            description=data.description,
            tags=data.tags,
            edge_table_name=data.edge_table_name,
            node_table_name=data.node_table_name,
            edge_structure=data.edge_structure.model_dump(),
            node_structure=data.node_structure.model_dump(),
            edge_properties=[p.model_dump() for p in data.edge_properties],
            node_properties=[p.model_dump() for p in data.node_properties],
            node_types=data.node_types,
            relationship_types=data.relationship_types,
            owner_email=user_email,
        )
        return context_to_response(context, user_email)


@router.get("/{context_id}", response_model=GraphContextResponse)
async def get_graph_context(context_id: UUID, request: Request):
    """Get a specific graph context (all contexts are globally accessible)."""
    user_email = get_current_user(request)

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
    else:
        store = get_memory_store()
        context = store.get_graph_context(context_id)

    if context is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "GRAPH_CONTEXT_NOT_FOUND",
                    "message": f"Graph context with id '{context_id}' not found",
                    "details": {},
                }
            },
        )

    return context_to_response(context, user_email)


@router.put("/{context_id}", response_model=GraphContextResponse)
async def update_graph_context(
    context_id: UUID, data: GraphContextUpdate, request: Request
):
    """Update a graph context."""
    user_email = get_current_user(request)

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
                raise HTTPException(status_code=404, detail="Graph context not found")

            # Check write access
            has_write = context.owner_email == user_email or user_has_write_access(
                user_email, context.shares
            )
            if not has_write:
                raise HTTPException(status_code=403, detail="No write access")

            # Update fields
            if data.title is not None:
                context.title = data.title
            if data.description is not None:
                context.description = data.description
            if data.tags is not None:
                context.tags = data.tags
            if data.edge_structure is not None:
                context.edge_structure = data.edge_structure.model_dump()
            if data.node_structure is not None:
                context.node_structure = data.node_structure.model_dump()
            if data.edge_properties is not None:
                context.edge_properties = [p.model_dump() for p in data.edge_properties]
            if data.node_properties is not None:
                context.node_properties = [p.model_dump() for p in data.node_properties]
            if data.node_types is not None:
                context.node_types = data.node_types
            if data.relationship_types is not None:
                context.relationship_types = data.relationship_types

            await session.commit()
            await session.refresh(context)
            await session.refresh(context, ["shares"])
            return context_to_response(context, user_email)
    else:
        store = get_memory_store()
        context = store.get_graph_context(context_id)

        if context is None:
            raise HTTPException(status_code=404, detail="Graph context not found")

        # Check write access
        has_write = context.owner_email == user_email or user_has_write_access(
            user_email, context.shares
        )
        if not has_write:
            raise HTTPException(status_code=403, detail="No write access")

        # Update fields
        updates = {}
        if data.title is not None:
            updates["title"] = data.title
        if data.description is not None:
            updates["description"] = data.description
        if data.tags is not None:
            updates["tags"] = data.tags
        if data.edge_structure is not None:
            updates["edge_structure"] = data.edge_structure.model_dump()
        if data.node_structure is not None:
            updates["node_structure"] = data.node_structure.model_dump()
        if data.edge_properties is not None:
            updates["edge_properties"] = [p.model_dump() for p in data.edge_properties]
        if data.node_properties is not None:
            updates["node_properties"] = [p.model_dump() for p in data.node_properties]
        if data.node_types is not None:
            updates["node_types"] = data.node_types
        if data.relationship_types is not None:
            updates["relationship_types"] = data.relationship_types

        context = store.update_graph_context(context_id, **updates)
        return context_to_response(context, user_email)


@router.delete("/{context_id}")
async def delete_graph_context(context_id: UUID, request: Request):
    """Delete a graph context."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import GraphContext

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(GraphContext).where(GraphContext.id == context_id)
            )
            context = result.scalar_one_or_none()

            if context is None:
                raise HTTPException(status_code=404, detail="Graph context not found")

            if context.owner_email != user_email:
                raise HTTPException(status_code=403, detail="Only owner can delete")

            await session.delete(context)
            await session.commit()
    else:
        store = get_memory_store()
        context = store.get_graph_context(context_id)

        if context is None:
            raise HTTPException(status_code=404, detail="Graph context not found")

        if context.owner_email != user_email:
            raise HTTPException(status_code=403, detail="Only owner can delete")

        store.delete_graph_context(context_id)

    return {"status": "deleted"}


@router.post("/{context_id}/share")
async def share_graph_context(context_id: UUID, data: ShareRequest, request: Request):
    """Share a graph context with another user."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload
        from graphlagoon.db.models import GraphContext, GraphContextShare

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(GraphContext)
                .options(selectinload(GraphContext.shares))
                .where(GraphContext.id == context_id)
            )
            context = result.scalar_one_or_none()

            if context is None:
                raise HTTPException(status_code=404, detail="Graph context not found")

            if context.owner_email != user_email:
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
            for share in context.shares:
                if share.shared_with_email == data.email:
                    share.permission = data.permission
                    await session.commit()
                    return {"status": "updated"}

            # Create new share
            share = GraphContextShare(
                graph_context_id=context_id,
                shared_with_email=data.email,
                permission=data.permission,
            )
            session.add(share)
            await session.commit()
    else:
        store = get_memory_store()
        context = store.get_graph_context(context_id)

        if context is None:
            raise HTTPException(status_code=404, detail="Graph context not found")

        if context.owner_email != user_email:
            raise HTTPException(status_code=403, detail="Only owner can share")

        # Validate email/wildcard
        settings = get_settings()
        is_valid, error_msg = validate_share_email(
            data.email,
            settings.allowed_share_domain_list,
        )
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg)

        store.share_graph_context(context_id, data.email, data.permission)

    return {"status": "shared"}


@router.delete("/{context_id}/share/{email}")
async def unshare_graph_context(context_id: UUID, email: str, request: Request):
    """Remove sharing for a user."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import GraphContext, GraphContextShare

        session_maker = get_session_maker()
        async with session_maker() as session:
            result = await session.execute(
                select(GraphContext).where(GraphContext.id == context_id)
            )
            context = result.scalar_one_or_none()

            if context is None:
                raise HTTPException(status_code=404, detail="Graph context not found")

            if context.owner_email != user_email:
                raise HTTPException(
                    status_code=403, detail="Only owner can manage sharing"
                )

            result = await session.execute(
                select(GraphContextShare).where(
                    GraphContextShare.graph_context_id == context_id,
                    GraphContextShare.shared_with_email == email,
                )
            )
            share = result.scalar_one_or_none()

            if share:
                await session.delete(share)
                await session.commit()
    else:
        store = get_memory_store()
        context = store.get_graph_context(context_id)

        if context is None:
            raise HTTPException(status_code=404, detail="Graph context not found")

        if context.owner_email != user_email:
            raise HTTPException(status_code=403, detail="Only owner can manage sharing")

        store.unshare_graph_context(context_id, email)

    return {"status": "removed"}
