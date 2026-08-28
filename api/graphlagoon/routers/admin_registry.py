"""Registries that decide what the admin area shows and audits.

These are the "forcing functions" of the admin area: ``tests/test_admin_registry.py``
fails the build when a new ``Settings`` field, database table or mutating
route is added without being classified here. Read the failing test's
message for what to update; the rule of thumb:

* **New setting** → add to ``CONFIG_FIELD_KINDS``. ``public`` values show in
  the Config tab; ``secret`` show only as set/not set; ``hidden`` are omitted.
* **New table** → add to ``CLEARABLE_TABLES`` (wiped by "clear environment",
  in FK-safe order) or ``PRESERVED_TABLES`` (survives it, with a reason).
* **New POST/PUT/DELETE route** → add to ``AUDITED_ROUTES`` (and call
  ``services.audit.record`` in the handler) or ``AUDIT_EXEMPT_ROUTES`` with
  the reason it needs no audit line.
"""

from __future__ import annotations

from typing import Literal

ConfigKind = Literal["public", "secret", "hidden"]

# Every field of graphlagoon.config.Settings, classified.
CONFIG_FIELD_KINDS: dict[str, ConfigKind] = {
    # URLs may embed credentials → secret.
    "sql_warehouse_url": "secret",
    "database_url": "secret",
    "database_enabled": "public",
    "database_pool_size": "public",
    "database_max_overflow": "public",
    "database_pool_timeout": "public",
    "database_pool_recycle": "public",
    "lakebase_enabled": "public",
    "lakebase_instance_name": "secret",
    "lakebase_database_name": "secret",
    "default_postgres_schema": "public",
    "allowed_share_domains": "public",
    # Shown as a list on the overview, not as a raw string here.
    "superuser_emails": "hidden",
    "default_behaviors": "public",
    "dev_mode": "public",
    "port": "public",
    "show_error_details": "public",
    "databricks_mode": "public",
    "databricks_host": "secret",
    "databricks_token": "secret",
    "databricks_warehouse_id": "secret",
    "databricks_catalog": "public",
    "databricks_schema": "public",
    "catalog_schemas": "public",
    "exploration_snapshots_dir": "public",
    "databricks_volume_path": "public",
    "precomputed_graphs_enabled": "public",
    "precomputed_graphs_dir": "public",
    "precomputed_graphs_volume_path": "public",
    "precomputed_graphs_max_bytes": "public",
    "style_presets_enabled": "public",
    "style_presets_dir": "public",
    "style_presets_volume_path": "public",
    "style_presets_max_per_context": "public",
    "custom_metrics_enabled": "public",
    "custom_metrics_auto_run_enabled": "public",
    "warehouse_http_timeout": "public",
    "warehouse_wait_timeout": "public",
    "warehouse_submit_wait_timeout": "public",
    "warehouse_max_poll_time": "public",
    "warehouse_poll_interval": "public",
    "warehouse_chunk_concurrency": "public",
    "neptune_endpoint": "secret",
    "neptune_port": "public",
    "neptune_use_tls": "public",
    "neptune_use_iam": "public",
    "neptune_region": "public",
    "neptune_tls_verify": "public",
    "neptune_http_timeout": "public",
    "neptune_discovery_sample_limit": "public",
}

# Tables wiped by "clear environment", in an order that respects foreign keys
# (children first). services.environment consumes this list directly.
CLEARABLE_TABLES: tuple[str, ...] = (
    "exploration_shares",
    "explorations",
    "graph_context_shares",
    "query_templates",
    "graph_contexts",
    "users",
)

# Tables that survive "clear environment", each with the reason.
PRESERVED_TABLES: dict[str, str] = {
    "usage_logs": "audit trail must outlive the clear that it records",
    "alembic_version": "schema bookkeeping, owned by Alembic",
}

# (METHOD, path) of every mutating route that writes an audit entry.
AUDITED_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {
        ("DELETE", "/api/graph-contexts/{context_id}"),
        ("POST", "/api/graph-contexts/{context_id}/share"),
        ("DELETE", "/api/graph-contexts/{context_id}/share/{email}"),
        ("DELETE", "/api/explorations/{exploration_id}"),
        ("POST", "/api/explorations/{exploration_id}/share"),
        ("DELETE", "/api/explorations/{exploration_id}/share/{email}"),
        ("PUT", "/api/graph-contexts/{context_id}/precomputed-graphs/{name}"),
        ("DELETE", "/api/graph-contexts/{context_id}/precomputed-graphs/{name}"),
        ("DELETE", "/api/graph-contexts/{context_id}/style-presets/{name}"),
        ("POST", "/api/admin/contexts/{context_id}/transfer"),
        ("POST", "/api/admin/explorations/{exploration_id}/transfer"),
        ("POST", "/api/admin/environment/clear"),
        ("DELETE", "/api/dev/clear-all"),
    }
)

# Mutating routes that deliberately write no audit entry, with the reason.
AUDIT_EXEMPT_ROUTES: dict[tuple[str, str], str] = {
    ("POST", "/api/graph-contexts"): "create is owner-scoped; low blast radius",
    (
        "PUT",
        "/api/graph-contexts/{context_id}",
    ): "edit by owner/writer; not destructive",
    ("POST", "/api/graph-contexts/{context_id}/explorations"): "owner-scoped create",
    ("PUT", "/api/explorations/{exploration_id}"): "edit by owner/writer",
    ("POST", "/api/graph-contexts/{context_id}/query-templates"): "owner-scoped create",
    ("PUT", "/api/graph-contexts/{context_id}/query-templates/{template_id}"): "edit",
    ("DELETE", "/api/graph-contexts/{context_id}/query-templates/{template_id}"): (
        "per-context artefact of a few hundred bytes; recreate is trivial"
    ),
    ("PUT", "/api/graph-contexts/{context_id}/style-presets/{name}"): (
        "personal preference anyone with write access may save"
    ),
    ("POST", "/api/graph-contexts/{context_id}/query"): "read-only query execution",
    (
        "POST",
        "/api/graph-contexts/{context_id}/query/async",
    ): "read-only query execution",
    ("POST", "/api/graph-contexts/{context_id}/query/table"): "read-only query",
    ("POST", "/api/graph-contexts/{context_id}/query/job/{job_id}/cancel"): (
        "cancels the caller's own query"
    ),
    ("POST", "/api/graph-contexts/{context_id}/query/table/{statement_id}/cancel"): (
        "cancels the caller's own query"
    ),
    ("POST", "/api/graph-contexts/{context_id}/cypher"): "read-only query execution",
    (
        "POST",
        "/api/graph-contexts/{context_id}/cypher/async",
    ): "read-only query execution",
    ("POST", "/api/graph-contexts/{context_id}/cypher/transpile"): "no side effects",
    ("POST", "/api/graph-contexts/{context_id}/subgraph"): "read-only fetch",
    ("POST", "/api/graph-contexts/{context_id}/expand"): "read-only fetch",
    ("POST", "/api/graph-contexts/{context_id}/nodes/batch"): "read-only fetch",
    (
        "POST",
        "/api/dev/random-graph",
    ): "dev-only generator; only writes throwaway tables",
    ("POST", "/api/schema-discovery"): "read-only discovery",
    ("POST", "/api/catalog/refresh"): "cache refresh; no data change",
    ("POST", "/api/admin/health/warehouse"): "read-only probe",
}
