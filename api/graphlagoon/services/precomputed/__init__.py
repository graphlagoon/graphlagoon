"""Precomputed graphs: named graph resources resolved by developer-registered providers.

A precomputed graph is whatever a provider says it is — a file in a volume, a
recursive query against Lakebase parameterised by the URL, a Delta table read
through the SQL warehouse. Providers form an ordered chain; the first one that
matches and answers wins. See ``spec.py`` for the protocol and its security
contract, and ``docs/guide/precomputed-graphs.md`` for worked examples.
"""

from graphlagoon.services.precomputed.params import (
    ParamError,
    ParamSpec,
    coerce_params,
    validate_param_specs,
)
from graphlagoon.services.precomputed.registry import (
    clear_precomputed_graph_registry,
    get_precomputed_graph_provider,
    get_precomputed_graph_providers,
    register_precomputed_graph_provider,
)
from graphlagoon.services.precomputed.request import (
    PrecomputedGraphRequest,
    PrecomputedGraphResult,
)
from graphlagoon.services.precomputed.resolver import (
    ProviderFailed,
    first_match,
    matching_providers,
    missing_requirement,
    plan_resolution,
    purge_context,
    resolve,
)
from graphlagoon.services.precomputed.spec import (
    PrecomputedGraphProvider,
    PrecomputedGraphUI,
    validate_provider,
)
from graphlagoon.services.precomputed.volume import (
    CorruptPayload,
    InvalidPrecomputedName,
    PayloadTooLarge,
    configure_precomputed_storage,
    context_prefix,
    decode_payload,
    default_store,
    precomputed_graphs_enabled,
    precomputed_key,
    reset_precomputed_storage,
    uses_default_store,
    validate_precomputed_name,
    volume_provider,
)

__all__ = [
    "CorruptPayload",
    "InvalidPrecomputedName",
    "ParamError",
    "ParamSpec",
    "PayloadTooLarge",
    "PrecomputedGraphProvider",
    "PrecomputedGraphRequest",
    "PrecomputedGraphResult",
    "PrecomputedGraphUI",
    "ProviderFailed",
    "clear_precomputed_graph_registry",
    "coerce_params",
    "configure_precomputed_storage",
    "context_prefix",
    "decode_payload",
    "default_store",
    "first_match",
    "get_precomputed_graph_provider",
    "get_precomputed_graph_providers",
    "matching_providers",
    "missing_requirement",
    "plan_resolution",
    "precomputed_graphs_enabled",
    "precomputed_key",
    "purge_context",
    "register_precomputed_graph_provider",
    "reset_precomputed_storage",
    "resolve",
    "uses_default_store",
    "validate_param_specs",
    "validate_precomputed_name",
    "validate_provider",
    "volume_provider",
]
