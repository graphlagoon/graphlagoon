"""Cases (05-plano-v2): one place with items, annotations, a journal and a
decision. Rules live in ``services/cases*.py``; this module maps them to HTTP,
the ``{"error": {...}}`` envelope and the audit trail.

Human-only routes (05 §6) carry ``forbid_agents``: decision, share, delete,
reopen, export and confirming/rejecting suggestions. The middleware allowlists
the rest for agent tokens; reads come back through ``agent_view`` (masked) and
binary content never reaches an agent (it reads ``…/text``).
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
    AnnotationUpdate,
    BriefResponse,
    BriefUpdate,
    InvestigationCreate,
    InvestigationDecisionCreate,
    InvestigationEventCreate,
    InvestigationEventResponse,
    InvestigationResponse,
    InvestigationShareRequest,
    InvestigationUpdate,
    ItemCreate,
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
    TypologiesRequest,
)
from graphlagoon.services import audit, case_annotations, case_items, case_queries, case_tables
from graphlagoon.services import cases as service
from graphlagoon.services import investigation_exports as exports
from graphlagoon.services import investigation_storage as storage
from graphlagoon.services.audit import AuditAction
from graphlagoon.services.case_graph import case_graph
from graphlagoon.services.masking import agent_view
from graphlagoon.services.paths import run_case_paths
from graphlagoon.services.trace import run_case_trace
from graphlagoon.services.typologies import run_case_typologies
from graphlagoon.utils.authz import agent_forbidden, forbid_agents, require_permission

router = APIRouter(prefix="/api/investigations", tags=["investigations"])


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


@router.get("", response_model=list[InvestigationResponse])
async def list_investigations(
    request: Request,
    status: Optional[str] = None,
    assignee: Optional[str] = None,
    kind_preset: Optional[str] = None,
    exploration_id: Optional[UUID] = None,
):
    return await service.list_investigations(
        get_current_user(request), status, assignee, kind_preset, exploration_id
    )


@router.post("", response_model=InvestigationResponse, status_code=201)
async def create_investigation(
    data: InvestigationCreate, user_email: str = Depends(require_permission("investigation.create"))
):
    try:
        inv = await service.create_investigation(user_email, data.model_dump())
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(user_email, AuditAction.INVESTIGATION_CREATE, inv["id"], title=inv["title"])
    return inv


@router.get("/{investigation_id}", response_model=InvestigationResponse)
async def get_investigation(investigation_id: UUID, request: Request):
    try:
        return await service.get_investigation(investigation_id, get_current_user(request))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.patch("/{investigation_id}", response_model=InvestigationResponse)
async def update_investigation(investigation_id: UUID, data: InvestigationUpdate, request: Request):
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


@router.delete("/{investigation_id}", dependencies=[Depends(forbid_agents)])
async def delete_investigation(investigation_id: UUID, request: Request, reason: Optional[str] = None):
    user_email = get_current_user(request)
    try:
        meta = await service.delete_investigation(investigation_id, user_email, reason)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(user_email, AuditAction.INVESTIGATION_DELETE, investigation_id, **meta)
    return {"status": "deleted"}


@router.post(
    "/{investigation_id}/decision",
    response_model=InvestigationResponse,
    dependencies=[Depends(forbid_agents)],
)
async def record_decision(
    investigation_id: UUID,
    data: InvestigationDecisionCreate,
    user_email: str = Depends(require_permission("investigation.decide")),
):
    """Human only (05 §7). Stores ``frozen_hash`` over the journal and the
    pinned versions; the case becomes read-only (every mutation answers 409)."""
    try:
        inv = await service.record_decision(
            investigation_id, user_email, data.outcome, data.actions, data.rationale, data.reviewer_email
        )
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(
        user_email,
        AuditAction.INVESTIGATION_DECIDE,
        investigation_id,
        outcome=data.outcome,
        actions=inv["decision"]["actions"],
        frozen_hash=inv["frozen_hash"],
    )
    return inv


@router.post(
    "/{investigation_id}/reopen",
    response_model=InvestigationResponse,
    dependencies=[Depends(forbid_agents)],
)
async def reopen_investigation(investigation_id: UUID, request: Request):
    """decided → analysis, human only; journaled as ``case.reopened``."""
    user_email = get_current_user(request)
    try:
        inv = await service.reopen_investigation(investigation_id, user_email)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(user_email, AuditAction.INVESTIGATION_REOPEN, investigation_id)
    return inv


@router.get("/{investigation_id}/export", dependencies=[Depends(forbid_agents)])
async def export_investigation(
    investigation_id: UUID,
    request: Request,
    format: Literal["json", "csv", "simba", "siscoaf"] = "json",
):
    """Package (json), csv, SIMBA (zip) or Siscoaf summary; verifies the frozen
    hash and is audited with the sha256 of what left the app. Human only:
    exports carry unmasked data."""
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


@router.post("/{investigation_id}/share", dependencies=[Depends(forbid_agents)])
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


@router.delete("/{investigation_id}/share/{email}", dependencies=[Depends(forbid_agents)])
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
    try:
        return model.model_validate(await request.json())
    except ValueError as exc:  # pydantic's ValidationError included
        raise _http(service.InvestigationError(422, "INVALID_BODY", str(exc)))


@router.get("/{investigation_id}/items", response_model=list[ItemResponse])
async def list_items(
    investigation_id: UUID,
    request: Request,
    kind: Optional[str] = None,
    status: Optional[str] = None,
    include_deleted: bool = False,
):
    try:
        return agent_view(
            await case_items.list_items(
                investigation_id, get_current_user(request), kind, status, include_deleted
            )
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/items", response_model=ItemResponse, status_code=201)
async def create_item(
    investigation_id: UUID,
    request: Request,
    kind: Optional[str] = None,
    subkind: Optional[str] = None,
    title: Optional[str] = None,
    filename: Optional[str] = None,
):
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
    return agent_view(item)


# Table operations (05 §3): static paths, declared before ``/items/{item_id}``.


@router.post("/{investigation_id}/items/join", response_model=ItemResponse, status_code=201)
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
    return agent_view(item)


@router.post("/{investigation_id}/items/compare")
async def compare_tables(investigation_id: UUID, data: TableCompareRequest, request: Request):
    """Diff by key of two tables, or of two runs of one query: rows only on one
    side, rows whose shared columns changed, and how many are the same."""
    try:
        return agent_view(
            await case_tables.compare_tables(
                investigation_id, get_current_user(request), data.left.model_dump(), data.right.model_dump(), data.key_column
            )
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/items/promote", response_model=list[ItemResponse])
async def promote_tables(investigation_id: UUID, data: TablePromoteRequest, request: Request):
    """Promotes tables (or the latest run of queries) to the graph or to
    enrichment in one go: each gets ``mapping.as`` with a spec over its columns."""
    try:
        return agent_view(
            await case_tables.promote(investigation_id, get_current_user(request), data.item_ids, data.as_, data.options)
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.get("/{investigation_id}/items/{item_id}", response_model=ItemResponse)
async def get_item(investigation_id: UUID, item_id: UUID, request: Request):
    try:
        return agent_view(await case_items.get_item(investigation_id, get_current_user(request), item_id))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.patch("/{investigation_id}/items/{item_id}", response_model=ItemResponse)
async def update_item(investigation_id: UUID, item_id: UUID, data: ItemUpdate, request: Request):
    try:
        return agent_view(
            await case_items.update_item(
                investigation_id, get_current_user(request), item_id, data.model_dump(exclude_unset=True)
            )
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.delete("/{investigation_id}/items/{item_id}")
async def delete_item(investigation_id: UUID, item_id: UUID, request: Request):
    user_email = get_current_user(request)
    try:
        meta = await case_items.delete_item(investigation_id, user_email, item_id)
    except service.InvestigationError as exc:
        raise _http(exc)
    await _record(user_email, AuditAction.INVESTIGATION_ITEM_REMOVE, investigation_id, item_id=str(item_id), **meta)
    return {"status": "deleted"}


@router.get("/{investigation_id}/items/{item_id}/versions", response_model=list[ItemVersionResponse])
async def list_versions(investigation_id: UUID, item_id: UUID, request: Request):
    try:
        return await case_items.list_versions(investigation_id, get_current_user(request), item_id)
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/items/{item_id}/versions", response_model=ItemResponse, status_code=201)
async def add_version(investigation_id: UUID, item_id: UUID, request: Request):
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
    return agent_view(item)


@router.get("/{investigation_id}/items/{item_id}/content")
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


@router.get("/{investigation_id}/items/{item_id}/text", response_model=ItemTextResponse)
async def get_text(investigation_id: UUID, item_id: UUID, request: Request, version: Optional[int] = None):
    """The text extraction of a version (null when the format has none); masked for agents."""
    try:
        text, meta = await case_items.get_text(investigation_id, get_current_user(request), item_id, version)
    except service.InvestigationError as exc:
        raise _http(exc)
    return agent_view({"text": text, "version": meta})


@router.post("/{investigation_id}/items/{item_id}/pin", response_model=ItemVersionResponse)
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
    response_model=ItemResponse,
    dependencies=[Depends(forbid_agents)],
)
async def reject_item(investigation_id: UUID, item_id: UUID, request: Request):
    try:
        return await case_items.set_status(investigation_id, get_current_user(request), item_id, "rejected")
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/items/{item_id}/run", response_model=ItemResponse)
async def run_query(investigation_id: UUID, item_id: UUID, data: ItemRunRequest, request: Request):
    """Executes a saved query (05 §1) and stores the result as a version with ``run``."""
    try:
        return agent_view(
            await case_queries.run_query(
                investigation_id, get_current_user(request), item_id, data.parameters, data.row_limit
            )
        )
    except service.InvestigationError as exc:
        raise _http(exc)


# ---------------------------------------------------------------------------
# Annotations
# ---------------------------------------------------------------------------


@router.get("/{investigation_id}/annotations", response_model=list[AnnotationResponse])
async def list_annotations(
    investigation_id: UUID,
    request: Request,
    kind: Optional[str] = None,
    status: Optional[str] = None,
    target: Optional[str] = None,
):
    try:
        return agent_view(
            await case_annotations.list_annotations(
                investigation_id, get_current_user(request), kind, status, target
            )
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/annotations", response_model=AnnotationResponse, status_code=201)
async def create_annotation(investigation_id: UUID, data: AnnotationCreate, request: Request):
    try:
        return agent_view(
            await case_annotations.create_annotation(
                investigation_id, get_current_user(request), data.kind, data.targets, data.value, data.reason
            )
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.patch("/{investigation_id}/annotations/{annotation_id}", response_model=AnnotationResponse)
async def update_annotation(
    investigation_id: UUID, annotation_id: UUID, data: AnnotationUpdate, request: Request
):
    try:
        return agent_view(
            await case_annotations.update_annotation(
                investigation_id, get_current_user(request), annotation_id, data.model_dump(exclude_unset=True)
            )
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.delete("/{investigation_id}/annotations/{annotation_id}")
async def delete_annotation(investigation_id: UUID, annotation_id: UUID, request: Request):
    try:
        await case_annotations.delete_annotation(investigation_id, get_current_user(request), annotation_id)
    except service.InvestigationError as exc:
        raise _http(exc)
    return {"status": "deleted"}


@router.post(
    "/{investigation_id}/annotations/{annotation_id}/confirm",
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


# ---------------------------------------------------------------------------
# Graph, analyses, journal, brief, search
# ---------------------------------------------------------------------------


@router.get("/{investigation_id}/graph")
async def get_graph(investigation_id: UUID, request: Request, item_id: Optional[str] = None):
    """The unified case graph (identity keys and confirmed same_as applied), or
    one item's with ``item_id``. Masked for agents."""
    try:
        graph = await case_graph(investigation_id, get_current_user(request), item_id)
    except service.InvestigationError as exc:
        raise _http(exc)
    secrets = graph.pop("secrets", frozenset())
    return agent_view(graph, secrets)


@router.get("/{investigation_id}/items/{item_id}/snapshot")
async def get_item_snapshot(investigation_id: UUID, item_id: UUID, request: Request):
    """What one graph item puts on the canvas (snapshot, identity keys, edge
    semantics); the browser unifies these with ``unifyGraph.ts``."""
    from graphlagoon.services.case_graph import is_graph_item, item_snapshot
    from graphlagoon.services.case_items import _context_readable, item_row

    user_email = get_current_user(request)
    try:
        async with service._session() as session:
            inv = await service.load_case(session, investigation_id, user_email)
            item = await item_row(session, investigation_id, item_id)
            if not is_graph_item(item):
                raise service.InvestigationError(422, "NOT_A_GRAPH_ITEM", "This item puts nothing on the canvas")
            if not await _context_readable(item.context_id, user_email):
                raise service.InvestigationError(403, "SOURCE_RESTRICTED", "You don't have access to this item's context")
            return agent_view(await item_snapshot(session, inv, item, user_email))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/analysis/trace")
async def analysis_trace(investigation_id: UUID, data: TraceRequest, request: Request):
    try:
        return agent_view(await run_case_trace(investigation_id, get_current_user(request), data))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/analysis/paths")
async def analysis_paths(investigation_id: UUID, data: PathsRequest, request: Request):
    try:
        return agent_view(await run_case_paths(investigation_id, get_current_user(request), data))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/analysis/typologies")
async def analysis_typologies(investigation_id: UUID, data: TypologiesRequest, request: Request):
    """Typology badges (CC 4.001): suggestions only; a person confirms them as annotations."""
    try:
        return agent_view(
            await run_case_typologies(investigation_id, get_current_user(request), data.typologies, data.params)
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/analysis/er", response_model=list[AnnotationResponse])
async def analysis_er(investigation_id: UUID, request: Request):
    """Entity resolution on the unified graph: new pairs become ``same_as``
    annotations, suggested (a person confirms them in the inspector)."""
    from graphlagoon.services.entity_resolution import suggest

    user_email = get_current_user(request)
    try:
        graph = await case_graph(investigation_id, user_email)
        known = {
            tuple(a["targets"])
            for a in await case_annotations.list_annotations(investigation_id, user_email, "same_as")
        }
        created = []
        for match in suggest(graph["nodes"]):
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
        return agent_view(created, graph.get("secrets", frozenset()))
    except service.InvestigationError as exc:
        raise _http(exc)


async def _suggest(investigation_id: UUID, row: dict) -> dict:
    """Entity-resolution hits are suggestions whoever ran them (05 §4b)."""
    async with service._session() as session:
        a = await service.get_row(session, case_annotations.TABLE, row["id"])
        await service.update_row(session, case_annotations.TABLE, a, status="suggested")
        await service.commit(session)
        return case_annotations.serialize(a)


@router.get("/{investigation_id}/events", response_model=list[InvestigationEventResponse])
async def list_events(
    investigation_id: UUID,
    request: Request,
    after: Optional[UUID] = None,
    limit: int = Query(100, ge=1, le=500),
):
    try:
        return agent_view(
            await service.list_events(investigation_id, get_current_user(request), after, limit)
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.post("/{investigation_id}/events", response_model=InvestigationEventResponse, status_code=201)
async def post_event(investigation_id: UUID, data: InvestigationEventCreate, request: Request):
    try:
        return await service.post_client_event(
            investigation_id, get_current_user(request), data.kind, data.payload
        )
    except service.InvestigationError as exc:
        raise _http(exc)


@router.get("/{investigation_id}/brief", response_model=BriefResponse)
async def get_brief(investigation_id: UUID, request: Request):
    try:
        return agent_view(await case_items.get_brief(investigation_id, get_current_user(request)))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.put("/{investigation_id}/brief", response_model=BriefResponse)
async def put_brief(investigation_id: UUID, data: BriefUpdate, request: Request):
    """The single ``document/brief`` item: a new version per save (05 §6)."""
    try:
        return agent_view(await case_items.put_brief(investigation_id, get_current_user(request), data.text))
    except service.InvestigationError as exc:
        raise _http(exc)


@router.get("/{investigation_id}/search", response_model=list[ItemSearchHit])
async def search(investigation_id: UUID, request: Request, q: str = Query(min_length=1, max_length=200)):
    try:
        return agent_view(await case_items.search(investigation_id, get_current_user(request), q))
    except service.InvestigationError as exc:
        raise _http(exc)
