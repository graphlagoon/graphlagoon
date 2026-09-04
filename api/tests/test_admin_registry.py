"""Forcing functions: the admin area must be updated when the environment grows.

Each failure message says what to do. See docs/dev/admin-area.md.
"""

import sys

import pytest

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

from fastapi.routing import APIRoute  # noqa: E402

from graphlagoon.config import Settings  # noqa: E402
from graphlagoon.db.database import Base  # noqa: E402
from graphlagoon.db import models  # noqa: E402,F401  (registers tables on Base)
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.routers.admin_registry import (  # noqa: E402
    AUDIT_EXEMPT_ROUTES,
    AUDITED_ROUTES,
    CLEARABLE_TABLES,
    CONFIG_FIELD_KINDS,
    PRESERVED_TABLES,
)
from graphlagoon.services.audit import AuditAction  # noqa: E402


def test_every_setting_is_classified():
    missing = sorted(set(Settings.model_fields) - set(CONFIG_FIELD_KINDS))
    assert not missing, (
        "New Settings field(s) without an admin classification: "
        f"{missing}. Add each to routers/admin_registry.CONFIG_FIELD_KINDS as "
        "'public' (shown in the admin Config tab), 'secret' (shown only as "
        "set/not set) or 'hidden'."
    )
    stale = sorted(set(CONFIG_FIELD_KINDS) - set(Settings.model_fields))
    assert not stale, f"CONFIG_FIELD_KINDS lists removed settings: {stale}"


def test_credential_bearing_settings_are_secret():
    for key in ("databricks_token", "database_url", "sql_warehouse_url"):
        assert CONFIG_FIELD_KINDS[key] == "secret"


def test_every_table_is_clearable_or_preserved():
    tables = set(Base.metadata.tables)
    known = set(CLEARABLE_TABLES) | set(PRESERVED_TABLES)
    missing = sorted(tables - known)
    assert not missing, (
        f"New persisted table(s) {missing} are unknown to the admin area. Add "
        "each to routers/admin_registry.CLEARABLE_TABLES (wiped by 'clear "
        "environment', children before parents) or PRESERVED_TABLES (with a "
        "reason), add a count to the admin overview if it has an owner, and "
        "extend graphlagoon.dev.seed so the admin area has data to show."
    )
    # alembic_version is not an ORM table; every other preserved one must exist.
    ghosts = sorted((known - tables) - {"alembic_version"})
    assert not ghosts, f"Registry lists tables that no longer exist: {ghosts}"
    assert not set(CLEARABLE_TABLES) & set(PRESERVED_TABLES)


def test_memory_store_clear_all_empties_every_collection():
    store = InMemoryStore()
    store.ensure_user("a@b.co")
    ctx = store.create_graph_context("t", "e", "n", "a@b.co")
    store.create_exploration(ctx.id, "x", "a@b.co", {})
    store.create_query_template(ctx.id, "a@b.co", "q", "cypher", "MATCH (n) RETURN n")
    store.record_usage("a@b.co", "context.delete")
    group = store.create_group("g", members=[{"kind": "email", "value": "a@b.co"}])
    store.set_permission(
        "context.create",
        "restricted",
        [{"group_id": group.id, "effect": "allow"}],
    )
    store.clear_all(keep_usage_logs=False)
    not_empty = [
        name
        for name, value in vars(store).items()
        if hasattr(value, "__len__") and len(value) > 0
    ]
    assert not not_empty, (
        f"InMemoryStore.clear_all() left {not_empty} populated — a new "
        "collection was added to the store without being cleared."
    )


def test_clear_all_keeps_audit_by_default():
    store = InMemoryStore()
    store.record_usage("a@b.co", "context.delete")
    store.clear_all()
    assert len(store.usage_logs) == 1


ROUTER_MODULES = (
    "admin",
    "admin_groups",
    "catalog",
    "config",
    "explorations",
    "graph",
    "graph_contexts",
    "precomputed_graphs",
    "query_templates",
    "similarity",
    "style_presets",
)


def _all_api_routes():
    """Every (METHOD, path, endpoint) of the API, read from each router module
    directly — ``app.routes`` wraps included routers lazily in recent FastAPI
    versions, but a router's own ``.routes`` carry the full prefixed path."""
    import importlib

    out = []
    for name in ROUTER_MODULES:
        module = importlib.import_module(f"graphlagoon.routers.{name}")
        for route in module.router.routes:
            if isinstance(route, APIRoute) and route.path.startswith("/api"):
                for method in route.methods:
                    out.append((method, route.path, route.endpoint))
    return out


def test_router_module_list_is_complete():
    """create_api_router must include exactly the modules walked above."""
    import inspect

    from graphlagoon import app as app_module

    source = inspect.getsource(app_module.create_api_router)
    included = {
        line.strip()[len("router.include_router(") : -len(".router)")]
        for line in source.splitlines()
        if line.strip().startswith("router.include_router(")
    }
    assert included == set(ROUTER_MODULES), (
        "create_api_router and tests/test_admin_registry.ROUTER_MODULES "
        f"disagree: {included ^ set(ROUTER_MODULES)}"
    )


def test_every_mutating_route_is_audited_or_exempt():
    routes = {
        (m, p)
        for m, p, _ in _all_api_routes()
        if m in {"POST", "PUT", "DELETE", "PATCH"}
    }
    unclassified = sorted(routes - AUDITED_ROUTES - set(AUDIT_EXEMPT_ROUTES))
    assert not unclassified, (
        f"Mutating route(s) {unclassified} are neither audited nor exempt. "
        "Either call services.audit.record in the handler and add the route "
        "to routers/admin_registry.AUDITED_ROUTES, or add it to "
        "AUDIT_EXEMPT_ROUTES with the reason it needs no audit line."
    )
    stale = sorted((AUDITED_ROUTES | set(AUDIT_EXEMPT_ROUTES)) - routes)
    assert not stale, f"Registry lists routes that no longer exist: {stale}"
    assert not AUDITED_ROUTES & set(AUDIT_EXEMPT_ROUTES)


def test_audit_actions_are_dotted_and_unique():
    actions = AuditAction.all()
    assert len(actions) == len(set(actions))
    assert all(a.count(".") == 1 for a in actions)


def test_permission_ids_are_dotted_and_unique():
    """Catalog entries follow the AuditAction shape and carry admin-UI copy."""
    from graphlagoon.services.permission_catalog import PERMISSIONS

    ids = [p.id for p in PERMISSIONS]
    assert len(ids) == len(set(ids))
    assert all(i.count(".") == 1 for i in ids)
    assert all(p.label.strip() and p.description.strip() for p in PERMISSIONS)


def test_permission_gates_reference_catalog():
    """Every require_permission("...") literal in a router must name a catalog
    entry — a gate on an uncataloged id is a typo, and a catalog entry is
    only honest when some gate (or planned gate) can reference it."""
    import importlib
    import inspect
    import re

    from graphlagoon.services.permission_catalog import PERMISSION_IDS

    referenced = set()
    for name in ROUTER_MODULES:
        module = importlib.import_module(f"graphlagoon.routers.{name}")
        referenced |= set(
            re.findall(r'require_permission\(\s*"([^"]+)"\s*\)', inspect.getsource(module))
        )
    unknown = sorted(referenced - PERMISSION_IDS)
    assert not unknown, (
        f"require_permission gate(s) reference id(s) {unknown} that are not in "
        "services/permission_catalog.PERMISSIONS — add the catalog entry or "
        "fix the typo."
    )


@pytest.mark.parametrize("route", sorted(AUDITED_ROUTES))
def test_audited_routes_reference_audit_module(route):
    """Static sanity check: the handler module of every audited route imports
    the audit service (the behavioural check lives in test_audit.py)."""
    import inspect

    handler = next(
        endpoint
        for method, path, endpoint in _all_api_routes()
        if (method, path) == route
    )
    source = inspect.getsource(sys.modules[handler.__module__])
    assert "audit.record(" in source, f"{handler.__module__} never calls audit.record"
