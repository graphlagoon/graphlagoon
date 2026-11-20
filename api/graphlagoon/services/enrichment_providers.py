"""Enrichment providers: post-query enrichment computed by code the deployer registers.

An enrichment query (``services/enrichment.py``) is the context author's SQL on the
SQL warehouse. A *provider* is the other half: an async Python callable registered
when the app is built — ``create_mountable_app(enrichment_providers=[...])`` — that
gets a batch of the loaded graph and returns new properties per edge or node id. It
may read anything the process can reach: Lakebase, an internal service, a cache. The
context author only picks a registered provider by name in the context form.

Trust model
-----------
**The framework guarantees, before ``enrich`` is awaited:** the caller can read the
context; the target is one the provider declared; at most ``enrichment_max_keys``
targets are sent; ids are the ones in the request. **And after:** ids that were not
sent are dropped, at most ``enrichment_max_rows`` rows are kept, values are coerced to
JSON scalars, and the call is cancelled after ``timeout_seconds``.

**The provider author owes:** binding ids as parameters, never interpolating them into
SQL; any row-level authorization narrower than the context (``user_email`` is given);
not blocking the event loop — a synchronous call inside ``enrich`` cannot be cancelled
by the timeout. Raise ``EnrichmentProviderError`` for a message the user should see;
any other exception reaches the user as a generic failure, named only in the server log.
"""

from __future__ import annotations

import inspect
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Optional
from uuid import UUID

logger = logging.getLogger(__name__)

PROVIDER_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,49}$")
Target = Literal["edges", "nodes"]


class EnrichmentProviderError(Exception):
    """Raised by a provider; its message is shown to the user as the reason."""


@dataclass
class EnrichmentProviderRequest:
    context_id: UUID
    user_email: Optional[str]
    target: Target
    #: ``{edge_id, src, dst, relationship_type, properties}`` dicts.
    edges: list[dict] = field(default_factory=list)
    #: ``{node_id, node_type, properties}`` dicts (properties only with ``node_props``).
    nodes: list[dict] = field(default_factory=list)


Enricher = Callable[[EnrichmentProviderRequest], Awaitable[dict[str, dict[str, Any]]]]


@dataclass
class EnrichmentProvider:
    name: str
    enrich: Enricher
    targets: tuple[Target, ...] = ("nodes", "edges")
    label: str = ""
    description: str = ""
    timeout_seconds: float = 30.0

    def ui_payload(self) -> dict[str, Any]:
        """What the frontend learns: copy and targets, nothing operational."""
        return {
            "name": self.name,
            "label": self.label or self.name,
            "description": self.description,
            "targets": list(self.targets),
        }


def validate_provider(provider: EnrichmentProvider) -> None:
    """Fail at app construction, not at the first run."""
    if not isinstance(provider, EnrichmentProvider):
        raise ValueError(
            "enrichment_providers must hold EnrichmentProvider instances, "
            f"got {type(provider).__name__}"
        )
    if not PROVIDER_NAME_RE.match(provider.name or ""):
        raise ValueError(
            f"Invalid enrichment provider name {provider.name!r}: must match "
            f"{PROVIDER_NAME_RE.pattern}"
        )
    owner = f"enrichment provider '{provider.name}'"
    fn = provider.enrich
    while hasattr(fn, "func"):  # see through functools.partial
        fn = fn.func
    if not callable(provider.enrich) or not inspect.iscoroutinefunction(fn):
        raise ValueError(f"{owner}: enrich must be an async function")
    if not provider.targets or any(t not in ("nodes", "edges") for t in provider.targets):
        raise ValueError(f"{owner}: targets must be 'nodes' and/or 'edges'")
    if not provider.timeout_seconds or provider.timeout_seconds <= 0:
        raise ValueError(f"{owner}: timeout_seconds must be positive")


_REGISTRY: dict[str, EnrichmentProvider] = {}


def register_enrichment_provider(provider: EnrichmentProvider) -> None:
    """Register a provider; the same object twice is a no-op, another one under a
    taken name is an error (it would change what saved contexts run)."""
    validate_provider(provider)
    existing = _REGISTRY.get(provider.name)
    if existing is provider:
        return
    if existing is not None:
        raise ValueError(f"An enrichment provider named '{provider.name}' is already registered")
    _REGISTRY[provider.name] = provider
    logger.info("Registered enrichment provider '%s'", provider.name)


def get_enrichment_provider(name: str) -> Optional[EnrichmentProvider]:
    return _REGISTRY.get(name)


def get_enrichment_providers() -> list[EnrichmentProvider]:
    return list(_REGISTRY.values())


def clear_enrichment_provider_registry() -> None:
    _REGISTRY.clear()


__all__ = [
    "EnrichmentProvider",
    "EnrichmentProviderError",
    "EnrichmentProviderRequest",
    "clear_enrichment_provider_registry",
    "get_enrichment_provider",
    "get_enrichment_providers",
    "register_enrichment_provider",
]
