"""Environment-level operations behind the admin area.

Everything here is either read-only (probes, counts) or guarded twice
(``clear_environment`` needs dev mode *and* a superuser, enforced by the
callers in ``routers/admin.py`` and ``routers/graph.py``).
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

import httpx

from graphlagoon.config import Settings, get_settings
from graphlagoon.db.database import get_session_maker, is_database_available
from graphlagoon.db.memory_store import get_memory_store
from graphlagoon.routers.admin_registry import CLEARABLE_TABLES

logger = logging.getLogger(__name__)

WAREHOUSE_PROBE_TIMEOUT_SECONDS = 3.0


def persistence_backend(settings: Optional[Settings] = None) -> str:
    settings = settings or get_settings()
    if not is_database_available():
        return "memory"
    return "lakebase" if settings.lakebase_enabled else "postgres"


async def database_health() -> dict[str, Any]:
    """``SELECT 1`` round-trip. Cheap, and safe to run on every overview load."""
    if not is_database_available():
        return {"status": "memory", "latency_ms": None, "detail": "in-memory store"}
    from sqlalchemy import text

    started = time.perf_counter()
    try:
        session_maker = get_session_maker()
        async with session_maker() as session:
            await session.execute(text("SELECT 1"))
        return {
            "status": "ok",
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
            "detail": None,
        }
    except Exception as exc:
        return {"status": "error", "latency_ms": None, "detail": str(exc)[:300]}


async def alembic_version() -> Optional[str]:
    """Current revision, ``None`` in memory mode, ``"unmanaged"`` when the
    table is missing (schema created by ``create_all``, not Alembic)."""
    if not is_database_available():
        return None
    from sqlalchemy import text

    try:
        session_maker = get_session_maker()
        async with session_maker() as session:
            row = (
                await session.execute(text("SELECT version_num FROM alembic_version"))
            ).first()
            return row[0] if row else "unmanaged"
    except Exception:
        return "unmanaged"


async def probe_warehouse(settings: Optional[Settings] = None) -> dict[str, Any]:
    """On-demand reachability check with its own short timeout.

    Deliberately not part of the overview: the warehouse client's HTTP
    timeout is minutes long, and hitting a stopped Databricks SQL warehouse
    can wake it (slow and billable). Uses the cheapest endpoint of each
    backend — the warehouse *metadata* on Databricks, ``/health`` locally.
    """
    settings = settings or get_settings()
    try:
        base = settings.warehouse_base_url
    except ValueError as exc:
        return {"status": "misconfigured", "latency_ms": None, "detail": str(exc)}

    if settings.databricks_mode:
        url = f"{base}/api/2.0/sql/warehouses/{settings.warehouse_id}"
        try:
            headers = settings.warehouse_headers
        except ValueError as exc:
            return {"status": "misconfigured", "latency_ms": None, "detail": str(exc)}
    else:
        url = f"{base}/health"
        headers = {}

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=WAREHOUSE_PROBE_TIMEOUT_SECONDS) as client:
            response = await client.get(url, headers=headers)
        latency = round((time.perf_counter() - started) * 1000, 1)
        if response.status_code >= 400:
            return {
                "status": "error",
                "latency_ms": latency,
                "detail": f"HTTP {response.status_code}",
            }
        detail = None
        if settings.databricks_mode:
            try:
                detail = response.json().get("state")
            except Exception:
                detail = None
        return {"status": "ok", "latency_ms": latency, "detail": detail}
    except httpx.TimeoutException:
        return {
            "status": "timeout",
            "latency_ms": None,
            "detail": f"no answer within {WAREHOUSE_PROBE_TIMEOUT_SECONDS:g}s",
        }
    except Exception as exc:
        return {"status": "error", "latency_ms": None, "detail": str(exc)[:300]}


async def clear_environment(warehouse=None) -> dict[str, Any]:
    """Wipe every clearable table (or the memory store) and the warehouse tables.

    The audit trail is preserved on purpose; callers record ``admin.clear_all``
    *after* this returns so the entry survives. Callers are responsible for
    the dev-mode + superuser checks.
    """
    cleared: list[str] = []
    if is_database_available():
        from sqlalchemy import text

        session_maker = get_session_maker()
        async with session_maker() as session:
            for table in CLEARABLE_TABLES:
                await session.execute(text(f"TRUNCATE TABLE {table} CASCADE"))
                cleared.append(table)
            await session.commit()
    else:
        get_memory_store().clear_all(keep_usage_logs=True)
        cleared = ["memory"]

    warehouse_result = None
    if warehouse is not None:
        try:
            warehouse_result = await warehouse.clear_all_tables()
        except Exception as exc:
            logger.warning("Warehouse clear failed: %s", exc)
            warehouse_result = {"error": str(exc)[:300]}

    return {"cleared": cleared, "warehouse": warehouse_result}
