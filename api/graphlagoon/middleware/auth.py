from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from typing import Callable, Optional, Union
from collections import deque
from collections.abc import Awaitable
from contextvars import ContextVar
import inspect
import re
import time

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


# The actor of the current request: None for a person, or
# {"kind": "agent", "token_id", "name", "owner_email", "scope",
# "investigation_ids"} for an agent token. A ContextVar so services (journal, audit) can attribute writes
# without threading the request through every call.
_current_actor: ContextVar[Optional[dict]] = ContextVar(
    "graphlagoon_actor", default=None
)

AGENT_REQUEST_ACTION = "agent.request"  # usage_logs line per agent request (the shared counter)


class _MemoryWindows:
    """shortcut: fixtures still call ``auth._agent_request_times.clear()``; the
    windows live on the InMemoryStore now. Drop once the fixtures stop."""

    def clear(self) -> None:
        from graphlagoon.db.memory_store import get_memory_store

        get_memory_store().agent_request_times.clear()


_agent_request_times = _MemoryWindows()


def get_current_actor() -> Optional[dict]:
    """The agent acting in this request, or None when a person is."""
    return _current_actor.get()


async def _agent_rate_limited(token_id, owner_email: str, limit_per_minute: int) -> bool:
    """Sliding minute per token in the shared store: the ``usage_logs`` table in
    Postgres (every worker counts the same rows), the InMemoryStore otherwise."""
    from datetime import datetime, timedelta

    from graphlagoon.db.database import get_session_maker, is_database_available

    if not is_database_available():
        from graphlagoon.db.memory_store import get_memory_store

        now = time.monotonic()
        window = get_memory_store().agent_request_times.setdefault(token_id, deque())
        while window and now - window[0] >= 60:
            window.popleft()
        if len(window) >= limit_per_minute:
            return True
        window.append(now)
        return False

    from sqlalchemy import func, select

    from graphlagoon.db.models import UsageLog

    now = datetime.now()
    async with get_session_maker()() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(UsageLog)
            .where(
                UsageLog.action == AGENT_REQUEST_ACTION,
                UsageLog.resource_id == token_id,
                UsageLog.created_at >= now - timedelta(seconds=60),
            )
        )
        if (count or 0) >= limit_per_minute:
            return True
        session.add(
            UsageLog(
                user_email=owner_email,
                action=AGENT_REQUEST_ACTION,
                resource_type="agent_token",
                resource_id=token_id,
                created_at=now,
            )
        )
        await session.commit()
    return False


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"detail": {"error": {"code": code, "message": message, "details": {}}}},
    )


def _bearer_agent_token(request: Request) -> Optional[str]:
    from graphlagoon.services.agent_tokens import TOKEN_PREFIX

    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    value = value.strip()
    if scheme.lower() == "bearer" and value.startswith(TOKEN_PREFIX):
        return value
    # The mcp-bridge sends it here when Authorization carries the Databricks
    # OAuth token that gets it through the Apps proxy (FA.5).
    value = request.headers.get("x-graphlagoon-agent-token", "").strip()
    return value if value.startswith(TOKEN_PREFIX) else None


# Headers to check for user email (in order of priority)
EMAIL_HEADERS = [
    "x-forwarded-email",  # Used by Databricks proxy
]


# Where an agent token may go (05 §6): the case routes, explorations, the
# graph queries of a context, /config and MCP. Everything else is 403.
_UUID = r"[0-9a-fA-F-]{36}"
AGENT_ALLOWED_PATHS = re.compile(
    r"^(/api/investigations(/|$)"
    r"|/api/explorations(/|$)"
    r"|/api/graph-contexts/" + _UUID + r"/(subgraph|expand|query|cypher|nodes/batch"
    r"|schema-drift|explorations|enrichment)(/|$)"
    r"|/api/config$"
    # The org's case types, library and authoring catalog: read-only, the REST
    # twins of get_case_type / get_playbook (an integration reads a type's
    # required fields before opening a case).
    r"|/api/org/"
    r"|/mcp$)"
)
_CASE_PATH = re.compile(r"^/api/investigations(?:/(" + _UUID + r"))?(?:/|$)")
# A case-scoped token stays inside its cases: no explorations or context queries
# outside a case (the MCP tools that touch a context all take the case), only
# the org's reads, /config and MCP besides.
_CASE_SCOPE_EXTRA_PATHS = re.compile(r"^(/api/config$|/api/org/|/mcp$)")


def agent_path_allowed(path: str, actor: Optional[dict] = None) -> bool:
    """Whether an agent token may reach ``path`` (mount prefixes stripped);
    a case-scoped token only reaches the cases it names."""
    if not AGENT_ALLOWED_PATHS.match(path):
        return False
    if actor and actor.get("scope") == "case":
        m = _CASE_PATH.match(path)
        if m is None:
            return bool(_CASE_SCOPE_EXTRA_PATHS.match(path))
        if m.group(1) and m.group(1).lower() not in actor.get("investigation_ids", []):
            return False
    return True


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

    # Paths that don't require authentication. The API docs (/docs, /openapi.json,
    # /redoc) are not among them: when ``api_docs_enabled`` serves them, they sit
    # behind the same login as the API, standalone or mounted under a prefix.
    PUBLIC_PATHS = {"/health", "/favicon.ico"}
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
        _current_actor.set(None)

        # An agent token wins over proxy headers: the agent acts *for* its
        # owner, and every write must say so.
        raw_token = _bearer_agent_token(request)
        if raw_token is not None:
            return await self._dispatch_agent(request, call_next, raw_token)

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

    async def _dispatch_agent(self, request: Request, call_next, raw_token: str):
        actor, error = await authenticate_agent(raw_token)
        if error is not None:
            return error
        path = request.url.path
        for prefix in (request.scope.get("root_path", ""), "/graphlagoon"):
            if prefix and path.startswith(prefix + "/"):
                path = path[len(prefix):]
        if not agent_path_allowed(path, actor) or (
            actor["scope"] == "case"
            and request.method != "GET"
            and path.rstrip("/") == "/api/investigations"
        ):
            return _error(
                403, "AGENT_FORBIDDEN", "Agent tokens may not use this route."
            )
        request.state.user_email = actor["owner_email"]
        request.state.actor = actor
        _current_actor.set(actor)
        return await call_next(request)


async def authenticate_agent(raw_token: str):
    """``(actor, None)`` for an active token under its rate limit, else
    ``(None, error_response)``. Shared by the middleware and the MCP endpoint."""
    from graphlagoon.services.agent_tokens import resolve_token

    settings = get_settings()
    token = await resolve_token(raw_token) if settings.agents_enabled else None
    if token is None:
        return None, _error(
            401,
            "INVALID_AGENT_TOKEN",
            "The agent token is invalid, expired or revoked.",
        )
    from graphlagoon.services.permissions import check_permission

    # Minting needs investigation.agent; using needs it still (a person who
    # changed teams keeps the SSO login, not the agent).
    if not (await check_permission(token["owner_email"], "investigation.agent")).allowed:
        return None, _error(
            403,
            "AGENT_PERMISSION_REVOKED",
            "The token's owner no longer has the permission to use agents.",
        )
    if await _agent_rate_limited(token["id"], token["owner_email"], settings.agent_rate_limit_per_minute):
        return None, _error(
            429,
            "AGENT_RATE_LIMITED",
            f"Agent token limited to {settings.agent_rate_limit_per_minute} "
            "requests per minute.",
        )
    actor = {
        "kind": "agent",
        "token_id": token["id"],
        "name": token["name"],
        "owner_email": token["owner_email"],
        "scope": token["scope"],
        "investigation_ids": token["investigation_ids"],
    }
    return actor, None


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
