from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from uuid import UUID
from typing import TYPE_CHECKING, Union

if TYPE_CHECKING:
    from graphlagoon.db.models import QueryTemplate

from graphlagoon.db.database import is_database_available, get_session_maker
from graphlagoon.db.memory_store import get_memory_store, MemoryQueryTemplate
from graphlagoon.models.schemas import (
    QueryTemplateCreate,
    QueryTemplateUpdate,
    QueryTemplateResponse,
    TemplateParameter,
)
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.routers.explorations import (
    check_context_access_db,
    check_context_access_memory,
)
from graphlagoon.utils.sharing import user_has_write_access

router = APIRouter(tags=["query-templates"])


def template_to_response(
    template: Union["QueryTemplate", MemoryQueryTemplate],
) -> QueryTemplateResponse:
    """Convert QueryTemplate model to response schema."""
    from graphlagoon.models.schemas import TemplateOptions

    params = template.parameters or []
    raw_options = template.options or {}
    if isinstance(raw_options, dict):
        options = TemplateOptions(**raw_options)
    else:
        options = raw_options
    return QueryTemplateResponse(
        id=template.id,
        graph_context_id=template.graph_context_id,
        owner_email=template.owner_email,
        name=template.name,
        description=template.description,
        query_type=template.query_type,
        query=template.query,
        parameters=[
            TemplateParameter(**p) if isinstance(p, dict) else p for p in params
        ],
        options=options,
        created_at=template.created_at,
        updated_at=template.updated_at,
    )


@router.get(
    "/api/graph-contexts/{context_id}/query-templates",
    response_model=list[QueryTemplateResponse],
)
async def list_query_templates(context_id: UUID, request: Request):
    """List all query templates for a context. Any user with context access can view."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import QueryTemplate

        session_maker = get_session_maker()
        async with session_maker() as session:
            await check_context_access_db(session, context_id, user_email)

            result = await session.execute(
                select(QueryTemplate)
                .where(QueryTemplate.graph_context_id == context_id)
                .order_by(QueryTemplate.created_at)
            )
            templates = result.scalars().all()
            return [template_to_response(t) for t in templates]
    else:
        check_context_access_memory(context_id, user_email)
        store = get_memory_store()
        templates = store.list_query_templates(context_id)
        return [template_to_response(t) for t in templates]


@router.post(
    "/api/graph-contexts/{context_id}/query-templates",
    response_model=QueryTemplateResponse,
    status_code=201,
)
async def create_query_template(
    context_id: UUID, data: QueryTemplateCreate, request: Request
):
    """Create a query template. Context owner or users with write access can create."""
    user_email = get_current_user(request)

    if is_database_available():
        from graphlagoon.db.models import QueryTemplate

        session_maker = get_session_maker()
        async with session_maker() as session:
            context = await check_context_access_db(session, context_id, user_email)

            has_write = context.owner_email == user_email or user_has_write_access(
                user_email, context.shares
            )
            if not has_write:
                raise HTTPException(
                    status_code=403,
                    detail="No write access to create templates",
                )

            template = QueryTemplate(
                graph_context_id=context_id,
                owner_email=user_email,
                name=data.name,
                description=data.description,
                query_type=data.query_type,
                query=data.query,
                parameters=[p.model_dump() for p in data.parameters],
                options=data.options.model_dump(),
            )
            session.add(template)
            await session.commit()
            await session.refresh(template)
            return template_to_response(template)
    else:
        context = check_context_access_memory(context_id, user_email)

        has_write = context.owner_email == user_email or user_has_write_access(
            user_email, context.shares
        )
        if not has_write:
            raise HTTPException(
                status_code=403, detail="No write access to create templates"
            )

        store = get_memory_store()
        template = store.create_query_template(
            graph_context_id=context_id,
            owner_email=user_email,
            name=data.name,
            query_type=data.query_type,
            query=data.query,
            description=data.description,
            parameters=[p.model_dump() for p in data.parameters],
            options=data.options.model_dump(),
        )
        return template_to_response(template)


@router.put(
    "/api/graph-contexts/{context_id}/query-templates/{template_id}",
    response_model=QueryTemplateResponse,
)
async def update_query_template(
    context_id: UUID,
    template_id: UUID,
    data: QueryTemplateUpdate,
    request: Request,
):
    """Update a query template. Only the template owner can update."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import QueryTemplate

        session_maker = get_session_maker()
        async with session_maker() as session:
            await check_context_access_db(session, context_id, user_email)

            result = await session.execute(
                select(QueryTemplate)
                .where(QueryTemplate.id == template_id)
                .where(QueryTemplate.graph_context_id == context_id)
            )
            template = result.scalar_one_or_none()

            if template is None:
                raise HTTPException(status_code=404, detail="Template not found")

            if template.owner_email != user_email:
                raise HTTPException(
                    status_code=403, detail="Only template owner can update"
                )

            if data.name is not None:
                template.name = data.name
            if data.description is not None:
                template.description = data.description
            if data.query_type is not None:
                template.query_type = data.query_type
            if data.query is not None:
                template.query = data.query
            if data.parameters is not None:
                template.parameters = [p.model_dump() for p in data.parameters]
            if data.options is not None:
                template.options = data.options.model_dump()

            await session.commit()
            await session.refresh(template)
            return template_to_response(template)
    else:
        check_context_access_memory(context_id, user_email)
        store = get_memory_store()
        template = store.get_query_template(template_id)

        if template is None or template.graph_context_id != context_id:
            raise HTTPException(status_code=404, detail="Template not found")

        if template.owner_email != user_email:
            raise HTTPException(
                status_code=403, detail="Only template owner can update"
            )

        updates = {}
        if data.name is not None:
            updates["name"] = data.name
        if data.description is not None:
            updates["description"] = data.description
        if data.query_type is not None:
            updates["query_type"] = data.query_type
        if data.query is not None:
            updates["query"] = data.query
        if data.parameters is not None:
            updates["parameters"] = [p.model_dump() for p in data.parameters]
        if data.options is not None:
            updates["options"] = data.options.model_dump()

        template = store.update_query_template(template_id, **updates)
        return template_to_response(template)


@router.delete("/api/graph-contexts/{context_id}/query-templates/{template_id}")
async def delete_query_template(context_id: UUID, template_id: UUID, request: Request):
    """Delete a query template. Only the template owner can delete."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import QueryTemplate

        session_maker = get_session_maker()
        async with session_maker() as session:
            await check_context_access_db(session, context_id, user_email)

            result = await session.execute(
                select(QueryTemplate)
                .where(QueryTemplate.id == template_id)
                .where(QueryTemplate.graph_context_id == context_id)
            )
            template = result.scalar_one_or_none()

            if template is None:
                raise HTTPException(status_code=404, detail="Template not found")

            if template.owner_email != user_email:
                raise HTTPException(
                    status_code=403, detail="Only template owner can delete"
                )

            await session.delete(template)
            await session.commit()
    else:
        check_context_access_memory(context_id, user_email)
        store = get_memory_store()
        template = store.get_query_template(template_id)

        if template is None or template.graph_context_id != context_id:
            raise HTTPException(status_code=404, detail="Template not found")

        if template.owner_email != user_email:
            raise HTTPException(
                status_code=403, detail="Only template owner can delete"
            )

        store.delete_query_template(template_id)

    return {"status": "deleted"}
