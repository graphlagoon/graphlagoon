"""Configuration router - exposes app configuration to frontend."""

from fastapi import APIRouter, Request

from graphlagoon.middleware.auth import get_current_user
from graphlagoon.services.public_config import build_public_config

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/config")
async def get_config(request: Request):
    """Get application configuration.

    Returns configuration that the frontend needs to know about, such as
    whether the database is enabled (affects persistence mode). Built by
    ``services.public_config.build_public_config`` — the same payload the SPA
    template injects and the admin overview shows.
    """
    return await build_public_config(get_current_user(request))
