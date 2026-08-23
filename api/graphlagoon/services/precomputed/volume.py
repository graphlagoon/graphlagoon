"""The built-in provider: precomputed graphs as files in a blob store.

This is the reference implementation of the provider protocol and the default
when a deployment does not register anything else. It is also meant to be
*composed with*: because a missing file makes `resolve` return ``None`` rather
than raise, ::

    precomputed_graph_providers=[volume_provider(writable=False), lakebase_bfs]

is "serve the nightly job's file when it exists, compute it otherwise" with no
extra machinery.

Files live at ``{root}/precomputed/{context_id}/{name}.jsonz``, so a store root
shared with style presets or snapshots stays legible. The read path returns the
stored bytes *still compressed* — the router hands them to the browser under
``Content-Encoding: gzip``, so nothing decompresses a large graph server-side
only to serialize it again.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional, Union
from uuid import UUID

from graphlagoon.models.schemas import (
    PrecomputedGraphData,
    PrecomputedGraphEntry,
    PrecomputedGraphPayload,
    PrecomputedGraphSource,
)
from graphlagoon.services import graph_codec
from graphlagoon.services.blob_storage import BlobStore
from graphlagoon.services.named_store import (
    ARTIFACT_NAME_RE,
    InvalidArtifactName,
    build_blob_store,
    validate_artifact_name,
)
from graphlagoon.services.precomputed.registry import (
    get_precomputed_graph_providers,
)
from graphlagoon.services.precomputed.request import (
    PrecomputedGraphRequest,
    PrecomputedGraphResult,
)
from graphlagoon.services.precomputed.spec import (
    PrecomputedGraphProvider,
    PrecomputedGraphUI,
)

logger = logging.getLogger(__name__)

HeaderProvider = Callable[[], Union[str, Awaitable[str]]]

#: Names share the artifact alphabet with style presets — services/named_store.py
#: owns the rule so the two cannot drift.
PRECOMPUTED_NAME_RE = ARTIFACT_NAME_RE

#: Kept as an alias: routers and tests catch this name, and it is the same
#: failure as any other invalid artifact name.
InvalidPrecomputedName = InvalidArtifactName

_STORAGE_PREFIX = "precomputed"


class PayloadTooLarge(ValueError):
    """An entry above the configured size limit."""


class CorruptPayload(ValueError):
    """A stored entry that could not be decoded."""


def validate_precomputed_name(name: str) -> str:
    """Return `name` if it is usable, else raise InvalidPrecomputedName."""
    return validate_artifact_name(name, kind="precomputed graph name")


def precomputed_key(context_id: UUID, name: str) -> str:
    """Storage key for one entry.

    Note what is *not* here: no parameter value ever reaches a storage key.
    Parameters say what to compute, never which file to read.
    """
    return (
        f"{_STORAGE_PREFIX}/{context_id}/"
        f"{validate_precomputed_name(name)}{graph_codec.EXTENSION}"
    )


def context_prefix(context_id: UUID) -> str:
    """Storage prefix holding every entry of one context."""
    return f"{_STORAGE_PREFIX}/{context_id}"


def decode_payload(raw: bytes, name: str) -> PrecomputedGraphPayload:
    """Decode stored bytes into a payload, or raise CorruptPayload.

    A volume write is not atomic, so a reader can in principle catch a partial
    object. Failing with a named error lets the router answer "unreadable"
    rather than render a blank canvas.
    """
    try:
        decoded = graph_codec.decompress(raw)
    except Exception as exc:
        raise CorruptPayload(
            f"Precomputed graph '{name}' could not be decoded ({exc}). It may "
            "have been written by an incompatible version, or read while being "
            "overwritten."
        ) from exc

    try:
        return PrecomputedGraphPayload.model_validate(decoded)
    except Exception as exc:
        raise CorruptPayload(
            f"Precomputed graph '{name}' could not be decoded ({exc})."
        ) from exc


# ---------------------------------------------------------------------------
# Default store, built lazily from settings
# ---------------------------------------------------------------------------
#
# A developer calls volume_provider() while building the app, before the
# header_provider exists, so the store cannot be constructed at that moment.
# These three functions mirror the configure/get/reset triple that warehouse.py
# and snapshot.py already use.

_settings = None
_header_provider: Optional[HeaderProvider] = None
_store: Optional[BlobStore] = None

#: Names of providers built without an explicit `store=`. app.py reads this to
#: decide whether the local-directory prep and the multi-replica warning apply
#: at all — a Lakebase-only deployment should not be warned about a directory it
#: never touches.
_default_store_provider_names: set[str] = set()


def configure_precomputed_storage(
    settings,
    header_provider: Optional[HeaderProvider] = None,
) -> None:
    """Configure the default blob store. Called at app startup."""
    global _settings, _header_provider, _store
    _settings = settings
    _header_provider = header_provider
    _store = None  # rebuilt on next use


def reset_precomputed_storage() -> None:
    """Reset storage configuration and the default-store bookkeeping (tests)."""
    global _settings, _header_provider, _store
    _settings = None
    _header_provider = None
    _store = None
    _default_store_provider_names.clear()


def current_settings():
    if _settings is not None:
        return _settings
    from graphlagoon.config import get_settings

    return get_settings()


def precomputed_graphs_enabled() -> bool:
    return bool(current_settings().precomputed_graphs_enabled)


def uses_default_store() -> bool:
    """Whether any registered provider relies on the settings-built store."""
    return any(
        provider.name in _default_store_provider_names
        for provider in get_precomputed_graph_providers()
    )


def default_store() -> BlobStore:
    """The blob store described by configuration (lazy, memoized)."""
    global _store
    if _store is not None:
        return _store

    settings = current_settings()
    if not settings.precomputed_graphs_enabled:
        raise ValueError(
            "Precomputed graphs are disabled. Set "
            "GRAPH_LAGOON_PRECOMPUTED_GRAPHS_ENABLED=true to enable them."
        )

    _store = build_blob_store(
        local_dir=settings.precomputed_graphs_dir,
        volume_path=settings.precomputed_graphs_volume_path_effective,
        databricks_host=settings.databricks_host,
        databricks_token=settings.databricks_token,
        header_provider=_header_provider,
        what="precomputed graphs",
    )
    return _store


# ---------------------------------------------------------------------------
# The provider
# ---------------------------------------------------------------------------


def volume_provider(
    *,
    name: str = "volume",
    store: Optional[BlobStore] = None,
    max_bytes: Optional[int] = None,
    matches=None,
    writable: bool = True,
    ui: Optional[PrecomputedGraphUI] = None,
) -> PrecomputedGraphProvider:
    """A provider serving entries from a blob store.

    Args:
        name: Provider name, recorded in payloads and the capabilities response.
        store: An explicit BlobStore. Omit to use the one built from settings —
            a local directory, or a Databricks Volume when a volume path is set.
        max_bytes: Write ceiling for the compressed entry. Defaults to
            ``GRAPH_LAGOON_PRECOMPUTED_GRAPHS_MAX_BYTES``.
        matches: Predicate selecting which requests this provider claims.
        writable: False leaves ``save``/``delete`` undeclared, so PUT and DELETE
            answer 405 and the frontend hides its write panel. The right setting
            for a store fed only by a batch job.
        ui: Copy shown to the frontend.
    """
    if store is None:
        _default_store_provider_names.add(name)

    def _store_for() -> BlobStore:
        return store if store is not None else default_store()

    def _limit() -> int:
        if max_bytes is not None:
            return max_bytes
        return current_settings().precomputed_graphs_max_bytes

    async def _resolve(
        request: PrecomputedGraphRequest,
    ) -> Optional[PrecomputedGraphResult]:
        raw = await _store_for().load(precomputed_key(request.context_id, request.name))
        if raw is None:
            # Not an error: declining lets a later provider compute the graph.
            return None
        return PrecomputedGraphResult.from_raw(raw)

    async def _save(
        request: PrecomputedGraphRequest,
        graph: PrecomputedGraphData,
        source: PrecomputedGraphSource,
    ) -> PrecomputedGraphEntry:
        result = PrecomputedGraphResult.from_graph(
            graph,
            name=request.name,
            context_id=request.context_id,
            provider=name,
            created_by=request.user_email,
            params=request.params,
            source=source,
        )
        data = result.to_bytes()
        limit = _limit()
        if len(data) > limit:
            raise PayloadTooLarge(
                f"Precomputed graph '{request.name}' is {len(data)} bytes "
                f"compressed, above the {limit}-byte limit "
                "(GRAPH_LAGOON_PRECOMPUTED_GRAPHS_MAX_BYTES)."
            )

        await _store_for().save(
            precomputed_key(request.context_id, request.name), data
        )
        assert result.payload is not None
        return PrecomputedGraphEntry(
            name=request.name,
            size_bytes=len(data),
            modified_at=result.payload.created_at,
        )

    async def _delete(request: PrecomputedGraphRequest) -> None:
        await _store_for().delete(
            precomputed_key(request.context_id, request.name)
        )

    async def _delete_context(context_id: UUID) -> None:
        await _store_for().delete_prefix(context_prefix(context_id))

    return PrecomputedGraphProvider(
        name=name,
        resolve=_resolve,
        matches=matches,
        save=_save if writable else None,
        delete=_delete if writable else None,
        delete_context=_delete_context,
        ui=ui
        or PrecomputedGraphUI(
            label="Volume",
            description=(
                "Graphs published as files, read back by name without touching "
                "the warehouse."
            ),
        ),
    )


__all__ = [
    "CorruptPayload",
    "InvalidPrecomputedName",
    "PRECOMPUTED_NAME_RE",
    "PayloadTooLarge",
    "configure_precomputed_storage",
    "context_prefix",
    "current_settings",
    "decode_payload",
    "default_store",
    "precomputed_graphs_enabled",
    "precomputed_key",
    "reset_precomputed_storage",
    "uses_default_store",
    "validate_precomputed_name",
    "volume_provider",
]
