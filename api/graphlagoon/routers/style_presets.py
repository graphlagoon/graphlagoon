"""Named style presets — how a context's graph looks, applied by URL.

    GET    /api/graph-contexts/{context_id}/style-presets          list them
    GET    /api/graph-contexts/{context_id}/style-presets/{name}   read one
    PUT    /api/graph-contexts/{context_id}/style-presets/{name}   create/update
    DELETE /api/graph-contexts/{context_id}/style-presets/{name}   remove one

Unlike precomputed graphs, this **is** listable and **is** writable in production.
Both differences follow from what a preset is: a few kilobytes of hand-authored
presentation settings. There are a handful per context, choosing one means
seeing what exists, and the count is bounded at write time rather than paginated
at read time.

Authorization has three levels, which is one more than anywhere else here:
reading needs access to the context, writing needs *write* access to it, and
deleting needs to be the person who created that particular preset (or a
superuser). Ownership is per preset rather than per context so one person's
saved look cannot be thrown away by another.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request

from graphlagoon.middleware.auth import get_current_user
from graphlagoon.models.schemas import (
    StylePreset,
    StylePresetListResponse,
    StylePresetWriteRequest,
)
from graphlagoon.services import style_presets as style_presets_service
from graphlagoon.services.named_store import InvalidArtifactName
from graphlagoon.services.style_presets import (
    CorruptPreset,
    PresetTooLarge,
    StylePresetService,
    TooManyPresets,
    get_style_preset_service,
    style_presets_enabled,
    validate_preset_name,
)
from graphlagoon.services import audit
from graphlagoon.services.audit import AuditAction
from graphlagoon.utils.authz import can_manage, can_write, is_superuser
from graphlagoon.utils.context_access import get_context_with_access

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/graph-contexts", tags=["style-presets"])


def _error(status: int, code: str, message: str, details: dict | None = None):
    return HTTPException(
        status_code=status,
        detail={"error": {"code": code, "message": message, "details": details or {}}},
    )


def _require_enabled() -> None:
    if not style_presets_enabled():
        raise _error(
            404,
            "STYLE_PRESETS_DISABLED",
            "Style presets are not enabled on this server.",
        )


def _validated_name(name: str) -> str:
    """Validate the *decoded* name — uvicorn has already unescaped %2F by here."""
    try:
        return validate_preset_name(name)
    except InvalidArtifactName as exc:
        raise _error(400, "INVALID_PRESET_NAME", str(exc)) from exc


def _service() -> StylePresetService:
    try:
        return get_style_preset_service()
    except ValueError as exc:
        raise _error(400, "STYLE_PRESETS_MISCONFIGURED", str(exc)) from exc


def _storage_error(operation: str, name: str, exc: Exception) -> HTTPException:
    """Map storage exceptions onto HTTP, as the precomputed graph router does."""
    if isinstance(exc, InvalidArtifactName):
        return _error(400, "INVALID_PRESET_NAME", str(exc))
    if isinstance(exc, TooManyPresets):
        return _error(409, "TOO_MANY_PRESETS", str(exc))
    if isinstance(exc, PresetTooLarge):
        return _error(413, "PRESET_TOO_LARGE", str(exc))
    if isinstance(exc, CorruptPreset):
        return _error(502, "PRESET_UNREADABLE", str(exc))
    if isinstance(exc, ValueError):
        return _error(400, "STYLE_PRESETS_MISCONFIGURED", str(exc))
    if isinstance(exc, PermissionError):
        return _error(403, "STORAGE_FORBIDDEN", str(exc))
    if isinstance(exc, TimeoutError):
        return _error(504, "STORAGE_TIMEOUT", str(exc))
    if isinstance(exc, (ConnectionError, OSError)):
        return _error(502, "STORAGE_UNAVAILABLE", str(exc))

    logger.error(
        "Unexpected style preset %s error for '%s': %s", operation, name, exc,
        exc_info=True,
    )
    return _error(500, "STORAGE_ERROR", f"Style preset storage error: {exc}")


async def enforce_body_limit(request: Request) -> None:
    """Reject an oversized body before Starlette materializes it.

    Mirrors precomputed_graphs.py's guard: the handler's own check happens after
    Pydantic has already parsed the whole JSON body (and `StylePresetSettings`
    allows arbitrary extra keys), so a multi-gigabyte payload would be fully
    buffered and decoded before ever hitting the post-compression limit.
    Content-Length is the only signal available that early.
    """
    limit = style_presets_service.MAX_PRESET_BYTES
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
            "PRESET_TOO_LARGE",
            f"Request body is {length} bytes, far above the "
            f"{limit}-byte compressed preset limit.",
        )


def _require_context_write(context, user_email: str) -> None:
    """Writing a preset needs write access to the context it belongs to.

    Same predicate query_templates.py uses — owner, a write-level share, or a
    superuser. `has_write_access` exists only on the API response model, never on
    the context object this receives.
    """
    if not can_write(context.owner_email, context.shares, user_email):
        raise _error(
            403,
            "FORBIDDEN",
            "You need write access to this context to save a style preset.",
        )


@router.get("/{context_id}/style-presets", response_model=StylePresetListResponse)
async def list_style_presets(context_id: UUID, request: Request):
    """List this context's presets. Requires read access to the context."""
    _require_enabled()
    user_email = get_current_user(request)
    await get_context_with_access(context_id, user_email)

    try:
        return StylePresetListResponse(presets=await _service().list(context_id))
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("list", str(context_id), exc) from exc


@router.get("/{context_id}/style-presets/{name}", response_model=StylePreset)
async def get_style_preset(context_id: UUID, name: str, request: Request):
    """Read one preset. Requires read access to the context."""
    _require_enabled()
    user_email = get_current_user(request)
    await get_context_with_access(context_id, user_email)
    validated = _validated_name(name)

    try:
        preset = await _service().load(context_id, validated)
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("load", validated, exc) from exc

    if preset is None:
        raise _error(
            404,
            "STYLE_PRESET_NOT_FOUND",
            f"No style preset named '{validated}' for this context.",
            {"name": validated},
        )
    return preset


@router.put(
    "/{context_id}/style-presets/{name}",
    response_model=StylePreset,
    dependencies=[Depends(enforce_body_limit)],
)
async def put_style_preset(
    context_id: UUID,
    name: str,
    data: StylePresetWriteRequest,
    request: Request,
):
    """Create or update a preset. Requires write access to the context.

    Overwriting keeps the original author: a preset is a named slot, and whoever
    created it stays the one who can delete it.
    """
    _require_enabled()
    user_email = get_current_user(request)
    context = await get_context_with_access(context_id, user_email)
    _require_context_write(context, user_email)
    validated = _validated_name(name)

    try:
        return await _service().save(
            context_id,
            validated,
            settings=data.settings,
            created_by=user_email,
            description=data.description,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("save", validated, exc) from exc


@router.delete("/{context_id}/style-presets/{name}", status_code=204)
async def delete_style_preset(context_id: UUID, name: str, request: Request):
    """Delete a preset. Only its creator — or a superuser — may do so.

    Ownership lives inside the stored file, so this reads the preset before
    deleting it. That is one extra round trip, and the reason the listing does
    not report owners: doing it there would cost one request per preset.
    """
    _require_enabled()
    user_email = get_current_user(request)
    await get_context_with_access(context_id, user_email)
    validated = _validated_name(name)
    service = _service()

    try:
        preset = await service.load(context_id, validated)
    except HTTPException:
        raise
    except CorruptPreset:
        # An unreadable preset has no discoverable owner. Refusing to delete it
        # would strand it forever, so a superuser is allowed to clear it out.
        if not is_superuser(user_email):
            raise _error(
                403,
                "FORBIDDEN",
                f"Style preset '{validated}' is unreadable, so its owner cannot be "
                "determined. Only a superuser can remove it.",
            ) from None
        preset = None
    except Exception as exc:
        raise _storage_error("load", validated, exc) from exc

    if preset is not None and not can_manage(preset.created_by, user_email):
        raise _error(
            403,
            "FORBIDDEN",
            f"Style preset '{validated}' was created by {preset.created_by}. "
            "Only its creator can delete it.",
            {"created_by": preset.created_by},
        )

    try:
        await service.delete(context_id, validated)
    except HTTPException:
        raise
    except Exception as exc:
        raise _storage_error("delete", validated, exc) from exc

    await audit.record(
        user_email,
        AuditAction.PRESET_DELETE,
        resource_type="graph_context",
        resource_id=context_id,
        metadata={
            "name": validated,
            "created_by": preset.created_by if preset is not None else None,
        },
    )
