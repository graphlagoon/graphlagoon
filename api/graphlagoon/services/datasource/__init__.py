"""Pluggable graph datasources.

``get_datasource_for_context(context)`` resolves the backend a graph context is
queried through — a SQL warehouse (the default, and what every context created
before this package existed uses) or a native graph database such as Amazon
Neptune.
"""

from graphlagoon.services.datasource.base import (
    DatasourceCapabilities,
    DatasourceError,
    DatasourceNotConfiguredError,
    GraphDatasource,
    GraphExecutionFailure,
    PreparedGraphQuery,
    UnknownDatasourceError,
    require_capability,
)
from graphlagoon.services.datasource.factory import (
    DEFAULT_DATASOURCE_TYPE,
    available_datasource_types,
    close_datasources,
    configure_datasources,
    get_datasource,
    get_datasource_for_context,
    reset_datasources,
)

__all__ = [
    "DEFAULT_DATASOURCE_TYPE",
    "DatasourceCapabilities",
    "DatasourceError",
    "DatasourceNotConfiguredError",
    "GraphDatasource",
    "GraphExecutionFailure",
    "PreparedGraphQuery",
    "UnknownDatasourceError",
    "available_datasource_types",
    "close_datasources",
    "configure_datasources",
    "get_datasource",
    "get_datasource_for_context",
    "require_capability",
    "reset_datasources",
]
