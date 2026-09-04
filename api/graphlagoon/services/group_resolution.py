"""Resolves a user's Databricks workspace groups for permission groups.

``services.permissions`` asks "which Databricks groups does this email belong
to?" whenever a Graph Lagoon group lists a ``databricks_group`` member. In
Databricks mode the answer comes from the workspace SCIM API, cached per
user with a TTL (``settings.group_cache_ttl_seconds``); everywhere else a
stub answers from a static map (empty by default — tests inject entries).

Failure contract (documented in docs/guide/permissions.md):

* SCIM error with a previously-resolved entry → serve the stale names
  (``source="stale"``) and record the error for the admin banner;
* SCIM error with a cold cache → empty names (``source="none"``) — the
  user's databricks-kind memberships simply don't match until SCIM recovers
  or an admin hits refresh. Email-kind members never depend on SCIM.

Only DIRECT membership is supported: the SCIM ``Users.groups`` attribute
does not guarantee expansion of nested workspace groups.

The app's own credential (OAuth M2M ``header_provider`` or a PAT) must be
allowed to read workspace SCIM Users — a deployment prerequisite noted in
docs/guide/databricks-apps.md.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from dataclasses import dataclass
from typing import Callable, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

_SCIM_USERS_PATH = "/api/2.0/preview/scim/v2/Users"


@dataclass(frozen=True)
class ResolvedMembership:
    """The outcome of one membership lookup, with provenance for the inspector."""

    names: frozenset  # lowercased Databricks group displayNames
    source: str  # "fresh" | "cache" | "stale" | "none" | "stub"
    error: Optional[str] = None


@dataclass
class _CacheEntry:
    names: frozenset
    fetched_at: float
    error: Optional[str] = None
    error_at: Optional[float] = None


class StubGroupResolver:
    """Static-map resolver for dev mode and tests."""

    def __init__(self, mapping: Optional[Dict[str, frozenset]] = None):
        # email (lowercased) -> frozenset of lowercased group names
        self.mapping: Dict[str, frozenset] = mapping or {}
        self.calls: list = []  # emails looked up, for fast-path assertions

    async def groups_for(self, email: str) -> ResolvedMembership:
        self.calls.append(email)
        names = self.mapping.get(email.strip().lower(), frozenset())
        return ResolvedMembership(names=frozenset(names), source="stub")

    async def refresh(self, email: Optional[str] = None) -> None:
        return None

    def status(self) -> dict:
        return {
            "mode": "stub",
            "ttl_seconds": 0,
            "cached_users": len(self.mapping),
            "errors": [],
        }


class DatabricksScimResolver:
    """SCIM-backed resolver with a per-user TTL cache and stale-on-error."""

    def __init__(
        self,
        base_url: str,
        header_provider: Optional[Callable] = None,
        token: Optional[str] = None,
        ttl_seconds: int = 600,
        timeout: float = 10.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._header_provider = header_provider
        self._token = token
        self._ttl = ttl_seconds
        self._timeout = timeout
        self._transport = transport  # test seam (httpx.MockTransport)
        self._cache: Dict[str, _CacheEntry] = {}
        self._lock = asyncio.Lock()

    async def _auth_headers(self) -> dict:
        if self._header_provider is not None:
            result = self._header_provider()
            token = await result if inspect.isawaitable(result) else result
            if not isinstance(token, str) or not token.strip():
                raise RuntimeError("group resolution header_provider returned no token")
            # Strip "Bearer " if the provider already includes it —
            # DatabricksOAuthService does, a raw PAT does not.
            token = token.replace("Bearer ", "").strip()
            return {"Authorization": f"Bearer {token}"}
        if self._token:
            return {"Authorization": f"Bearer {self._token}"}
        raise RuntimeError("group resolution has no credential configured")

    async def _fetch(self, email: str) -> frozenset:
        headers = await self._auth_headers()
        params = {
            "filter": f'userName eq "{email}"',
            "attributes": "groups",
        }
        async with httpx.AsyncClient(
            timeout=self._timeout, transport=self._transport
        ) as client:
            response = await client.get(
                f"{self._base_url}{_SCIM_USERS_PATH}", params=params, headers=headers
            )
        response.raise_for_status()
        resources = response.json().get("Resources") or []
        if not resources:
            return frozenset()
        groups = resources[0].get("groups") or []
        return frozenset(
            str(g.get("display", "")).strip().lower() for g in groups if g.get("display")
        )

    async def groups_for(self, email: str) -> ResolvedMembership:
        email = email.strip().lower()
        now = time.time()
        async with self._lock:
            entry = self._cache.get(email)
        if entry is not None and now - entry.fetched_at < self._ttl:
            return ResolvedMembership(names=entry.names, source="cache")

        try:
            names = await self._fetch(email)
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            logger.warning("SCIM group lookup failed for %s: %s", email, message)
            async with self._lock:
                if entry is not None:
                    self._cache[email] = _CacheEntry(
                        names=entry.names,
                        fetched_at=entry.fetched_at,
                        error=message,
                        error_at=now,
                    )
                    return ResolvedMembership(
                        names=entry.names, source="stale", error=message
                    )
                self._cache[email] = _CacheEntry(
                    names=frozenset(), fetched_at=0.0, error=message, error_at=now
                )
            return ResolvedMembership(names=frozenset(), source="none", error=message)

        async with self._lock:
            self._cache[email] = _CacheEntry(names=names, fetched_at=now)
        return ResolvedMembership(names=names, source="fresh")

    async def refresh(self, email: Optional[str] = None) -> None:
        """Drop one user's cache entry, or all of them."""
        async with self._lock:
            if email is None:
                self._cache.clear()
            else:
                self._cache.pop(email.strip().lower(), None)

    def status(self) -> dict:
        errors = [
            {
                "email": email,
                "error": entry.error,
                "at": entry.error_at,
            }
            for email, entry in sorted(self._cache.items())
            if entry.error
        ]
        return {
            "mode": "databricks",
            "ttl_seconds": self._ttl,
            "cached_users": len(self._cache),
            "errors": errors,
        }


_resolver = None


def configure_group_resolution(settings, header_provider: Optional[Callable] = None):
    """Wire the module-global resolver; called from app startup beside the
    other ``configure_*`` calls. Databricks mode with a credential gets the
    SCIM resolver; everything else (dev, tests) gets the stub."""
    global _resolver
    if settings.databricks_mode and settings.databricks_host and (
        header_provider is not None or settings.databricks_token
    ):
        _resolver = DatabricksScimResolver(
            base_url=f"https://{settings.databricks_host}",
            header_provider=header_provider,
            token=settings.databricks_token,
            ttl_seconds=settings.group_cache_ttl_seconds,
        )
    else:
        _resolver = StubGroupResolver()
    return _resolver


def get_group_resolver():
    """The configured resolver; a stub when nothing was configured (tests
    that mount routers bare)."""
    global _resolver
    if _resolver is None:
        _resolver = StubGroupResolver()
    return _resolver


def set_group_resolver(resolver) -> None:
    """Test seam: inject a resolver (e.g. a stub with a prepared mapping)."""
    global _resolver
    _resolver = resolver
