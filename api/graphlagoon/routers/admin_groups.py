"""Admin API for permission groups and rules.

A sibling of ``routers.admin`` (NOT nested inside it: FastAPI 0.139's lazy
``_IncludedRouter`` would hide nested routes from ``router.routes``, breaking
the registry introspection tests — see
docs/dev/gotchas: fastapi_lazy_included_router). Same ``/api/admin`` prefix
and the same router-level ``require_superuser`` gate, walked by
``tests/test_admin_groups.py``. Handlers are thin wrappers over
``services.groups`` / ``services.permissions``; every mutation writes an
audit entry (``routers/admin_registry.AUDITED_ROUTES``).
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from graphlagoon.models.schemas import (
    AdminGroupIn,
    AdminGroupOut,
    AdminGroupsResponse,
    AdminPermissionOut,
    AdminPermissionsResponse,
    AdminPermissionUpdate,
    GroupCacheRefreshRequest,
    PermissionInspection,
    ResolverStatus,
)
from graphlagoon.services import audit
from graphlagoon.services import groups as groups_service
from graphlagoon.services.audit import AuditAction
from graphlagoon.services.group_resolution import get_group_resolver
from graphlagoon.services.permission_catalog import PERMISSION_IDS, PERMISSIONS
from graphlagoon.services.permissions import inspect_user
from graphlagoon.utils.authz import require_superuser

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(require_superuser)],
)


def _error(status: int, code: str, message: str, details: dict | None = None):
    return HTTPException(
        status_code=status,
        detail={"error": {"code": code, "message": message, "details": details or {}}},
    )


def _resolver_status() -> ResolverStatus:
    return ResolverStatus(**get_group_resolver().status())


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------


@router.get("/groups", response_model=AdminGroupsResponse)
async def list_groups():
    """All permission groups, plus the membership resolver's health."""
    items = await groups_service.list_groups()
    return AdminGroupsResponse(
        items=[AdminGroupOut(**g) for g in items], resolver=_resolver_status()
    )


@router.post("/groups", response_model=AdminGroupOut, status_code=201)
async def create_group(
    data: AdminGroupIn, admin_email: str = Depends(require_superuser)
):
    """Create a group (members: emails and/or Databricks group names)."""
    try:
        group = await groups_service.create_group(
            data.name, data.description, [m.model_dump() for m in data.members]
        )
    except groups_service.GroupNameTaken as exc:
        raise _error(400, "GROUP_NAME_TAKEN", exc.message)
    except groups_service.InvalidMember as exc:
        raise _error(400, "INVALID_MEMBER", exc.message)
    await audit.record(
        admin_email,
        AuditAction.GROUP_CREATE,
        resource_type="group",
        resource_id=UUID(group["id"]),
        metadata={"name": group["name"], "members": len(group["members"])},
    )
    return AdminGroupOut(**group)


@router.put("/groups/{group_id}", response_model=AdminGroupOut)
async def update_group(
    group_id: UUID,
    data: AdminGroupIn,
    admin_email: str = Depends(require_superuser),
):
    """Full replacement of a group's name, description and members."""
    try:
        group = await groups_service.update_group(
            group_id, data.name, data.description, [m.model_dump() for m in data.members]
        )
    except groups_service.GroupNotFound as exc:
        raise _error(404, "GROUP_NOT_FOUND", exc.message)
    except groups_service.GroupNameTaken as exc:
        raise _error(400, "GROUP_NAME_TAKEN", exc.message)
    except groups_service.InvalidMember as exc:
        raise _error(400, "INVALID_MEMBER", exc.message)
    await audit.record(
        admin_email,
        AuditAction.GROUP_UPDATE,
        resource_type="group",
        resource_id=group_id,
        metadata={"name": group["name"], "members": len(group["members"])},
    )
    return AdminGroupOut(**group)


@router.delete("/groups/{group_id}")
async def delete_group(
    group_id: UUID, admin_email: str = Depends(require_superuser)
):
    """Delete a group; its permission rules cascade away with it."""
    try:
        deleted = await groups_service.delete_group(group_id)
    except groups_service.GroupNotFound as exc:
        raise _error(404, "GROUP_NOT_FOUND", exc.message)
    await audit.record(
        admin_email,
        AuditAction.GROUP_DELETE,
        resource_type="group",
        resource_id=group_id,
        metadata={
            "name": deleted["name"],
            "rules_removed": deleted.get("rules_removed", 0),
        },
    )
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


def _permission_out(perm, config: dict) -> AdminPermissionOut:
    stored = config.get(perm.id) or {"mode": "everyone", "rules": []}
    return AdminPermissionOut(
        id=perm.id,
        label=perm.label,
        description=perm.description,
        mode=stored["mode"],
        rules=stored["rules"],
    )


@router.get("/permissions", response_model=AdminPermissionsResponse)
async def list_permissions():
    """The full catalog, merged with stored modes/rules (absent ⇒ everyone)."""
    config = await groups_service.get_permissions_config()
    return AdminPermissionsResponse(
        items=[
            _permission_out(perm, config)
            for perm in sorted(PERMISSIONS, key=lambda p: p.id)
        ],
        resolver=_resolver_status(),
    )


@router.put("/permissions/{permission_id}", response_model=AdminPermissionOut)
async def update_permission(
    permission_id: str,
    data: AdminPermissionUpdate,
    admin_email: str = Depends(require_superuser),
):
    """Full replacement of one permission's mode and rules."""
    if permission_id not in PERMISSION_IDS:
        raise _error(
            404,
            "PERMISSION_UNKNOWN",
            f"{permission_id!r} is not in the permission catalog.",
        )
    try:
        await groups_service.set_permission(
            permission_id,
            data.mode,
            [
                {"group_id": UUID(r.group_id), "effect": r.effect}
                for r in data.rules
            ],
        )
    except groups_service.GroupNotFound as exc:
        raise _error(400, "GROUP_NOT_FOUND", exc.message)
    await audit.record(
        admin_email,
        AuditAction.PERMISSION_UPDATE,
        resource_type="permission",
        metadata={
            "permission": permission_id,
            "mode": data.mode,
            "rules": len(data.rules),
        },
    )
    config = await groups_service.get_permissions_config()
    perm = next(p for p in PERMISSIONS if p.id == permission_id)
    return _permission_out(perm, config)


@router.get("/permissions/inspect", response_model=PermissionInspection)
async def inspect_permissions(email: str = Query(..., min_length=3)):
    """Effective permissions for one user, with the matched rule and the
    Databricks membership resolution — the "why can't they?" answer."""
    return PermissionInspection(**await inspect_user(email))


@router.post("/groups/resolution/refresh", response_model=ResolverStatus)
async def refresh_group_resolution(data: GroupCacheRefreshRequest):
    """Drop the SCIM membership cache (one email, or all of it)."""
    await get_group_resolver().refresh(data.email)
    return _resolver_status()
