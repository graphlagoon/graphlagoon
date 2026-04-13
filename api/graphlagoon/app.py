"""Factory functions for creating Graph Lagoon Studio FastAPI applications."""

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
import json
import logging

from fastapi import FastAPI, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from graphlagoon.config import get_settings, Settings
from graphlagoon.db.database import (
    create_tables,
    close_database,
    is_database_available,
    configure_database,
    is_lakebase_auth_error,
)
from graphlagoon.services.warehouse import (
    close_warehouse_client,
    configure_warehouse,
    HeaderProvider,
)
from graphlagoon.services.snapshot import configure_snapshot_service
from graphlagoon.middleware.auth import AuthMiddleware, configure_auth, UserProvider

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def add_exception_handlers(app: FastAPI, show_error_details: bool = True) -> None:
    """Add global exception handlers to capture and return detailed errors.

    This helps debug 500 errors by returning structured error responses
    instead of generic "Internal Server Error" messages.

    Args:
        app: The FastAPI application.
        show_error_details: If True, include traceback and exception type in error responses.
                           Controlled by GRAPH_LAGOON_SHOW_ERROR_DETAILS setting.
    """

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        """Handle unhandled exceptions with detailed error response."""
        import traceback

        # Lakebase token expiry: refresh token, dispose pool, return 503
        if is_lakebase_auth_error(exc):
            logger.warning("Lakebase auth error detected, refreshing token: %s", exc)
            try:
                from graphlagoon.db.lakebase import refresh_lakebase_token

                await refresh_lakebase_token()
            except Exception as refresh_err:
                logger.error("Emergency token refresh failed: %s", refresh_err)
            return JSONResponse(
                status_code=503,
                headers={"Retry-After": "1"},
                content={
                    "detail": {
                        "error": {
                            "code": "DATABASE_AUTH_EXPIRED",
                            "message": "Database authentication expired. Please retry.",
                            "details": {},
                        }
                    }
                },
            )

        # Log the full traceback
        tb_str = traceback.format_exc()
        logger.error(f"Unhandled exception: {exc}\n{tb_str}")

        # Return structured error response
        details: dict = {}
        if show_error_details:
            details["exception_type"] = type(exc).__name__
            details["traceback"] = tb_str.split("\n")

        return JSONResponse(
            status_code=500,
            content={
                "detail": {
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": str(exc),
                        "details": details,
                    }
                }
            },
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        """Handle HTTP exceptions with consistent format."""
        # If detail is already structured, return as-is
        if isinstance(exc.detail, dict) and "error" in exc.detail:
            return JSONResponse(
                status_code=exc.status_code, content={"detail": exc.detail}
            )

        # Wrap simple string details in structured format
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "detail": {
                    "error": {
                        "code": f"HTTP_{exc.status_code}",
                        "message": str(exc.detail)
                        if exc.detail
                        else "An error occurred",
                        "details": {},
                    }
                }
            },
        )


# Paths for static files and templates
PACKAGE_DIR = Path(__file__).parent
STATIC_DIR = PACKAGE_DIR / "static"
TEMPLATES_DIR = PACKAGE_DIR / "templates"


def load_vite_manifest() -> dict:
    """Load Vite manifest to get asset paths with hashes."""
    manifest_path = STATIC_DIR / ".vite" / "manifest.json"
    if manifest_path.exists():
        return json.loads(manifest_path.read_text())
    # Fallback for dev mode or when manifest doesn't exist
    return {}


def get_assets_from_manifest(manifest: dict) -> dict:
    """Extract JS and CSS assets from Vite manifest."""
    js_files = []
    css_files = []

    # Look for the entry point (index.html in Vite manifest)
    entry = manifest.get("index.html", {})
    if entry:
        if "file" in entry:
            js_files.append(entry["file"])
        if "css" in entry:
            css_files.extend(entry["css"])

    # Look for standalone CSS (when cssCodeSplit: false)
    style_entry = manifest.get("style.css", {})
    if style_entry and "file" in style_entry:
        css_files.append(style_entry["file"])

    return {"js": js_files, "css": css_files}


def create_api_router(settings: Optional[Settings] = None) -> APIRouter:
    """Create API router with all Graph Lagoon Studio endpoints.

    This router can be mounted in an existing FastAPI app.

    Args:
        settings: Optional settings override. Uses get_settings() if not provided.

    Returns:
        APIRouter with all API endpoints.
    """
    if settings is None:
        settings = get_settings()

    from graphlagoon.routers import (
        graph_contexts,
        explorations,
        graph,
        catalog,
        config,
        query_templates,
    )

    router = APIRouter()
    router.include_router(config.router)
    router.include_router(graph_contexts.router)
    router.include_router(explorations.router)
    router.include_router(query_templates.router)
    router.include_router(graph.router)
    router.include_router(catalog.router)

    return router


def create_frontend_router(
    settings: Optional[Settings] = None,
    static_prefix: str = "/static",
    router_base: str = "/",
    api_prefix: str = "",
) -> APIRouter:
    """Create frontend router that serves the SPA.

    Args:
        settings: Optional settings override.
        static_prefix: Prefix for static files (used in template).
        router_base: Base path for Vue Router (e.g., "/graphlagoon/" when mounted).
        api_prefix: Prefix for API calls (e.g., "/graphlagoon" when mounted).

    Returns:
        APIRouter that serves the frontend SPA.
    """
    if settings is None:
        settings = get_settings()

    router = APIRouter()

    # Check if templates directory exists
    if not TEMPLATES_DIR.exists():
        logger.warning(f"Templates directory not found: {TEMPLATES_DIR}")
        return router

    templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

    def render_spa(request: Request):
        """Render the SPA template."""
        manifest = load_vite_manifest()
        assets = get_assets_from_manifest(manifest)

        from graphlagoon import __version__

        config = {
            "dev_mode": settings.dev_mode,
            "database_enabled": is_database_available(),
            "databricks_mode": settings.databricks_mode,
            "router_base": router_base,
            "allowed_share_domains": settings.allowed_share_domain_list,
            "version": __version__,
        }
        # Inject user email so frontend auto-logins
        user_email = getattr(request.state, "user_email", None)
        if user_email:
            config["databricks_user_email"] = user_email

        return templates.TemplateResponse(
            "index.html",
            {
                "request": request,
                "api_url": api_prefix,
                "static_prefix": static_prefix,
                "assets": assets,
                "config": config,
            },
        )

    @router.get("/", response_class=HTMLResponse)
    async def serve_frontend_root(request: Request):
        """Serve the SPA for root route."""
        return render_spa(request)

    @router.get("/{path:path}", response_class=HTMLResponse)
    async def serve_frontend(request: Request, path: str = ""):
        """Serve the SPA for all non-API/static routes."""
        # Skip paths that should be handled by other handlers
        if path.startswith(("api/", "static/", "docs", "openapi.json", "health")):
            from fastapi import HTTPException

            raise HTTPException(status_code=404, detail="Not found")
        return render_spa(request)

    return router


def add_mount_redirect(app: FastAPI, mount_path: str) -> None:
    """Add a redirect route for a mounted sub-application.

    When you mount a FastAPI app at a path like '/graphlagoon', accessing
    '/graphlagoon' (without trailing slash) may not redirect properly to
    '/graphlagoon/' (with trailing slash). This helper adds that redirect.

    Args:
        app: The parent FastAPI application
        mount_path: The path where the sub-app is mounted (e.g., "/graphlagoon")

    Example:
        from fastapi import FastAPI
        from graphlagoon import create_mountable_app, add_mount_redirect

        main_app = FastAPI()
        sgraph_app = create_mountable_app(mount_prefix="/graphlagoon")

        # Add redirect before mounting
        add_mount_redirect(main_app, "/graphlagoon")
        main_app.mount("/graphlagoon", sgraph_app)
    """

    @app.get(mount_path)
    async def redirect_to_mounted_app():
        return RedirectResponse(url=f"{mount_path}/")


def create_mountable_app(
    settings: Optional[Settings] = None,
    include_frontend: bool = True,
    mount_prefix: str = "/",
    header_provider: Optional[HeaderProvider] = None,
    user_provider: Optional[UserProvider] = None,
    databricks_catalog: Optional[str] = None,
    databricks_schema: Optional[str] = None,
    catalog_schemas: Optional[list[tuple[str, str]]] = None,
) -> FastAPI:
    """Create a Graph Lagoon Studio app that can be mounted under a prefix.

    Use this when embedding Graph Lagoon Studio in an existing FastAPI application.

    IMPORTANT: When mounting the app, you should also add a redirect for the
    mount path without trailing slash. Use the add_mount_redirect() helper
    function for this.

    Example:
        from fastapi import FastAPI
        from graphlagoon import create_mountable_app, add_mount_redirect

        main_app = FastAPI()
        sgraph_app = create_mountable_app(mount_prefix="/graphlagoon")

        # Add redirect: /graphlagoon -> /graphlagoon/
        add_mount_redirect(main_app, "/graphlagoon")

        # Mount the app
        main_app.mount("/graphlagoon", sgraph_app)

        # Access at: http://localhost:8000/graphlagoon/

    Example with dynamic header provider (token refresh):
        async def get_fresh_headers():
            token = await my_token_service.get_token()
            return {"Authorization": f"Bearer {token}"}

        sgraph_app = create_mountable_app(
            settings=my_settings,
            header_provider=get_fresh_headers,
            databricks_catalog="my_catalog",
            databricks_schema="my_schema",
        )

    Example with multiple catalog.schema pairs:
        sgraph_app = create_mountable_app(
            settings=my_settings,
            catalog_schemas=[
                ("catalog_a", "schema_1"),
                ("catalog_b", "schema_2"),
            ],
        )

    Example with custom user provider (integrate with parent app's auth):
        def get_user_from_parent(request: Request) -> str:
            # Parent app sets request.state.current_user
            return request.state.current_user.email

        sgraph_app = create_mountable_app(
            settings=my_settings,
            user_provider=get_user_from_parent,
        )

    Args:
        settings: Optional settings override.
        include_frontend: Whether to include frontend serving.
        mount_prefix: The prefix where this app will be mounted (e.g., "/graphlagoon").
                      Used to configure Vue Router's base path.
        header_provider: Optional async/sync callable that returns auth token string.
                        Called before each warehouse request to get a fresh token.
                        The token is automatically wrapped in Authorization: Bearer header.
                        Takes precedence over settings.databricks_token.
        user_provider: Optional async/sync callable that extracts user email from request.
                      Use this when parent app has its own auth middleware.
                      If not provided, reads from X-User-Email or X-Forwarded-Email headers.
        databricks_catalog: Override catalog for Databricks queries.
                           Required when databricks_mode=True if not in settings.
        databricks_schema: Override schema for Databricks queries.
                          Required when databricks_mode=True if not in settings.
        catalog_schemas: List of (catalog, schema) tuples to search for datasets.
                        When set, list_datasets will search all specified pairs.
                        Overrides the single databricks_catalog/databricks_schema for discovery.

    Returns:
        FastAPI app that can be mounted at any prefix.
    """
    if settings is None:
        settings = get_settings()

    # Override catalog/schema if provided
    overrides = {}
    if databricks_catalog is not None:
        overrides["databricks_catalog"] = databricks_catalog
    if databricks_schema is not None:
        overrides["databricks_schema"] = databricks_schema
    if catalog_schemas is not None:
        overrides["catalog_schemas"] = ",".join(f"{c}.{s}" for c, s in catalog_schemas)
    if overrides:
        settings = Settings(**{**settings.model_dump(), **overrides})

    # Configure database, warehouse, snapshot service, and auth
    configure_database(settings)
    configure_warehouse(settings, header_provider=header_provider)
    configure_snapshot_service(settings, header_provider=header_provider)
    if user_provider is not None:
        configure_auth(user_provider=user_provider)

    @asynccontextmanager
    async def mountable_lifespan(app: FastAPI):
        if not settings.databricks_volume_path:
            Path(settings.exploration_snapshots_dir).mkdir(
                parents=True, exist_ok=True
            )
        if is_database_available():
            await create_tables()
            if settings.lakebase_enabled:
                from graphlagoon.db.lakebase import start_lakebase_token_refresh

                await start_lakebase_token_refresh()
        yield
        if settings.lakebase_enabled:
            from graphlagoon.db.lakebase import stop_lakebase_token_refresh

            await stop_lakebase_token_refresh()
        await close_database()

    app = FastAPI(
        description="Graph visualization and exploration tool",
        lifespan=mountable_lifespan,
    )

    # Add exception handlers for better error visibility
    add_exception_handlers(app, show_error_details=settings.show_error_details)

    # Static files
    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # API routers
    api_router = create_api_router(settings)
    app.include_router(api_router)

    # Frontend router
    if include_frontend and TEMPLATES_DIR.exists():
        # Ensure router_base ends with / for Vue Router
        prefix_clean = mount_prefix.rstrip("/")
        router_base = f"{prefix_clean}/" if prefix_clean else "/"
        api_prefix = prefix_clean  # API calls use mount prefix
        frontend_router = create_frontend_router(
            settings,
            static_prefix=f"{prefix_clean}/static" if prefix_clean else "/static",
            router_base=router_base,
            api_prefix=api_prefix,
        )
        app.include_router(frontend_router)

    @app.get("/health")
    async def health_check():
        return {"status": "healthy"}

    return app


def create_app(
    settings: Optional[Settings] = None,
    include_frontend: bool = True,
    cors_origins: Optional[list[str]] = None,
    header_provider: Optional[HeaderProvider] = None,
    databricks_catalog: Optional[str] = None,
    databricks_schema: Optional[str] = None,
    catalog_schemas: Optional[list[tuple[str, str]]] = None,
) -> FastAPI:
    """Create a standalone Graph Lagoon Studio FastAPI application.

    Args:
        settings: Optional settings override. Uses get_settings() if not provided.
        include_frontend: Whether to include frontend serving (default True).
        cors_origins: List of allowed CORS origins. Default allows all.
        header_provider: Optional async/sync callable that returns auth token string.
                        Called before each warehouse request to get a fresh token.
                        The token is automatically wrapped in Authorization: Bearer header.
        databricks_catalog: Override catalog for Databricks queries.
                           Required when databricks_mode=True if not in settings.
        databricks_schema: Override schema for Databricks queries.
                          Required when databricks_mode=True if not in settings.
        catalog_schemas: List of (catalog, schema) tuples to search for datasets.
                        When set, list_datasets will search all specified pairs.

    Returns:
        Configured FastAPI application.
    """
    if settings is None:
        settings = get_settings()

    # Override catalog/schema if provided
    overrides = {}
    if databricks_catalog is not None:
        overrides["databricks_catalog"] = databricks_catalog
    if databricks_schema is not None:
        overrides["databricks_schema"] = databricks_schema
    if catalog_schemas is not None:
        overrides["catalog_schemas"] = ",".join(f"{c}.{s}" for c, s in catalog_schemas)
    if overrides:
        settings = Settings(**{**settings.model_dump(), **overrides})

    # Configure database, warehouse, and snapshot service (lazy initialization)
    configure_database(settings)
    configure_warehouse(settings, header_provider=header_provider)
    configure_snapshot_service(settings, header_provider=header_provider)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Startup
        logger.info("Starting Graph Lagoon Studio...")
        logger.info(f"Dev mode: {settings.dev_mode}")
        logger.info(f"Database enabled: {settings.database_enabled}")
        logger.info(f"Lakebase enabled: {settings.lakebase_enabled}")
        logger.info(f"Databricks mode: {settings.databricks_mode}")

        if not settings.databricks_volume_path:
            Path(settings.exploration_snapshots_dir).mkdir(
                parents=True, exist_ok=True
            )
            logger.info(
                "Snapshot directory: %s", settings.exploration_snapshots_dir
            )

        if is_database_available():
            await create_tables()
            logger.info("Database tables created/verified")
            if settings.lakebase_enabled:
                from graphlagoon.db.lakebase import start_lakebase_token_refresh

                await start_lakebase_token_refresh()
        else:
            logger.info("Database disabled - running without persistence")

        yield

        # Shutdown
        logger.info("Shutting down Graph Lagoon Studio...")
        if settings.lakebase_enabled:
            from graphlagoon.db.lakebase import stop_lakebase_token_refresh

            await stop_lakebase_token_refresh()
        await close_warehouse_client()
        await close_database()
        logger.info("Cleanup complete")

    app = FastAPI(
        title="Graph Lagoon Studio",
        description="Graph visualization and exploration tool",
        version="0.1.0",
        lifespan=lifespan,
    )

    # Add exception handlers for better error visibility
    add_exception_handlers(app, show_error_details=settings.show_error_details)

    # CORS middleware
    origins = cors_origins or ["*"]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Auth middleware
    app.add_middleware(AuthMiddleware)

    # Static files FIRST (must come before routers to take precedence)
    if STATIC_DIR.exists():
        app.mount(
            "/graphlagoon/static", StaticFiles(directory=str(STATIC_DIR)), name="static"
        )
        logger.info(f"Static files mounted from: {STATIC_DIR}")

    # Include API routers under /graphlagoon prefix
    api_router = create_api_router(settings)
    app.include_router(api_router, prefix="/graphlagoon")

    # Frontend router (must be last - catches all routes)
    if include_frontend and TEMPLATES_DIR.exists():
        frontend_router = create_frontend_router(
            settings,
            static_prefix="/graphlagoon/static",
            router_base="/graphlagoon/",
            api_prefix="/graphlagoon",
        )
        app.include_router(frontend_router, prefix="/graphlagoon")

    # Redirect root to /graphlagoon/
    @app.get("/")
    async def redirect_to_graphlagoon():
        return RedirectResponse(url="/graphlagoon/")

    # Health check endpoint
    @app.get("/health")
    async def health_check():
        """Health check endpoint."""
        return {
            "status": "healthy",
            "dev_mode": settings.dev_mode,
            "database_enabled": settings.database_enabled,
            "databricks_mode": settings.databricks_mode,
        }

    return app
