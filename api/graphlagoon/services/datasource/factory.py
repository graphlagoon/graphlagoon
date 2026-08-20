"""Datasource registry: pick the backend a context should be queried through.

Mirrors the singleton pattern of ``services/snapshot.py`` — configured once at
app startup, instantiated lazily per type, resettable for tests.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

from graphlagoon.services.datasource.base import (
    DatasourceNotConfiguredError,
    GraphDatasource,
    UnknownDatasourceError,
)

if TYPE_CHECKING:
    from graphlagoon.config import Settings

logger = logging.getLogger(__name__)

DEFAULT_DATASOURCE_TYPE = "sql_warehouse"
"""What a context without an explicit type is queried through.

Every context predating multi-datasource support is a SQL warehouse context,
so this default is what lets the whole feature ship without touching a single
existing row's behaviour.
"""

_datasources: dict[str, GraphDatasource] = {}
_settings: Optional["Settings"] = None
_header_provider = None


def configure_datasources(settings: "Settings", header_provider=None) -> None:
    """Configure the datasource registry. Call once at app startup."""
    global _settings, _header_provider
    _settings = settings
    _header_provider = header_provider
    _datasources.clear()


def _get_settings() -> "Settings":
    if _settings is not None:
        return _settings
    from graphlagoon.config import get_settings

    return get_settings()


def _build(type_name: str, name: Optional[str] = None) -> GraphDatasource:
    if type_name == "sql_warehouse":
        from graphlagoon.services.datasource.sql_warehouse import SqlWarehouseDatasource

        return SqlWarehouseDatasource()

    if type_name == "neptune":
        settings = _get_settings()
        if not settings.neptune_enabled:
            raise DatasourceNotConfiguredError(
                "Amazon Neptune is not configured on this server. Set "
                "GRAPH_LAGOON_NEPTUNE_ENDPOINT to enable it."
            )
        from graphlagoon.services.datasource.neptune import NeptuneDatasource

        return NeptuneDatasource.from_settings(settings)

    if type_name == "rest":
        from graphlagoon.services.datasource.rest import (
            RestDatasource,
            get_rest_connection,
        )

        spec = get_rest_connection(name) if name else None
        if spec is None:
            raise DatasourceNotConfiguredError(
                f"REST connection '{name}' is not registered on this server. "
                f"Register it with create_mountable_app(rest_connections=[...])."
            )
        return RestDatasource(spec)

    raise UnknownDatasourceError(f"Unknown datasource type: '{type_name}'")


def get_datasource(type_name: str, name: Optional[str] = None) -> GraphDatasource:
    """Return the configured datasource for a type (lazy singleton).

    ``rest`` is the one type with named instances — ``name`` selects the
    connection, and each connection gets its own singleton (its own HTTP
    client, its own spec). The other types ignore ``name``.
    """
    key = f"rest:{name}" if type_name == "rest" else type_name
    existing = _datasources.get(key)
    if existing is not None:
        return existing

    datasource = _build(type_name, name)
    _datasources[key] = datasource
    return datasource


def get_datasource_for_context(context) -> GraphDatasource:
    """Resolve the datasource a context is queried through.

    Anything other than a non-empty string means SQL warehouse: contexts
    created before this attribute existed carry no value at all, and test
    doubles built from ``MagicMock`` auto-generate a truthy attribute for every
    name asked of them. Both describe a context that has not chosen a backend,
    which is exactly what the default is for. The same guard applies to
    ``datasource_name`` for the identical reason.
    """
    type_name = getattr(context, "datasource_type", None)
    if not isinstance(type_name, str) or not type_name:
        type_name = DEFAULT_DATASOURCE_TYPE
    name = getattr(context, "datasource_name", None)
    if not isinstance(name, str) or not name:
        name = None
    return get_datasource(type_name, name)


def available_datasource_types() -> dict[str, bool]:
    """Which datasource types this server can serve, for ``GET /api/config``.

    The frontend uses this to decide whether to offer a type when creating a
    context; it does NOT describe what each type can do (that matrix lives in
    the frontend, versioned with the UI that renders it).
    """
    settings = _get_settings()
    return {
        "sql_warehouse": True,
        "neptune": bool(getattr(settings, "neptune_enabled", False)),
    }


def available_datasource_connections() -> list[dict]:
    """Named datasource instances this server can serve, for ``GET /api/config``.

    One entry per registered REST connection: UI copy plus the per-connection
    operation flags, and nothing else — transport and auth stay in-process.
    Kept separate from :func:`available_datasource_types` (a frozen
    ``{type: bool}`` record) so legacy consumers keep their shape while named
    instances carry the richer payload they need.
    """
    from graphlagoon.services.datasource.rest import get_registered_rest_connections

    return [spec.ui_payload() for spec in get_registered_rest_connections()]


async def close_datasources() -> None:
    """Release datasource resources at app shutdown (best effort)."""
    for type_name, datasource in list(_datasources.items()):
        close = getattr(datasource, "close", None)
        if close is None:
            continue
        try:
            await close()
        except Exception as e:  # noqa: BLE001 — shutdown must not fail
            logger.warning(f"closing datasource '{type_name}' failed: {e}")
    _datasources.clear()


def reset_datasources() -> None:
    """Reset the registry (for testing)."""
    global _settings, _header_provider
    _datasources.clear()
    _settings = None
    _header_provider = None
