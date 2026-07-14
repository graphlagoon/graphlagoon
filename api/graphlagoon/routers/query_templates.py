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
from graphlagoon.utils.authz import can_write, is_superuser

router = APIRouter(tags=["query-templates"])


def user_has_context_write(context, user_email: str) -> bool:
    """Context owner, a share with write permission, or superuser."""
    return can_write(context.owner_email, context.shares, user_email)


def check_can_mutate_template(template, context, user_email: str) -> None:
    """Raise 403 unless the user may edit/delete the template.

    Private templates: creator only. Shared templates: anyone with context write.
    Superusers may mutate any template, including others' private ones.
    """
    if is_superuser(user_email):
        return
    if template.visibility == "private":
        if template.owner_email != user_email:
            # 404, not 403: don't reveal that someone else's private template exists
            raise HTTPException(status_code=404, detail="Template not found")
    elif not user_has_context_write(context, user_email):
        raise HTTPException(
            status_code=403, detail="No write access to modify shared templates"
        )


def check_visibility_change(new_visibility, template, context, user_email: str) -> None:
    """Raise 403 on a disallowed visibility change.

    Only the creator (or a superuser) may change visibility, and promoting to
    "shared" is equivalent to creating a shared template, so it also needs
    context write.
    """
    if new_visibility is None or new_visibility == template.visibility:
        return
    if is_superuser(user_email):
        return
    if template.owner_email != user_email:
        raise HTTPException(
            status_code=403, detail="Only the template owner can change visibility"
        )
    if new_visibility == "shared" and not user_has_context_write(context, user_email):
        raise HTTPException(
            status_code=403,
            detail="No write access to share templates with the context",
        )


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
        visibility=getattr(template, "visibility", None) or "shared",
        created_at=template.created_at,
        updated_at=template.updated_at,
    )


@router.get(
    "/api/graph-contexts/{context_id}/query-templates",
    response_model=list[QueryTemplateResponse],
)
async def list_query_templates(context_id: UUID, request: Request):
    """List query templates for a context: shared ones plus the caller's private ones."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select, or_
        from graphlagoon.db.models import QueryTemplate

        session_maker = get_session_maker()
        async with session_maker() as session:
            await check_context_access_db(session, context_id, user_email)

            query = select(QueryTemplate).where(
                QueryTemplate.graph_context_id == context_id
            )
            if not is_superuser(user_email):
                query = query.where(
                    or_(
                        QueryTemplate.visibility != "private",
                        QueryTemplate.owner_email == user_email,
                    )
                )
            result = await session.execute(query.order_by(QueryTemplate.created_at))
            templates = result.scalars().all()
            return [template_to_response(t) for t in templates]
    else:
        check_context_access_memory(context_id, user_email)
        store = get_memory_store()
        templates = [
            t
            for t in store.list_query_templates(context_id)
            if t.visibility != "private"
            or t.owner_email == user_email
            or is_superuser(user_email)
        ]
        return [template_to_response(t) for t in templates]


@router.post(
    "/api/graph-contexts/{context_id}/query-templates",
    response_model=QueryTemplateResponse,
    status_code=201,
)
async def create_query_template(
    context_id: UUID, data: QueryTemplateCreate, request: Request
):
    """Create a query template.

    Shared templates require context write access; private templates only
    require context access (so exploration-share users can save their own).
    """
    user_email = get_current_user(request)

    if is_database_available():
        from graphlagoon.db.models import QueryTemplate

        session_maker = get_session_maker()
        async with session_maker() as session:
            context = await check_context_access_db(session, context_id, user_email)

            if data.visibility == "shared" and not user_has_context_write(
                context, user_email
            ):
                raise HTTPException(
                    status_code=403,
                    detail="No write access to create shared templates",
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
                visibility=data.visibility,
            )
            session.add(template)
            await session.commit()
            await session.refresh(template)
            return template_to_response(template)
    else:
        context = check_context_access_memory(context_id, user_email)

        if data.visibility == "shared" and not user_has_context_write(
            context, user_email
        ):
            raise HTTPException(
                status_code=403,
                detail="No write access to create shared templates",
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
            visibility=data.visibility,
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
    """Update a query template.

    Private: creator only. Shared: anyone with context write.
    Changing visibility is restricted to the template creator.
    """
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import QueryTemplate

        session_maker = get_session_maker()
        async with session_maker() as session:
            context = await check_context_access_db(session, context_id, user_email)

            result = await session.execute(
                select(QueryTemplate)
                .where(QueryTemplate.id == template_id)
                .where(QueryTemplate.graph_context_id == context_id)
            )
            template = result.scalar_one_or_none()

            if template is None:
                raise HTTPException(status_code=404, detail="Template not found")

            check_can_mutate_template(template, context, user_email)
            check_visibility_change(data.visibility, template, context, user_email)

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
            if data.visibility is not None:
                template.visibility = data.visibility

            await session.commit()
            await session.refresh(template)
            return template_to_response(template)
    else:
        context = check_context_access_memory(context_id, user_email)
        store = get_memory_store()
        template = store.get_query_template(template_id)

        if template is None or template.graph_context_id != context_id:
            raise HTTPException(status_code=404, detail="Template not found")

        check_can_mutate_template(template, context, user_email)
        check_visibility_change(data.visibility, template, context, user_email)

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
        if data.visibility is not None:
            updates["visibility"] = data.visibility

        template = store.update_query_template(template_id, **updates)
        return template_to_response(template)


@router.delete("/api/graph-contexts/{context_id}/query-templates/{template_id}")
async def delete_query_template(context_id: UUID, template_id: UUID, request: Request):
    """Delete a query template. Private: creator only. Shared: anyone with context write."""
    user_email = get_current_user(request)

    if is_database_available():
        from sqlalchemy import select
        from graphlagoon.db.models import QueryTemplate

        session_maker = get_session_maker()
        async with session_maker() as session:
            context = await check_context_access_db(session, context_id, user_email)

            result = await session.execute(
                select(QueryTemplate)
                .where(QueryTemplate.id == template_id)
                .where(QueryTemplate.graph_context_id == context_id)
            )
            template = result.scalar_one_or_none()

            if template is None:
                raise HTTPException(status_code=404, detail="Template not found")

            check_can_mutate_template(template, context, user_email)

            await session.delete(template)
            await session.commit()
    else:
        context = check_context_access_memory(context_id, user_email)
        store = get_memory_store()
        template = store.get_query_template(template_id)

        if template is None or template.graph_context_id != context_id:
            raise HTTPException(status_code=404, detail="Template not found")

        check_can_mutate_template(template, context, user_email)

        store.delete_query_template(template_id)

    return {"status": "deleted"}
