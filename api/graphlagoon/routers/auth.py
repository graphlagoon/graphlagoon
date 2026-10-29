"""App-hosted sign-in with Databricks (``auth_mode=databricks`` outside the
Databricks Apps proxy): Authorization Code + PKCE against the workspace, the
user's token used once for ``/Me``, then a signed session cookie
(``services.session``). People only; agents never sign in.

``login`` and ``callback`` are public (``AuthMiddleware.PUBLIC_SUFFIXES``);
``me`` and ``logout`` run behind the middleware like any route.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import time
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from graphlagoon.config import get_settings
from graphlagoon.middleware.auth import get_current_actor, session_secret
from graphlagoon.services import session as sessions
from graphlagoon.services.identity_verification import get_identity_verifier

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

SCOPE = "all-apis"
_transport: Optional[httpx.AsyncBaseTransport] = None  # test seam


def set_oauth_transport(transport) -> None:
    global _transport
    _transport = transport


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": code, "message": message, "details": {}}})


def _workspace(settings) -> str:
    host = (settings.databricks_host or "").rstrip("/")
    return host if host.startswith(("http://", "https://")) else f"https://{host}"


def _enabled(settings) -> None:
    if settings.auth_mode != "databricks" or not settings.auth_oauth_client_id_effective:
        raise _error(404, "NOT_FOUND", "Not Found")


def _prefix(request: Request) -> str:
    return (request.scope.get("root_path") or "").rstrip("/")


def _redirect_url(request: Request, settings) -> str:
    if settings.auth_oauth_redirect_url:
        return settings.auth_oauth_redirect_url
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    return f"{scheme}://{request.headers.get('host', request.url.netloc)}{_prefix(request)}/api/auth/callback"


def _secure(request: Request) -> bool:
    return request.headers.get("x-forwarded-proto", request.url.scheme) == "https"


def _safe_next(value: Optional[str], request: Request) -> str:
    """A relative path on this site, never an absolute or protocol-relative URL."""
    fallback = f"{_prefix(request)}/"
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return fallback
    return value


def _secret(settings) -> str:
    secret = session_secret(settings)
    if not secret:
        raise _error(
            500,
            "AUTH_MISCONFIGURED",
            "GRAPH_LAGOON_AUTH_SESSION_SECRET is required for the sign-in outside dev mode.",
        )
    return secret


@router.get("/login", include_in_schema=False)
async def login(request: Request, next: Optional[str] = None):
    """Start the sign-in: redirect to the workspace's consent page."""
    settings = get_settings()
    _enabled(settings)
    secret = _secret(settings)
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode()
    query = urlencode(
        {
            "client_id": settings.auth_oauth_client_id_effective,
            "redirect_uri": _redirect_url(request, settings),
            "response_type": "code",
            "scope": SCOPE,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    response = RedirectResponse(f"{_workspace(settings)}/oidc/v1/authorize?{query}", status_code=302)
    response.set_cookie(
        sessions.OAUTH_COOKIE,
        sessions.sign(
            {"state": state, "verifier": verifier, "next": _safe_next(next, request),
             "exp": int(time.time()) + sessions.OAUTH_COOKIE_MAX_AGE},
            secret,
        ),
        max_age=sessions.OAUTH_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=_secure(request),
        path=f"{_prefix(request)}/",
    )
    return response


@router.get("/callback", include_in_schema=False)
async def callback(request: Request, code: Optional[str] = None, state: Optional[str] = None,
                   error: Optional[str] = None):
    """Finish the sign-in: exchange the code, learn who the token is, open the session."""
    settings = get_settings()
    _enabled(settings)
    secret = _secret(settings)
    if error:
        raise _error(401, "SIGN_IN_DENIED", f"The workspace refused the sign-in: {error}")
    pending = sessions.verify(request.cookies.get(sessions.OAUTH_COOKIE), secret)
    if not code or not state or pending is None or not secrets.compare_digest(str(pending.get("state")), state):
        raise _error(401, "SIGN_IN_STATE_MISMATCH", "The sign-in did not start here or took too long; try again.")
    try:
        async with httpx.AsyncClient(timeout=10.0, transport=_transport, verify=settings.databricks_tls_verify) as client:
            response = await client.post(
                f"{_workspace(settings)}/oidc/v1/token",
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": _redirect_url(request, settings),
                    "code_verifier": pending["verifier"],
                    "client_id": settings.auth_oauth_client_id_effective,
                },
                auth=(settings.auth_oauth_client_id_effective, settings.auth_oauth_client_secret_effective or ""),
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError as exc:
        logger.warning("Sign-in token exchange failed: %s", exc)
        raise _error(503, "SIGN_IN_UNAVAILABLE", "The workspace could not be reached; try again shortly.")
    if response.status_code != 200:
        logger.warning("Sign-in token exchange rejected: HTTP %s", response.status_code)
        raise _error(401, "SIGN_IN_REJECTED", "The workspace rejected the sign-in code.")
    token = (response.json() or {}).get("access_token")
    if not token:
        raise _error(401, "SIGN_IN_REJECTED", "The workspace returned no access token.")
    verdict = await get_identity_verifier().verify(token)
    if verdict.status == "unavailable":
        raise _error(503, "IDENTITY_VERIFICATION_UNAVAILABLE", "The workspace could not confirm who you are; try again shortly.")
    if verdict.status != "verified" or not verdict.email:
        raise _error(401, "IDENTITY_TOKEN_INVALID", "The workspace did not recognise the sign-in token.")

    from graphlagoon.services.users import touch_user

    await touch_user(verdict.email)
    redirect = RedirectResponse(pending.get("next") or f"{_prefix(request)}/", status_code=302)
    redirect.set_cookie(
        sessions.SESSION_COOKIE,
        sessions.new_session(verdict.email, secret, settings.auth_session_hours),
        max_age=settings.auth_session_hours * 3600,
        httponly=True,
        samesite="lax",
        secure=_secure(request),
        path=f"{_prefix(request)}/",
    )
    redirect.delete_cookie(sessions.OAUTH_COOKIE, path=f"{_prefix(request)}/")
    return redirect


@router.get("/me")
async def me(request: Request):
    """Who the server thinks is calling, or 401."""
    email = getattr(request.state, "user_email", None)
    if not email:
        raise _error(401, "UNAUTHORIZED", "Not signed in.")
    actor = get_current_actor()
    return {"email": email, "auth_mode": get_settings().auth_mode, "actor": actor["kind"] if actor else "person"}


@router.post("/logout")
async def logout(request: Request):
    """End the sign-in session (the cookie); the proxy's own login is untouched."""
    response = JSONResponse({"status": "signed_out"})
    response.delete_cookie(sessions.SESSION_COOKIE, path=f"{_prefix(request)}/")
    return response
