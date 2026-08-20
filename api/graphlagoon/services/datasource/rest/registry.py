"""Global registry of REST graph connections.

Mirrors the similarity-endpoint registry: parent apps register specs at
construction time via ``create_mountable_app(rest_connections=[...])``; the
datasource factory resolves them by name at query time.
"""

from __future__ import annotations

import logging
from typing import Optional

from graphlagoon.services.datasource.rest.spec import (
    RestConnectionSpec,
    validate_spec,
)

logger = logging.getLogger(__name__)

_REGISTRY: dict[str, RestConnectionSpec] = {}


def register_rest_connection(spec: RestConnectionSpec) -> None:
    """Register a REST connection, validating it eagerly.

    Registering the *same object* twice is a no-op so that repeated app
    construction (tests, re-mounts) stays idempotent; registering a different
    spec under an existing name is an error — silently replacing a connection
    that live contexts point at would change what their queries hit.
    """
    validate_spec(spec)
    existing = _REGISTRY.get(spec.name)
    if existing is spec:
        return
    if existing is not None:
        raise ValueError(f"A REST connection named '{spec.name}' is already registered")
    _REGISTRY[spec.name] = spec
    logger.info(f"Registered REST connection '{spec.name}' -> {spec.base_url}")


def get_rest_connection(name: str) -> Optional[RestConnectionSpec]:
    """Look up a registered connection by name."""
    return _REGISTRY.get(name)


def get_registered_rest_connections() -> list[RestConnectionSpec]:
    """All registered connections, in registration order."""
    return list(_REGISTRY.values())


def clear_rest_registry() -> None:
    """Clear all registered connections (for testing)."""
    _REGISTRY.clear()
