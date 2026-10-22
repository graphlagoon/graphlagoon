"""Cases (05-plano-v2): one place with items, annotations, a journal and a
decision. Rules live in ``services/cases*.py``; this module maps them to HTTP,
the ``{"error": {...}}`` envelope and the audit trail.

Human-only routes (05 §6) carry ``forbid_agents``: decisions and their review,
share, delete, reopen, export and confirming/rejecting suggestions. The middleware allowlists
the rest for agent tokens; binary content never reaches an agent (it reads
``…/text``).
"""

from __future__ import annotations

from typing import Literal, Optional
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from graphlagoon.middleware.auth import get_current_actor, get_current_user
from graphlagoon.models.schemas import (
    AnnotationCreate,
    AnnotationResponse,
    AnnotationStatusBulk,
    AnnotationStatusBulkResponse,
    AnnotationUpdate,
    DecisionReview,
    EntityResolutionRequest,
    BriefResponse,
    BriefUpdate,
    InvestigationCreate,
    InvestigationDecisionCreate,
    InvestigationEventCreate,
    InvestigationEventResponse,
    InvestigationPage,
    InvestigationResponse,
    InvestigationShareRequest,
    InvestigationUpdate,
    EntityCase,
    ItemCreate,
    ReportCreate,
    TaskResponse,
    ItemPinRequest,
    ItemResponse,
    ItemRunRequest,
    ItemSearchHit,
    ItemTextResponse,
    ItemUpdate,
    ItemVersionCreate,
    ItemVersionResponse,
    PathsRequest,
    TableCompareRequest,
    TableJoinRequest,
    TablePromoteRequest,
    TraceRequest,
)
from graphlagoon.services import audit, case_annotations, case_items, case_queries, case_tables
from graphlagoon.services import cases as service
from graphlagoon.services import investigation_exports as exports
from graphlagoon.services import investigation_storage as storage
from graphlagoon.services.audit import AuditAction
from graphlagoon.services.case_graph import case_graph
from graphlagoon.services.paths import run_case_paths
from graphlagoon.services.trace import run_case_trace
from graphlagoon.utils.authz import agent_forbidden, forbid_agents, require_permission

router = APIRouter(prefix="/api/investigations")


def _http(exc: service.InvestigationError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"error": {"code": exc.code, "message": exc.message, "details": {}}},
    )


async def _record(user_email: str, action: str, investigation_id: UUID, **meta):
    await audit.record(
        user_email, action, resource_type="investigation", resource_id=investigation_id, metadata=meta
    )


# ---------------------------------------------------------------------------
# Case
# ---------------------------------------------------------------------------


@router.get("", tags=["cases"], response_model=InvestigationPage)
async def list_investigations(
    request: Request,
    status: Optional[str] = None,
    assignee: Optional[str] = None,
    case_type: Optional[str] = None,
    exploration_id: Optional[UUID] = None,
    external_ref: Optional[str] = None,
    q: Optional[str] = Query(default=None, max_length=200),
    deadline: Optional[Literal["urgent", "overdue"]] = None,
    suggested: Optional[bool] = None,
    sort: str = "-updated_at",
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """A page of the queue (06 §2b). Field filters are ``field.<id>=<value>``
    or ``field.<id>=gte:<n>`` (also ``lte:``, ``contains:``); ``sort`` is
    ``updated_at | created_at | title | deadline | field.<id>``, ``-`` first
    for descending."""
    fields = {k[len("field."):]: v for k, v in request.query_params.items() if k.startswith("field.")}
    try:
        return await service.list_investigations(
            get_current_user(request), status, assignee, case_type, exploration_id, external_ref, q, deadline,
            suggested, fields, sort, limit, offset,
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.get("/entities/cases", tags=["graph & analysis"], response_model=list[EntityCase])
async def entity_cases(request: Request, uid: str = Query(min_length=1, max_length=512)):
    """06 P7: the cases the caller reads where the entity ``uid`` is on the
    graph or a target of an annotation or decision (a read; not audited)."""
    from graphlagoon.services import case_entities

    return await case_entities.find_cases(uid, get_current_user(request))


@router.get("/tasks", tags=["annotations & tasks"], response_model=list[TaskResponse])
async def list_tasks(
    request: Request,
    mine: bool = False,
    state: Optional[Literal["open", "done", "cancelled"]] = None,
    overdue: Optional[bool] = None,
    limit: int = Query(200, ge=1, le=1000),
):
    """Tasks across the cases the caller reads (06 §1), oldest due first.
    ``mine``: a person's are assigned to them; an agent's are assigned to agents
    under its token name (or to any agent)."""
    return await case_annotations.list_tasks(get_current_user(request), mine, state, overdue, limit)


@router.post("", tags=["cases"], response_model=InvestigationResponse, status_code=201)
async def create_investigation(
    data: InvestigationCreate,
    response: Response,
    user_email: str = Depends(require_permission("investigation.create")),
):
    """201 with the new case, or 200 with the one already opened for the same
    ``external_ref`` (among the cases the caller reads)."""
    try:
        inv, created = await service.create_investigation(user_email, data.model_dump())
    except service.InvestigationError as exc:
        raise _http(exc)
    if not created:
        response.status_code = 200
        return inv
    await _record(user_email, AuditAction.INVESTIGATION_CREATE, inv["id"], title=inv["title"], case_type=inv["case_type"])
    return inv


@router.get("/{investigation_id}", tags=["cases"], response_model=InvestigationResponse)
async def get_investigation(investigation_id: UUID, request: Request):
    """One case as the caller reads it: status and stage, type and fields, deadline, decisions,
    shares and access flags. 404 when it does not exist or the caller cannot read it (a
    case's existence never leaks)."""
    try:
        return await service.get_investigation(investigation_id, get_current_user(request))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.patch("/{investigation_id}", tags=["cases"], response_model=InvestigationResponse)
async def update_investigation(investigation_id: UUID, data: InvestigationUpdate, request: Request):
    """Edit the case: title, description, tags, case type and fields (merged; null removes one),
    stage, assignee, dates, SLA hours, settings and view state. `status` moves between open
    and analysis; only a decision closes a case. An agent's status change arrives as a
    suggested `status_change`. 409 `CASE_CLOSED` on a closed case."""
    user_email = get_current_user(request)
    changes = data.model_dump(exclude_unset=True)
    if "assignee_email" in changes and get_current_actor():
        raise agent_forbidden("Assigning a case is reserved to people.")
    try:
        inv = await service.update_investigation(investigation_id, user_email, changes)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(user_email, AuditAction.INVESTIGATION_UPDATE, investigation_id, fields=sorted(changes))
    return inv


@router.delete("/{investigation_id}", tags=["cases"], dependencies=[Depends(forbid_agents)])
async def delete_investigation(investigation_id: UUID, request: Request, reason: Optional[str] = None):
    user_email = get_current_user(request)
    try:
        meta = await service.delete_investigation(investigation_id, user_email, reason)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(user_email, AuditAction.INVESTIGATION_DELETE, investigation_id, **meta)
    return {"status": "deleted"}


@router.post(
    "/{investigation_id}/decisions",
    tags=["decisions"],
    response_model=InvestigationResponse,
    dependencies=[Depends(forbid_agents)],
)
async def record_decision(
    investigation_id: UUID,
    data: InvestigationDecisionCreate,
    user_email: str = Depends(require_permission("investigation.decide")),
):
    """Human only (06 §1): appends a decision with its own hash. An outcome that
    closes the case freezes it (every mutation answers 409 until reopened); with
    four eyes it waits for another person's review first."""
    try:
        inv = await service.record_decision(investigation_id, user_email, data.model_dump(mode="json"))
    except service.InvestigationError as exc:
        raise _http(exc)
    d = inv["decisions"][-1]
    await _record(
        user_email, AuditAction.INVESTIGATION_DECIDE, investigation_id,
        decision_id=d["id"], outcome=d["outcome_label"], closes_case=d["closes_case"], review=d["review"], hash=d["hash"],
    )
    return inv


@router.post(
    "/{investigation_id}/decisions/{decision_id}/review",
    tags=["decisions"],
    response_model=InvestigationResponse,
    dependencies=[Depends(forbid_agents)],
)
async def review_decision(
    investigation_id: UUID,
    decision_id: str,
    data: DecisionReview,
    user_email: str = Depends(require_permission("investigation.decide")),
):
    """Four eyes: approve or reject a pending decision (never one's own)."""
    try:
        inv = await service.review_decision(investigation_id, user_email, decision_id, data.approve, data.note)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email, AuditAction.INVESTIGATION_DECISION_REVIEW, investigation_id,
        decision_id=decision_id, approved=data.approve, closed=inv["status"] == "closed",
    )
    return inv


@router.post(
    "/{investigation_id}/reopen",
    tags=["cases"],
    response_model=InvestigationResponse,
    dependencies=[Depends(forbid_agents)],
)
async def reopen_investigation(investigation_id: UUID, request: Request):
    """closed → analysis, human only; journaled as ``case.reopened``."""
    user_email = get_current_user(request)
    try:
        inv = await service.reopen_investigation(investigation_id, user_email)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(user_email, AuditAction.INVESTIGATION_REOPEN, investigation_id)
    return inv


@router.get("/{investigation_id}/export", tags=["cases"], dependencies=[Depends(forbid_agents)])
async def export_investigation(
    investigation_id: UUID,
    request: Request,
    format: Literal["json", "csv"] = "json",
):
    """Package (json) or csv; verifies every decision's hash and is audited with
    the sha256 of what left the app. Human only: what leaves the app is a person's call."""
    user_email = get_current_user(request)
    try:
        out = await exports.export(investigation_id, user_email, format)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email,
        AuditAction.INVESTIGATION_EXPORT,
        investigation_id,
        format=format,
        sha256=out.sha256,
        size_bytes=len(out.data),
    )
    return Response(
        content=out.data,
        media_type=out.media_type,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(out.filename)}",
            "X-Content-Type-Options": "nosniff",
            "X-Content-SHA256": out.sha256,
        },
    )


@router.post("/{investigation_id}/share", tags=["cases"], dependencies=[Depends(forbid_agents)])
async def share_investigation(
    investigation_id: UUID,
    data: InvestigationShareRequest,
    user_email: str = Depends(require_permission("investigation.share")),
):
    try:
        email = await service.share_investigation(investigation_id, user_email, data.email, data.role)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email, AuditAction.INVESTIGATION_SHARE, investigation_id, **{"with": email}, role=data.role
    )
    return {"status": "shared"}


@router.delete("/{investigation_id}/share/{email}", tags=["cases"], dependencies=[Depends(forbid_agents)])
async def unshare_investigation(
    investigation_id: UUID,
    email: str,
    user_email: str = Depends(require_permission("investigation.share")),
):
    try:
        removed = await service.unshare_investigation(investigation_id, user_email, email)
    except service.InvestigationError as exc:
        raise _http(exc)
    if removed:
        await _record(user_email, AuditAction.INVESTIGATION_UNSHARE, investigation_id, **{"with": email})
    return {"status": "removed"}


# ---------------------------------------------------------------------------
# Items (05 §1): JSON bodies for text/JSON content; a raw body streams an upload
# (filename, kind, subkind, title in the query; needs investigation.upload).
# ---------------------------------------------------------------------------


async def _receive_upload(request: Request, investigation_id: UUID, user_email: str) -> storage.Received:
    from graphlagoon.config import get_settings
    from graphlagoon.services.permissions import check_permission

    if not (await check_permission(user_email, "investigation.upload")).allowed:
        raise HTTPException(
            status_code=403,
            detail={
                "error": {
                    "code": "PERMISSION_DENIED",
                    "message": 'You do not have the "Upload investigation files" permission.',
                    "details": {"permission": "investigation.upload"},
                }
            },
        )
    max_bytes = get_settings().investigation_file_max_bytes
    try:
        await service.ensure_case_access(investigation_id, user_email, "write")
    except service.InvestigationError as exc:
        raise _http(exc)
    try:
        return await storage.receive(request.stream(), max_bytes)
    except storage.TooLarge:
        raise _http(
            service.InvestigationError(413, "FILE_TOO_LARGE", f"Files are limited to {max_bytes} bytes")
        )


def _is_json(request: Request) -> bool:
    return request.headers.get("content-type", "").startswith("application/json")


async def _json_body(request: Request, model):
    """The JSON body (an item's text or JSON content) read up to the file limit:
    content is content, uploaded as a file or inline, and an unbounded body
    would be buffered and parsed whole before any check."""
    import json

    from graphlagoon.config import get_settings

    max_bytes = get_settings().investigation_file_max_bytes
    too_large = service.InvestigationError(413, "BODY_TOO_LARGE", f"Content is limited to {max_bytes} bytes")
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > max_bytes:
        raise _http(too_large)
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > max_bytes:
            raise _http(too_large)
        chunks.append(chunk)
    try:
        return model.model_validate(json.loads(b"".join(chunks) or b"null"))
    except ValueError as exc:  # pydantic's ValidationError and bad JSON included
        raise _http(service.InvestigationError(422, "INVALID_BODY", str(exc)))


@router.get("/{investigation_id}/items", tags=["case items"], response_model=list[ItemResponse])
async def list_items(
    investigation_id: UUID,
    request: Request,
    kind: Optional[str] = None,
    status: Optional[str] = None,
    include_deleted: bool = False,
):
    """The case material: every item (graph, table, query, document, note) with its author, status
    (suggested, confirmed, rejected), latest version and pins. Filter with `kind` and
    `status`."""
    try:
        return await case_items.list_items(
                investigation_id, get_current_user(request), kind, status, include_deleted
            )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/items", tags=["case items"], response_model=ItemResponse, status_code=201)
async def create_item(
    investigation_id: UUID,
    request: Request,
    kind: Optional[str] = None,
    subkind: Optional[str] = None,
    title: Optional[str] = None,
    filename: Optional[str] = None,
):
    """Add an item. JSON body (`ItemCreate`) for text or JSON content, links, saved queries and
    exploration references; or the raw file bytes with `?kind=&subkind=&filename=` (and
    `Content-Type`) for an upload, streamed to the case storage with its sha256. An agent's
    item may arrive suggested."""
    user_email = get_current_user(request)
    try:
        if _is_json(request):
            body = await _json_body(request, ItemCreate)
            content, content_type = case_items.encode_content(body.content, body.content_json)
            item = await case_items.create_item(
                investigation_id, user_email, body.model_dump(exclude={"content", "content_json"}), content, content_type
            )
        else:
            received = await _receive_upload(request, investigation_id, user_email)
            data = {
                "kind": kind or "document",
                "subkind": subkind or ("csv" if kind == "table" else "upload"),
                "title": title,
                "filename": filename or title,
            }
            item = await case_items.create_item(
                investigation_id, user_email, data, None, request.headers.get("content-type"), received=received
            )
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email,
        AuditAction.INVESTIGATION_ITEM_ADD,
        investigation_id,
        item_id=str(item["id"]),
        kind=f"{item['kind']}/{item['subkind']}",
        title=item["title"],
        sha256=(item["latest"] or {}).get("sha256"),
    )
    return item


# Table operations (05 §3): static paths, declared before ``/items/{item_id}``.


@router.post("/{investigation_id}/items/join", tags=["case items"], response_model=ItemResponse, status_code=201)
async def join_tables(investigation_id: UUID, data: TableJoinRequest, request: Request):
    """A new ``table/result`` item: the tables joined by the key column; its
    provenance names the parents."""
    user_email = get_current_user(request)
    try:
        item = await case_tables.join_tables(investigation_id, user_email, data.item_ids, data.key_column, data.title)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email, AuditAction.INVESTIGATION_ITEM_ADD, investigation_id,
        item_id=str(item["id"]), kind="table/result", title=item["title"], sha256=(item["latest"] or {}).get("sha256"),
    )
    return item


@router.post("/{investigation_id}/items/compare", tags=["case items"])
async def compare_tables(investigation_id: UUID, data: TableCompareRequest, request: Request):
    """Diff by key of two tables, or of two runs of one query: rows only on one
    side, rows whose shared columns changed, and how many are the same."""
    try:
        return await case_tables.compare_tables(
                investigation_id, get_current_user(request), data.left.model_dump(), data.right.model_dump(), data.key_column
            )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/items/promote", tags=["case items"], response_model=list[ItemResponse])
async def promote_tables(investigation_id: UUID, data: TablePromoteRequest, request: Request):
    """Promotes tables (or the latest run of queries) to the graph or to
    enrichment in one go: each gets ``mapping.as`` with a spec over its columns."""
    try:
        return await case_tables.promote(investigation_id, get_current_user(request), data.item_ids, data.as_, data.options)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.get("/{investigation_id}/items/{item_id}", tags=["case items"], response_model=ItemResponse)
async def get_item(investigation_id: UUID, item_id: UUID, request: Request):
    """One item with its provenance, mapping, query, anchor, view state and latest version."""
    try:
        return await case_items.get_item(investigation_id, get_current_user(request), item_id)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.patch("/{investigation_id}/items/{item_id}", tags=["case items"], response_model=ItemResponse)
async def update_item(investigation_id: UUID, item_id: UUID, data: ItemUpdate, request: Request):
    """Edit an item's title, description, tags, mapping (tables), query (queries), anchor, view
    state (`state.chart` for a table) or position. Content changes are new versions, never
    edits."""
    try:
        return await case_items.update_item(
                investigation_id, get_current_user(request), item_id, data.model_dump(exclude_unset=True)
            )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.delete("/{investigation_id}/items/{item_id}", tags=["case items"], dependencies=[Depends(forbid_agents)])
async def delete_item(investigation_id: UUID, item_id: UUID, request: Request):
    """Remove an item from the case (people only). It is
    marked deleted, so the journal and the versions it pinned keep their history; its blobs go
    when the case is deleted."""
    user_email = get_current_user(request)
    try:
        meta = await case_items.delete_item(investigation_id, user_email, item_id)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(user_email, AuditAction.INVESTIGATION_ITEM_REMOVE, investigation_id, item_id=str(item_id), **meta)
    return {"status": "deleted"}


@router.post(
    "/{investigation_id}/items/{item_id}/restore",
    tags=["case items"],
    response_model=ItemResponse,
    dependencies=[Depends(forbid_agents)],
)
async def restore_item(investigation_id: UUID, item_id: UUID, request: Request):
    """Put a removed item back in the material (people only), with its versions and pins. 409
    `ITEM_EXISTS` when the case meanwhile has the same exploration or another brief."""
    user_email = get_current_user(request)
    try:
        item = await case_items.restore_item(investigation_id, user_email, item_id)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(user_email, AuditAction.INVESTIGATION_ITEM_RESTORE, investigation_id, item_id=str(item_id), title=item["title"])
    return item


@router.get("/{investigation_id}/items/{item_id}/versions", tags=["case items"], response_model=list[ItemVersionResponse])
async def list_versions(investigation_id: UUID, item_id: UUID, request: Request):
    """Every version of an item, oldest first: number, sha256, size, content type, author, run
    metadata for queries and pin."""
    try:
        return await case_items.list_versions(investigation_id, get_current_user(request), item_id)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/items/{item_id}/versions", tags=["case items"], response_model=ItemResponse, status_code=201)
async def add_version(investigation_id: UUID, item_id: UUID, request: Request):
    """A new immutable version of an item: JSON body (`content` or `content_json`) or raw bytes.
    Pinned versions never change."""
    user_email = get_current_user(request)
    try:
        if _is_json(request):
            body = await _json_body(request, ItemVersionCreate)
            content, content_type = case_items.encode_content(body.content, body.content_json)
            if content is None:
                raise service.InvestigationError(422, "INVALID_BODY", "Give content or content_json")
            item = await case_items.add_version(investigation_id, user_email, item_id, content, content_type)
        else:
            received = await _receive_upload(request, investigation_id, user_email)
            item = await case_items.add_version(
                investigation_id, user_email, item_id, None, request.headers.get("content-type"), received=received
            )
    except service.InvestigationError as exc:
        raise _http(exc)
    return item


@router.get("/{investigation_id}/items/{item_id}/content", tags=["case items"])
async def get_content(
    investigation_id: UUID, item_id: UUID, request: Request, version: Optional[int] = None, download: bool = False
):
    """The bytes of a version. Agents read text through ``…/text`` (05 §6)."""
    if get_current_actor():
        raise agent_forbidden("Agents read an item through its text (…/items/{id}/text).")
    user_email = get_current_user(request)
    try:
        data, meta, item = await case_items.get_content(investigation_id, user_email, item_id, version)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email, AuditAction.INVESTIGATION_ITEM_READ, investigation_id,
        item_id=str(item_id), version=meta["version"], sha256=meta["sha256"],
    )
    name = (item["provenance"] or {}).get("filename") or f"{item['title']}.{'json' if meta['content_type'] == 'application/json' else 'txt'}"
    # Case data is never rendered by the browser (XSS): opaque type unless inline JSON/text.
    inline = meta["content_type"].startswith(("application/json", "text/plain", "text/markdown", "text/csv")) and not download
    return Response(
        content=data,
        media_type=meta["content_type"] if inline else "application/octet-stream",
        headers={
            "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(name)}",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "X-Content-SHA256": meta["sha256"],
        },
    )


@router.get("/{investigation_id}/items/{item_id}/text", tags=["case items"], response_model=ItemTextResponse)
async def get_text(investigation_id: UUID, item_id: UUID, request: Request, version: Optional[int] = None):
    """The text extraction of a version (null when the format has none)."""
    try:
        text, meta = await case_items.get_text(investigation_id, get_current_user(request), item_id, version)
    except service.InvestigationError as exc:
        raise _http(exc)
    return {"text": text, "version": meta}


@router.post("/{investigation_id}/items/{item_id}/pin", tags=["case items"], response_model=ItemVersionResponse)
async def pin_item(investigation_id: UUID, item_id: UUID, data: ItemPinRequest, request: Request):
    """Pins a version as evidence (immutable); a live exploration is frozen first."""
    try:
        return await case_items.pin_version(
            investigation_id, get_current_user(request), item_id, data.version, data.label
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/items/{item_id}/confirm",
    tags=["case items"],
    response_model=ItemResponse,
    dependencies=[Depends(forbid_agents)],
)
async def confirm_item(investigation_id: UUID, item_id: UUID, request: Request):
    try:
        return await case_items.set_status(investigation_id, get_current_user(request), item_id, "confirmed")
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/items/{item_id}/reject",
    tags=["case items"],
    response_model=ItemResponse,
    dependencies=[Depends(forbid_agents)],
)
async def reject_item(investigation_id: UUID, item_id: UUID, request: Request):
    try:
        return await case_items.set_status(investigation_id, get_current_user(request), item_id, "rejected")
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/items/{item_id}/reopen",
    tags=["case items"],
    response_model=ItemResponse,
    dependencies=[Depends(forbid_agents)],
)
async def reopen_item(investigation_id: UUID, item_id: UUID, request: Request):
    """A rejected suggestion is a suggestion again (people only): 409 `NOT_REJECTED` otherwise."""
    try:
        return await case_items.reopen_item(investigation_id, get_current_user(request), item_id)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/items/{item_id}/run", tags=["case items"], response_model=ItemResponse)
async def run_query(investigation_id: UUID, item_id: UUID, data: ItemRunRequest, request: Request):
    """Executes a saved query (05 §1) and stores the result as a version with ``run``."""
    try:
        return await case_queries.run_query(
                investigation_id, get_current_user(request), item_id, data.parameters, data.row_limit
            )
    except service.InvestigationError as exc:
        raise _http(exc)


# ---------------------------------------------------------------------------
# Annotations
# ---------------------------------------------------------------------------


@router.get("/{investigation_id}/annotations", tags=["annotations & tasks"], response_model=list[AnnotationResponse])
async def list_annotations(
    investigation_id: UUID,
    request: Request,
    kind: Optional[str] = None,
    status: Optional[str] = None,
    target: Optional[str] = None,
):
    """Annotations of the case (role, tag, group, same_as, hypothesis, hypothesis_status,
    status_change, task, decision_proposal) with status, author and reason. Filter with
    `kind`, `status` and `target` (an entity or item id)."""
    try:
        return await case_annotations.list_annotations(
                investigation_id, get_current_user(request), kind, status, target
            )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/annotations", tags=["annotations & tasks"], response_model=AnnotationResponse, status_code=201)
async def create_annotation(investigation_id: UUID, data: AnnotationCreate, request: Request):
    """Annotate entities or items. A person's annotation is confirmed; an agent's arrives suggested
    for the kinds the case lists (and always for a decision_proposal). A confirmed role
    replaces the entity's previous one unless the case type allows several. Tasks and their
    edits also work on a closed case."""
    try:
        return await case_annotations.create_annotation(
                investigation_id, get_current_user(request), data.kind, data.targets, data.value, data.reason
            )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.patch("/{investigation_id}/annotations/{annotation_id}", tags=["annotations & tasks"], response_model=AnnotationResponse)
async def update_annotation(
    investigation_id: UUID, annotation_id: UUID, data: AnnotationUpdate, request: Request
):
    """Edit an annotation's value, targets or reason. An agent edits only the tasks it wrote or
    that are assigned to it (403 `TASK_NOT_YOURS`)."""
    try:
        return await case_annotations.update_annotation(
                investigation_id, get_current_user(request), annotation_id, data.model_dump(exclude_unset=True)
            )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.delete(
    "/{investigation_id}/annotations/{annotation_id}", tags=["annotations & tasks"], dependencies=[Depends(forbid_agents)]
)
async def delete_annotation(investigation_id: UUID, annotation_id: UUID, request: Request):
    """Remove an annotation (people only)."""
    try:
        await case_annotations.delete_annotation(investigation_id, get_current_user(request), annotation_id)
    except service.InvestigationError as exc:
        raise _http(exc)
    return {"status": "deleted"}


@router.post(
    "/{investigation_id}/annotations/{annotation_id}/confirm",
    tags=["annotations & tasks"],
    response_model=AnnotationResponse,
    dependencies=[Depends(forbid_agents)],
)
async def confirm_annotation(investigation_id: UUID, annotation_id: UUID, request: Request):
    try:
        return await case_annotations.set_status(
            investigation_id, get_current_user(request), annotation_id, "confirmed"
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/annotations/{annotation_id}/reject",
    tags=["annotations & tasks"],
    response_model=AnnotationResponse,
    dependencies=[Depends(forbid_agents)],
)
async def reject_annotation(investigation_id: UUID, annotation_id: UUID, request: Request):
    try:
        return await case_annotations.set_status(
            investigation_id, get_current_user(request), annotation_id, "rejected"
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/annotations/{annotation_id}/reopen",
    tags=["annotations & tasks"],
    response_model=AnnotationResponse,
    dependencies=[Depends(forbid_agents)],
)
async def reopen_annotation(investigation_id: UUID, annotation_id: UUID, request: Request):
    """A rejected suggestion is a suggestion again (people only): 409 `NOT_REJECTED` otherwise.
    Nothing was applied when it was rejected, so nothing is undone."""
    try:
        return await case_annotations.reopen(investigation_id, get_current_user(request), annotation_id)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post(
    "/{investigation_id}/annotations/status",
    tags=["annotations & tasks"],
    response_model=AnnotationStatusBulkResponse,
    dependencies=[Depends(forbid_agents)],
)
async def set_annotations_status(investigation_id: UUID, data: AnnotationStatusBulk, request: Request):
    """Confirm or reject several suggestions at once (people only). All are checked first; one
    unknown id or forbidden kind fails the call. Ones no longer suggested come back in `skipped`."""
    try:
        return await case_annotations.set_status_many(investigation_id, get_current_user(request), data.ids, data.status)
    except service.InvestigationError as exc:
        raise _http(exc)


# ---------------------------------------------------------------------------
# Graph, analyses, journal, brief, search
# ---------------------------------------------------------------------------


@router.get("/{investigation_id}/graph", tags=["graph & analysis"])
async def get_graph(investigation_id: UUID, request: Request, item_id: Optional[str] = None):
    """The unified case graph (identity keys and confirmed same_as applied), or
    one item's with ``item_id``."""
    try:
        return await case_graph(investigation_id, get_current_user(request), item_id)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.get("/{investigation_id}/items/{item_id}/snapshot", tags=["graph & analysis"])
async def get_item_snapshot(investigation_id: UUID, item_id: UUID, request: Request):
    """What one graph item puts on the canvas (snapshot, identity keys, edge
    semantics); the browser unifies these with ``unifyGraph.ts``."""
    from graphlagoon.services.case_graph import is_graph_item, item_snapshot_or_error
    from graphlagoon.services.case_items import ensure_sources_readable, item_row

    user_email = get_current_user(request)
    try:
        async with service._session() as session:
            inv = await service.load_case(session, investigation_id, user_email)
            item = await item_row(session, investigation_id, item_id)
            if not is_graph_item(item):
                raise service.InvestigationError(422, "NOT_A_GRAPH_ITEM", "This item puts nothing on the canvas")
            await ensure_sources_readable(item, user_email)
            return await item_snapshot_or_error(session, inv, item, user_email)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/analysis/trace", tags=["graph & analysis"])
async def analysis_trace(investigation_id: UUID, data: TraceRequest, request: Request):
    """Follow the money on the case's unified graph: from `seed_edge_ids` or a `seed_node`, forward
    or backward, with an allocation rule, layers, dwell time, minimum amount, time window
    and stop types (unset values come from the case type's trace defaults). Returns the
    exits, the coverage and the method stamp; journaled as `trace.run`."""
    try:
        return await run_case_trace(investigation_id, get_current_user(request), data)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/analysis/paths", tags=["graph & analysis"])
async def analysis_paths(investigation_id: UUID, data: PathsRequest, request: Request):
    """Paths between two entities of the unified graph: shortest, weighted, k-shortest or earliest
    arrival. Journaled as `path.run`."""
    try:
        return await run_case_paths(investigation_id, get_current_user(request), data)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/analysis/er", tags=["graph & analysis"], response_model=list[AnnotationResponse])
async def analysis_er(investigation_id: UUID, request: Request, data: Optional[EntityResolutionRequest] = None):
    """Entity resolution on the unified graph: entities sharing a blocking
    attribute with similar names become ``same_as`` annotations, suggested (a
    person confirms them in the inspector)."""
    from graphlagoon.services.entity_resolution import suggest

    user_email = get_current_user(request)
    try:
        graph = await case_graph(investigation_id, user_email)
        known = {
            tuple(a["targets"])
            for a in await case_annotations.list_annotations(investigation_id, user_email, "same_as")
        }
        created = []
        for match in suggest(graph["nodes"], *((data.block_on, data.name_keys) if data else (None, None))):
            pair = (match["left"]["uid"], match["right"]["uid"])
            if pair in known or pair[::-1] in known:
                continue
            row = await case_annotations.create_annotation(
                investigation_id, user_email, "same_as", list(pair),
                {"score": match["score"], "reasons": match["reasons"]},
            )
            if not get_current_actor():  # a person's run is still a suggestion to review
                row = await _suggest(investigation_id, row)
            created.append(row)
        return created
    except service.InvestigationError as exc:
        raise _http(exc)


async def _suggest(investigation_id: UUID, row: dict) -> dict:
    """Entity-resolution hits are suggestions whoever ran them (05 §4b)."""
    async with service._session() as session:
        a = await service.get_row(session, case_annotations.TABLE, row["id"])
        await service.update_row(session, case_annotations.TABLE, a, status="suggested")
        await service.commit(session)
        return case_annotations.serialize(a)


@router.get("/{investigation_id}/events", tags=["cases"], response_model=list[InvestigationEventResponse])
async def list_events(
    investigation_id: UUID,
    request: Request,
    after: Optional[UUID] = None,
    limit: int = Query(100, ge=1, le=500),
    order: Literal["asc", "desc"] = "asc",
):
    """The case journal: who did what, a person or an agent for a person. Oldest first by default;
    `order=desc` reads it newest first (the UI's journal). `after` is the last event id already
    seen, in the same order."""
    try:
        return await service.list_events(investigation_id, get_current_user(request), after, limit, order)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/events", tags=["cases"], response_model=InvestigationEventResponse, status_code=201)
async def post_event(investigation_id: UUID, data: InvestigationEventCreate, request: Request):
    """Journal what the browser ran on its own graph: `trace.run`, `path.run`, `nodes.promoted`
    (enrichment nodes added to the canvas) or `metric.saved` (a metric saved as a property).
    Other kinds answer 422 `EVENT_KIND_NOT_ALLOWED`."""
    try:
        return await service.post_client_event(
            investigation_id, get_current_user(request), data.kind, data.payload
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.get("/{investigation_id}/brief", tags=["cases"], response_model=BriefResponse)
async def get_brief(investigation_id: UUID, request: Request):
    """The case brief (markdown) and its item with versions; `item` is null while the case has
    none."""
    try:
        return await case_items.get_brief(investigation_id, get_current_user(request))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.put("/{investigation_id}/brief", tags=["cases"], response_model=BriefResponse)
async def put_brief(investigation_id: UUID, data: BriefUpdate, request: Request):
    """The single ``document/brief`` item: a new version per save (05 §6)."""
    try:
        return await case_items.put_brief(investigation_id, get_current_user(request), data.text)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/reports", tags=["case items"], response_model=ItemResponse, status_code=201)
async def render_report(investigation_id: UUID, data: ReportCreate, request: Request):
    """Renders an org library template (kind ``template``) over the case into a
    ``document/markdown`` item (06 §1); an agent's arrives suggested."""
    from graphlagoon.services import reports

    user_email = get_current_user(request)
    try:
        item = await reports.render_report(investigation_id, user_email, data.template, data.title)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email, AuditAction.INVESTIGATION_ITEM_ADD, investigation_id,
        item_id=str(item["id"]), kind="document", title=item["title"], template=data.template,
        sha256=(item.get("latest") or {}).get("sha256"),
    )
    return item


@router.get("/{investigation_id}/search", tags=["cases"], response_model=list[ItemSearchHit])
async def search(investigation_id: UUID, request: Request, q: str = Query(min_length=1, max_length=200)):
    """Items whose title, description, tags, query or latest text contain `q` (case-insensitive
    substring), with a snippet when the hit is in the text."""
    try:
        return await case_items.search(investigation_id, get_current_user(request), q)
    except service.InvestigationError as exc:
        raise _http(exc)
