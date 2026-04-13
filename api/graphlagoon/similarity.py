"""Similarity endpoint registration types and global registry.

Parent apps register similarity endpoints as path strings when calling
create_mountable_app(). The frontend calls these endpoints directly on
the same origin.
"""

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class SimilarityEndpointParam:
    """Schema for a single parameter accepted by a similarity endpoint."""

    name: str
    type: str  # "str" | "int" | "float" | "bool"
    default: Any = None
    required: bool = False
    description: str = ""
    choices: Optional[list[str]] = None


@dataclass
class SimilarityEndpointSpec:
    """Specification for a registered similarity endpoint."""

    name: str
    description: str
    endpoint: str  # absolute path, e.g. "/dummy/similarity/circle"
    params: list[SimilarityEndpointParam] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Global registry
# ---------------------------------------------------------------------------

_REGISTRY: dict[str, SimilarityEndpointSpec] = {}


def register_similarity_endpoint(spec: SimilarityEndpointSpec) -> None:
    """Register a similarity endpoint specification."""
    _REGISTRY[spec.name] = spec


def get_registered_endpoints() -> list[SimilarityEndpointSpec]:
    """Return all registered endpoint specs."""
    return list(_REGISTRY.values())


def get_endpoint(name: str) -> Optional[SimilarityEndpointSpec]:
    """Look up a registered endpoint by name."""
    return _REGISTRY.get(name)


def clear_registry() -> None:
    """Clear all registered endpoints (for testing)."""
    _REGISTRY.clear()
