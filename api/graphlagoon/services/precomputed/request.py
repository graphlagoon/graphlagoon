"""What a provider is handed, and what it may hand back.

The split between the two result forms is the whole performance story of this
feature. A provider reading a file that is already ``gzip(orjson(payload))``
returns those bytes untouched and the router hands them to the browser under
``Content-Encoding: gzip`` — nothing decompresses or re-serializes a large graph
server-side. A provider that computes a graph in memory returns a payload and
lets this layer compress it once.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Optional
from uuid import UUID

from graphlagoon.models.schemas import (
    PrecomputedGraphData,
    PrecomputedGraphPayload,
    PrecomputedGraphSource,
)
from graphlagoon.services import graph_codec


@dataclass
class PrecomputedGraphRequest:
    """One attempt to resolve `?precomputed=<name>` for a context.

    Everything here has already been validated — see the security contract in
    ``spec.py`` for exactly which guarantees that covers and which it does not.
    """

    context_id: UUID
    name: str
    #: Declared parameters only, coerced to their declared Python types.
    params: dict[str, Any] = field(default_factory=dict)
    #: The untouched query string, for logging and debugging. Never a source of
    #: values a provider acts on — that is what `params` is for.
    raw_params: Mapping[str, str] = field(default_factory=dict)
    user_email: str = ""
    #: The GraphContext the caller already has read access to.
    context: Any = None


@dataclass
class PrecomputedGraphResult:
    """A resolved graph: either stored bytes or an in-memory payload.

    Exactly one of `raw` and `payload` is set. Build one with `from_raw` (a
    provider that already holds encoded bytes) or `from_graph` (a provider that
    just computed nodes and edges), rather than by hand.
    """

    raw: Optional[bytes] = None
    payload: Optional[PrecomputedGraphPayload] = None

    def __post_init__(self) -> None:
        if (self.raw is None) == (self.payload is None):
            raise ValueError(
                "PrecomputedGraphResult takes exactly one of raw= or payload=; "
                "use from_raw() or from_graph()."
            )

    def to_bytes(self) -> bytes:
        """The wire form: `gzip(orjson(payload))`, either way.

        Already-encoded bytes are returned untouched — that pass-through is the
        reason `raw` exists at all, and re-encoding here would quietly undo it.
        """
        if self.raw is not None:
            return self.raw
        assert self.payload is not None  # guaranteed by __post_init__
        return graph_codec.compress(self.payload.model_dump(mode="json"))

    @classmethod
    def from_raw(cls, data: bytes) -> "PrecomputedGraphResult":
        """Bytes that are already `gzip(orjson(payload))`, passed through as-is."""
        return cls(raw=data)

    @classmethod
    def from_payload(
        cls, payload: PrecomputedGraphPayload
    ) -> "PrecomputedGraphResult":
        """A fully-built envelope, for a provider that wants to set every field."""
        return cls(payload=payload)

    @classmethod
    def from_graph(
        cls,
        graph: PrecomputedGraphData,
        *,
        name: str,
        context_id: UUID | str,
        provider: str,
        created_by: str = "",
        params: Optional[Mapping[str, Any]] = None,
        source: Optional[PrecomputedGraphSource] = None,
        created_at: Optional[datetime] = None,
    ) -> "PrecomputedGraphResult":
        """Wrap nodes and edges in the envelope, deriving everything derivable.

        A provider computing a BFS should never hand-assemble `node_count` or
        `payload_version` — the same "the server derives the envelope" split the
        write API has always drawn for its callers.
        """
        payload = PrecomputedGraphPayload(
            name=name,
            context_id=str(context_id),
            provider=provider,
            params=dict(params or {}),
            created_at=created_at or datetime.now(timezone.utc),
            created_by=created_by,
            node_count=len(graph.nodes),
            edge_count=len(graph.edges),
            properties_complete=not graph.properties_deferred,
            source=source or PrecomputedGraphSource(),
            graph=graph,
        )
        return cls(payload=payload)


__all__ = ["PrecomputedGraphRequest", "PrecomputedGraphResult"]
