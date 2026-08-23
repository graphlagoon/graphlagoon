"""Precomputed graphs, addressable by URL.

    GET    /api/graph-contexts/{context_id}/precomputed-graphs          capabilities
    GET    /api/graph-contexts/{context_id}/precomputed-graphs/{name}   resolve one
    PUT    /api/graph-contexts/{context_id}/precomputed-graphs/{name}   write one
    DELETE /api/graph-contexts/{context_id}/precomputed-graphs/{name}   remove one

Reading is gated only by access to the context — that is the whole point of the
feature. Writing and deleting need two things at once: superuser status
(GRAPH_LAGOON_SUPERUSER_EMAILS), because a precomputed graph is a published,
administered artifact rather than a personal one, *and* a resolving provider
that declares those capabilities. Most providers do not: a graph computed from a
Lakebase query has nowhere to write back to, and says so with a 405.

**There is deliberately no listing endpoint.** Entries are addressed by a name
their author chose, so nothing needs to enumerate them — and enumeration is the
one operation that does not survive scale. A directory listing is O(entries):
measured locally at ~16 µs and ~100 bytes of JSON each, so a context with a
million entries would mean a 16-second call returning a 100 MB response. Paging
would only have moved the cost around, since the Databricks Files API has no
server-side name filter to page *toward*. The collection URL answers with
capabilities — what this context can do — never with an inventory.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from graphlagoon.config import get_settings
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.models.schemas import (
    PrecomputedGraphEntry,
    PrecomputedGraphWriteRequest,
)
from graphlagoon.services import graph_codec
from graphlagoon.services.precomputed import (
    CorruptPayload,
    InvalidPrecomputedName,
    ParamError,
    PayloadTooLarge,
    PrecomputedGraphProvider,
    PrecomputedGraphRequest,
    coerce_params,
    first_match,
    get_precomputed_graph_providers,
    matching_providers,
    precomputed_graphs_enabled,
    resolve,
    validate_precomputed_name,
)
from graphlagoon.services.precomputed.resolver import (
    ProviderFailed,
    missing_requirement,
    plan_resolution,
)
from graphlagoon.utils.authz import is_superuser
from graphlagoon.utils.context_access import get_context_with_access

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/graph-contexts", tags=["precomputed-graphs"])


def _error(status: int, code: str, message: str, details: dict | None = None):
    return HTTPException(
        status_code=status,
        detail={"error": {"code": code, "message": message, "details": details or {}}},
    )


def _require_enabled() -> None:
    if not precomputed_graphs_enabled():
        raise _error(
            404,
            "PRECOMPUTED_GRAPHS_DISABLED",
            "Precomputed graphs are not enabled on this server.",
        )


def _require_superuser(user_email: str) -> None:
    """Writing and deleting a precomputed graph is a superuser-only action.

    Unlike a style preset — a few kilobytes of personal preference anyone with
    context write access can save — a precomputed graph is shared by everyone
    who reads the context, so authoring it is an administrative action rather
    than an ownership one. The context owner gets no special power here; only
    GRAPH_LAGOON_SUPERUSER_EMAILS does.
    """
    if not is_superuser(user_email):
        raise _error(
            403,
            "FORBIDDEN",
            "Creating and deleting precomputed graphs is restricted to superusers.",
        )


def _validated_name(name: str) -> str:
    """Validate the *decoded* name — uvicorn has already unescaped %2F by here."""
    try:
        return validate_precomputed_name(name)
    except InvalidPrecomputedName as exc:
        raise _error(400, "INVALID_PRECOMPUTED_NAME", str(exc)) from exc


def _raw_items(request: Request) -> list[tuple[str, str]]:
    """The query string as pairs.

    `multi_items()` rather than `dict(query_params)`: the dict form silently
    keeps the last value of a repeated key, and a value decided by luck is
    exactly what the parameter layer exists to prevent.
    """
    return list(request.query_params.multi_items())


def _base_request(
    context_id: UUID,
    name: str,
    user_email: str,
    context,
    raw_items: list[tuple[str, str]],
) -> PrecomputedGraphRequest:
    """The request every provider sees, before its own parameters are attached.

    `params` is empty here and is filled in per provider by the resolver, since
    a provider is what declares the parameters in the first place. A matcher
    therefore sees an empty `params` and a populated `raw_params`: route on
    `context_id`, `name`, or the raw strings, all of which are final by now.
    """
    return PrecomputedGraphRequest(
        context_id=context_id,
        name=name,
        params={},
        raw_params=dict(raw_items),
        user_email=user_email,
        context=context,
    )


def _single_provider_params(
    provider: PrecomputedGraphProvider | None, raw_items: list[tuple[str, str]]
) -> dict:
    """Coerce for one known provider — the write path, where there is no chain.

    A write already resolved to exactly one provider, so there is no union to
    take and an undeclared key is unambiguously wrong.
    """
    try:
        return coerce_params(provider.params if provider else [], raw_items)
    except ParamError as exc:
        raise _error(400, exc.code, exc.message, exc.details) from exc


def _storage_error(operation: str, name: str, exc: Exception) -> HTTPException:
    """Map storage and provider exceptions onto HTTP."""
    if isinstance(exc, InvalidPrecomputedName):
        return _error(400, "INVALID_PRECOMPUTED_NAME", str(exc))
    if isinstance(exc, PayloadTooLarge):
        return _error(413, "PRECOMPUTED_GRAPH_TOO_LARGE", str(exc))
    if isinstance(exc, CorruptPayload):
        return _error(502, "PRECOMPUTED_GRAPH_UNREADABLE", str(exc))
    if isinstance(exc, ProviderFailed):
        # The provider name is in the log (resolver.py logs with exc_info); the
        # response stays generic unless the deployment opted into detail.
        detail = str(exc) if get_settings().show_error_details else (
            f"The provider serving '{name}' failed. See the server log."
        )
        return _error(502, "PROVIDER_FAILED", detail, {"provider": exc.provider})
    if isinstance(exc, ValueError):
        return _error(400, "PRECOMPUTED_GRAPHS_MISCONFIGURED", str(exc))
    if isinstance(exc, PermissionError):
        return _error(403, "STORAGE_FORBIDDEN", str(exc))
    if isinstance(exc, TimeoutError):
        return _error(504, "STORAGE_TIMEOUT", str(exc))
    if isinstance(exc, (ConnectionError, OSError)):
        return _error(502, "STORAGE_UNAVAILABLE", str(exc))

    logger.error(
        "Unexpected precomputed graph %s error for '%s': %s",
        operation,
        name,
        exc,
        exc_info=True,
    )
    return _error(500, "STORAGE_ERROR", f"Precomputed graph storage error: {exc}")


def _capability_denied(
    operation: str, name: str, provider: PrecomputedGraphProvider | None
) -> HTTPException:
    """405 for a provider that resolves this name but cannot be written to.

    Raised *after* the authorization checks, so a stranger cannot probe whether
    a provider is writable.
    """
    if provider is None:
        return _error(
            404,
            "PRECOMPUTED_GRAPH_NOT_FOUND",
            f"No provider serves precomputed graphs named '{name}' for this "
            "context.",
            {"name": name},
        )
    return HTTPException(
        status_code=405,
        detail={
            "error": {
                "code": "PROVIDER_READ_ONLY",
                "message": (
                    f"The provider serving '{name}' ('{provider.name}') cannot "
                    f"{operation} precomputed graphs. Graphs it serves are "
                    "produced outside the app."
                ),
                "details": {"provider": provider.name},
            }
        },
        headers={"Allow": "GET"},
    )


async def enforce_body_limit(request: Request) -> None:
    """Reject an oversized body before Starlette materializes it.

    The provider's own size check happens after the JSON is parsed and so cannot
    stop a multi-gigabyte upload from exhausting memory first. Content-Length is
    the only signal available that early.
    """
    limit = get_settings().precomputed_graphs_max_bytes
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
            "PRECOMPUTED_GRAPH_TOO_LARGE",
            f"Request body is {length} bytes, far above the "
            f"{limit}-byte compressed limit.",
        )


@router.get("/{context_id}/precomputed-graphs")
async def get_precomputed_graph_capabilities(context_id: UUID, request: Request):
    """What this context can do with precomputed graphs.

    Deliberately not a listing: it answers "can anything here be written, and by
    which providers", so the frontend knows whether to show its write panel. It
    never enumerates entries.
    """
    _require_enabled()
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)

    providers = get_precomputed_graph_providers()
    # A capability probe cannot know the name the user will eventually ask for,
    # so it reports the union: "something here is writable". The write endpoint
    # still resolves the real provider for the real name.
    probe = _base_request(context_id, "", user_email, context, [])
    claimed = []
    for provider in providers:
        try:
            if provider.matches is None or provider.accepts(probe):
                claimed.append(provider)
        except Exception:  # noqa: BLE001 — a probing matcher must not 502 here
            logger.debug(
                "Provider '%s' matcher raised during a capability probe; "
                "treating it as claiming the context.",
                provider.name,
                exc_info=True,
            )
            claimed.append(provider)

    return {
        "enabled": True,
        "can_write": any(p.save is not None for p in claimed)
        and is_superuser(user_email),
        "can_delete": any(p.delete is not None for p in claimed)
        and is_superuser(user_email),
        "providers": [p.ui_payload() for p in claimed],
    }


@router.get("/{context_id}/precomputed-graphs/{name}")
async def get_precomputed_graph(context_id: UUID, name: str, request: Request):
    """Resolve a precomputed graph. Requires read access to the context.

    Returns the payload under `Content-Encoding: gzip`. When the resolving
    provider held encoded bytes already, they are passed through untouched:
    Starlette's GZipMiddleware forwards a body that already declares an
    encoding, so nothing decompresses or re-serializes the graph server-side.
    """
    _require_enabled()
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    validated = _validated_name(name)

    raw_items = _raw_items(request)
    base = _base_request(context_id, validated, user_email, context, raw_items)

    try:
        claimed = matching_providers(base)
    except ProviderFailed as exc:
        raise _storage_error("match", validated, exc) from exc

    # Each provider is paired with the arguments it actually declared, so a
    # chain can mix a volume that takes none with a query that takes several.
    try:
        plan = plan_resolution(claimed, raw_items)
    except ParamError as exc:
        raise _error(400, exc.code, exc.message, exc.details) from exc

    try:
        resolved = await resolve(base, plan)
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("resolve", validated, exc) from exc

    if resolved is None:
        # Every provider stood down. If one of them did so because an argument
        # it requires was not supplied, say that — answering "no such graph"
        # would send someone hunting for a name that is perfectly fine.
        stood_down = missing_requirement(claimed, raw_items)
        if stood_down is not None and not plan:
            raise _error(
                400, stood_down.code, stood_down.message, stood_down.details
            )
        raise _error(
            404,
            "PRECOMPUTED_GRAPH_NOT_FOUND",
            f"No precomputed graph named '{validated}' for this context.",
            {"name": validated},
        )

    _, result = resolved
    try:
        raw = result.to_bytes()
    except Exception as exc:
        raise _storage_error("encode", validated, exc) from exc

    encoding = graph_codec.sniff_encoding(raw)
    if encoding != "gzip":
        raise _error(
            502,
            "PRECOMPUTED_GRAPH_UNREADABLE",
            f"Precomputed graph '{validated}' is not gzip-encoded (found "
            f"{encoding or 'unknown encoding'}); it may have been written by an "
            "incompatible version, read while being overwritten, or returned by "
            "a provider using a different codec.",
        )

    return Response(
        content=raw,
        media_type="application/json",
        headers={"Content-Encoding": "gzip", "Cache-Control": "no-cache"},
    )


@router.put(
    "/{context_id}/precomputed-graphs/{name}",
    response_model=PrecomputedGraphEntry,
    dependencies=[Depends(enforce_body_limit)],
)
async def put_precomputed_graph(
    context_id: UUID,
    name: str,
    data: PrecomputedGraphWriteRequest,
    request: Request,
):
    """Publish a graph the client already holds. Superuser only, where supported."""
    _require_enabled()
    user_email = get_current_user(request)
    _require_superuser(user_email)
    context = await get_context_with_access(context_id, user_email)
    validated = _validated_name(name)

    if data.graph.properties_deferred:
        raise _error(
            400,
            "PRECOMPUTED_GRAPH_INCOMPLETE",
            "Refusing to publish a graph whose node properties are still being "
            "loaded — the entry would replay with empty properties. Wait for "
            "enrichment to finish and try again.",
        )

    raw_items = _raw_items(request)
    base = _base_request(context_id, validated, user_email, context, raw_items)
    try:
        provider = first_match(base)
    except ProviderFailed as exc:
        raise _storage_error("match", validated, exc) from exc

    if provider is None or provider.save is None:
        raise _capability_denied("write", validated, provider)

    write_request = replace(
        base, params=_single_provider_params(provider, raw_items)
    )

    try:
        return await provider.save(write_request, data.graph, data.source)
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("save", validated, exc) from exc


@router.delete("/{context_id}/precomputed-graphs/{name}", status_code=204)
async def delete_precomputed_graph(context_id: UUID, name: str, request: Request):
    """Delete a precomputed graph. Superuser only, where the provider supports it.

    A precomputed graph is shared, so removing one affects every viewer, and
    (unlike a style preset) authoring one is not tied to context ownership in
    the first place.
    """
    _require_enabled()
    user_email = get_current_user(request)
    _require_superuser(user_email)
    context = await get_context_with_access(context_id, user_email)
    validated = _validated_name(name)

    raw_items = _raw_items(request)
    base = _base_request(context_id, validated, user_email, context, raw_items)
    try:
        provider = first_match(base)
    except ProviderFailed as exc:
        raise _storage_error("match", validated, exc) from exc

    if provider is None or provider.delete is None:
        raise _capability_denied("delete", validated, provider)

    delete_request = replace(
        base, params=_single_provider_params(provider, raw_items)
    )

    try:
        await provider.delete(delete_request)
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("delete", validated, exc) from exc

    return Response(status_code=204)
