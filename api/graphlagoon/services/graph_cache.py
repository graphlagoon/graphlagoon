"""Named, per-context graph caches.

A cache entry is a query result — nodes and edges — stored under a name, so
`/graph/{context_id}?graph={name}` replays it without touching the warehouse.
Anyone who can read the context can read its caches; writing through the API
additionally requires dev mode.

Entries are addressed by name and never enumerated. There is no `list` here on
purpose: enumeration is O(entries) and is the one operation that stops working
as the store grows, while every real use of a cache already knows the name it
wants. `BlobStore.list` still exists because purging a deleted context has to
find the files, but that is internal and bounded by one context.

This is the first of several cache systems, so the semantics (named entries
scoped to a context) sit behind `GraphCacheService` while the storage medium
sits behind `BlobStore`. A future cache backed by Redis or Postgres implements
the former without touching the routers.

Relation to exploration snapshots, which also persist a graph to the same kind
of volume: a snapshot is per-user, addressed by an opaque UUID, and carries UI
state — positions, communities, clusters. A cache is named, shared by everyone
with context access, and carries none of that.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional, Union
from uuid import UUID

from graphlagoon.models.schemas import (
    CachedGraph,
    GraphCacheEntry,
    GraphCachePayload,
    GraphCacheSource,
)
from graphlagoon.services import graph_codec
from graphlagoon.services.blob_storage import BlobStore
from graphlagoon.services.named_store import (
    ARTIFACT_NAME_RE,
    InvalidArtifactName,
    build_blob_store,
    validate_artifact_name,
)

logger = logging.getLogger(__name__)

HeaderProvider = Callable[[], Union[str, Awaitable[str]]]

#: Cache names share the artifact alphabet with style presets — see
#: services/named_store.py, which owns the rule so the two cannot drift.
CACHE_NAME_RE = ARTIFACT_NAME_RE

#: Files live under `{root}/cache/{context_id}/{name}.jsonz`, so a store root
#: shared with anything else stays legible.
_CACHE_PREFIX = "cache"


#: Kept as an alias: routers and tests catch this name, and it is the same
#: failure as any other invalid artifact name.
InvalidCacheName = InvalidArtifactName


class CacheTooLarge(ValueError):
    """A cache entry above the configured size limit."""


class CorruptCacheEntry(ValueError):
    """A stored entry that could not be decoded."""


def validate_cache_name(name: str) -> str:
    """Return `name` if it is a usable cache name, else raise InvalidCacheName."""
    return validate_artifact_name(name, kind="cache name")


def cache_key(context_id: UUID, name: str) -> str:
    """Storage key for one cache entry."""
    return f"{_CACHE_PREFIX}/{context_id}/{validate_cache_name(name)}{graph_codec.EXTENSION}"


def context_prefix(context_id: UUID) -> str:
    """Storage prefix holding every cache entry of one context."""
    return f"{_CACHE_PREFIX}/{context_id}"


class GraphCacheService(ABC):
    """Named graph caches scoped to a context."""

    @abstractmethod
    async def load_raw(self, context_id: UUID, name: str) -> Optional[bytes]:
        """Stored bytes, still compressed, or None when the entry is absent.

        Returning them compressed is the point: the read endpoint hands them
        straight to the client under `Content-Encoding`, so the server never
        decompresses a large graph just to serialize it again.
        """

    @abstractmethod
    async def load(self, context_id: UUID, name: str) -> Optional[GraphCachePayload]:
        """Decoded entry, for callers that need to inspect it."""

    @abstractmethod
    async def save(
        self,
        context_id: UUID,
        name: str,
        graph: CachedGraph,
        source: GraphCacheSource,
        created_by: str,
    ) -> GraphCacheEntry: ...

    @abstractmethod
    async def delete(self, context_id: UUID, name: str) -> None: ...

    @abstractmethod
    async def delete_context(self, context_id: UUID) -> None:
        """Drop every cache entry of a context. Never raises for a missing one."""


class VolumeGraphCacheService(GraphCacheService):
    """Cache entries as compressed files in a BlobStore."""

    def __init__(self, store: BlobStore, max_bytes: int) -> None:
        self._store = store
        self._max_bytes = max_bytes

    async def load_raw(self, context_id: UUID, name: str) -> Optional[bytes]:
        return await self._store.load(cache_key(context_id, name))

    async def load(self, context_id: UUID, name: str) -> Optional[GraphCachePayload]:
        raw = await self.load_raw(context_id, name)
        if raw is None:
            return None
        return decode_payload(raw, name)

    async def save(
        self,
        context_id: UUID,
        name: str,
        graph: CachedGraph,
        source: GraphCacheSource,
        created_by: str,
    ) -> GraphCacheEntry:
        validate_cache_name(name)

        payload = GraphCachePayload(
            name=name,
            context_id=str(context_id),
            created_at=datetime.now(timezone.utc),
            created_by=created_by,
            node_count=len(graph.nodes),
            edge_count=len(graph.edges),
            properties_complete=not graph.properties_deferred,
            source=source,
            graph=graph,
        )

        data = graph_codec.compress(payload.model_dump(mode="json"))
        if len(data) > self._max_bytes:
            raise CacheTooLarge(
                f"Cache entry '{name}' is {len(data)} bytes compressed, above the "
                f"{self._max_bytes}-byte limit (GRAPH_LAGOON_GRAPH_CACHE_MAX_BYTES)."
            )

        await self._store.save(cache_key(context_id, name), data)

        return GraphCacheEntry(
            name=name,
            size_bytes=len(data),
            modified_at=payload.created_at,
        )

    async def delete(self, context_id: UUID, name: str) -> None:
        await self._store.delete(cache_key(context_id, name))

    async def delete_context(self, context_id: UUID) -> None:
        await self._store.delete_prefix(context_prefix(context_id))


def decode_payload(raw: bytes, name: str) -> GraphCachePayload:
    """Decode stored bytes into a payload, or raise CorruptCacheEntry.

    A volume write is not atomic, so a reader can in principle catch a partial
    object. Failing with a named error lets the router answer "unreadable, run
    the query instead" rather than a blank canvas.
    """
    try:
        return GraphCachePayload.model_validate(graph_codec.decompress(raw))
    except Exception as exc:
        raise CorruptCacheEntry(
            f"Cache entry '{name}' could not be decoded ({exc}). It may have been "
            "written by an incompatible version, or read while being overwritten."
        ) from exc


# ---------------------------------------------------------------------------
# Singleton management (mirrors snapshot.py / warehouse.py)
# ---------------------------------------------------------------------------

_cache_service: Optional[GraphCacheService] = None
_cache_settings = None
_cache_header_provider: Optional[HeaderProvider] = None


def configure_graph_cache_service(
    settings,
    header_provider: Optional[HeaderProvider] = None,
) -> None:
    """Configure the graph cache singleton. Called at app startup."""
    global _cache_service, _cache_settings, _cache_header_provider
    _cache_settings = settings
    _cache_header_provider = header_provider
    _cache_service = None  # reset so next get() creates a fresh instance


def _settings():
    if _cache_settings is not None:
        return _cache_settings
    from graphlagoon.config import get_settings

    return get_settings()


def graph_cache_enabled() -> bool:
    return bool(_settings().graph_cache_enabled)


def graph_cache_writable() -> bool:
    """Whether the API may create or delete cache entries.

    Reads the settings handed to `configure_graph_cache_service`, not
    `get_settings()`: a mounted app can be constructed with a Settings object
    that differs from the cached global one, and the two must not disagree about
    whether writing is allowed.
    """
    settings = _settings()
    return bool(settings.graph_cache_enabled and settings.dev_mode)


def get_graph_cache_service() -> GraphCacheService:
    """Return the configured GraphCacheService singleton (lazy init)."""
    global _cache_service

    if _cache_service is not None:
        return _cache_service

    settings = _settings()
    if not settings.graph_cache_enabled:
        raise ValueError(
            "Graph cache is disabled. Set GRAPH_LAGOON_GRAPH_CACHE_ENABLED=true "
            "to enable it."
        )

    store: BlobStore = build_blob_store(
        local_dir=settings.graph_cache_dir,
        volume_path=settings.graph_cache_volume_path_effective,
        databricks_host=settings.databricks_host,
        databricks_token=settings.databricks_token,
        header_provider=_cache_header_provider,
        what="graph cache",
    )

    _cache_service = VolumeGraphCacheService(store, settings.graph_cache_max_bytes)
    return _cache_service


def reset_graph_cache_service() -> None:
    """Reset the singleton (for testing)."""
    global _cache_service, _cache_settings, _cache_header_provider
    _cache_service = None
    _cache_settings = None
    _cache_header_provider = None
