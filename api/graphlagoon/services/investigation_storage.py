"""Case storage (03-arquitetura §2.3): one BlobStore rooted at
``investigations_volume_path`` (a Volume, via the Files API) or, without one,
at ``{exploration_snapshots_dir}/investigations`` on local disk.

Layout under the root::

    {investigation_id}/sources/{source_id}.json.gz
    {investigation_id}/artifacts/{artifact_id}/v{n}/{name}
    {investigation_id}/files/{sha256}
    (evidence/…, exports/… arrive with F4.1, F4.6)

Uploads stream into a temp file while the sha256 is computed, and only then
go to the store with ``save_stream``; nothing is ever overwritten. The paths
never leave the server: every read goes through the API.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Optional
from uuid import UUID

from graphlagoon.services.blob_storage import BlobStore

CHUNK_BYTES = 1024 * 1024

_settings = None
_header_provider = None
_store: Optional[BlobStore] = None


def configure_investigation_storage(settings, header_provider=None) -> None:
    """Called at app startup, like the snapshot and preset services."""
    global _settings, _header_provider, _store
    _settings = settings
    _header_provider = header_provider
    _store = None


def get_store() -> BlobStore:
    global _store
    if _store is None:
        from graphlagoon.config import get_settings
        from graphlagoon.services.named_store import build_blob_store

        settings = _settings or get_settings()
        _store = build_blob_store(
            local_dir=os.path.join(settings.exploration_snapshots_dir, "investigations"),
            volume_path=settings.investigations_volume_path_effective,
            databricks_host=settings.databricks_host,
            databricks_token=settings.databricks_token,
            header_provider=_header_provider,
            what="investigation",
        )
    return _store


def source_key(investigation_id: UUID, source_id: UUID) -> str:
    return f"{investigation_id}/sources/{source_id}.json.gz"


def artifact_key(
    investigation_id: UUID, artifact_id: UUID, version: int, name: str
) -> str:
    return f"{investigation_id}/artifacts/{artifact_id}/v{version}/{name}"


def file_key(investigation_id: UUID, sha256: str) -> str:
    return f"{investigation_id}/files/{sha256}"


class TooLarge(Exception):
    def __init__(self, max_bytes: int):
        super().__init__(f"Upload exceeds {max_bytes} bytes")
        self.max_bytes = max_bytes


@dataclass
class Received:
    """An upload spooled to a local temp file, with its hash and size."""

    path: str
    sha256: str
    size_bytes: int

    def discard(self) -> None:
        Path(self.path).unlink(missing_ok=True)


async def receive(chunks: AsyncIterator[bytes], max_bytes: int) -> Received:
    """Spool ``chunks`` to a temp file, hashing on the way; memory stays at one chunk."""
    fd, path = tempfile.mkstemp(prefix="gl-investigation-")
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(fd, "wb") as f:
            async for chunk in chunks:
                size += len(chunk)
                if size > max_bytes:
                    raise TooLarge(max_bytes)
                digest.update(chunk)
                f.write(chunk)
    except BaseException:
        Path(path).unlink(missing_ok=True)
        raise
    return Received(path=path, sha256=digest.hexdigest(), size_bytes=size)


async def put(key: str, received: Received) -> None:
    """Store a received file under ``key``. FileExistsError if the key exists."""
    try:
        await get_store().save_stream(key, received.path)
    finally:
        received.discard()


async def save_bytes(key: str, data: bytes) -> None:
    """Small payloads built in memory (frozen sources)."""
    await get_store().save(key, data)


async def load(key: str) -> Optional[bytes]:
    """shortcut: whole blob in memory; stream reads when artifacts get large."""
    return await get_store().load(key)
