"""A demo enrichment provider and a demo table provider for the dev host (``graphlagoon/main.py``).

Pure Python, so it works with or without Postgres: the values derive from the node id.
A real provider reads Lakebase or a service instead — the recipe is in
docs/guide/python-api.md. The ``DEMO_FAIL`` node type makes it fail on purpose, so the
status chip's error and Retry can be tried.
"""

from __future__ import annotations

import hashlib

from graphlagoon.services.enrichment_providers import (
    EnrichmentProvider,
    EnrichmentProviderError,
    EnrichmentProviderRequest,
    ParamSpec,
)

from graphlagoon.services.table_providers import (
    ColumnSpec,
    TableProvider,
    TableProviderRequest,
    TableProviderResult,
)

TIERS = ("low", "medium", "high")
SCHEMES = {"3-tier": TIERS, "5-tier": ("very low", "low", "medium", "high", "very high")}
CHANNELS = ("pix", "card", "wire")


async def _risk_profile(request: EnrichmentProviderRequest) -> dict[str, dict]:
    if any(n["node_type"] == "DEMO_FAIL" for n in request.nodes):
        raise EnrichmentProviderError("The demo provider refuses DEMO_FAIL nodes")
    tiers = SCHEMES[request.params["scheme"]]
    out: dict[str, dict] = {}
    for node in request.nodes:
        digest = int(hashlib.sha256(node["node_id"].encode()).hexdigest()[:8], 16)
        out[node["node_id"]] = {
            "kyc_tier": tiers[digest % len(tiers)],
            "kyc_score": round((digest % 1000) / 1000, 3),
        }
    return out


def demo_enrichment_providers() -> list[EnrichmentProvider]:
    return [
        EnrichmentProvider(
            name="demo-kyc",
            enrich=_risk_profile,
            targets=("nodes",),
            label="Demo · KYC profile (Python)",
            description="Adds kyc_tier and kyc_score to each node, computed in Python "
            "where a real deployment would read Lakebase. Quick and safe to rerun.",
            timeout_seconds=10.0,
            params=[
                ParamSpec(
                    "scheme", choices=list(SCHEMES), default="3-tier",
                    description="How many risk tiers kyc_tier uses",
                )
            ],
            columns=(
                ColumnSpec("kyc_tier", description="Risk tier of the scheme asked for; 'high' is the riskiest"),
                ColumnSpec("kyc_score", type="float", description="0 (no risk) to 1"),
            ),
        )
    ]


async def _activity(request: TableProviderRequest) -> TableProviderResult:
    """Made-up monthly activity of one node, derived from its id. The id is a parameter
    (the action binds it to the clicked node), so the source also answers when asked
    directly, with no clicked item."""
    months, channel, ident = request.params["months"], request.params["channel"], request.params["node"]
    rows = []
    for back in range(months):
        for name in CHANNELS if channel == "all" else (channel,):
            digest = int(hashlib.sha256(f"{ident}:{back}:{name}".encode()).hexdigest()[:8], 16)
            rows.append([f"month -{back}", name, digest % 40, round((digest % 900000) / 100, 2)])
    return TableProviderResult(
        columns=["month", "channel", "transactions", "amount"],
        rows=rows[: request.row_limit],
        truncated=len(rows) > request.row_limit,
    )


def demo_table_providers() -> list[TableProvider]:
    return [
        TableProvider(
            name="demo-activity",
            run=_activity,
            targets=("node",),
            label="Demo · Monthly activity (Python)",
            description="Transactions and amount per month and channel of one node, computed in "
            "Python where a real deployment would call an internal service. One row per month "
            "and channel; cheap to run.",
            timeout_seconds=10.0,
            params=[
                ParamSpec("node", required=True, description="Id of the node the activity is about"),
                ParamSpec("months", type="int", default=6, min=1, max=24,
                          description="How many months back"),
                ParamSpec("channel", choices=["all", *CHANNELS], default="all",
                          description="One channel, or all of them"),
            ],
            columns=(
                ColumnSpec("month", description="Months back from now: 'month -0' is the current one"),
                ColumnSpec("channel", description="pix, card or wire"),
                ColumnSpec("transactions", type="int", description="Transactions in the month on that channel"),
                ColumnSpec("amount", type="float", description="Total moved", unit="BRL"),
            ),
        )
    ]
