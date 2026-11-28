"""Table providers: rows about one node or edge, computed by code the deployer registers.

A context declares a *table source*: an entry of its ``enrichment_tables`` naming a
registered provider (``table_provider``), with the context's parameter values and the
parameters a caller may set. That declaration is the isolation boundary: a provider is
usable in a context only through a source that context declares (which takes
``context.create``), by someone who can read the context.

A right-click action of kind ``run-table-provider`` points at a source and runs it for
the clicked node or edge, showing what it returns as a table — the same modal, CSV
export, "Add to case" and agent tools (``list_entity_actions`` / ``run_entity_action``)
as a query-template table. An agent can also ask a source directly (``query_source``). Where a query template is the context author's SQL on the SQL
warehouse, a provider is an async Python callable registered when the app is built —
``create_mountable_app(table_providers=[...])`` — that may read anything the process can
reach: an internal REST service, Lakebase, a cache.

It is the sibling of an enrichment provider (``enrichment_providers.py``): that one
returns properties per id for the whole loaded graph; this one returns rows for one
entity. Same parameter declaration (``ParamSpec``), same trust model.

Trust model
-----------
**The framework guarantees, before ``run`` is awaited:** the caller can read the
context; the target's kind is one the provider declared; ``applies_to`` (when given)
accepted the context; ``params`` holds only the declared names, each coerced to its
type and inside its ``choices`` / ``min`` / ``max``; a required parameter with no value
means ``run`` is not called. **And after:** at most ``row_limit`` rows are kept, cells
become text, and the call is cancelled after ``timeout_seconds``.

**The provider author owes:** binding values as parameters, never interpolating them;
any authorization narrower than the context (``user_email`` is always given;
``user_token`` only when the request carried the caller's own token — never for an
agent); honouring ``row_limit`` at the source; not blocking the event loop. Raise
``TableProviderError`` for a message the user should see; any other exception reaches
the user as a generic failure, named only in the server log.

A parameter the source does not list in ``runtime_params`` always takes the context's
value (or the declared default). One it lists comes, in order, from: the action's fixed
``params`` (not changeable by whoever runs it), the value typed in the table or passed
by an agent, the action's binding to the clicked item (``{node_id}``, ``{prop:x}``),
the context's value, the declared default.
"""

from __future__ import annotations

import inspect
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Optional
from uuid import UUID

from graphlagoon.services.enrichment_providers import (
    PROVIDER_NAME_RE,
    ColumnSpec,
    column_names,
    validate_columns,
)
from graphlagoon.services.precomputed.params import ParamSpec, validate_param_specs

logger = logging.getLogger(__name__)

TargetKind = Literal["node", "edge"]


class TableProviderError(Exception):
    """Raised by a provider; its message is shown to the user as the reason."""


@dataclass
class TableProviderRequest:
    context_id: UUID
    user_email: Optional[str]
    #: The clicked item: ``{type: "node"|"edge", id, node_type, relationship_type,
    #: src, dst}`` (ids are the datasource's own). Its properties are not sent:
    #: what a provider needs from the item arrives as a bound parameter. **Empty**
    #: when the source is asked directly, with no clicked item (an agent's
    #: ``query_source``): read what you need from ``params``, not from here.
    target: dict
    #: Declared parameters only, typed and inside their bounds.
    params: dict[str, Any] = field(default_factory=dict)
    #: Return at most this many rows (more are cut and reported as truncated).
    row_limit: int = 1000
    #: The caller's own access token when the request carried one, else None.
    user_token: Optional[str] = None


@dataclass
class TableProviderResult:
    columns: list[str]
    #: One list per row in ``columns`` order, or one dict per row keyed by column.
    rows: list
    #: True when the source had more rows than were returned.
    truncated: bool = False


TableRunner = Callable[[TableProviderRequest], Awaitable[TableProviderResult]]


@dataclass
class TableProvider:
    name: str
    run: TableRunner
    targets: tuple[TargetKind, ...] = ("node",)
    label: str = ""
    #: What it returns and when to use it: shown where an action is configured, and
    #: given to an AI asked to write actions and to an agent choosing one.
    description: str = ""
    params: list[ParamSpec] = field(default_factory=list)
    #: The columns it returns, to describe them before anyone runs it: names, or
    #: ``ColumnSpec`` with type, meaning and unit. Documentation only.
    columns: tuple = ()
    timeout_seconds: float = 30.0
    #: Which contexts may use it (asked with the context on every run). None: all.
    applies_to: Optional[Callable[[Any], bool]] = None

    def ui_payload(self) -> dict[str, Any]:
        """What the frontend learns: copy, targets and parameters, nothing operational."""
        return {
            "name": self.name,
            "label": self.label or self.name,
            "description": self.description,
            "targets": list(self.targets),
            "params": [p.ui_payload() for p in self.params],
            "columns": column_names(self.columns),
        }


def validate_provider(provider: TableProvider) -> None:
    """Fail at app construction, not at the first run."""
    if not isinstance(provider, TableProvider):
        raise ValueError(
            f"table_providers must hold TableProvider instances, got {type(provider).__name__}"
        )
    if not PROVIDER_NAME_RE.match(provider.name or ""):
        raise ValueError(
            f"Invalid table provider name {provider.name!r}: must match {PROVIDER_NAME_RE.pattern}"
        )
    owner = f"table provider '{provider.name}'"
    fn = provider.run
    while hasattr(fn, "func"):  # see through functools.partial
        fn = fn.func
    if not callable(provider.run) or not inspect.iscoroutinefunction(fn):
        raise ValueError(f"{owner}: run must be an async function")
    if not provider.targets or any(t not in ("node", "edge") for t in provider.targets):
        raise ValueError(f"{owner}: targets must be 'node' and/or 'edge'")
    if not provider.timeout_seconds or provider.timeout_seconds <= 0:
        raise ValueError(f"{owner}: timeout_seconds must be positive")
    validate_param_specs(provider.params, owner=owner, url=False)
    validate_columns(provider.columns, owner)
    if provider.applies_to is not None and not callable(provider.applies_to):
        raise ValueError(f"{owner}: applies_to must be callable")


_REGISTRY: dict[str, TableProvider] = {}


def register_table_provider(provider: TableProvider) -> None:
    """Register a provider; the same object twice is a no-op, another one under a
    taken name is an error (it would change what saved actions run)."""
    validate_provider(provider)
    existing = _REGISTRY.get(provider.name)
    if existing is provider:
        return
    if existing is not None:
        raise ValueError(f"A table provider named '{provider.name}' is already registered")
    _REGISTRY[provider.name] = provider
    logger.info("Registered table provider '%s'", provider.name)


def get_table_provider(name: str) -> Optional[TableProvider]:
    return _REGISTRY.get(name)


def get_table_providers() -> list[TableProvider]:
    return list(_REGISTRY.values())


def clear_table_provider_registry() -> None:
    _REGISTRY.clear()


__all__ = [
    "ColumnSpec",
    "ParamSpec",
    "TableProvider",
    "TableProviderError",
    "TableProviderRequest",
    "TableProviderResult",
    "clear_table_provider_registry",
    "get_table_provider",
    "get_table_providers",
    "register_table_provider",
]
