"""File-based storage for exploration graph snapshots.

Snapshots store the full graph state (nodes + edges with positions and
properties) so explorations can be restored without re-executing the query.

Two backends are supported:
- LocalSnapshotService: stores files in a local directory (local/dev mode)
- DatabricksSnapshotService: stores files in a Databricks Volume via the
  Files REST API using httpx async (databricks_mode=True)
"""

from __future__ import annotations

import gzip
import inspect
import json
import logging
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable, Optional, Union, Awaitable, TYPE_CHECKING
from uuid import UUID

import httpx

if TYPE_CHECKING:
    from graphlagoon.config import Settings

logger = logging.getLogger(__name__)

# Same type as warehouse.py HeaderProvider
HeaderProvider = Callable[[], Union[str, Awaitable[str]]]

_snapshot_service: Optional["SnapshotService"] = None
_snapshot_settings: Optional["Settings"] = None
_snapshot_header_provider: Optional[HeaderProvider] = None


# ---------------------------------------------------------------------------
# Compress / decompress helpers
# ---------------------------------------------------------------------------

def compress_snapshot(data: dict) -> bytes:
    """Serialize and gzip-compress a snapshot dict."""
    return gzip.compress(json.dumps(data).encode("utf-8"))


def decompress_snapshot(data: bytes) -> dict:
    """Decompress and deserialize a snapshot."""
    return json.loads(gzip.decompress(data).decode("utf-8"))


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------

class SnapshotService(ABC):
    @abstractmethod
    async def save(self, exploration_id: UUID, data: bytes) -> None: ...

    @abstractmethod
    async def load(self, exploration_id: UUID) -> Optional[bytes]: ...

    @abstractmethod
    async def delete(self, exploration_id: UUID) -> None: ...

    @abstractmethod
    async def exists(self, exploration_id: UUID) -> bool: ...


# ---------------------------------------------------------------------------
# Local implementation
# ---------------------------------------------------------------------------

class LocalSnapshotService(SnapshotService):
    """Saves snapshots as gzip files in a local directory.

    Uses atomic write (temp file → rename) to avoid partial reads.
    """

    def __init__(self, base_dir: str) -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)

    def _path(self, eid: UUID) -> Path:
        return self._base / f"{eid}.json.gz"

    async def save(self, eid: UUID, data: bytes) -> None:
        tmp = self._path(eid).with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(self._path(eid))  # atomic on same filesystem

    async def load(self, eid: UUID) -> Optional[bytes]:
        p = self._path(eid)
        if p.exists():
            return p.read_bytes()
        return None

    async def delete(self, eid: UUID) -> None:
        p = self._path(eid)
        if p.exists():
            p.unlink()

    async def exists(self, eid: UUID) -> bool:
        return self._path(eid).exists()


# ---------------------------------------------------------------------------
# Databricks implementation (httpx async + HeaderProvider)
# ---------------------------------------------------------------------------

class DatabricksSnapshotService(SnapshotService):
    """Saves snapshots to a Databricks Unity Catalog Volume via Files API.

    Uses the same HeaderProvider pattern as WarehouseClient so token refresh
    is handled transparently (PAT, OAuth M2M, etc.).

    Files API:
        PUT/GET/DELETE/HEAD https://{host}/api/2.0/fs/files{volume_path}/{id}.json.gz
    """

    _HTTP_TIMEOUT = 60.0

    def __init__(
        self,
        base_url: str,
        volume_path: str,
        header_provider: HeaderProvider,
    ) -> None:
        # base_url: "https://adb-xxx.azuredatabricks.net"
        self._base_url = base_url.rstrip("/")
        # volume_path: "/Volumes/catalog/schema/vol_name"
        self._volume_path = "/" + volume_path.strip("/")
        self._header_provider = header_provider

    async def _auth_headers(self) -> dict:
        result = self._header_provider()
        if inspect.isawaitable(result):
            token = await result
        else:
            token = result
        return {"Authorization": f"Bearer {token}"}

    def _api_url(self, eid: UUID) -> str:
        return (
            f"{self._base_url}/api/2.0/fs/files"
            f"{self._volume_path}/{eid}.json.gz"
        )

    def _check_response(self, resp: httpx.Response, operation: str, eid: UUID) -> None:
        """Raise a descriptive error for non-2xx responses."""
        if resp.is_success:
            return
        status = resp.status_code
        if status == 401:
            raise PermissionError(
                f"Databricks snapshot {operation} [{eid}]: authentication failed (401). "
                "Check databricks_token or header_provider."
            )
        if status == 403:
            raise PermissionError(
                f"Databricks snapshot {operation} [{eid}]: access denied (403). "
                f"Ensure the token has READ/WRITE permission on {self._volume_path}."
            )
        if status == 404:
            raise FileNotFoundError(
                f"Databricks snapshot {operation} [{eid}]: not found (404). "
                f"Volume path may not exist: {self._volume_path}"
            )
        # generic fallback — include response body for diagnostics
        try:
            body = resp.text[:500]
        except Exception:
            body = "<unreadable>"
        raise OSError(
            f"Databricks snapshot {operation} [{eid}]: HTTP {status}. Body: {body}"
        )

    async def save(self, eid: UUID, data: bytes) -> None:
        headers = await self._auth_headers()
        headers["Content-Type"] = "application/octet-stream"
        try:
            async with httpx.AsyncClient(timeout=self._HTTP_TIMEOUT) as client:
                resp = await client.put(
                    self._api_url(eid),
                    content=data,
                    headers=headers,
                    params={"overwrite": "true"},
                )
            self._check_response(resp, "save", eid)
        except (PermissionError, FileNotFoundError, OSError):
            raise
        except httpx.TimeoutException as exc:
            raise TimeoutError(
                f"Databricks snapshot save [{eid}]: request timed out "
                f"after {self._HTTP_TIMEOUT}s."
            ) from exc
        except httpx.RequestError as exc:
            raise ConnectionError(
                f"Databricks snapshot save [{eid}]: network error — {exc}"
            ) from exc

    async def load(self, eid: UUID) -> Optional[bytes]:
        headers = await self._auth_headers()
        try:
            async with httpx.AsyncClient(timeout=self._HTTP_TIMEOUT) as client:
                resp = await client.get(self._api_url(eid), headers=headers)
            if resp.status_code == 404:
                return None
            self._check_response(resp, "load", eid)
            return resp.content
        except (PermissionError, OSError):
            raise
        except httpx.TimeoutException as exc:
            raise TimeoutError(
                f"Databricks snapshot load [{eid}]: request timed out "
                f"after {self._HTTP_TIMEOUT}s."
            ) from exc
        except httpx.RequestError as exc:
            raise ConnectionError(
                f"Databricks snapshot load [{eid}]: network error — {exc}"
            ) from exc

    async def delete(self, eid: UUID) -> None:
        headers = await self._auth_headers()
        try:
            async with httpx.AsyncClient(timeout=self._HTTP_TIMEOUT) as client:
                resp = await client.delete(self._api_url(eid), headers=headers)
            if resp.status_code in (200, 204, 404):
                return
            self._check_response(resp, "delete", eid)
        except (PermissionError, OSError):
            raise
        except httpx.TimeoutException as exc:
            raise TimeoutError(
                f"Databricks snapshot delete [{eid}]: request timed out "
                f"after {self._HTTP_TIMEOUT}s."
            ) from exc
        except httpx.RequestError as exc:
            raise ConnectionError(
                f"Databricks snapshot delete [{eid}]: network error — {exc}"
            ) from exc

    async def exists(self, eid: UUID) -> bool:
        headers = await self._auth_headers()
        try:
            async with httpx.AsyncClient(timeout=self._HTTP_TIMEOUT) as client:
                # Use GET instead of HEAD — HEAD is not officially documented
                # for the Databricks Files API. Stream to avoid downloading the body.
                async with client.stream("GET", self._api_url(eid), headers=headers) as resp:
                    return resp.status_code == 200
        except (httpx.TimeoutException, httpx.RequestError):
            return False


# ---------------------------------------------------------------------------
# Singleton management (mirrors warehouse.py pattern)
# ---------------------------------------------------------------------------

def configure_snapshot_service(
    settings: "Settings",
    header_provider: Optional[HeaderProvider] = None,
) -> None:
    """Configure the snapshot service singleton.

    Must be called at app startup (same as configure_warehouse).
    The header_provider is used for Databricks auth token retrieval.
    If None in databricks_mode, falls back to settings.databricks_token.
    """
    global _snapshot_service, _snapshot_settings, _snapshot_header_provider
    _snapshot_settings = settings
    _snapshot_header_provider = header_provider
    _snapshot_service = None  # reset so next get() creates a fresh instance


def get_snapshot_service() -> SnapshotService:
    """Return the configured SnapshotService singleton (lazy init)."""
    global _snapshot_service, _snapshot_settings, _snapshot_header_provider

    if _snapshot_service is not None:
        return _snapshot_service

    from graphlagoon.config import get_settings

    settings = _snapshot_settings or get_settings()

    if settings.databricks_volume_path:
        # Volume path configured → use Databricks Files API regardless of databricks_mode
        hp = _snapshot_header_provider
        if hp is None:
            token = settings.databricks_token
            if not token:
                raise ValueError(
                    "databricks_token is required when databricks_volume_path is set "
                    "and no header_provider is configured."
                )
            hp = lambda: token  # noqa: E731

        _snapshot_service = DatabricksSnapshotService(
            base_url=settings.warehouse_base_url,
            volume_path=settings.databricks_volume_path,
            header_provider=hp,
        )
    else:
        # No volume path → local directory (works in both local and databricks_mode)
        _snapshot_service = LocalSnapshotService(
            settings.exploration_snapshots_dir
        )

    return _snapshot_service


def reset_snapshot_service() -> None:
    """Reset the singleton (for testing)."""
    global _snapshot_service, _snapshot_settings, _snapshot_header_provider
    _snapshot_service = None
    _snapshot_settings = None
    _snapshot_header_provider = None
