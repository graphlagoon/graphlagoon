"""Global, ordered registry of precomputed graph providers.

Mirrors the REST connection registry: parent apps register providers at
construction time via ``create_mountable_app(precomputed_graph_providers=[...])``
and the resolver walks them at request time.

The backing dict is insertion-ordered, which gives uniqueness of names and the
order of the chain in one structure — and the order is semantic here, not
cosmetic: it decides which provider gets first refusal.
"""

from __future__ import annotations

import logging
from typing import Optional

from graphlagoon.services.precomputed.spec import (
    PrecomputedGraphProvider,
    validate_provider,
)

logger = logging.getLogger(__name__)

_REGISTRY: dict[str, PrecomputedGraphProvider] = {}


def register_precomputed_graph_provider(provider: PrecomputedGraphProvider) -> None:
    """Register a provider at the end of the chain, validating it eagerly.

    Registering the *same object* twice is a no-op so repeated app construction
    (tests, re-mounts) stays idempotent; registering a different provider under
    an existing name is an error — silently replacing one would change what
    every live link resolves to.
    """
    validate_provider(provider)
    existing = _REGISTRY.get(provider.name)
    if existing is provider:
        return
    if existing is not None:
        raise ValueError(
            f"A precomputed graph provider named '{provider.name}' is already "
            "registered"
        )
    _REGISTRY[provider.name] = provider
    logger.info("Registered precomputed graph provider '%s'", provider.name)


def get_precomputed_graph_providers() -> list[PrecomputedGraphProvider]:
    """Every registered provider, in chain order."""
    return list(_REGISTRY.values())


def get_precomputed_graph_provider(name: str) -> Optional[PrecomputedGraphProvider]:
    """Look up one provider by name."""
    return _REGISTRY.get(name)


def clear_precomputed_graph_registry() -> None:
    """Clear the registry (for testing, and for re-registration in one process)."""
    _REGISTRY.clear()


__all__ = [
    "clear_precomputed_graph_registry",
    "get_precomputed_graph_provider",
    "get_precomputed_graph_providers",
    "register_precomputed_graph_provider",
]
