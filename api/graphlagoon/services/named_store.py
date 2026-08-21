"""Shared plumbing for named, per-context artifacts kept on a volume.

Two features store things this way — graph caches and style presets — and they
agree on everything except what the payload means: a name the author chose, a
context that scopes it, gzip'd JSON in a blob store that is a local directory or
a Databricks Volume depending on configuration.

This module owns the parts that must not drift between them: what a legal name
is, and how a configured backend is chosen.
"""

from __future__ import annotations

import re
from typing import Awaitable, Callable, Optional, Union

from graphlagoon.services.blob_storage import (
    BlobStore,
    DatabricksBlobStore,
    LocalBlobStore,
)

HeaderProvider = Callable[[], Union[str, Awaitable[str]]]

#: Names are user-supplied and become path segments, so they stay in a
#: conservative alphabet. Requiring an alphanumeric first character also
#: reserves '_' and '.' prefixes for anything internal stored alongside.
ARTIFACT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


class InvalidArtifactName(ValueError):
    """A name that is empty, too long, or contains unsafe characters."""


def validate_artifact_name(name: str, *, kind: str = "name") -> str:
    """Return `name` if it is usable, else raise InvalidArtifactName."""
    if not isinstance(name, str) or not ARTIFACT_NAME_RE.match(name):
        raise InvalidArtifactName(
            f"Invalid {kind} '{name}'. Names must be 1-64 characters, start "
            "with a letter or digit, and contain only letters, digits, '_', '-' "
            "and '.'."
        )
    return name


def build_blob_store(
    *,
    local_dir: str,
    volume_path: Optional[str],
    databricks_host: Optional[str],
    databricks_token: Optional[str],
    header_provider: Optional[HeaderProvider],
    what: str,
) -> BlobStore:
    """Pick a storage backend from configuration.

    A configured volume path decides, not `databricks_mode` — the same rule
    `snapshot.py` follows, so a local deployment can still write to a Volume and
    a Databricks deployment can still keep files on disk.
    """
    if not volume_path:
        return LocalBlobStore(local_dir)

    provider = header_provider
    if provider is None:
        if not databricks_token:
            raise ValueError(
                f"databricks_token is required when a {what} volume path is set "
                "and no header_provider is configured."
            )
        token = databricks_token
        provider = lambda: token  # noqa: E731

    if not databricks_host:
        raise ValueError(
            f"GRAPH_LAGOON_DATABRICKS_HOST is required when a {what} volume path "
            "is set."
        )

    return DatabricksBlobStore(
        base_url=f"https://{databricks_host}",
        root_path=volume_path,
        header_provider=provider,
    )
