from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from typing import Callable, Optional, Union
from collections.abc import Awaitable
import inspect

from graphlagoon.config import get_settings

DEV_DEFAULT_EMAIL = "dev@graphlagoon.local"

# Type for custom user provider: sync or async callable that takes Request and returns email
UserProvider = Callable[[Request], Union[str, Awaitable[str]]]

# Global user provider (set by configure_auth)
_user_provider: Optional[UserProvider] = None


def configure_auth(user_provider: Optional[UserProvider] = None) -> None:
    """Configure authentication with optional custom user provider.

    When mounting graphlagoon in an existing FastAPI app that already has auth,
    use this to tell graphlagoon how to extract the user email from requests.

    Args:
        user_provider: Callable that extracts user email from request.
                      Can be sync or async. Called for each request.

    Example:
        # Use existing user from parent app's middleware
        def get_user_from_parent_auth(request: Request) -> str:
            return request.state.current_user.email

        configure_auth(user_provider=get_user_from_parent_auth)

        # Or async version
        async def get_user_async(request: Request) -> str:
            user = await get_user_from_token(request.headers.get("Authorization"))
            return user.email

        configure_auth(user_provider=get_user_async)
    """
    global _user_provider
    _user_provider = user_provider


def get_user_provider() -> Optional[UserProvider]:
    """Get the configured user provider."""
    return _user_provider


# Headers to check for user email (in order of priority)
EMAIL_HEADERS = [
    "x-forwarded-email",  # Used by Databricks proxy
]


class AuthMiddleware(BaseHTTPMiddleware):
    """Middleware to extract user email from request headers or custom provider.

    If a custom user_provider was configured via configure_auth(), it will be
    used to extract the user email. Otherwise, checks standard headers:
    - X-Forwarded-Email: Used by Databricks proxy
    - X-User-Email: Legacy/custom header for backwards compatibility

    In dev mode, uses a default email if no user is found.

    ``/api/admin`` must never be added to PUBLIC_PATHS/PUBLIC_PREFIXES — the
    admin router relies on the identity resolved here (guarded by a test).
    """

    # Paths that don't require authentication
    PUBLIC_PATHS = {"/health", "/docs", "/openapi.json", "/redoc", "/favicon.ico"}
    # Prefixes that don't require authentication (for static files)
    PUBLIC_PREFIXES = ("/static/",)

    async def dispatch(self, request: Request, call_next):
        # Skip auth for public paths
        if request.url.path in self.PUBLIC_PATHS:
            return await call_next(request)

        # Skip auth for public prefixes (static files)
        for prefix in self.PUBLIC_PREFIXES:
            if request.url.path.startswith(prefix):
                return await call_next(request)

        settings = get_settings()
        user_email = None

        # First, try custom user provider if configured
        if _user_provider is not None:
            try:
                result = _user_provider(request)
                if inspect.isawaitable(result):
                    user_email = await result
                else:
                    user_email = result
            except Exception:
                # Provider failed, fall through to header check
                pass

        # If no custom provider or it failed, try headers
        if not user_email:
            for header in EMAIL_HEADERS:
                user_email = request.headers.get(header)
                if user_email:
                    break

        # In dev mode, use default email if nothing found
        if not user_email:
            if settings.dev_mode:
                user_email = DEV_DEFAULT_EMAIL
            else:
                # Return the response directly: an HTTPException raised from a
                # BaseHTTPMiddleware sits above the exception handlers and
                # would surface as a 500 with a traceback instead of a 403.
                return JSONResponse(
                    status_code=403,
                    content={
                        "detail": {
                            "error": {
                                "code": "FORBIDDEN",
                                "message": (
                                    "Access denied. Authentication header required. "
                                    f"Expected header: {', '.join(EMAIL_HEADERS)}"
                                ),
                                "details": {},
                            }
                        }
                    },
                )

        # Store email in request state
        request.state.user_email = user_email

        # Register the user (DB *and* memory mode) and bump last_seen_at.
        from graphlagoon.services.users import touch_user

        await touch_user(user_email)

        return await call_next(request)


async def ensure_user_exists(session, email: str):
    """Ensure user exists in database, create if not."""
    from sqlalchemy import select
    from graphlagoon.db.models import User

    result = await session.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()

    if user is None:
        user = User(email=email, display_name=email.split("@")[0])
        session.add(user)
        await session.flush()

    return user


def get_current_user(request: Request) -> str:
    """Get current user email from request.

    Resolution order:
    1. request.state.user_email (set by AuthMiddleware)
    2. The custom user_provider registered via configure_auth(), when the
       host app relies on it instead of installing AuthMiddleware. A sync
       provider is called here; an async one cannot be awaited from a sync
       dependency and is a configuration error — the host must install
       AuthMiddleware so the identity is resolved before the handler runs.
       Without this step a mounted deployment would trust a client-supplied
       X-Forwarded-Email header over the host's own authentication.
    3. X-Forwarded-Email header (direct read — guards against
       BaseHTTPMiddleware state propagation issues)
    4. DEV_DEFAULT_EMAIL (dev mode only)
    """
    if hasattr(request.state, "user_email"):
        return request.state.user_email

    if _user_provider is not None:
        try:
            result = _user_provider(request)
        except Exception:
            result = None
        if inspect.isawaitable(result):
            if hasattr(result, "close"):
                result.close()  # avoid "coroutine was never awaited" warnings
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "code": "AUTH_MISCONFIGURED",
                        "message": (
                            "An async user_provider is configured but AuthMiddleware "
                            "is not installed; install AuthMiddleware so the identity "
                            "is resolved before handlers run."
                        ),
                        "details": {},
                    }
                },
            )
        if result:
            request.state.user_email = result
            return result

    # Direct header read as fallback
    for header in EMAIL_HEADERS:
        email = request.headers.get(header)
        if email:
            return email

    settings = get_settings()
    if settings.dev_mode:
        return DEV_DEFAULT_EMAIL

    raise HTTPException(
        status_code=401,
        detail={
            "error": {
                "code": "UNAUTHORIZED",
                "message": "User not authenticated. Missing request.state.user_email",
                "details": {},
            }
        },
    )
