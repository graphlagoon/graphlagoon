"""Walking the provider chain.

This module owns the semantics the registry deliberately does not: who gets
first refusal on a read, who a write goes to, and what happens to every backend
when a context is deleted.

Three different traversals, and the differences are all deliberate:

* **read** — first provider that matches *and* returns something wins.
* **write/delete** — the first provider that *matches* is the only candidate.
  If it has no ``save``, that is a 405; the chain does not fall through to a
  writable provider further down. Writing to somewhere other than where you
  read from is the worst surprise this feature could produce.
* **purge** — *every* provider that declares ``delete_context`` is called,
  because a context's entries can live in several backends at once.

Parameters are coerced **per provider**, which is what lets a chain mix
providers with different declared arguments — a volume that takes none in front
of a query that takes several. Each provider is handed exactly the arguments it
declared, coerced against its own specs; see `plan_resolution` for the three
ways that can fail and why they are not all the same failure.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Optional
from uuid import UUID

from graphlagoon.services.precomputed.params import (
    MAX_PARAMS,
    MAX_PARAMS_BYTES,
    ParamError,
    coerce_params,
)
from graphlagoon.services.precomputed.registry import get_precomputed_graph_providers
from graphlagoon.services.precomputed.request import (
    PrecomputedGraphRequest,
    PrecomputedGraphResult,
)
from graphlagoon.services.precomputed.spec import PrecomputedGraphProvider

logger = logging.getLogger(__name__)


class ProviderFailed(RuntimeError):
    """A provider raised while resolving, matching, writing or deleting.

    Named so the router can answer 502 "the source failed" rather than 500
    "something broke", and carries the provider name so the log says which one.
    """

    def __init__(self, provider: str, operation: str, cause: BaseException) -> None:
        super().__init__(
            f"Precomputed graph provider '{provider}' failed during {operation}: "
            f"{cause}"
        )
        self.provider = provider
        self.operation = operation
        self.cause = cause


def matching_providers(
    request: PrecomputedGraphRequest,
) -> list[PrecomputedGraphProvider]:
    """Providers claiming this request, in chain order.

    A predicate that raises aborts rather than being read as "no match": a
    throwing matcher is a bug, and quietly handing the request to the next
    provider would answer with the wrong graph instead of an error.
    """
    claimed: list[PrecomputedGraphProvider] = []
    for provider in get_precomputed_graph_providers():
        try:
            if provider.accepts(request):
                claimed.append(provider)
        except Exception as exc:  # noqa: BLE001 — re-raised as ProviderFailed
            logger.error(
                "Precomputed graph provider '%s' raised in matches() for "
                "context=%s name=%s",
                provider.name,
                request.context_id,
                request.name,
                exc_info=True,
            )
            raise ProviderFailed(provider.name, "matches", exc) from exc
    return claimed


def first_match(
    request: PrecomputedGraphRequest,
) -> Optional[PrecomputedGraphProvider]:
    """The provider a write or delete belongs to, or None when nothing claims it."""
    claimed = matching_providers(request)
    return claimed[0] if claimed else None


def _shared_guards(items: list[tuple[str, str]]) -> None:
    """Ceilings that hold no matter whose parameters these are.

    Checked once for the whole request rather than per provider: they are about
    the size of the query string, not about what any one provider declared.
    """
    if len(items) > MAX_PARAMS:
        raise ParamError(
            "TOO_MANY_PARAMS",
            f"{len(items)} query parameters supplied, above the {MAX_PARAMS} limit.",
        )
    size = sum(len(key) + len(value) for key, value in items)
    if size > MAX_PARAMS_BYTES:
        raise ParamError(
            "PARAMS_TOO_LARGE",
            f"Query parameters total {size} bytes, above the "
            f"{MAX_PARAMS_BYTES}-byte limit.",
        )

    seen: set[str] = set()
    for key, _ in items:
        if key in seen:
            raise ParamError(
                "DUPLICATE_PARAM",
                f"Parameter '{key}' is given more than once. Supply it exactly "
                "once — the server will not guess which value you meant.",
                param=key,
            )
        seen.add(key)


def _reject_undeclared(
    providers: list[PrecomputedGraphProvider], items: list[tuple[str, str]]
) -> None:
    """A key no matching provider declares is a typo, and typos must be loud.

    Checked against the **union** across the chain rather than one provider, so
    a volume that declares nothing sitting in front of a query that declares
    `seed` does not make `?seed=` an error. The typo protection survives: `?sed=`
    is declared by nobody and still fails.
    """
    declared: set[str] = set()
    for provider in providers:
        declared.update(spec.name for spec in provider.params)

    for key, _ in items:
        if key not in declared:
            raise ParamError(
                "UNKNOWN_PARAM",
                f"Unknown parameter '{key}'. This graph accepts "
                + (
                    f"{sorted(declared)}."
                    if declared
                    else "no parameters."
                ),
                param=key,
                details={"declared": sorted(declared)},
            )


def plan_resolution(
    providers: list[PrecomputedGraphProvider],
    items: list[tuple[str, str]],
) -> list[tuple[PrecomputedGraphProvider, dict]]:
    """Pair each matching provider with the arguments it will actually receive.

    Three ways a provider can fail to take the given arguments, and they are
    deliberately *not* the same failure:

    * **A key nobody declared** — a typo. Hard 400, before anything resolves.
    * **A value outside a provider's declared bounds** — hard 400, even when a
      later provider would have answered. Falling through would serve a graph
      that silently ignored the argument you asked for, and a wrong answer you
      cannot see is worse than an error.
    * **A required parameter this provider did not get** — that provider is
      simply *not applicable*, exactly as if its `matches` had said no. It is
      skipped and the chain continues. This is what lets `?precomputed=x` with
      no arguments hit a volume while a BFS provider requiring `seed` stands
      down.

    Raises ParamError. Returns [] when every provider stood down, which the
    caller reports as 404 unless it prefers to explain why.
    """
    _shared_guards(items)
    _reject_undeclared(providers, items)

    plan: list[tuple[PrecomputedGraphProvider, dict]] = []
    for provider in providers:
        names = {spec.name for spec in provider.params}
        mine = [(key, value) for key, value in items if key in names]
        try:
            plan.append((provider, coerce_params(provider.params, mine)))
        except ParamError as exc:
            if exc.code == "MISSING_PARAM":
                # Not applicable, not wrong. Same standing-down as a matcher.
                logger.debug(
                    "Provider '%s' stood down: %s", provider.name, exc.message
                )
                continue
            raise

    return plan


def missing_requirement(
    providers: list[PrecomputedGraphProvider], items: list[tuple[str, str]]
) -> Optional[ParamError]:
    """Why every provider stood down, when one of them did so for a missing arg.

    Answering 404 "no such graph" when the real problem is a forgotten `?seed=`
    would send someone hunting for a name that is perfectly fine.
    """
    for provider in providers:
        names = {spec.name for spec in provider.params}
        mine = [(key, value) for key, value in items if key in names]
        try:
            coerce_params(provider.params, mine)
        except ParamError as exc:
            if exc.code == "MISSING_PARAM":
                return exc
    return None


async def resolve(
    request: PrecomputedGraphRequest,
    plan: list[tuple[PrecomputedGraphProvider, dict]],
) -> Optional[tuple[PrecomputedGraphProvider, PrecomputedGraphResult]]:
    """Walk the plan until one provider answers. None when all decline.

    Each provider is given a request carrying **its own** coerced parameters,
    which is the whole reason `plan` is passed in rather than recomputed here.
    """
    for provider, params in plan:
        scoped = replace(request, params=params)
        try:
            result = await provider.resolve(scoped)
        except Exception as exc:  # noqa: BLE001 — re-raised as ProviderFailed
            logger.error(
                "Precomputed graph provider '%s' failed resolving context=%s "
                "name=%s params=%s",
                provider.name,
                request.context_id,
                request.name,
                params,
                exc_info=True,
            )
            raise ProviderFailed(provider.name, "resolve", exc) from exc

        if result is not None:
            if not isinstance(result, PrecomputedGraphResult):
                raise ProviderFailed(
                    provider.name,
                    "resolve",
                    TypeError(
                        "resolve must return a PrecomputedGraphResult or None, "
                        f"got {type(result).__name__}"
                    ),
                )
            return provider, result

    return None


async def purge_context(context_id: UUID) -> None:
    """Drop every precomputed graph of a context, across all backends.

    Every provider is given a chance, and one failing does not stop the rest:
    a context delete that half-succeeded should still clean up everywhere it
    can. Failures are logged, never raised — the caller is a cascade that must
    not fail the deletion it is cleaning up after.
    """
    for provider in get_precomputed_graph_providers():
        if provider.delete_context is None:
            continue
        try:
            await provider.delete_context(context_id)
        except Exception:  # noqa: BLE001 — cascade must not fail the deletion
            logger.warning(
                "Precomputed graph provider '%s' failed to purge context %s; "
                "its entries may be left behind.",
                provider.name,
                context_id,
                exc_info=True,
            )


__all__ = [
    "ProviderFailed",
    "first_match",
    "matching_providers",
    "missing_requirement",
    "plan_resolution",
    "purge_context",
    "resolve",
]
