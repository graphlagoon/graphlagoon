"""Verifies that a Databricks user token belongs to the identity a request
claims (``auth_mode=databricks``).

Three callers hand a Databricks OAuth *user* token to ``verify``:

* the Databricks Apps proxy, in ``X-Forwarded-Access-Token`` next to
  ``X-Forwarded-Email`` (the app checks that the two agree);
* a REST/CLI caller outside the proxy, in ``Authorization: Bearer …``;
* the app-hosted sign-in (``routers/auth.py``), once, right after the OAuth
  code exchange, to learn whose session to open.

The verdict comes from ``GET /api/2.0/preview/scim/v2/Me`` called **with the
caller's token** (never the app's own credential): the workspace says who the
token is. Verdicts are cached by the token's sha256 for a TTL; the token
itself is never stored or logged.

Failure contract (the opposite of ``group_resolution``, where degrading gives
*fewer* groups): an unverifiable identity would give *more* access, so a cold
cache fails closed (``unavailable`` → 503). A verdict already obtained keeps
serving while Databricks is unreachable, up to ``stale_max_seconds`` — the
token already proved whose it is; only a revocation would be missed, and for
no longer than the token itself lives.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Dict, Optional

import httpx

logger = logging.getLogger(__name__)

SCIM_ME_PATH = "/api/2.0/preview/scim/v2/Me"


@dataclass(frozen=True)
class IdentityVerdict:
    """The outcome of one verification."""

    status: str  # "verified" | "invalid" | "unavailable"
    email: Optional[str] = None  # the workspace's answer (verified only)
    source: str = "fresh"  # "fresh" | "cache" | "stale" | "stub"
    error: Optional[str] = None


@dataclass
class _CacheEntry:
    email: Optional[str]  # None when the workspace rejected the token
    fetched_at: float


def _key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def email_of_me(payload: dict) -> Optional[str]:
    """``userName`` of a SCIM ``Me`` document, or its primary e-mail (a service
    principal's ``userName`` is its application id; its e-mails may be empty)."""
    user_name = str(payload.get("userName") or "").strip()
    emails = payload.get("emails") or []
    primary = next(
        (str(e.get("value") or "").strip() for e in emails if e.get("primary")),
        None,
    )
    if "@" in user_name:
        return user_name
    return primary or user_name or None


class StubIdentityVerifier:
    """Static map for dev mode and tests: token → e-mail. Unknown tokens are
    invalid; ``unavailable_tokens`` simulate an outage."""

    def __init__(self, mapping: Optional[Dict[str, str]] = None):
        self.mapping: Dict[str, str] = dict(mapping or {})
        self.unavailable_tokens: set = set()
        self.calls: list = []

    async def verify(self, token: str) -> IdentityVerdict:
        self.calls.append(_key(token)[:8])
        if token in self.unavailable_tokens:
            return IdentityVerdict(status="unavailable", source="stub", error="stub outage")
        email = self.mapping.get(token)
        if email is None:
            return IdentityVerdict(status="invalid", source="stub")
        return IdentityVerdict(status="verified", email=email, source="stub")

    def status(self) -> dict:
        return {"mode": "stub", "ttl_seconds": 0, "cached_tokens": len(self.mapping), "errors": []}


class DatabricksIdentityVerifier:
    """``/Me``-backed verifier with a per-token TTL cache and stale-on-error."""

    def __init__(
        self,
        base_url: str,
        ttl_seconds: int = 300,
        stale_max_seconds: int = 3600,
        timeout: float = 5.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        base_url = base_url.rstrip("/")
        if not base_url.startswith(("http://", "https://")):
            base_url = f"https://{base_url}"
        self._base_url = base_url
        self._ttl = ttl_seconds
        self._stale_max = stale_max_seconds
        self._timeout = timeout
        self._transport = transport  # test seam (httpx.MockTransport)
        self._cache: Dict[str, _CacheEntry] = {}
        self._lock = asyncio.Lock()
        self._errors: list = []

    async def _fetch(self, token: str) -> Optional[str]:
        """The token's e-mail, or None when the workspace rejects the token."""
        async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
            response = await client.get(
                f"{self._base_url}{SCIM_ME_PATH}",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
        if response.status_code in (401, 403):
            return None
        response.raise_for_status()
        return email_of_me(response.json())

    async def verify(self, token: str) -> IdentityVerdict:
        key = _key(token)
        now = time.time()
        async with self._lock:
            entry = self._cache.get(key)
        if entry is not None and now - entry.fetched_at < self._ttl:
            if entry.email is None:
                return IdentityVerdict(status="invalid", source="cache")
            return IdentityVerdict(status="verified", email=entry.email, source="cache")

        try:
            email = await self._fetch(token)
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            logger.warning("Identity check %s… failed: %s", key[:8], message)
            async with self._lock:
                self._errors = (self._errors + [{"at": now, "error": message}])[-10:]
            if entry is not None and entry.email and now - entry.fetched_at < self._stale_max:
                return IdentityVerdict(status="verified", email=entry.email, source="stale", error=message)
            return IdentityVerdict(status="unavailable", error=message)

        async with self._lock:
            self._cache[key] = _CacheEntry(email=email, fetched_at=now)
        if email is None:
            logger.info("Identity check %s…: token rejected by the workspace", key[:8])
            return IdentityVerdict(status="invalid")
        return IdentityVerdict(status="verified", email=email)

    def status(self) -> dict:
        return {
            "mode": "databricks",
            "ttl_seconds": self._ttl,
            "stale_max_seconds": self._stale_max,
            "cached_tokens": len(self._cache),
            "errors": list(self._errors),
        }


_verifier = None


def configure_identity_verification(settings):
    """Wire the module-global verifier beside the other ``configure_*`` calls.
    ``auth_mode=databricks`` needs ``databricks_host`` (the workspace that
    issued the tokens); anything else gets the stub."""
    global _verifier
    if getattr(settings, "auth_mode", "header") == "databricks":
        if not settings.databricks_host:
            raise RuntimeError(
                "GRAPH_LAGOON_AUTH_MODE=databricks needs GRAPH_LAGOON_DATABRICKS_HOST "
                "(the workspace that signs people in)."
            )
        _verifier = DatabricksIdentityVerifier(
            base_url=settings.databricks_host,
            ttl_seconds=settings.auth_identity_cache_ttl_seconds,
            stale_max_seconds=settings.auth_identity_stale_max_seconds,
        )
    else:
        _verifier = StubIdentityVerifier()
    return _verifier


def get_identity_verifier():
    global _verifier
    if _verifier is None:
        _verifier = StubIdentityVerifier()
    return _verifier


def set_identity_verifier(verifier) -> None:
    """Test seam."""
    global _verifier
    _verifier = verifier
