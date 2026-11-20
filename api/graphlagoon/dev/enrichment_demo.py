"""A demo enrichment provider for the dev host (``graphlagoon/main.py``).

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
)

TIERS = ("low", "medium", "high")


async def _risk_profile(request: EnrichmentProviderRequest) -> dict[str, dict]:
    if any(n["node_type"] == "DEMO_FAIL" for n in request.nodes):
        raise EnrichmentProviderError("The demo provider refuses DEMO_FAIL nodes")
    out: dict[str, dict] = {}
    for node in request.nodes:
        digest = int(hashlib.sha256(node["node_id"].encode()).hexdigest()[:8], 16)
        out[node["node_id"]] = {
            "kyc_tier": TIERS[digest % 3],
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
            "where a real deployment would read Lakebase.",
            timeout_seconds=10.0,
        )
    ]
