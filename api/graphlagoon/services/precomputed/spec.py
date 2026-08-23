"""Specification for a precomputed graph provider.

A *precomputed graph* is a named graph resource resolved server-side. Where it
comes from is the deploying developer's decision, not this library's: a file in a
Unity Catalog volume, a recursive query against Lakebase parameterised by the
URL, a Delta table read through the SQL warehouse, an internal service. A parent
app registers one provider per source when calling
``create_mountable_app(precomputed_graph_providers=[...])`` — the same
registration idiom as ``rest_connections`` and ``similarity_endpoints``.

Providers form an **ordered chain**. Each may declare ``matches`` to say which
requests are its business; ``resolve`` returning ``None`` declines and the next
provider is tried. That is what makes composition free::

    precomputed_graph_providers=[volume_provider(), lakebase_bfs]

reads the nightly job's file when it exists and computes the graph when it does
not, with no extra machinery.

Capabilities are **derived** from what is declared: a provider with no ``save``
answers 405 on PUT and the frontend hides its write panel. There is no override
flag that could drift out of sync with reality — the same doctrine
``RestConnectionSpec.rest_ops`` follows.

Trust model
-----------
Providers are declared by the developer embedding the app, in code, and run
in-process with whatever credentials that process holds. URL parameters, by
contrast, come from whoever opened the link.

**The framework guarantees, before ``resolve`` is awaited:**

* ``params`` holds *only the names this provider declared*, each coerced to its
  declared type and inside its declared ``choices`` / ``min`` / ``max`` /
  ``max_length``. Coercion is per provider, so a sibling in the chain declaring
  different arguments changes nothing about what arrives here. A required
  argument that was not supplied means ``resolve`` is not called at all — the
  provider stands down and the chain continues.
* ``name`` passed ``ARTIFACT_NAME_RE`` — it never contains ``/``, quotes,
  whitespace or NUL.
* ``context_id`` is a real UUID and the caller **has read access to that
  context**; ``user_email`` came from the auth middleware.
* An exception from ``resolve`` becomes a 502 with the provider named in the
  server log and a generic message in the response.

**The provider author owes:**

* *A coerced ``str`` is still attacker-controlled text.* ``type="str"``
  guarantees the type, never the content. Bind it (``:x``, ``%(x)s``, ``?``);
  never interpolate it into SQL.
* *A value in an identifier position needs ``choices``.* Table, column,
  partition, sort key — an allowlist is the only safe way to put a user value
  there, and it is why ``choices`` exists.
* *``min``/``max`` is the only cost control there is.* Declare it on anything
  that becomes a LIMIT, an offset, a lookback window or a hop count, or a link
  can ask the warehouse for everything.
* *Authorization narrower than the context is yours.* The framework knows
  nothing about row-level access to your tables; re-check ``user_email`` inside
  ``resolve`` when the data is narrower than the context.
* *Result size is yours.* ``max_bytes`` is enforced on volume *writes* only. A
  ``resolve`` that builds a payload in memory can return an unbounded graph.
* *Timeouts are yours.* ``resolve`` is awaited with no framework timeout — the
  same stance this library takes for REST connections.
"""

from __future__ import annotations

import inspect
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from graphlagoon.services.precomputed.params import ParamSpec, validate_param_specs
from graphlagoon.services.precomputed.request import (
    PrecomputedGraphRequest,
    PrecomputedGraphResult,
)

#: Provider names appear in stored payloads, log lines and the capabilities
#: endpoint; keep them a tame slug, as REST connection names are.
PROVIDER_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,49}$")

Resolver = Callable[[PrecomputedGraphRequest], Awaitable[Optional[PrecomputedGraphResult]]]
Matcher = Callable[[PrecomputedGraphRequest], bool]


@dataclass
class PrecomputedGraphUI:
    """Copy describing this provider to the frontend.

    Rebuilt field-by-field into `ui_payload` rather than serialized wholesale,
    so nothing operational can leak into a client-facing response by accident.
    """

    label: str = ""
    description: str = ""
    caveat: str = ""


@dataclass
class PrecomputedGraphProvider:
    """One source of precomputed graphs.

    ``resolve`` is the only required behaviour. Everything else is opt-in, and
    what is left ``None`` is genuinely off — not defaulted to something plausible.
    """

    name: str
    resolve: Resolver

    #: URL parameters this provider accepts. Anything not declared here is a 400
    #: before `resolve` runs; see params.py.
    params: list[ParamSpec] = field(default_factory=list)

    #: Which requests are this provider's business. None means "all of them".
    #: A predicate that raises aborts the request rather than being read as "no
    #: match" — silently serving the next provider's graph is worse than a 502.
    matches: Optional[Matcher] = None

    # ── Write capabilities (absence == capability off) ───────────────────
    save: Optional[Callable[..., Awaitable[Any]]] = None
    delete: Optional[Callable[..., Awaitable[None]]] = None
    #: Called when a context is deleted. Unlike resolve, *every* provider that
    #: declares this is called — a context's entries can live in several places.
    delete_context: Optional[Callable[..., Awaitable[None]]] = None

    ui: Optional[PrecomputedGraphUI] = None

    def accepts(self, request: PrecomputedGraphRequest) -> bool:
        """Whether this provider claims `request`. No matcher means yes."""
        return True if self.matches is None else bool(self.matches(request))

    def capabilities(self) -> dict[str, bool]:
        """Per-provider capability flags, derived from the declared callables."""
        return {
            "write": self.save is not None,
            "delete": self.delete is not None,
        }

    def ui_payload(self) -> dict[str, Any]:
        """The frontend-facing description of this provider."""
        ui = self.ui or PrecomputedGraphUI()
        return {
            "name": self.name,
            "label": ui.label or self.name,
            "description": ui.description,
            "caveat": ui.caveat,
            "capabilities": self.capabilities(),
            "params": [spec.ui_payload() for spec in self.params],
        }


def validate_provider(provider: PrecomputedGraphProvider) -> None:
    """Reject a malformed provider at registration time.

    Failing here means failing at app construction — the developer sees it on
    startup, not the first user at open-a-link time.
    """
    if not isinstance(provider, PrecomputedGraphProvider):
        raise ValueError(
            "precomputed_graph_providers must hold PrecomputedGraphProvider "
            f"instances, got {type(provider).__name__}"
        )

    if not PROVIDER_NAME_RE.match(provider.name or ""):
        raise ValueError(
            f"Invalid precomputed graph provider name {provider.name!r}: must "
            f"match {PROVIDER_NAME_RE.pattern} (lowercase slug, max 50 chars)"
        )

    owner = f"precomputed graph provider '{provider.name}'"

    if not callable(provider.resolve):
        raise ValueError(f"{owner}: resolve is required and must be callable")
    if not inspect.iscoroutinefunction(_unwrap(provider.resolve)):
        raise ValueError(
            f"{owner}: resolve must be an async function — it is awaited on the "
            "request path."
        )

    for attr in ("matches", "save", "delete", "delete_context"):
        value = getattr(provider, attr)
        if value is not None and not callable(value):
            raise ValueError(f"{owner}: {attr} must be callable or None")

    if provider.delete is not None and provider.save is None:
        raise ValueError(
            f"{owner}: declares delete without save. A provider that can remove "
            "entries it cannot create is almost always a wiring mistake; pass "
            "save=None and delete=None for a read-only provider."
        )

    validate_param_specs(provider.params, owner=owner)


def _unwrap(fn: Any) -> Any:
    """See through functools.partial so an async partial still reads as async."""
    while hasattr(fn, "func"):
        fn = fn.func
    return fn


__all__ = [
    "PROVIDER_NAME_RE",
    "PrecomputedGraphProvider",
    "PrecomputedGraphUI",
    "validate_provider",
]
