"""Investigation cases: CRUD, nominal sharing and sources (03-arquitetura §3.1–3.2).

Rules live in services.investigations; this module maps them to HTTP, the
`{"error": {...}}` envelope and the audit trail.
"""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from graphlagoon.middleware.auth import get_current_user
from graphlagoon.models.schemas import (
    ArtifactResponse,
    ArtifactTextUpload,
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
from graphlagoon.services import investigation_artifacts as artifacts
from graphlagoon.services import investigation_storage as storage
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


# Case space (FA.2, 03 §8.5). A binary goes as the raw request body (streamed to
# a temp file while hashed, never held in memory) with name/kind/note in the
# query; text goes as JSON. Recorded in the case journal (AUDIT_EXEMPT_ROUTES).


async def _receive_artifact(
    request: Request,
    name: Optional[str],
    kind: Optional[str],
    note: Optional[str],
    evidence: list[str],
) -> tuple[storage.Received, dict]:
    from graphlagoon.config import get_settings

    max_bytes = get_settings().artifact_max_bytes
    if request.headers.get("content-type", "").startswith("application/json"):
        try:
            body = ArtifactTextUpload.model_validate(await request.json())
        except ValueError as exc:  # pydantic's ValidationError included
            raise _http(service.InvestigationError(422, "INVALID_BODY", str(exc)))
        data = body.text.encode("utf-8")

        async def chunks():
            yield data

        meta = {
            "name": body.name,
            "kind": body.kind,
            "note": body.note,
            "source_evidence_ids": body.source_evidence_ids,
        }
    else:
        chunks = request.stream
        meta = {"name": name, "kind": kind, "note": note, "source_evidence_ids": evidence}
    try:
        received = await storage.receive(chunks(), max_bytes)
    except storage.TooLarge:
        raise _http(
            service.InvestigationError(
                413, "ARTIFACT_TOO_LARGE", f"Artifacts are limited to {max_bytes} bytes"
            )
        )
    return received, meta


@router.get(
    "/{investigation_id}/artifacts", response_model=list[ArtifactResponse]
)
async def list_artifacts(investigation_id: UUID, request: Request):
    try:
        return await artifacts.list_artifacts(
            investigation_id, get_current_user(request)
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/artifacts",
    response_model=ArtifactResponse,
    status_code=201,
)
async def create_artifact(
    investigation_id: UUID,
    request: Request,
    name: Optional[str] = None,
    kind: Optional[str] = None,
    note: Optional[str] = None,
    source_evidence_ids: list[str] = Query(default_factory=list),
):
    received, meta = await _receive_artifact(
        request, name, kind, note, source_evidence_ids
    )
    try:
        return await artifacts.create_artifact(
            investigation_id, get_current_user(request), received, **meta
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/artifacts/{artifact_id}/versions",
    response_model=ArtifactResponse,
    status_code=201,
)
async def add_artifact_version(
    investigation_id: UUID,
    artifact_id: UUID,
    request: Request,
    name: Optional[str] = None,
    note: Optional[str] = None,
    source_evidence_ids: list[str] = Query(default_factory=list),
):
    received, meta = await _receive_artifact(
        request, name, None, note, source_evidence_ids
    )
    meta.pop("kind")
    try:
        return await artifacts.add_version(
            investigation_id, get_current_user(request), artifact_id, received, **meta
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.get("/{investigation_id}/artifacts/{artifact_id}/versions/{version}/content")
async def get_artifact_content(
    investigation_id: UUID,
    artifact_id: UUID,
    version: int,
    request: Request,
    download: bool = False,
):
    try:
        data, meta = await artifacts.get_content(
            investigation_id, get_current_user(request), artifact_id, version
        )
    except service.InvestigationError as exc:
        raise _http(exc)
    # html/svg are never rendered by the browser (XSS): attachment + opaque type.
    attach = download or meta["download_only"]
    media_type = (
        "application/octet-stream" if meta["download_only"] else meta["content_type"]
    )
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Content-Disposition": (
                f"{'attachment' if attach else 'inline'}; "
                f"filename*=UTF-8''{quote(meta['name'])}"
            ),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "X-Content-SHA256": meta["sha256"],
        },
    )


@router.post(
    "/{investigation_id}/artifacts/{artifact_id}/versions/{version}/approve",
    response_model=ArtifactResponse,
    dependencies=[Depends(forbid_agents)],
)
async def approve_artifact_version(
    investigation_id: UUID, artifact_id: UUID, version: int, request: Request
):
    try:
        return await artifacts.approve_version(
            investigation_id, get_current_user(request), artifact_id, version
        )
    except service.InvestigationError as exc:
        raise _http(exc)
