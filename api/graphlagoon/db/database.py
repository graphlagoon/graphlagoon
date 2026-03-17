import logging
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from typing import AsyncGenerator, Optional
from fastapi import HTTPException

from graphlagoon.config import Settings

logger = logging.getLogger(__name__)

# Global state for lazy initialization
_engine = None
_async_session_maker = None
_settings: Optional[Settings] = None


class Base(DeclarativeBase):
    pass


def configure_database(settings: Settings) -> None:
    """Configure database with given settings. Call before first use."""
    global _settings, _engine, _async_session_maker
    _settings = settings

    # Reset connection if reconfiguring
    if _engine is not None:
        # Note: This is sync, but we're just clearing the reference
        # The actual disposal should happen via close_database()
        _engine = None
        _async_session_maker = None


def _ensure_initialized() -> None:
    """Ensure database is initialized. Uses lazy initialization."""
    global _engine, _async_session_maker, _settings

    if _settings is None:
        # Use default settings if not configured
        from graphlagoon.config import get_settings

        _settings = get_settings()

    if not _settings.database_enabled or _engine is not None:
        return

    # Lakebase backend (Databricks-managed PostgreSQL)
    if _settings.lakebase_enabled:
        from graphlagoon.db.lakebase import create_lakebase_engine

        _engine, _async_session_maker = create_lakebase_engine(_settings)
        return

    # Standard PostgreSQL backend
    if _settings.database_url:
        _engine = create_async_engine(
            _settings.database_url,
            echo=_settings.dev_mode,
            pool_pre_ping=True,
        )
        _async_session_maker = async_sessionmaker(
            _engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )


def is_database_available() -> bool:
    """Check if database is configured and available."""
    _ensure_initialized()
    return (
        _settings is not None
        and _settings.database_enabled
        and _async_session_maker is not None
    )


def get_session_maker():
    """Get the async session maker. Returns None if database is not available."""
    _ensure_initialized()
    return _async_session_maker


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Get database session. Raises 503 if database is not available."""
    _ensure_initialized()

    if not is_database_available():
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "code": "DATABASE_UNAVAILABLE",
                    "message": "Database is not configured. Set GRAPH_LAGOON_DATABASE_ENABLED=true and GRAPH_LAGOON_DATABASE_URL to enable persistence.",
                    "details": {},
                }
            },
        )

    async with _async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def get_db_optional() -> AsyncGenerator[Optional[AsyncSession], None]:
    """Get database session if available, otherwise yield None."""
    _ensure_initialized()

    if not is_database_available():
        yield None
        return

    async with _async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def create_tables():
    """Run Alembic migrations to create/update database schema.

    Uses the existing async engine connection so it works inside the
    running event loop (FastAPI lifespan).  Falls back to
    ``Base.metadata.create_all`` when the alembic config is not found
    (e.g. when graphlagoon is installed as a wheel without the alembic
    directory).
    """
    _ensure_initialized()

    if not is_database_available():
        return

    alembic_ini = Path(__file__).resolve().parent.parent / "alembic.ini"

    if alembic_ini.exists():
        from alembic.config import Config
        from alembic import command

        def _run_upgrade(connection):
            cfg = Config(str(alembic_ini))
            cfg.attributes["connection"] = connection
            command.upgrade(cfg, "head")

        async with _engine.begin() as conn:
            await conn.run_sync(_run_upgrade)
        logger.info("Alembic migrations applied successfully")
    else:
        logger.info("alembic.ini not found — falling back to create_all")
        async with _engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)


def is_lakebase_auth_error(exc: Exception) -> bool:
    """Check if exception is an asyncpg InvalidPasswordError (token expired).

    Walks the exception chain because SQLAlchemy wraps asyncpg errors.
    Uses string comparison to avoid importing asyncpg (optional dependency).
    """
    if _settings is None or not _settings.lakebase_enabled:
        return False
    current: BaseException | None = exc
    while current is not None:
        if type(current).__name__ == "InvalidPasswordError":
            return True
        current = current.__cause__ or current.__context__
    return False


async def close_database():
    """Close database engine if it exists."""
    global _engine, _async_session_maker
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _async_session_maker = None

    # Clean up Lakebase state if it was active
    if _settings is not None and _settings.lakebase_enabled:
        from graphlagoon.db.lakebase import reset_lakebase_state

        reset_lakebase_state()
