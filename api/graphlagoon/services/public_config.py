"""The configuration payload the frontend receives.

Built in exactly one place so ``GET /api/config``, the SPA template
injection (``window.__GRAPH_LAGOON_CONFIG__``) and the admin overview can
never disagree. Add a flag here and every consumer — including the admin
area's "feature flags" card — sees it.
"""

from __future__ import annotations

from typing import Optional

from graphlagoon.config import Settings, get_settings
from graphlagoon.db.database import is_database_available
from graphlagoon.services.datasource import (
    available_datasource_connections,
    available_datasource_types,
)
from graphlagoon.utils.authz import is_superuser


def app_version() -> str:
    from graphlagoon import __version__

    return __version__


def build_public_config(
    user_email: Optional[str], settings: Optional[Settings] = None
) -> dict:
    """Public, per-user configuration. Contains no secrets and no user lists."""
    if settings is None:
        settings = get_settings()
    return {
        "dev_mode": settings.dev_mode,
        "database_enabled": is_database_available(),
        "databricks_mode": settings.databricks_mode,
        # Reading a precomputed graph only needs context access; creating and
        # deleting additionally needs superuser status plus a capable provider.
        "precomputed_graphs_enabled": settings.precomputed_graphs_enabled,
        "style_presets_enabled": settings.style_presets_enabled,
        # Custom metrics: feature on/off, and whether auto_run definitions may
        # evaluate on graph load (false ⇒ Recompute only).
        "custom_metrics_enabled": settings.custom_metrics_enabled,
        "custom_metrics_auto_run_enabled": settings.custom_metrics_auto_run_enabled,
        # Which backends this server can serve, and the named REST connections
        # (UI copy + operation flags only; transport and auth never leave the
        # process).
        "datasources": available_datasource_types(),
        "datasource_connections": available_datasource_connections(),
        "allowed_share_domains": settings.allowed_share_domain_list,
        "default_behaviors": settings.default_behaviors_dict,
        "version": app_version(),
        # Per-user boolean only; the superuser list itself is admin-only.
        "is_superuser": is_superuser(user_email) if user_email else False,
    }
