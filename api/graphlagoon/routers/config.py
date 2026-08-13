"""Configuration router - exposes app configuration to frontend."""

from fastapi import APIRouter, Request

from graphlagoon.config import get_settings
from graphlagoon.db.database import is_database_available
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.services.datasource import available_datasource_types
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
        # Which backends this server can serve. Drives whether the context
        # creation form offers a datasource beyond the SQL warehouse; what each
        # backend can *do* is the frontend's own matrix.
        "datasources": available_datasource_types(),
        "allowed_share_domains": settings.allowed_share_domain_list,
        "default_behaviors": settings.default_behaviors_dict,
        "version": app_version,
        "is_superuser": is_superuser(get_current_user(request)),
    }
