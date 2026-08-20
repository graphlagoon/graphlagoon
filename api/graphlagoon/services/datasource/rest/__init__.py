"""REST-backed graph datasource: spec, registry, mapping and implementation."""

from graphlagoon.services.datasource.rest.datasource import RestDatasource
from graphlagoon.services.datasource.rest.registry import (
    clear_rest_registry,
    get_registered_rest_connections,
    get_rest_connection,
    register_rest_connection,
)
from graphlagoon.services.datasource.rest.spec import (
    RestConnectionSpec,
    RestConnectionUI,
    RestRequest,
    validate_spec,
)

__all__ = [
    "RestConnectionSpec",
    "RestConnectionUI",
    "RestDatasource",
    "RestRequest",
    "clear_rest_registry",
    "get_registered_rest_connections",
    "get_rest_connection",
    "register_rest_connection",
    "validate_spec",
]
