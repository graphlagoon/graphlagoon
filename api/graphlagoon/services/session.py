"""Signed session cookie for the app-hosted Databricks sign-in
(``auth_mode=databricks`` outside the Databricks Apps proxy).

The cookie carries ``{sub, iat, exp, nonce}`` as base64url JSON plus an
HMAC-SHA256 over it with ``auth_session_secret``. No Databricks token is
kept anywhere: the user's token is used once, for ``/Me``, and dropped.
Stdlib only (``hmac``/``hashlib``), so the base install needs nothing new.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Optional

SESSION_COOKIE = "gl_session"
OAUTH_COOKIE = "gl_oauth"  # state + PKCE verifier between /login and /callback
OAUTH_COOKIE_MAX_AGE = 600
# Header a browser must send with the cookie on non-GET requests (CSRF: a
# cross-site form post cannot set custom headers; SameSite=Lax is the first
# layer, this is the second).
REQUESTED_WITH_HEADER = "x-requested-with"
REQUESTED_WITH_VALUE = "graphlagoon"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(payload: dict, secret: str) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    mac = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64(mac)}"


def verify(token: Optional[str], secret: str, now: Optional[float] = None) -> Optional[dict]:
    """The payload of a well-signed, unexpired token; None otherwise."""
    if not token or "." not in token:
        return None
    body, _, given = token.partition(".")
    expected = _b64(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, given):
        return None
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, UnicodeDecodeError):
        return None
    exp = payload.get("exp")
    if not isinstance(payload, dict) or not isinstance(exp, (int, float)):
        return None
    if (now if now is not None else time.time()) >= exp:
        return None
    return payload


def new_session(email: str, secret: str, hours: int) -> str:
    now = int(time.time())
    return sign({"sub": email, "iat": now, "exp": now + hours * 3600, "nonce": secrets.token_urlsafe(8)}, secret)


def session_email(token: Optional[str], secret: Optional[str]) -> Optional[str]:
    if not secret:
        return None
    payload = verify(token, secret)
    sub = payload.get("sub") if payload else None
    return sub if isinstance(sub, str) and sub.strip() else None
