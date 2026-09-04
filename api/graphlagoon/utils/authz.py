"""Authorization predicates combining ownership, shares, and superuser status.

Superusers are configured via GRAPH_LAGOON_SUPERUSER_EMAILS (comma-separated,
case-insensitive) and bypass ownership/share checks everywhere. They do NOT
bypass share-target validation (allowed_share_domains).
"""

from fastapi import HTTPException, Request

from graphlagoon.config import get_settings
from graphlagoon.utils.sharing import user_has_share_access, user_has_write_access


def is_superuser(user_email: str) -> bool:
    """Check if user_email is in the configured superuser list (case-insensitive)."""
    if not user_email:
        return False
    return user_email.strip().lower() in get_settings().superuser_email_list


def can_manage(owner_email: str, user_email: str) -> bool:
    """Owner-level power: delete, share, unshare. Owner or superuser."""
    return owner_email == user_email or is_superuser(user_email)


def can_write(owner_email: str, shares: list, user_email: str) -> bool:
    """Write power: owner, write-share, or superuser."""
    return (
        owner_email == user_email
        or user_has_write_access(user_email, shares)
        or is_superuser(user_email)
    )


def can_read(owner_email: str, shares: list, user_email: str) -> bool:
    """Read power: owner, any share, or superuser."""
    return (
        owner_email == user_email
        or user_has_share_access(user_email, shares)
        or is_superuser(user_email)
    )


def require_permission(permission_id: str):
    """Dependency factory: 403 ``PERMISSION_DENIED`` unless the caller holds
    the catalog permission. Use it where the route IS the capability::

        @router.post("", ...)
        async def create_graph_context(
            user_email: str = Depends(require_permission("context.create")),
        ): ...

    Resolves the catalog entry at import time so a typo'd id fails app
    startup, not the first request (tests/test_admin_registry.py also walks
    router sources for unknown ids). Existing ownership/share checks remain
    separate AND-gates — this one is about *who may do the action at all*.
    """
    from graphlagoon.services.permission_catalog import get_permission

    perm = get_permission(permission_id)

    async def dependency(request: Request) -> str:
        from graphlagoon.middleware.auth import get_current_user
        from graphlagoon.services.permissions import check_permission

        user_email = get_current_user(request)
        decision = await check_permission(user_email, perm.id)
        if not decision.allowed:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": {
                        "code": "PERMISSION_DENIED",
                        "message": (
                            f'You do not have the "{perm.label}" permission. '
                            "Ask an administrator to add you to a group that "
                            "allows it."
                        ),
                        "details": {
                            "permission": perm.id,
                            "reason": decision.reason,
                        },
                    }
                },
            )
        return user_email

    return dependency


def require_superuser(request: Request) -> str:
    """FastAPI dependency: the current user's email, or 403 if not a superuser.

    Resolves identity through ``get_current_user`` (not ``request.state``)
    because a mounted deployment may run without ``AuthMiddleware`` and tests
    mount routers bare. Use it as a router-level dependency so no handler can
    forget the gate::

        router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_superuser)])
    """
    from graphlagoon.middleware.auth import get_current_user

    user_email = get_current_user(request)
    if not is_superuser(user_email):
        raise HTTPException(
            status_code=403,
            detail={
                "error": {
                    "code": "FORBIDDEN",
                    "message": "This action is restricted to superusers.",
                    "details": {},
                }
            },
        )
    return user_email
