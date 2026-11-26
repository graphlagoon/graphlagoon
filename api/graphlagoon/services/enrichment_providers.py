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
JSON scalars, and the call is cancelled after ``timeout_seconds``. ``params`` holds only
the names the provider declared, each coerced to its type and inside its ``choices`` /
``min`` / ``max`` (``services/precomputed/params.py``); when ``columns`` is declared, any
other key the provider returns is dropped. ``applies_to`` (when given) was asked for this
context, on save and on run.

Parameters
----------
A provider declares ``params=[ParamSpec(...)]``. The context author sets values in the
entry (``provider.params``) and lists in ``provider.runtime_params`` the ones whoever
runs it may change; nothing can be changed at run time unless the author listed it. A
coerced ``str`` is still user text: bind it, never interpolate it; give ``choices`` to
anything that lands in an identifier position and ``min``/``max`` to anything that
becomes a limit or a window.

Identity
--------
``user_email`` is always the caller. ``user_token`` is the caller's own access token when
the request carried one (the Databricks Apps proxy's ``X-Forwarded-Access-Token``), and
``None`` otherwise — always ``None`` for an agent (MCP) run. With ``None`` the provider
can only use the process's own credentials: authorize by ``user_email`` then.

Not provided (the provider's own business): caching, de-duplication and rate limiting
of the service it calls — an ``auto`` entry runs after every query and expand of every
user; a way to clear a value (a ``None`` is ignored); nested values (lists and objects
arrive as text).

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

from graphlagoon.services.precomputed.params import ParamSpec, validate_param_specs

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
    #: Declared parameters only, typed and inside their bounds.
    params: dict[str, Any] = field(default_factory=dict)
    #: The caller's own access token when the request carried one, else None.
    user_token: Optional[str] = None


Enricher = Callable[[EnrichmentProviderRequest], Awaitable[dict[str, dict[str, Any]]]]


@dataclass
class EnrichmentProvider:
    name: str
    enrich: Enricher
    targets: tuple[Target, ...] = ("nodes", "edges")
    label: str = ""
    description: str = ""
    timeout_seconds: float = 30.0
    #: Parameters a context entry (and, where its author allows, a run) may set.
    params: list[ParamSpec] = field(default_factory=list)
    #: The properties it writes. Declared, they are shown before anyone runs it and
    #: any other key it returns is dropped; empty means "whatever it returns".
    columns: tuple[str, ...] = ()
    #: Which contexts may use it (asked with the context, on save and on run).
    #: None means every context.
    applies_to: Optional[Callable[[Any], bool]] = None

    def ui_payload(self) -> dict[str, Any]:
        """What the frontend learns: copy, targets and parameters, nothing operational."""
        return {
            "name": self.name,
            "label": self.label or self.name,
            "description": self.description,
            "targets": list(self.targets),
            "params": [p.ui_payload() for p in self.params],
            "columns": list(self.columns),
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
    validate_param_specs(provider.params, owner=owner, url=False)
    if isinstance(provider.columns, str) or not all(
        isinstance(c, str) and c for c in provider.columns
    ):
        raise ValueError(f"{owner}: columns must be a list of property names")
    if provider.applies_to is not None and not callable(provider.applies_to):
        raise ValueError(f"{owner}: applies_to must be callable")


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
    "ParamSpec",
    "clear_enrichment_provider_registry",
    "get_enrichment_provider",
    "get_enrichment_providers",
    "register_enrichment_provider",
]
