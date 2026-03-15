from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from typing import Callable, Optional, Union
from collections.abc import Awaitable
import inspect

from graphlagoon.db.database import get_session_maker, is_database_available
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
                raise HTTPException(
                    status_code=403,
                    detail={
                        "error": {
                            "code": "FORBIDDEN",
                            "message": (
                                "Access denied. Authentication header required. "
                                f"Expected header: {', '.join(EMAIL_HEADERS)}"
                            ),
                            "details": {},
                        }
                    },
                )

        # Store email in request state
        request.state.user_email = user_email

        # Ensure user exists in database (only if database is available)
        if is_database_available():
            session_maker = get_session_maker()
            async with session_maker() as session:
                await ensure_user_exists(session, user_email)
                await session.commit()

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
    2. X-Forwarded-Email header (direct read — guards against
       BaseHTTPMiddleware state propagation issues)
    3. DEV_DEFAULT_EMAIL (dev mode only)
    """
    if hasattr(request.state, "user_email"):
        return request.state.user_email

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
