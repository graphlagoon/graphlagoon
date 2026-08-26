"""Tests for database engine pool configuration (db/database.py).

Technical debt #9: the standard PostgreSQL engine was created without explicit
pool limits, so under load connections could be exhausted silently. These tests
pin the contract: the engine receives the pool settings from Settings, and the
settings themselves are overridable via GRAPH_LAGOON_* env vars.
"""

import sys

import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and break
# test_transpile_options.
try:
    import gsql2rsql  # noqa: F401
except ImportError:
    from unittest.mock import MagicMock as _MagicMock

    for _name in (
        "gsql2rsql",
        "gsql2rsql.parser",
        "gsql2rsql.parser.opencypher_parser",
        "gsql2rsql.planner",
        "gsql2rsql.planner.logical_plan",
        "gsql2rsql.planner.subquery_flattening",
        "gsql2rsql.planner.pass_manager",
        "gsql2rsql.renderer",
        "gsql2rsql.renderer.sql_renderer",
        "gsql2rsql.renderer.schema_provider",
        "gsql2rsql.common",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from graphlagoon.config import Settings  # noqa: E402
from graphlagoon.db import database  # noqa: E402


@pytest.fixture
def clean_db_state():
    """Isolate the module-level engine globals from other tests."""
    database.configure_database(
        Settings(
            database_enabled=True,
            database_url="postgresql+asyncpg://u:p@localhost:5432/test",
        )
    )
    yield
    database._engine = None
    database._async_session_maker = None
    database._settings = None


def test_engine_created_with_default_pool_config(clean_db_state, monkeypatch):
    captured = {}

    def fake_create_async_engine(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)

        class _FakeEngine:
            pass

        return _FakeEngine()

    monkeypatch.setattr(database, "create_async_engine", fake_create_async_engine)

    database._ensure_initialized()

    assert captured["pool_size"] == 10
    assert captured["max_overflow"] == 20
    assert captured["pool_timeout"] == 30
    assert captured["pool_recycle"] == 3600
    assert captured["pool_pre_ping"] is True


def test_engine_pool_config_respects_settings(monkeypatch):
    captured = {}

    def fake_create_async_engine(url, **kwargs):
        captured.update(kwargs)

        class _FakeEngine:
            pass

        return _FakeEngine()

    monkeypatch.setattr(database, "create_async_engine", fake_create_async_engine)

    database.configure_database(
        Settings(
            database_enabled=True,
            database_url="postgresql+asyncpg://u:p@localhost:5432/test",
            database_pool_size=3,
            database_max_overflow=5,
            database_pool_timeout=7,
            database_pool_recycle=900,
        )
    )
    try:
        database._ensure_initialized()
    finally:
        database._engine = None
        database._async_session_maker = None
        database._settings = None

    assert captured["pool_size"] == 3
    assert captured["max_overflow"] == 5
    assert captured["pool_timeout"] == 7
    assert captured["pool_recycle"] == 900


def test_pool_settings_read_from_env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DATABASE_POOL_SIZE", "4")
    monkeypatch.setenv("GRAPH_LAGOON_DATABASE_MAX_OVERFLOW", "8")
    monkeypatch.setenv("GRAPH_LAGOON_DATABASE_POOL_TIMEOUT", "15")
    monkeypatch.setenv("GRAPH_LAGOON_DATABASE_POOL_RECYCLE", "1200")

    settings = Settings()

    assert settings.database_pool_size == 4
    assert settings.database_max_overflow == 8
    assert settings.database_pool_timeout == 15
    assert settings.database_pool_recycle == 1200
