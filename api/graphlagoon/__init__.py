"""Graph Lagoon Studio - Graph visualization and exploration tool for Spark.

Usage as standalone app:
    uvicorn graphlagoon.main:app --host 0.0.0.0 --port 8000

Usage as importable module (API only):
    from fastapi import FastAPI
    from graphlagoon import create_api_router

    app = FastAPI()
    app.include_router(create_api_router(), prefix="/api")

Usage as mountable sub-app (API + Frontend):
    from fastapi import FastAPI
    from graphlagoon import create_mountable_app, add_mount_redirect

    app = FastAPI()
    sgraph_app = create_mountable_app(mount_prefix="/graphlagoon")

    # Add redirect for /graphlagoon -> /graphlagoon/
    add_mount_redirect(app, "/graphlagoon")

    app.mount("/graphlagoon", sgraph_app)
    # Access at: http://localhost:8000/graphlagoon/

Usage with Databricks (specifying catalog and schema):
    from fastapi import FastAPI
    from graphlagoon import create_mountable_app

    app = FastAPI()
    app.mount("/graphlagoon", create_mountable_app(
        databricks_catalog="my_catalog",
        databricks_schema="my_schema",
    ))

Usage with multiple catalog.schema pairs:
    from fastapi import FastAPI
    from graphlagoon import create_mountable_app

    app = FastAPI()
    app.mount("/graphlagoon", create_mountable_app(
        catalog_schemas=[
            ("catalog_a", "schema_1"),
            ("catalog_b", "schema_2"),
        ],
    ))

Usage with dynamic header provider (token refresh):
    from fastapi import FastAPI
    from graphlagoon import create_mountable_app, HeaderProvider

    # Provider retorna o token (str), não o dict de headers
    async def get_fresh_token() -> str:
        return await my_token_service.get_token()

    app = FastAPI()
    app.mount("/graphlagoon", create_mountable_app(
        header_provider=get_fresh_token,  # Token é convertido para Authorization: Bearer
        databricks_catalog="my_catalog",
        databricks_schema="my_schema",
    ))

Usage with custom user provider (integrate with parent app's auth):
    from fastapi import FastAPI, Request
    from graphlagoon import create_mountable_app, UserProvider

    def get_user_from_parent(request: Request) -> str:
        # Parent app's middleware sets request.state.current_user
        return request.state.current_user.email

    app = FastAPI()
    app.mount("/graphlagoon", create_mountable_app(
        user_provider=get_user_from_parent,
        databricks_catalog="my_catalog",
        databricks_schema="my_schema",
    ))
"""

from graphlagoon.app import (
    create_app,
    create_api_router,
    create_frontend_router,
    create_mountable_app,
    add_mount_redirect,
)
from graphlagoon.config import Settings, get_settings
from graphlagoon.services.warehouse import HeaderProvider
from graphlagoon.middleware.auth import UserProvider, configure_auth
from graphlagoon.similarity import (
    SimilarityEndpointSpec,
    SimilarityEndpointParam,
    register_similarity_endpoint,
)

__all__ = [
    "create_app",
    "create_api_router",
    "create_frontend_router",
    "create_mountable_app",
    "add_mount_redirect",
    "Settings",
    "get_settings",
    "HeaderProvider",
    "UserProvider",
    "configure_auth",
    "SimilarityEndpointSpec",
    "SimilarityEndpointParam",
    "register_similarity_endpoint",
]


def _get_version() -> str:
    """Read version from pyproject.toml (single source of truth)."""
    from importlib.metadata import version, PackageNotFoundError

    try:
        return version("graphlagoon")
    except PackageNotFoundError:
        return "0.0.0-dev"


__version__ = _get_version()
