"""Named graph caches, addressable by URL.

    GET    /api/graph-contexts/{context_id}/graph-cache/{name}   replay one
    PUT    /api/graph-contexts/{context_id}/graph-cache/{name}   write one   (dev only)
    DELETE /api/graph-contexts/{context_id}/graph-cache/{name}   remove one  (dev only)

Reading is gated only by access to the context — that is the whole point of the
feature. Creating and deleting through the API additionally requires dev mode;
in production, entries reach the volume through an external process.

**There is deliberately no listing endpoint.** Entries are addressed by a name
their author chose, so nothing needs to enumerate them — and enumeration is the
one operation that does not survive scale. A directory listing is O(entries):
measured locally at ~16 µs and ~100 bytes of JSON each, so a context with a
million entries would mean a 16-second call returning a 100 MB response. Paging
that would only have moved the cost around, since the Databricks Files API has
no server-side name filter to page *toward*. Not offering it is the only answer
that stays correct at every size.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from graphlagoon.config import get_settings
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.models.schemas import GraphCacheEntry, GraphCacheWriteRequest
from graphlagoon.services import graph_codec
from graphlagoon.services.graph_cache import (
    CacheTooLarge,
    CorruptCacheEntry,
    GraphCacheService,
    InvalidCacheName,
    get_graph_cache_service,
    graph_cache_enabled,
    graph_cache_writable,
    validate_cache_name,
)
from graphlagoon.utils.authz import can_manage
from graphlagoon.utils.context_access import get_context_with_access

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/graph-contexts", tags=["graph-cache"])


def _error(status: int, code: str, message: str, details: dict | None = None):
    return HTTPException(
        status_code=status,
        detail={"error": {"code": code, "message": message, "details": details or {}}},
    )


def _require_enabled() -> None:
    if not graph_cache_enabled():
        raise _error(
            404,
            "GRAPH_CACHE_DISABLED",
            "The graph cache is not enabled on this server.",
        )


def _require_writable() -> None:
    """Writes are dev-only, mirroring /api/dev/* in routers/graph.py."""
    if not graph_cache_writable():
        raise _error(
            403,
            "FORBIDDEN",
            "Creating and deleting graph caches is only available in dev mode.",
        )


def _validated_name(name: str) -> str:
    """Validate the *decoded* name — uvicorn has already unescaped %2F by here."""
    try:
        return validate_cache_name(name)
    except InvalidCacheName as exc:
        raise _error(400, "INVALID_CACHE_NAME", str(exc)) from exc


def _service() -> GraphCacheService:
    try:
        return get_graph_cache_service()
    except ValueError as exc:
        raise _error(400, "GRAPH_CACHE_MISCONFIGURED", str(exc)) from exc


def _storage_error(operation: str, name: str, exc: Exception) -> HTTPException:
    """Map storage exceptions onto HTTP, as _persist_snapshot does for snapshots."""
    if isinstance(exc, InvalidCacheName):
        return _error(400, "INVALID_CACHE_NAME", str(exc))
    if isinstance(exc, CacheTooLarge):
        return _error(413, "CACHE_TOO_LARGE", str(exc))
    if isinstance(exc, CorruptCacheEntry):
        return _error(502, "CACHE_UNREADABLE", str(exc))
    if isinstance(exc, ValueError):
        return _error(400, "GRAPH_CACHE_MISCONFIGURED", str(exc))
    if isinstance(exc, PermissionError):
        return _error(403, "STORAGE_FORBIDDEN", str(exc))
    if isinstance(exc, TimeoutError):
        return _error(504, "STORAGE_TIMEOUT", str(exc))
    if isinstance(exc, (ConnectionError, OSError)):
        return _error(502, "STORAGE_UNAVAILABLE", str(exc))

    logger.error(
        "Unexpected graph cache %s error for '%s': %s", operation, name, exc,
        exc_info=True,
    )
    return _error(500, "STORAGE_ERROR", f"Graph cache storage error: {exc}")


async def enforce_body_limit(request: Request) -> None:
    """Reject an oversized body before Starlette materializes it.

    The handler's own size check happens after the JSON is parsed and so cannot
    stop a multi-gigabyte upload from exhausting memory first. Content-Length is
    the only signal available that early.
    """
    limit = get_settings().graph_cache_max_bytes
    raw_length = request.headers.get("content-length")
    if raw_length is None:
        return
    try:
        length = int(raw_length)
    except ValueError:
        return
    # The body is uncompressed JSON while the limit applies to the compressed
    # entry, so allow generous headroom here and let the real check run on the
    # compressed bytes.
    if length > limit * 10:
        raise _error(
            413,
            "CACHE_TOO_LARGE",
            f"Request body is {length} bytes, far above the "
            f"{limit}-byte compressed cache limit.",
        )


@router.get("/{context_id}/graph-cache/{name}")
async def get_graph_cache(context_id: UUID, name: str, request: Request):
    """Replay a cached graph. Requires read access to the context.

    Returns the stored bytes untouched under `Content-Encoding: gzip`. Starlette's
    GZipMiddleware forwards a body that already declares an encoding, so nothing
    decompresses or re-serializes the graph server-side; the browser unpacks it.
    """
    _require_enabled()
    user_email = get_current_user(request)
    await get_context_with_access(context_id, user_email)
    validated = _validated_name(name)

    try:
        raw = await _service().load_raw(context_id, validated)
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("load", validated, exc) from exc

    if raw is None:
        raise _error(
            404,
            "GRAPH_CACHE_NOT_FOUND",
            f"No cached graph named '{validated}' for this context.",
            {"name": validated},
        )

    encoding = graph_codec.sniff_encoding(raw)
    if encoding != "gzip":
        raise _error(
            502,
            "CACHE_UNREADABLE",
            f"Cache entry '{validated}' is not gzip-encoded (found "
            f"{encoding or 'unknown encoding'}); it may have been written by an "
            "incompatible version or read while being overwritten.",
        )

    return Response(
        content=raw,
        media_type="application/json",
        headers={"Content-Encoding": "gzip", "Cache-Control": "no-cache"},
    )


@router.put(
    "/{context_id}/graph-cache/{name}",
    response_model=GraphCacheEntry,
    dependencies=[Depends(enforce_body_limit)],
)
async def put_graph_cache(
    context_id: UUID,
    name: str,
    data: GraphCacheWriteRequest,
    request: Request,
):
    """Write a cache entry from a graph the client already holds. Dev mode only."""
    _require_enabled()
    user_email = get_current_user(request)
    _require_writable()
    await get_context_with_access(context_id, user_email)
    validated = _validated_name(name)

    if data.graph.properties_deferred:
        raise _error(
            400,
            "CACHE_INCOMPLETE",
            "Refusing to cache a graph whose node properties are still being "
            "loaded — the entry would replay with empty properties. Wait for "
            "enrichment to finish and try again.",
        )

    try:
        return await _service().save(
            context_id,
            validated,
            graph=data.graph,
            source=data.source,
            created_by=user_email,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("save", validated, exc) from exc


@router.delete("/{context_id}/graph-cache/{name}", status_code=204)
async def delete_graph_cache(context_id: UUID, name: str, request: Request):
    """Delete a cache entry. Dev mode only, and only for someone who can manage
    the context — a cache is shared, so removing one affects every viewer."""
    _require_enabled()
    user_email = get_current_user(request)
    _require_writable()
    context = await get_context_with_access(context_id, user_email)
    validated = _validated_name(name)

    if not can_manage(context.owner_email, user_email):
        raise _error(
            403,
            "FORBIDDEN",
            "Only the context owner can delete a cached graph.",
        )

    try:
        await _service().delete(context_id, validated)
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("delete", validated, exc) from exc

    return Response(status_code=204)
