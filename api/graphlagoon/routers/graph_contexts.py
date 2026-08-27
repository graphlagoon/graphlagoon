from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, Depends
from uuid import UUID
from typing import TYPE_CHECKING, Optional, Union

if TYPE_CHECKING:
    from graphlagoon.db.models import GraphContext

from graphlagoon.db.database import is_database_available, get_session_maker
from graphlagoon.db.memory_store import get_memory_store, MemoryGraphContext
from graphlagoon.models.schemas import (
    DEFAULT_DATASOURCE_TYPE,
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
    share_match_emails,
    user_has_share_access,
    validate_share_email,
)
from graphlagoon.utils.authz import can_manage, can_write, is_superuser
from graphlagoon.config import get_settings
from graphlagoon.services.warehouse import get_warehouse_client, WarehouseClient
from graphlagoon.services.schema_drift import (
    validate_context_tables,
    ContextValidationError,
)
from graphlagoon.services.datasource import (
    DatasourceNotConfiguredError,
    UnknownDatasourceError,
    get_datasource,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/graph-contexts", tags=["graph-contexts"])


def get_warehouse() -> WarehouseClient:
    return get_warehouse_client()


async def _validate_datasource_or_400(
    datasource_type: str, datasource_name: str | None = None
) -> None:
    """Reject a context whose backend this server cannot reach.

    Creating a Neptune context on a server with no Neptune endpoint — or a
    REST context naming a connection nobody registered — would produce a
    context that fails on its first query with a confusing error; failing at
    creation says exactly what is missing.
    """
    details = {"datasource_type": datasource_type}
    if datasource_name:
        details["datasource_name"] = datasource_name
    try:
        get_datasource(datasource_type, datasource_name)
    except DatasourceNotConfiguredError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "DATASOURCE_NOT_CONFIGURED",
                    "message": str(e),
                    "details": details,
                }
            },
        )
    except UnknownDatasourceError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "UNKNOWN_DATASOURCE",
                    "message": str(e),
                    "details": details,
                }
            },
        )


async def _validate_or_400(
    warehouse: WarehouseClient,
    node_table_name: Optional[str],
    edge_table_name: str,
    node_structure: Optional[dict],
    edge_structure: Optional[dict],
) -> None:
    """Run ``validate_context_tables`` and translate a failure into the
    standard error envelope. Shared by create and update."""
    try:
        await validate_context_tables(
            warehouse,
            node_table_name,
            edge_table_name,
            node_structure,
            edge_structure,
        )
    except ContextValidationError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": e.code,
                    "message": e.message,
                    "details": e.details,
                }
            },
        )


def context_to_response(
    context: Union["GraphContext", MemoryGraphContext],
    user_email: str = "",
) -> GraphContextResponse:
    """Convert GraphContext model to response schema."""
    shared_with = [share.shared_with_email for share in context.shares]
    has_write = can_write(context.owner_email, context.shares, user_email)

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
        # Rows predating the column report the default rather than failing.
        datasource_type=getattr(context, "datasource_type", None)
        or DEFAULT_DATASOURCE_TYPE,
        datasource_name=getattr(context, "datasource_name", None),
        edge_table_name=context.edge_table_name,
        node_table_name=context.node_table_name,
        edge_structure=(
            EdgeStructure(**edge_struct)
            if isinstance(edge_struct, dict)
            else edge_struct
        ),
        node_structure=(
            NodeStructure(**node_struct)
            if isinstance(node_struct, dict)
            else node_struct
        ),
        edge_properties=edge_props,
        node_properties=node_props,
        node_types=context.node_types or [],
        relationship_types=context.relationship_types or [],
        # `or {}` / `or []` cover rows created before the columns existed (NULL).
        default_behaviors=context.default_behaviors or {},
        cluster_programs=context.cluster_programs or [],
        context_menu_actions=context.context_menu_actions or [],
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

        match_emails = share_match_emails(user_email)

        session_maker = get_session_maker()
        async with session_maker() as session:
            # Context IDs shared directly with user (exact, domain wildcard or public)
            ctx_share_q = select(GraphContextShare.graph_context_id).where(
                GraphContextShare.shared_with_email.in_(match_emails)
            )
            # Context IDs accessible via exploration shares
            exp_share_q = (
                select(Exploration.graph_context_id)
                .join(
                    ExplorationShare, ExplorationShare.exploration_id == Exploration.id
                )
                .where(ExplorationShare.shared_with_email.in_(match_emails))
            )

            query = select(GraphContext).options(selectinload(GraphContext.shares))
            if not is_superuser(user_email):
                query = query.where(
                    or_(
                        GraphContext.owner_email == user_email,
                        GraphContext.id.in_(ctx_share_q),
                        GraphContext.id.in_(exp_share_q),
                    )
                )
            result = await session.execute(
                query.order_by(GraphContext.updated_at.desc())
            )
            contexts = result.scalars().all()
            return [context_to_response(ctx, user_email) for ctx in contexts]
    else:
        store = get_memory_store()
        if is_superuser(user_email):
            accessible = list(store.graph_contexts.values())
        else:
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
async def create_graph_context(
    request: Request,
    data: GraphContextCreate,
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """Create a new graph context."""
    user_email = get_current_user(request)

    await _validate_datasource_or_400(data.datasource_type, data.datasource_name)

    # Table validation only means something for a table-backed context; a
    # schemaless graph database has nothing to check here.
    if data.datasource_type == "sql_warehouse":
        await _validate_or_400(
            warehouse,
            data.node_table_name,
            data.edge_table_name,
            data.node_structure.model_dump(),
            data.edge_structure.model_dump(),
        )

    if is_database_available():
        from graphlagoon.db.models import GraphContext

        session_maker = get_session_maker()
        async with session_maker() as session:
            context = GraphContext(
                title=data.title,
                description=data.description,
                tags=data.tags,
                datasource_type=data.datasource_type,
                datasource_name=data.datasource_name,
                edge_table_name=data.edge_table_name,
                node_table_name=data.node_table_name,
                edge_structure=data.edge_structure.model_dump(),
                node_structure=data.node_structure.model_dump(),
                edge_properties=[p.model_dump() for p in data.edge_properties],
                node_properties=[p.model_dump() for p in data.node_properties],
                node_types=data.node_types,
                relationship_types=data.relationship_types,
                default_behaviors=data.default_behaviors,
                cluster_programs=data.cluster_programs,
                context_menu_actions=data.context_menu_actions,
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
            datasource_type=data.datasource_type,
            datasource_name=data.datasource_name,
            edge_table_name=data.edge_table_name,
            node_table_name=data.node_table_name,
            edge_structure=data.edge_structure.model_dump(),
            node_structure=data.node_structure.model_dump(),
            edge_properties=[p.model_dump() for p in data.edge_properties],
            node_properties=[p.model_dump() for p in data.node_properties],
            node_types=data.node_types,
            relationship_types=data.relationship_types,
            default_behaviors=data.default_behaviors,
            cluster_programs=data.cluster_programs,
            context_menu_actions=data.context_menu_actions,
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
    context_id: UUID,
    data: GraphContextUpdate,
    request: Request,
    warehouse: WarehouseClient = Depends(get_warehouse),
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
            if not can_write(context.owner_email, context.shares, user_email):
                raise HTTPException(status_code=403, detail="No write access")

            # Table names are immutable — validate the EFFECTIVE structure (new
            # if provided, else the stored one) against the existing tables, and
            # only when structure is actually part of this request; skip the
            # warehouse round-trip entirely for e.g. the cluster_programs-only
            # writer in stores/cluster.ts.
            # Warehouse-only: a schemaless graph database has no tables whose
            # columns could disagree with the structure.
            if (
                getattr(context, "datasource_type", None) or DEFAULT_DATASOURCE_TYPE
            ) == "sql_warehouse" and (
                data.node_structure is not None or data.edge_structure is not None
            ):
                await _validate_or_400(
                    warehouse,
                    context.node_table_name,
                    context.edge_table_name,
                    (
                        data.node_structure.model_dump()
                        if data.node_structure is not None
                        else context.node_structure
                    ),
                    (
                        data.edge_structure.model_dump()
                        if data.edge_structure is not None
                        else context.edge_structure
                    ),
                )

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
            if data.default_behaviors is not None:
                context.default_behaviors = data.default_behaviors
            if data.cluster_programs is not None:
                context.cluster_programs = data.cluster_programs
            if data.context_menu_actions is not None:
                context.context_menu_actions = data.context_menu_actions

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
        if not can_write(context.owner_email, context.shares, user_email):
            raise HTTPException(status_code=403, detail="No write access")

        # Warehouse-only: a schemaless graph database has no tables whose
        # columns could disagree with the structure.
        if (
            getattr(context, "datasource_type", None) or DEFAULT_DATASOURCE_TYPE
        ) == "sql_warehouse" and (
            data.node_structure is not None or data.edge_structure is not None
        ):
            await _validate_or_400(
                warehouse,
                context.node_table_name,
                context.edge_table_name,
                (
                    data.node_structure.model_dump()
                    if data.node_structure is not None
                    else context.node_structure
                ),
                (
                    data.edge_structure.model_dump()
                    if data.edge_structure is not None
                    else context.edge_structure
                ),
            )

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
        if data.default_behaviors is not None:
            updates["default_behaviors"] = data.default_behaviors
        if data.cluster_programs is not None:
            updates["cluster_programs"] = data.cluster_programs
        if data.context_menu_actions is not None:
            updates["context_menu_actions"] = data.context_menu_actions

        context = store.update_graph_context(context_id, **updates)
        return context_to_response(context, user_email)


async def _purge_style_presets(context_id: UUID) -> None:
    """Drop a deleted context's style presets, best effort.

    Same stance as the cache purge: owner-initiated cleanup, never allowed to
    fail the deletion.
    """
    from graphlagoon.services.style_presets import (
        get_style_preset_service,
        style_presets_enabled,
    )

    try:
        if not style_presets_enabled():
            return
        await get_style_preset_service().delete_context(context_id)
    except Exception as exc:
        logger.warning(
            "Failed to purge style presets for deleted context %s: %s", context_id, exc
        )


async def _purge_precomputed_graphs(context_id: UUID) -> None:
    """Drop a deleted context's precomputed graphs, best effort.

    Every provider that declares `delete_context` is asked, not just the first
    one that would have served a read: a context's entries can live in several
    backends at once.

    Deliberately not gated on who is deleting, unlike the write endpoints: this
    is cleanup the owner asked for, not authoring, and skipping it in production
    would leak volume storage permanently. Never fails the deletion — the same
    stance `_delete_snapshot_if_exists` takes in explorations.py.
    """
    from graphlagoon.services.precomputed import (
        precomputed_graphs_enabled,
        purge_context,
    )

    try:
        if not precomputed_graphs_enabled():
            return
        await purge_context(context_id)
    except Exception as exc:
        logger.warning(
            "Failed to purge precomputed graphs for deleted context %s: %s",
            context_id,
            exc,
        )


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

            if not can_manage(context.owner_email, user_email):
                raise HTTPException(status_code=403, detail="Only owner can delete")

            await session.delete(context)
            await session.commit()
    else:
        store = get_memory_store()
        context = store.get_graph_context(context_id)

        if context is None:
            raise HTTPException(status_code=404, detail="Graph context not found")

        if not can_manage(context.owner_email, user_email):
            raise HTTPException(status_code=403, detail="Only owner can delete")

        store.delete_graph_context(context_id)

    await _purge_precomputed_graphs(context_id)
    await _purge_style_presets(context_id)

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

            if not can_manage(context.owner_email, user_email):
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

        if not can_manage(context.owner_email, user_email):
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

            if not can_manage(context.owner_email, user_email):
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

        if not can_manage(context.owner_email, user_email):
            raise HTTPException(status_code=403, detail="Only owner can manage sharing")

        store.unshare_graph_context(context_id, email)

    return {"status": "removed"}
