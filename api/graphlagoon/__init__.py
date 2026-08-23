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

Usage with the built-in Databricks OAuth M2M provider:
    from fastapi import FastAPI
    from graphlagoon import create_mountable_app, get_oauth_service

    # Reads DATABRICKS_HOST / DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET
    # from the environment (provided natively by the Databricks App).
    app = FastAPI()
    app.mount("/graphlagoon", create_mountable_app(
        header_provider=get_oauth_service().get_token,
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

Usage with precomputed graph providers (what `?precomputed=<name>` resolves to):
    from graphlagoon import (
        create_mountable_app, volume_provider,
        PrecomputedGraphProvider, PrecomputedGraphResult, ParamSpec,
    )

    async def bfs(request):
        rows = await run_bound_query(
            seed=request.params["seed"], hops=request.params["hops"]
        )
        if not rows:
            return None          # decline; the next provider is tried
        return PrecomputedGraphResult.from_graph(
            build_graph(rows),
            name=request.name, context_id=request.context_id,
            provider="lakebase-bfs", params=request.params,
        )

    app = FastAPI()
    app.mount("/graphlagoon", create_mountable_app(
        precomputed_graph_providers=[
            # Serve the nightly job's file when there is one...
            volume_provider(writable=False),
            # ...otherwise compute it from the link's own arguments.
            PrecomputedGraphProvider(
                name="lakebase-bfs",
                resolve=bfs,
                params=[
                    ParamSpec("seed", "str", required=True, max_length=64),
                    ParamSpec("hops", "int", default=2, min=1, max=4),
                ],
                # No save/delete: this graph is computed, not stored, so PUT and
                # DELETE answer 405 and the UI hides its publish panel.
            ),
        ],
    ))

    # Omitting `precomputed_graph_providers` registers the built-in volume
    # provider alone; passing [] serves no precomputed graphs at all.
    # See docs/guide/precomputed-graphs.md, and read the security contract in
    # services/precomputed/spec.py before writing a provider — URL arguments
    # reach your query.
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
from graphlagoon.services.databricks_oauth import (
    DatabricksOAuthService,
    OAuthToken,
    get_databricks_oauth_service,
    get_oauth_service,
)
from graphlagoon.middleware.auth import UserProvider, configure_auth
from graphlagoon.similarity import (
    SimilarityEndpointSpec,
    SimilarityEndpointParam,
    register_similarity_endpoint,
)
from graphlagoon.services.datasource.rest import (
    RestConnectionSpec,
    RestConnectionUI,
    RestRequest,
    register_rest_connection,
)
from graphlagoon.models.schemas import (
    Edge,
    Node,
    PrecomputedGraphData,
    PrecomputedGraphPayload,
    PrecomputedGraphSource,
)
from graphlagoon.services.precomputed import (
    ParamSpec,
    PrecomputedGraphProvider,
    PrecomputedGraphRequest,
    PrecomputedGraphResult,
    PrecomputedGraphUI,
    register_precomputed_graph_provider,
    volume_provider,
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
    "DatabricksOAuthService",
    "OAuthToken",
    "get_databricks_oauth_service",
    "get_oauth_service",
    "UserProvider",
    "configure_auth",
    "SimilarityEndpointSpec",
    "SimilarityEndpointParam",
    "register_similarity_endpoint",
    "RestConnectionSpec",
    "RestConnectionUI",
    "RestRequest",
    "register_rest_connection",
    "Node",
    "Edge",
    "ParamSpec",
    "PrecomputedGraphData",
    "PrecomputedGraphPayload",
    "PrecomputedGraphProvider",
    "PrecomputedGraphRequest",
    "PrecomputedGraphResult",
    "PrecomputedGraphSource",
    "PrecomputedGraphUI",
    "register_precomputed_graph_provider",
    "volume_provider",
]


def _get_version() -> str:
    """Read version from pyproject.toml (single source of truth)."""
    from importlib.metadata import version, PackageNotFoundError

    try:
        return version("graphlagoon")
    except PackageNotFoundError:
        return "0.0.0-dev"


__version__ = _get_version()
