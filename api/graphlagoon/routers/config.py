"""Configuration router - exposes app configuration to frontend."""

from fastapi import APIRouter

from graphlagoon.config import get_settings
from graphlagoon.db.database import is_database_available

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/config")
async def get_config():
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
        "allowed_share_domains": settings.allowed_share_domain_list,
        "version": app_version,
    }
