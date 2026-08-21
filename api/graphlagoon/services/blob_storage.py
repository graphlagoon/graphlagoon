"""Key/value blob storage over a local directory or a Databricks Volume.

The same two backends `snapshot.py` has, generalized in the two ways a cache
needs and an exploration snapshot does not: keys are **relative paths** rather
than bare UUIDs, and directories can be **listed** and **purged**.

`snapshot.py` is deliberately left alone. It sits on the critical path of every
exploration open, has no test coverage, and its error taxonomy is load-bearing —
`_persist_snapshot` maps PermissionError/TimeoutError/OSError onto distinct HTTP
codes, and the frontend's exploration loader depends on the load path *throwing*
to trigger its query re-execution fallback. Folding it into this module is a
worthwhile follow-up behind characterization tests, not a free refactor. See
docs/dev/technical_debts.md.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
import posixpath
import shutil
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable, Optional, Union

import httpx

logger = logging.getLogger(__name__)

# Same type as warehouse.py / snapshot.py
HeaderProvider = Callable[[], Union[str, Awaitable[str]]]

#: Prefix for in-progress local writes. Dot-prefixed so `list()` can filter them
#: out: a crashed write must not surface as a phantom entry.
_TEMP_PREFIX = ".tmp-"


@dataclass(frozen=True)
class BlobInfo:
    """One stored blob, as reported by `BlobStore.list`."""

    key: str
    size_bytes: int
    modified_at: Optional[datetime] = None


class InvalidBlobKey(ValueError):
    """A key that could escape the store root, or is otherwise unusable."""


def normalize_key(key: str) -> str:
    """Validate a relative POSIX key and return it in canonical form.

    This is the single barrier against path traversal. Every backend runs a key
    through it before touching storage, so a caller that forgets to validate a
    user-supplied name still cannot reach outside the store root.
    """
    if not isinstance(key, str) or not key:
        raise InvalidBlobKey("Blob key must be a non-empty string")
    if "\x00" in key:
        raise InvalidBlobKey("Blob key must not contain a null byte")
    if "\\" in key:
        raise InvalidBlobKey("Blob key must use '/' as separator, not '\\'")
    if key.startswith("/"):
        raise InvalidBlobKey(f"Blob key must be relative, got '{key}'")

    segments = key.split("/")
    for segment in segments:
        if segment in ("", ".", ".."):
            raise InvalidBlobKey(
                f"Blob key must not contain empty or relative segments, got '{key}'"
            )

    return posixpath.join(*segments)


def normalize_prefix(prefix: str) -> str:
    """Validate a directory prefix. The empty prefix means the store root."""
    stripped = prefix.strip("/")
    if not stripped:
        return ""
    return normalize_key(stripped)


class BlobStore(ABC):
    """Storage backend. Keys are relative POSIX paths under a fixed root."""

    @abstractmethod
    async def save(self, key: str, data: bytes) -> None: ...

    @abstractmethod
    async def load(self, key: str) -> Optional[bytes]:
        """Return the stored bytes, or None when the key does not exist."""

    @abstractmethod
    async def delete(self, key: str) -> None: ...

    @abstractmethod
    async def exists(self, key: str) -> bool: ...

    @abstractmethod
    async def list(self, prefix: str) -> list[BlobInfo]:
        """List blobs directly under `prefix`. A missing prefix yields []."""

    @abstractmethod
    async def delete_prefix(self, prefix: str) -> None:
        """Remove every blob under `prefix`. Missing prefix is not an error."""


# ---------------------------------------------------------------------------
# Local filesystem
# ---------------------------------------------------------------------------


class LocalBlobStore(BlobStore):
    """Stores blobs as files under a base directory.

    Blocking filesystem calls are pushed to a thread so a large read cannot
    stall the event loop.
    """

    def __init__(self, base_dir: str) -> None:
        self._base = Path(base_dir).resolve()
        self._base.mkdir(parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        path = (self._base / normalize_key(key)).resolve()
        # Belt and braces: normalize_key already rejects traversal, but a symlink
        # inside the base dir could still point outside it.
        if not path.is_relative_to(self._base):
            raise InvalidBlobKey(f"Blob key escapes the store root: '{key}'")
        return path

    def _resolve_dir(self, prefix: str) -> Path:
        normalized = normalize_prefix(prefix)
        if not normalized:
            return self._base
        path = (self._base / normalized).resolve()
        if not path.is_relative_to(self._base):
            raise InvalidBlobKey(f"Blob prefix escapes the store root: '{prefix}'")
        return path

    def _save_sync(self, path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # A unique temp name per write. Deriving it from the target (the way
        # snapshot.py does, via with_suffix('.tmp')) gives concurrent writers of
        # the same key one shared temp file: their writes interleave and the
        # rename publishes a corrupt blob.
        tmp = path.parent / f"{_TEMP_PREFIX}{uuid.uuid4().hex}"
        try:
            tmp.write_bytes(data)
            os.replace(tmp, path)  # atomic within a filesystem
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    async def save(self, key: str, data: bytes) -> None:
        await asyncio.to_thread(self._save_sync, self._resolve(key), data)

    async def load(self, key: str) -> Optional[bytes]:
        path = self._resolve(key)

        def _read() -> Optional[bytes]:
            try:
                return path.read_bytes()
            except FileNotFoundError:
                return None

        return await asyncio.to_thread(_read)

    async def delete(self, key: str) -> None:
        path = self._resolve(key)
        await asyncio.to_thread(lambda: path.unlink(missing_ok=True))

    async def exists(self, key: str) -> bool:
        path = self._resolve(key)
        return await asyncio.to_thread(path.is_file)

    async def list(self, prefix: str) -> list[BlobInfo]:
        directory = self._resolve_dir(prefix)
        normalized = normalize_prefix(prefix)

        def _list() -> list[BlobInfo]:
            if not directory.is_dir():
                return []
            out: list[BlobInfo] = []
            for entry in sorted(directory.iterdir()):
                if not entry.is_file() or entry.name.startswith("."):
                    continue
                stat = entry.stat()
                out.append(
                    BlobInfo(
                        key=posixpath.join(normalized, entry.name)
                        if normalized
                        else entry.name,
                        size_bytes=stat.st_size,
                        modified_at=datetime.fromtimestamp(
                            stat.st_mtime, tz=timezone.utc
                        ),
                    )
                )
            return out

        return await asyncio.to_thread(_list)

    async def delete_prefix(self, prefix: str) -> None:
        directory = self._resolve_dir(prefix)
        if directory == self._base:
            raise InvalidBlobKey("Refusing to delete the store root")
        await asyncio.to_thread(lambda: shutil.rmtree(directory, ignore_errors=True))


# ---------------------------------------------------------------------------
# Databricks Unity Catalog Volume (Files API)
# ---------------------------------------------------------------------------


class DatabricksBlobStore(BlobStore):
    """Stores blobs in a Databricks Volume through the Files REST API.

    Files:       PUT/GET/DELETE https://{host}/api/2.0/fs/files{root}/{key}
    Directories: PUT/GET/DELETE https://{host}/api/2.0/fs/directories{root}/{dir}

    Uses the same HeaderProvider pattern as WarehouseClient and SnapshotService,
    so token refresh (PAT, OAuth M2M) is handled transparently.

    Two deliberate conservatisms, because the directories API is not exercised
    anywhere else in this codebase and its exact contract is unverified here:
    a directory is created explicitly before the first file write rather than
    relying on implicit parent creation, and a 404 from the listing is read as
    "empty", never as an error.
    """

    _HTTP_TIMEOUT = 60.0
    _MAX_LIST_PAGES = 50
    _DELETE_CONCURRENCY = 16

    def __init__(
        self,
        base_url: str,
        root_path: str,
        header_provider: HeaderProvider,
    ) -> None:
        # base_url: "https://adb-xxx.azuredatabricks.net"
        self._base_url = base_url.rstrip("/")
        # root_path: "/Volumes/catalog/schema/vol_name/graph-cache"
        self._root = "/" + root_path.strip("/")
        self._header_provider = header_provider
        self._client: Optional[httpx.AsyncClient] = None
        # Directories already created this process. Saves a round trip per write
        # without ever being load-bearing: a stale entry costs at most one 404.
        self._known_dirs: set[str] = set()

    # -- plumbing ---------------------------------------------------------

    def _http(self) -> httpx.AsyncClient:
        """A client shared across calls — cache reads are a hot path."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self._HTTP_TIMEOUT)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def _auth_headers(self) -> dict:
        try:
            result = self._header_provider()
            token = await result if inspect.isawaitable(result) else result

            if token is None:
                raise ValueError("header_provider returned None")
            if not isinstance(token, str):
                raise TypeError(
                    f"header_provider must return str, got {type(token).__name__}"
                )
            if not token.strip():
                raise ValueError("header_provider returned empty token string")

            # Strip "Bearer " if the provider already includes it — DatabricksOAuthService
            # does, a raw PAT does not.
            token = token.replace("Bearer ", "").strip()
            return {"Authorization": f"Bearer {token}"}
        except Exception as exc:
            logger.error(
                "Blob storage header_provider error: %s: %s", type(exc).__name__, exc
            )
            raise RuntimeError(
                f"Failed to obtain auth token for blob storage: {exc}"
            ) from exc

    def _file_url(self, key: str) -> str:
        return f"{self._base_url}/api/2.0/fs/files{self._root}/{normalize_key(key)}"

    def _dir_url(self, prefix: str) -> str:
        normalized = normalize_prefix(prefix)
        suffix = f"/{normalized}" if normalized else ""
        return f"{self._base_url}/api/2.0/fs/directories{self._root}{suffix}"

    def _check_response(
        self, resp: httpx.Response, operation: str, key: str, url: str
    ) -> None:
        """Raise a descriptive error for non-2xx responses, always including the URL."""
        if resp.is_success:
            return
        status = resp.status_code
        try:
            body = resp.text[:500]
        except Exception:
            body = "<unreadable>"
        logger.error(
            "Databricks blob %s [%s] failed: HTTP %s url=%s body=%s",
            operation,
            key,
            status,
            url,
            body,
        )
        # Databricks returns 401 for missing/expired tokens, but may return
        # 400 with INVALID_TOKEN in the body for malformed token values.
        is_auth_error = status == 401 or (
            status == 400 and "invalid_token" in body.lower()
        )
        if is_auth_error:
            raise PermissionError(
                f"Databricks blob {operation} [{key}]: authentication failed "
                f"(HTTP {status}). Token comes from header_provider — verify it is "
                f"a valid PAT or OAuth token (no 'Bearer ' prefix). url={url}"
            )
        if status == 403:
            raise PermissionError(
                f"Databricks blob {operation} [{key}]: access denied (403). "
                f"Ensure the token has READ/WRITE permission on {self._root}. url={url}"
            )
        if status == 404:
            raise FileNotFoundError(
                f"Databricks blob {operation} [{key}]: not found (404). "
                f"Volume path may not exist: {self._root}. url={url}"
            )
        raise OSError(
            f"Databricks blob {operation} [{key}]: HTTP {status}. url={url} body={body}"
        )

    async def _request(
        self, method: str, url: str, operation: str, key: str, **kwargs
    ) -> httpx.Response:
        """One HTTP call with the shared network-error taxonomy."""
        try:
            return await self._http().request(method, url, **kwargs)
        except httpx.TimeoutException as exc:
            logger.error("Databricks blob %s [%s] timed out. url=%s", operation, key, url)
            raise TimeoutError(
                f"Databricks blob {operation} [{key}]: timed out after "
                f"{self._HTTP_TIMEOUT}s. url={url}"
            ) from exc
        except httpx.RequestError as exc:
            logger.error(
                "Databricks blob %s [%s] network error: %s url=%s",
                operation,
                key,
                exc,
                url,
            )
            raise ConnectionError(
                f"Databricks blob {operation} [{key}]: network error — {exc}. url={url}"
            ) from exc

    async def _ensure_directory(self, key: str) -> None:
        """Create the parent directory of `key` if we have not already.

        Whether a file PUT auto-creates its parents is not documented; doing it
        explicitly costs one idempotent round trip on the (dev-only) write path.
        """
        parent = posixpath.dirname(normalize_key(key))
        if not parent or parent in self._known_dirs:
            return

        url = self._dir_url(parent)
        headers = await self._auth_headers()
        resp = await self._request("PUT", url, "mkdir", parent, headers=headers)
        # 409 / "already exists" is success for our purposes.
        if resp.is_success or resp.status_code == 409:
            self._known_dirs.add(parent)
            return
        self._check_response(resp, "mkdir", parent, url)

    # -- BlobStore --------------------------------------------------------

    async def save(self, key: str, data: bytes) -> None:
        await self._ensure_directory(key)

        url = self._file_url(key)
        headers = await self._auth_headers()
        headers["Content-Type"] = "application/octet-stream"
        # Straight overwrite, never delete-then-write: a delete first would open a
        # guaranteed window in which readers get a 404.
        resp = await self._request(
            "PUT",
            url,
            "save",
            key,
            content=data,
            headers=headers,
            params={"overwrite": "true"},
        )
        self._check_response(resp, "save", key, url)

    async def load(self, key: str) -> Optional[bytes]:
        url = self._file_url(key)
        headers = await self._auth_headers()
        resp = await self._request("GET", url, "load", key, headers=headers)
        if resp.status_code == 404:
            return None
        self._check_response(resp, "load", key, url)
        return resp.content

    async def delete(self, key: str) -> None:
        url = self._file_url(key)
        headers = await self._auth_headers()
        resp = await self._request("DELETE", url, "delete", key, headers=headers)
        if resp.status_code in (200, 204, 404):
            return
        self._check_response(resp, "delete", key, url)

    async def exists(self, key: str) -> bool:
        url = self._file_url(key)
        headers = await self._auth_headers()
        try:
            resp = await self._request("HEAD", url, "exists", key, headers=headers)
        except (TimeoutError, ConnectionError) as exc:
            logger.warning("Databricks blob exists [%s] check failed: %s", key, exc)
            return False
        return resp.status_code == 200

    async def list(self, prefix: str) -> list[BlobInfo]:
        normalized = normalize_prefix(prefix)
        url = self._dir_url(prefix)
        headers = await self._auth_headers()

        out: list[BlobInfo] = []
        page_token: Optional[str] = None

        for _ in range(self._MAX_LIST_PAGES):
            params = {"page_token": page_token} if page_token else None
            resp = await self._request(
                "GET", url, "list", normalized or "/", headers=headers, params=params
            )
            # A context that has never been cached simply has no directory.
            if resp.status_code == 404:
                return out
            self._check_response(resp, "list", normalized or "/", url)

            try:
                body = resp.json()
            except Exception as exc:
                raise OSError(
                    f"Databricks blob list [{normalized or '/'}]: response was not "
                    f"JSON ({exc}). url={url}"
                ) from exc

            out.extend(_parse_listing(body, normalized))

            page_token = body.get("next_page_token") or None
            if not page_token:
                return out

        # Never return a short list that looks complete. The only caller is
        # delete_prefix, where silently missing entries means files orphaned on
        # the volume forever; a caller that can tolerate partial results can
        # catch this and say so.
        raise OSError(
            f"Databricks blob list [{normalized or '/'}]: more than "
            f"{self._MAX_LIST_PAGES} pages of results ({len(out)} entries so far). "
            "Refusing to return a truncated listing."
        )

    async def delete_prefix(self, prefix: str) -> None:
        normalized = normalize_prefix(prefix)
        if not normalized:
            raise InvalidBlobKey("Refusing to delete the store root")

        # The Files API has no bulk or recursive delete, so this is one request
        # per blob. Done sequentially a context with a thousand entries would
        # hold the caller for the better part of a minute; bounded concurrency
        # keeps it to seconds without flooding the workspace.
        blobs = await self.list(normalized)
        if blobs:
            limiter = asyncio.Semaphore(self._DELETE_CONCURRENCY)

            async def _delete_one(key: str) -> None:
                async with limiter:
                    await self.delete(key)

            await asyncio.gather(*(_delete_one(info.key) for info in blobs))

        # Directory delete is non-recursive and may not exist at all; an orphaned
        # empty directory is harmless, so never let this fail the caller.
        url = self._dir_url(normalized)
        try:
            headers = await self._auth_headers()
            await self._request("DELETE", url, "rmdir", normalized, headers=headers)
        except Exception as exc:
            logger.warning(
                "Databricks blob rmdir [%s] failed (leaving empty directory): %s",
                normalized,
                exc,
            )
        self._known_dirs.discard(normalized)


def _parse_listing(body: dict, prefix: str) -> list[BlobInfo]:
    """Read a directory listing tolerantly.

    Field names in the Files API listing are not pinned by anything in this
    repo, so a mismatch degrades to an entry with missing metadata rather than
    a 500.
    """
    entries = body.get("contents")
    if entries is None:
        entries = body.get("files") or []

    out: list[BlobInfo] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("is_directory") or entry.get("is_dir"):
            continue

        path = entry.get("path") or ""
        name = entry.get("name") or posixpath.basename(path)
        if not name or name.startswith("."):
            continue

        size = entry.get("file_size", entry.get("size"))
        raw_modified = entry.get("last_modified", entry.get("modification_time"))

        out.append(
            BlobInfo(
                key=posixpath.join(prefix, name) if prefix else name,
                size_bytes=int(size) if isinstance(size, (int, float)) else 0,
                modified_at=_parse_timestamp(raw_modified),
            )
        )
    return out


def _parse_timestamp(value) -> Optional[datetime]:
    """Accept epoch milliseconds, epoch seconds or an ISO-8601 string."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # The Files API reports milliseconds; anything smaller is implausible as
        # a millisecond timestamp and is read as seconds.
        seconds = value / 1000 if value > 1e11 else value
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None
