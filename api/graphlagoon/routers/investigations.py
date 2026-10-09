"""Investigation cases: CRUD, nominal sharing and sources (03-arquitetura §3.1–3.2).

Rules live in services.investigations; this module maps them to HTTP, the
`{"error": {...}}` envelope and the audit trail.
"""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from graphlagoon.middleware.auth import get_current_user
from graphlagoon.models.schemas import (
    InvestigationCreate,
    InvestigationEventCreate,
    InvestigationEventResponse,
    InvestigationNoteCreate,
    InvestigationNoteResponse,
    InvestigationNoteUpdate,
    InvestigationResponse,
    InvestigationShareRequest,
    InvestigationSourceCreate,
    InvestigationSourceResponse,
    InvestigationStateUpdate,
    InvestigationUpdate,
)
from graphlagoon.services import audit
from graphlagoon.services import investigations as service
from graphlagoon.services.audit import AuditAction
from graphlagoon.utils.authz import forbid_agents, require_permission

router = APIRouter(prefix="/api/investigations", tags=["investigations"])

# Human-only routes (03 §8.7) carry forbid_agents; every other route takes the
# agent's scope from utils.authz.agent_guard (GET → read, writes → write).


def _http(exc: service.InvestigationError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"error": {"code": exc.code, "message": exc.message, "details": {}}},
    )


async def _record(user_email: str, action: str, investigation_id: UUID, **meta):
    await audit.record(
        user_email,
        action,
        resource_type="investigation",
        resource_id=investigation_id,
        metadata=meta,
    )


@router.get("", response_model=list[InvestigationResponse])
async def list_investigations(
    request: Request,
    status: Optional[str] = None,
    assignee: Optional[str] = None,
    typology: Optional[str] = None,
):
    return await service.list_investigations(
        get_current_user(request), status, assignee, typology
    )


@router.post("", response_model=InvestigationResponse, status_code=201)
async def create_investigation(
    data: InvestigationCreate,
    user_email: str = Depends(require_permission("investigation.create")),
):
    try:
        inv = await service.create_investigation(user_email, data.model_dump())
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email, AuditAction.INVESTIGATION_CREATE, inv["id"], title=inv["title"]
    )
    return inv


@router.get("/{investigation_id}", response_model=InvestigationResponse)
async def get_investigation(investigation_id: UUID, request: Request):
    try:
        return await service.get_investigation(
            investigation_id, get_current_user(request)
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.patch("/{investigation_id}", response_model=InvestigationResponse)
async def update_investigation(
    investigation_id: UUID, data: InvestigationUpdate, request: Request
):
    user_email = get_current_user(request)
    changes = data.model_dump(exclude_unset=True)
    try:
        inv = await service.update_investigation(investigation_id, user_email, changes)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email,
        AuditAction.INVESTIGATION_UPDATE,
        investigation_id,
        fields=sorted(changes),
    )
    return inv


@router.delete("/{investigation_id}", dependencies=[Depends(forbid_agents)])
async def delete_investigation(
    investigation_id: UUID, request: Request, reason: Optional[str] = None
):
    user_email = get_current_user(request)
    try:
        meta = await service.delete_investigation(investigation_id, user_email, reason)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email, AuditAction.INVESTIGATION_DELETE, investigation_id, **meta
    )
    return {"status": "deleted"}


@router.post("/{investigation_id}/share", dependencies=[Depends(forbid_agents)])
async def share_investigation(
    investigation_id: UUID, data: InvestigationShareRequest, request: Request
):
    user_email = get_current_user(request)
    try:
        email = await service.share_investigation(
            investigation_id, user_email, data.email, data.permission
        )
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email,
        AuditAction.INVESTIGATION_SHARE,
        investigation_id,
        **{"with": email},
        permission=data.permission,
    )
    return {"status": "shared"}


@router.delete(
    "/{investigation_id}/share/{email}", dependencies=[Depends(forbid_agents)]
)
async def unshare_investigation(investigation_id: UUID, email: str, request: Request):
    user_email = get_current_user(request)
    try:
        removed = await service.unshare_investigation(
            investigation_id, user_email, email
        )
    except service.InvestigationError as exc:
        raise _http(exc)
    if removed:
        await _record(
            user_email,
            AuditAction.INVESTIGATION_UNSHARE,
            investigation_id,
            **{"with": email},
        )
    return {"status": "removed"}


@router.get(
    "/{investigation_id}/sources", response_model=list[InvestigationSourceResponse]
)
async def list_sources(investigation_id: UUID, request: Request):
    try:
        return await service.list_sources(investigation_id, get_current_user(request))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/sources",
    response_model=InvestigationSourceResponse,
    status_code=201,
)
async def add_source(
    investigation_id: UUID, data: InvestigationSourceCreate, request: Request
):
    user_email = get_current_user(request)
    try:
        source = await service.add_source(
            investigation_id, user_email, data.exploration_id, data.mode
        )
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email,
        AuditAction.INVESTIGATION_SOURCE_ADD,
        investigation_id,
        source_id=str(source["id"]),
        exploration_id=str(data.exploration_id),
        mode=data.mode,
        sha256=source.get("frozen_sha256"),
    )
    return source


@router.delete("/{investigation_id}/sources/{source_id}")
async def remove_source(investigation_id: UUID, source_id: UUID, request: Request):
    user_email = get_current_user(request)
    try:
        meta = await service.remove_source(investigation_id, user_email, source_id)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email,
        AuditAction.INVESTIGATION_SOURCE_REMOVE,
        investigation_id,
        source_id=str(source_id),
        **meta,
    )
    return {"status": "removed"}


@router.get("/{investigation_id}/sources/{source_id}/snapshot")
async def get_source_snapshot(
    investigation_id: UUID, source_id: UUID, request: Request
):
    try:
        return await service.source_snapshot(
            investigation_id, get_current_user(request), source_id
        )
    except service.InvestigationError as exc:
        raise _http(exc)


# Journal, state and notes (F1.7): recorded in the case's own hash-chained
# journal rather than the audit log (see AUDIT_EXEMPT_ROUTES).


@router.get(
    "/{investigation_id}/events", response_model=list[InvestigationEventResponse]
)
async def list_events(
    investigation_id: UUID,
    request: Request,
    after: Optional[UUID] = None,
    limit: int = Query(100, ge=1, le=500),
):
    try:
        return await service.list_events(
            investigation_id, get_current_user(request), after, limit
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/events",
    response_model=InvestigationEventResponse,
    status_code=201,
)
async def post_event(
    investigation_id: UUID, data: InvestigationEventCreate, request: Request
):
    try:
        return await service.post_client_event(
            investigation_id, get_current_user(request), data.kind, data.payload
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.patch("/{investigation_id}/state", response_model=InvestigationResponse)
async def update_state(
    investigation_id: UUID, data: InvestigationStateUpdate, request: Request
):
    try:
        return await service.update_state(
            investigation_id, get_current_user(request), data.roles, data.pins
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.get("/{investigation_id}/notes", response_model=list[InvestigationNoteResponse])
async def list_notes(investigation_id: UUID, request: Request):
    try:
        return await service.list_notes(investigation_id, get_current_user(request))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/notes",
    response_model=InvestigationNoteResponse,
    status_code=201,
)
async def create_note(
    investigation_id: UUID, data: InvestigationNoteCreate, request: Request
):
    try:
        return await service.create_note(
            investigation_id,
            get_current_user(request),
            data.anchor.model_dump(),
            data.body,
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.patch(
    "/{investigation_id}/notes/{note_id}", response_model=InvestigationNoteResponse
)
async def update_note(
    investigation_id: UUID,
    note_id: UUID,
    data: InvestigationNoteUpdate,
    request: Request,
):
    try:
        return await service.update_note(
            investigation_id, get_current_user(request), note_id, data.model_dump()
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.delete("/{investigation_id}/notes/{note_id}")
async def delete_note(investigation_id: UUID, note_id: UUID, request: Request):
    try:
        await service.delete_note(investigation_id, get_current_user(request), note_id)
    except service.InvestigationError as exc:
        raise _http(exc)
    return {"status": "deleted"}
