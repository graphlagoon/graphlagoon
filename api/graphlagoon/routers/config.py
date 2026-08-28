"""Configuration router - exposes app configuration to frontend."""

from fastapi import APIRouter, Request

from graphlagoon.config import get_settings
from graphlagoon.db.database import is_database_available
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.services.datasource import (
    available_datasource_connections,
    available_datasource_types,
)
from graphlagoon.utils.authz import is_superuser

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/config")
async def get_config(request: Request):
    """Get application configuration.

    Returns configuration that the frontend needs to know about,
    such as whether the database is enabled (affects persistence mode).
    """
    settings = get_settings()

    from importlib.metadata import version as pkg_version

    try:
        app_version = pkg_version("graphlagoon")
    except Exception:
        app_version = "dev"

    return {
        "dev_mode": settings.dev_mode,
        "database_enabled": is_database_available(),
        "databricks_mode": settings.databricks_mode,
        # Reading a cache only needs context access; creating and deleting
        # additionally needs dev mode, which the frontend gates on separately.
        "precomputed_graphs_enabled": settings.precomputed_graphs_enabled,
        "style_presets_enabled": settings.style_presets_enabled,
        # Custom metrics: feature on/off, and whether auto_run definitions may
        # evaluate on graph load (false ⇒ Recompute only).
        "custom_metrics_enabled": settings.custom_metrics_enabled,
        "custom_metrics_auto_run_enabled": settings.custom_metrics_auto_run_enabled,
        # Which backends this server can serve. Drives whether the context
        # creation form offers a datasource beyond the SQL warehouse; what each
        # backend can *do* is the frontend's own matrix.
        "datasources": available_datasource_types(),
        # Named datasource instances (REST connections): UI copy plus
        # per-connection operation flags. Transport and auth never leave the
        # process.
        "datasource_connections": available_datasource_connections(),
        "allowed_share_domains": settings.allowed_share_domain_list,
        "default_behaviors": settings.default_behaviors_dict,
        "version": app_version,
        "is_superuser": is_superuser(get_current_user(request)),
    }
