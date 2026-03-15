"""Lakebase (Databricks-managed PostgreSQL) engine and token management.

Handles OAuth token generation, background refresh with retry/backoff,
and SQLAlchemy engine creation for connecting to a Databricks Lakebase instance.
"""

import asyncio
import logging
import os
import uuid
from typing import Optional, Tuple

from sqlalchemy import URL, event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from graphlagoon.config import Settings

logger = logging.getLogger(__name__)

TOKEN_REFRESH_INTERVAL_SECONDS = 50 * 60  # 50 minutes
_MAX_REFRESH_RETRIES = 3
_INITIAL_RETRY_DELAY = 30  # seconds
_FAILURE_RETRY_INTERVAL = 5 * 60  # 5 min — retry soon after total failure


def _get_workspace_client():
    """Import and create WorkspaceClient with clear error on missing SDK."""
    try:
        from databricks.sdk import WorkspaceClient
    except ImportError:
        raise ImportError(
            "databricks-sdk is required for Lakebase support. "
            "Install it with: pip install graphlagoon[lakebase]"
        )
    return WorkspaceClient()


class LakebaseManager:
    """Manages Lakebase engine, token lifecycle, and connection pool.

    Encapsulates all state for a single Lakebase connection: workspace client,
    database instance, OAuth token, SQLAlchemy engine, and background refresh task.
    Uses an asyncio.Lock to prevent concurrent token refreshes (background loop
    vs on-demand refresh triggered by InvalidPasswordError).
    """

    def __init__(self):
        self._workspace_client = None
        self._database_instance = None
        self._postgres_password: Optional[str] = None
        self._engine: Optional[AsyncEngine] = None
        self._token_refresh_task: Optional[asyncio.Task] = None
        self._refresh_lock: Optional[asyncio.Lock] = None

    def _ensure_lock(self):
        """Lazily create the asyncio.Lock (must be in a running event loop)."""
        if self._refresh_lock is None:
            self._refresh_lock = asyncio.Lock()

    def create_engine(
        self, settings: Settings
    ) -> Tuple[AsyncEngine, async_sessionmaker]:
        """Create SQLAlchemy async engine for a Lakebase instance.

        Authenticates via the Databricks SDK, retrieves the instance DNS,
        generates an initial OAuth token, and registers a do_connect event
        to inject the current token on each new connection.

        Returns:
            (engine, session_maker) tuple.
        """
        self._workspace_client = _get_workspace_client()

        instance_name = settings.lakebase_instance_name
        self._database_instance = self._workspace_client.database.get_database_instance(
            name=instance_name
        )

        # Generate initial credentials
        cred = self._workspace_client.database.generate_database_credential(
            request_id=str(uuid.uuid4()),
            instance_names=[self._database_instance.name],
        )
        self._postgres_password = cred.token
        logger.info("Lakebase: initial credentials generated")

        # Resolve username
        username = (
            os.getenv("DATABRICKS_CLIENT_ID")
            or self._workspace_client.current_user.me().user_name
        )

        # Resolve database name
        database_name = settings.lakebase_database_name or self._database_instance.name

        url = URL.create(
            drivername="postgresql+asyncpg",
            username=username,
            password="",  # injected by do_connect event
            host=self._database_instance.read_write_dns,
            port=5432,
            database=database_name,
        )

        # Build connect_args
        server_settings = {"application_name": "graphlagoon"}
        if settings.default_postgres_schema:
            server_settings["search_path"] = settings.default_postgres_schema

        engine = create_async_engine(
            url,
            pool_pre_ping=True,
            echo=settings.dev_mode,
            pool_size=5,
            max_overflow=10,
            pool_timeout=30,
            pool_recycle=2700,  # 45 min — recycle well before token expiry
            connect_args={
                "command_timeout": 30,
                "server_settings": server_settings,
                "ssl": "require",
            },
        )

        self._engine = engine

        # Capture self reference for the closure
        manager = self

        @event.listens_for(engine.sync_engine, "do_connect")
        def provide_token(_dialect, _conn_rec, _cargs, cparams):
            cparams["password"] = manager._postgres_password

        session_maker = async_sessionmaker(
            engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )

        logger.info(
            "Lakebase engine initialized for %s at %s",
            database_name,
            self._database_instance.read_write_dns,
        )
        return engine, session_maker

    async def refresh_token(self):
        """Generate a fresh OAuth token and dispose the connection pool.

        Protected by an asyncio.Lock to prevent concurrent refreshes from
        the background loop and on-demand error handler.

        Raises RuntimeError if called before create_engine().
        """
        if self._workspace_client is None or self._database_instance is None:
            raise RuntimeError(
                "LakebaseManager not initialized — call create_engine() first"
            )

        self._ensure_lock()
        assert self._refresh_lock is not None  # guaranteed by _ensure_lock
        async with self._refresh_lock:
            logger.info("Lakebase: refreshing OAuth token")
            cred = self._workspace_client.database.generate_database_credential(
                request_id=str(uuid.uuid4()),
                instance_names=[self._database_instance.name],
            )
            self._postgres_password = cred.token
            logger.info("Lakebase: token refreshed successfully")

            if self._engine is not None:
                await self._engine.dispose()
                logger.info("Lakebase: connection pool disposed after token refresh")

    async def _refresh_loop(self):
        """Background loop: refresh OAuth token with retry + exponential backoff.

        On success, sleeps for the normal interval (50 min).
        On total failure (all retries exhausted), sleeps only 5 min before
        trying again — never leaves the app stuck with an expired token.
        """
        sleep_interval = TOKEN_REFRESH_INTERVAL_SECONDS
        while True:
            await asyncio.sleep(sleep_interval)
            success = False
            for attempt in range(_MAX_REFRESH_RETRIES):
                try:
                    await self.refresh_token()
                    success = True
                    break
                except Exception as e:
                    delay = min(_INITIAL_RETRY_DELAY * (2**attempt), 300)
                    logger.error(
                        "Lakebase: token refresh attempt %d/%d failed: %s. "
                        "Retry in %ds",
                        attempt + 1,
                        _MAX_REFRESH_RETRIES,
                        e,
                        delay,
                    )
                    if attempt < _MAX_REFRESH_RETRIES - 1:
                        await asyncio.sleep(delay)

            if success:
                sleep_interval = TOKEN_REFRESH_INTERVAL_SECONDS
            else:
                sleep_interval = _FAILURE_RETRY_INTERVAL
                logger.critical(
                    "Lakebase: all %d token refresh attempts failed. "
                    "Retrying in %d min",
                    _MAX_REFRESH_RETRIES,
                    _FAILURE_RETRY_INTERVAL // 60,
                )

    async def start_refresh_loop(self):
        """Start the background token refresh task."""
        if self._token_refresh_task is None or self._token_refresh_task.done():
            self._token_refresh_task = asyncio.create_task(self._refresh_loop())
            logger.info("Lakebase: token refresh task started")

    async def stop_refresh_loop(self):
        """Stop the background token refresh task."""
        if self._token_refresh_task and not self._token_refresh_task.done():
            self._token_refresh_task.cancel()
            try:
                await self._token_refresh_task
            except asyncio.CancelledError:
                pass
            logger.info("Lakebase: token refresh task stopped")
        self._token_refresh_task = None

    def build_url(self, settings: Settings) -> str:
        """Build a connection URL string with a fresh token for Alembic.

        Reuses the existing workspace client if initialized, otherwise
        creates a new one.
        """
        ws = self._workspace_client or _get_workspace_client()

        instance = self._database_instance or ws.database.get_database_instance(
            name=settings.lakebase_instance_name
        )

        cred = ws.database.generate_database_credential(
            request_id=str(uuid.uuid4()),
            instance_names=[instance.name],
        )

        username = os.getenv("DATABRICKS_CLIENT_ID") or ws.current_user.me().user_name
        database_name = settings.lakebase_database_name or instance.name

        url = URL.create(
            drivername="postgresql+asyncpg",
            username=username,
            password=cred.token,
            host=instance.read_write_dns,
            port=5432,
            database=database_name,
        )
        return str(url)

    def reset(self):
        """Reset all state. Called on shutdown."""
        self._workspace_client = None
        self._database_instance = None
        self._postgres_password = None
        self._engine = None
        self._token_refresh_task = None
        self._refresh_lock = None


# ---------------------------------------------------------------------------
# Module-level singleton + backward-compatible wrapper functions
# ---------------------------------------------------------------------------

_manager = LakebaseManager()


def create_lakebase_engine(
    settings: Settings,
) -> Tuple[AsyncEngine, async_sessionmaker]:
    return _manager.create_engine(settings)


async def start_lakebase_token_refresh():
    await _manager.start_refresh_loop()


async def stop_lakebase_token_refresh():
    await _manager.stop_refresh_loop()


def reset_lakebase_state():
    _manager.reset()


def build_lakebase_url(settings: Settings) -> str:
    return _manager.build_url(settings)


async def refresh_lakebase_token():
    """On-demand token refresh (called by exception handler)."""
    await _manager.refresh_token()
