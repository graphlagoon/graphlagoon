"""Named style presets: how a context's graph looks, saved under a name.

A preset carries the presentation subset of an exploration — style (colors,
icons, aesthetics), labels (text formatting) and layout (algorithm, parameters,
3D forces) — and nothing about which data is shown. Applying one to a graph
therefore never changes what is on screen, only how it is drawn.

`/graph/{context_id}?style={name}` applies it to whatever graph is loaded, and
composes with `?graph=` so a link can pin both the data and its look.

Two things differ deliberately from the graph cache, which otherwise shares this
storage:

- **Presets are listable.** They are hand-authored, so a context holds a handful,
  and choosing one means seeing what exists. The cache refuses to list because
  entries are machine-written and unbounded; presets stay listable by being
  *bounded at write time* instead — see `max_per_context`.
- **Anyone with write access to the context can create one**, because a preset is
  a few kilobytes of preference, not a materialized query result. Only whoever
  created a preset (or a superuser) can delete it.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional, Union
from uuid import UUID

from graphlagoon.models.schemas import (
    StylePreset,
    StylePresetEntry,
    StylePresetSettings,
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

#: Presets live under `{root}/style/{context_id}/{name}.jsonz`.
_PRESET_PREFIX = "style"

#: A preset is settings, not data — a few kilobytes. Anything near this is a bug
#: or an abuse, not a legitimate preset.
MAX_PRESET_BYTES = 1024 * 1024


class TooManyPresets(ValueError):
    """The per-context preset limit is already reached."""


class PresetTooLarge(ValueError):
    """A preset above the size limit."""


class CorruptPreset(ValueError):
    """A stored preset that could not be decoded."""


def validate_preset_name(name: str) -> str:
    return validate_artifact_name(name, kind="preset name")


def preset_key(context_id: UUID, name: str) -> str:
    return (
        f"{_PRESET_PREFIX}/{context_id}/"
        f"{validate_preset_name(name)}{graph_codec.EXTENSION}"
    )


def context_prefix(context_id: UUID) -> str:
    return f"{_PRESET_PREFIX}/{context_id}"


def _entry_name(key: str) -> Optional[str]:
    """Preset name for a storage key, or None if the key is not a preset."""
    filename = key.rsplit("/", 1)[-1]
    if not filename.endswith(graph_codec.EXTENSION):
        return None
    name = filename[: -len(graph_codec.EXTENSION)]
    return name if ARTIFACT_NAME_RE.match(name) else None


class StylePresetService(ABC):
    """Named presentation settings scoped to a context."""

    @abstractmethod
    async def list(self, context_id: UUID) -> list[StylePresetEntry]: ...

    @abstractmethod
    async def load(self, context_id: UUID, name: str) -> Optional[StylePreset]:
        """The stored preset, or None when it does not exist."""

    @abstractmethod
    async def save(
        self,
        context_id: UUID,
        name: str,
        settings: StylePresetSettings,
        created_by: str,
        description: Optional[str] = None,
    ) -> StylePreset: ...

    @abstractmethod
    async def delete(self, context_id: UUID, name: str) -> None: ...

    @abstractmethod
    async def delete_context(self, context_id: UUID) -> None: ...


class VolumeStylePresetService(StylePresetService):
    """Presets as compressed files in a BlobStore."""

    def __init__(self, store: BlobStore, max_per_context: int) -> None:
        self._store = store
        self._max_per_context = max_per_context

    async def list(self, context_id: UUID) -> list[StylePresetEntry]:
        entries = []
        for info in await self._store.list(context_prefix(context_id)):
            name = _entry_name(info.key)
            if name is None:
                continue
            entries.append(
                StylePresetEntry(
                    name=name,
                    size_bytes=info.size_bytes,
                    modified_at=info.modified_at,
                )
            )
        return sorted(entries, key=lambda e: e.name.lower())

    async def load(self, context_id: UUID, name: str) -> Optional[StylePreset]:
        raw = await self._store.load(preset_key(context_id, name))
        if raw is None:
            return None
        try:
            return StylePreset.model_validate(graph_codec.decompress(raw))
        except Exception as exc:
            raise CorruptPreset(
                f"Style preset '{name}' could not be decoded ({exc}). It may have "
                "been written by an incompatible version, or read while being "
                "overwritten."
            ) from exc

    async def save(
        self,
        context_id: UUID,
        name: str,
        settings: StylePresetSettings,
        created_by: str,
        description: Optional[str] = None,
    ) -> StylePreset:
        validate_preset_name(name)

        # Overwriting keeps the original author and creation time: a preset is a
        # named slot, and whoever made it stays responsible for deleting it.
        existing = await self.load(context_id, name)
        if existing is None:
            current = await self.list(context_id)
            if len(current) >= self._max_per_context:
                raise TooManyPresets(
                    f"This context already holds {len(current)} style presets, the "
                    f"configured maximum ({self._max_per_context}). Delete one "
                    "before creating another."
                )

        now = datetime.now(timezone.utc)
        preset = StylePreset(
            name=name,
            context_id=str(context_id),
            created_at=existing.created_at if existing else now,
            created_by=existing.created_by if existing else created_by,
            updated_at=now if existing else None,
            description=description,
            settings=settings,
        )

        data = graph_codec.compress(preset.model_dump(mode="json"))
        if len(data) > MAX_PRESET_BYTES:
            raise PresetTooLarge(
                f"Style preset '{name}' is {len(data)} bytes compressed, above the "
                f"{MAX_PRESET_BYTES}-byte limit. A preset holds settings, not data."
            )

        await self._store.save(preset_key(context_id, name), data)
        return preset

    async def delete(self, context_id: UUID, name: str) -> None:
        await self._store.delete(preset_key(context_id, name))

    async def delete_context(self, context_id: UUID) -> None:
        await self._store.delete_prefix(context_prefix(context_id))


# ---------------------------------------------------------------------------
# Singleton management (mirrors graph_cache.py / snapshot.py)
# ---------------------------------------------------------------------------

_preset_service: Optional[StylePresetService] = None
_preset_settings = None
_preset_header_provider: Optional[HeaderProvider] = None


def configure_style_preset_service(
    settings,
    header_provider: Optional[HeaderProvider] = None,
) -> None:
    """Configure the style preset singleton. Called at app startup."""
    global _preset_service, _preset_settings, _preset_header_provider
    _preset_settings = settings
    _preset_header_provider = header_provider
    _preset_service = None


def _settings():
    if _preset_settings is not None:
        return _preset_settings
    from graphlagoon.config import get_settings

    return get_settings()


def style_presets_enabled() -> bool:
    return bool(_settings().style_presets_enabled)


def get_style_preset_service() -> StylePresetService:
    """Return the configured StylePresetService singleton (lazy init)."""
    global _preset_service

    if _preset_service is not None:
        return _preset_service

    settings = _settings()
    if not settings.style_presets_enabled:
        raise ValueError(
            "Style presets are disabled. Set "
            "GRAPH_LAGOON_STYLE_PRESETS_ENABLED=true to enable them."
        )

    store = build_blob_store(
        local_dir=settings.style_presets_dir,
        volume_path=settings.style_presets_volume_path_effective,
        databricks_host=settings.databricks_host,
        databricks_token=settings.databricks_token,
        header_provider=_preset_header_provider,
        what="style preset",
    )

    _preset_service = VolumeStylePresetService(
        store, settings.style_presets_max_per_context
    )
    return _preset_service


def reset_style_preset_service() -> None:
    """Reset the singleton (for testing)."""
    global _preset_service, _preset_settings, _preset_header_provider
    _preset_service = None
    _preset_settings = None
    _preset_header_provider = None


__all__ = [
    "CorruptPreset",
    "InvalidArtifactName",
    "MAX_PRESET_BYTES",
    "PresetTooLarge",
    "StylePresetService",
    "TooManyPresets",
    "VolumeStylePresetService",
    "configure_style_preset_service",
    "context_prefix",
    "get_style_preset_service",
    "preset_key",
    "reset_style_preset_service",
    "style_presets_enabled",
    "validate_preset_name",
]
