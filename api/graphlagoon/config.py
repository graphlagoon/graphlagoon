import json
import logging
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from functools import lru_cache
from typing import Optional

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Graph Lagoon Studio configuration settings.

    All environment variables use the GRAPH_LAGOON_ prefix to avoid conflicts.
    Example: GRAPH_LAGOON_DATABRICKS_MODE=true
    """

    model_config = SettingsConfigDict(
        env_prefix="GRAPH_LAGOON_",
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # Local sql-warehouse (dev mode)
    sql_warehouse_url: str = Field(
        default="http://localhost:8001",
        description="URL for local sql-warehouse (dev mode)",
    )

    # Database (optional - can be disabled)
    database_url: Optional[str] = Field(
        default="postgresql+asyncpg://sgraph:sgraph@localhost:5432/sgraph",
        description="PostgreSQL connection URL",
    )
    database_enabled: bool = Field(
        default=False, description="Enable database persistence"
    )
    database_pool_size: int = Field(
        default=10,
        description="Max persistent connections kept in the database pool",
    )
    database_max_overflow: int = Field(
        default=20,
        description="Extra connections allowed beyond pool_size under load",
    )
    database_pool_timeout: int = Field(
        default=30,
        description="Seconds to wait for a free connection before failing",
    )
    database_pool_recycle: int = Field(
        default=3600,
        description="Recycle pooled connections older than this many seconds",
    )

    # Lakebase (Databricks-managed PostgreSQL)
    lakebase_enabled: bool = Field(
        default=False,
        description="Enable Databricks Lakebase backend (implies database_enabled=True)",
    )
    lakebase_instance_name: Optional[str] = Field(
        default=None, description="Lakebase database instance name"
    )
    lakebase_database_name: Optional[str] = Field(
        default=None,
        description="Lakebase database name (defaults to instance name if not set)",
    )
    default_postgres_schema: Optional[str] = Field(
        default=None,
        description="PostgreSQL search_path schema for Lakebase (e.g. 'graphlagoon')",
    )

    # Sharing
    allowed_share_domains: Optional[str] = Field(
        default=None,
        description="Comma-separated list of domains allowed for wildcard sharing "
        "(e.g. 'stone.com.br,company.com'). "
        "When set, users can share with *@domain for listed domains.",
    )

    # Superusers
    superuser_emails: Optional[str] = Field(
        default=None,
        description="Comma-separated list of emails granted superuser access "
        "(full read/write/delete/share on all contexts, explorations, and "
        "query templates). E.g. 'admin@company.com,ops@company.com'.",
    )

    # Frontend defaults
    default_behaviors: Optional[str] = Field(
        default=None,
        description="JSON object of default graph behavior settings for the frontend "
        '(e.g. \'{"mapStylePan": false, "viewMode": "3d"}\'). '
        "Seeds the initial value of the Behaviors panel. Keys are passed through "
        "opaquely and merged over the frontend's own defaults, so any behavior the "
        "frontend supports can be set here without a backend change. Users can still "
        "change them in the panel, and a saved exploration overrides them.",
    )

    # General settings
    dev_mode: bool = Field(default=True, description="Enable development mode")
    port: int = Field(default=8000, description="Server port")
    show_error_details: bool = Field(
        default=True,
        description="Show detailed error info (traceback, exception type) in API error responses",
    )

    # Databricks connection (production mode)
    databricks_mode: bool = Field(
        default=False,
        description="Enable Databricks mode (connect to Databricks SQL Warehouse)",
    )
    databricks_host: Optional[str] = Field(
        default=None,
        description="Databricks host (e.g., adb-123456789.0.azuredatabricks.net)",
    )
    databricks_token: Optional[str] = Field(
        default=None, description="Databricks personal access token"
    )
    databricks_warehouse_id: Optional[str] = Field(
        default=None, description="Databricks SQL warehouse ID"
    )
    databricks_catalog: Optional[str] = Field(
        default=None,
        description="Databricks catalog (required when databricks_mode=True)",
    )
    databricks_schema: Optional[str] = Field(
        default=None,
        description="Databricks schema (required when databricks_mode=True)",
    )
    catalog_schemas: Optional[str] = Field(
        default=None,
        description="Comma-separated catalog.schema pairs (e.g. 'cat1.schema1,cat2.schema2'). "
        "When set, list_datasets searches all specified pairs instead of just default_catalog/default_schema.",
    )

    # Exploration snapshots (file-based graph state persistence)
    exploration_snapshots_dir: str = Field(
        default="./tmp/explorations",
        description="Local directory for exploration snapshot files (used when databricks_mode=False)",
    )
    databricks_volume_path: Optional[str] = Field(
        default=None,
        description="Databricks Volume path for snapshot storage "
        "(e.g. /Volumes/catalog/schema/volume/explorations). "
        "Required when databricks_mode=True and graph snapshots are saved.",
    )

    # Precomputed graphs (named graphs resolved by a registered provider)
    precomputed_graphs_enabled: bool = Field(
        default=True,
        description="Enable precomputed graphs (read is always allowed; writing "
        "and deleting through the API is restricted to superusers, see "
        "GRAPH_LAGOON_SUPERUSER_EMAILS, and only where the resolving provider "
        "declares those capabilities)",
    )
    precomputed_graphs_dir: str = Field(
        default="./tmp/precomputed-graphs",
        description="Local directory the built-in volume provider uses "
        "(when no volume path is configured)",
    )
    precomputed_graphs_volume_path: Optional[str] = Field(
        default=None,
        description="Databricks Volume path for precomputed graph storage "
        "(e.g. /Volumes/catalog/schema/volume/precomputed-graphs). Defaults to "
        "a 'precomputed-graphs' subdirectory of databricks_volume_path when "
        "that is set.",
    )
    precomputed_graphs_max_bytes: int = Field(
        default=200 * 1024 * 1024,
        description="Maximum compressed size of a single precomputed graph "
        "written through the volume provider, in bytes",
    )

    # Style presets (named style + label + layout settings, applied by URL)
    style_presets_enabled: bool = Field(
        default=True,
        description="Enable named style presets (style, labels and layout per context)",
    )
    style_presets_dir: str = Field(
        default="./tmp/style-presets",
        description="Local directory for style preset files "
        "(used when no preset volume path is configured)",
    )
    style_presets_volume_path: Optional[str] = Field(
        default=None,
        description="Databricks Volume path for style presets. Defaults to a "
        "'style-presets' subdirectory of databricks_volume_path when that is set.",
    )
    style_presets_max_per_context: int = Field(
        default=100,
        description="Maximum presets one context may hold. Presets are listed in "
        "full for the picker, so the count is bounded at write time rather than "
        "paginated at read time.",
    )

    # Warehouse timeout settings
    warehouse_http_timeout: float = Field(
        default=300.0,
        description="HTTP timeout (seconds) for individual warehouse API calls",
    )
    warehouse_wait_timeout: int = Field(
        default=300,
        description="Databricks wait_timeout (seconds) for SQL statement execution. "
        "Databricks holds the HTTP connection open for up to this duration "
        "before returning a PENDING state. Max allowed by Databricks is 50s "
        "for INLINE and no limit for EXTERNAL_LINKS polling flow.",
    )
    warehouse_max_poll_time: float = Field(
        default=900.0,
        description="Max time (seconds) to poll for query completion (default 15 min)",
    )
    warehouse_poll_interval: float = Field(
        default=2.0, description="Interval (seconds) between polling requests"
    )
    warehouse_chunk_concurrency: int = Field(
        default=8,
        description="Max concurrent chunk downloads for the EXTERNAL_LINKS "
        "result flow. Chunks are independent files in object storage, so "
        "downloading them in parallel cuts wall-clock for large results. "
        "Bounded to avoid hitting Databricks rate limits; set to 1 to force "
        "serial downloads.",
    )
    warehouse_submit_wait_timeout: int = Field(
        default=0,
        description="wait_timeout (seconds) used by the cancellable table-query "
        "submit path. Default 0 makes the submit asynchronous: Databricks "
        "returns a statement_id immediately (PENDING), so the Cancel button is "
        "available from the start of the spinner and the client polls for the "
        "result. A non-zero value (5-50s) trades that off for a fast path where "
        "queries finishing within the window return inline on the first call.",
    )

    # ── Amazon Neptune (openCypher) ──────────────────────────────────────
    #
    # Connection is server-level, exactly like the warehouse above: one cluster
    # per deployment, and a graph context only records that it is a "neptune"
    # context. Setting neptune_endpoint is what enables the datasource.
    neptune_endpoint: Optional[str] = Field(
        default=None,
        description="Neptune cluster endpoint host, without scheme "
        "(e.g. my-cluster.cluster-abc123.us-east-1.neptune.amazonaws.com). "
        "Unset disables the Neptune datasource entirely.",
    )
    neptune_port: int = Field(default=8182, description="Neptune endpoint port")
    neptune_use_iam: bool = Field(
        default=False,
        description="Sign requests with AWS SigV4 (required for IAM-auth "
        "enabled clusters). Needs the 'neptune-iam' extra for botocore.",
    )
    neptune_region: Optional[str] = Field(
        default=None,
        description="AWS region used for SigV4 signing. Required when "
        "neptune_use_iam=True.",
    )
    neptune_use_tls: bool = Field(
        default=True,
        description="Use https for the Neptune endpoint. Set False only for "
        "the local emulator (make dev-neptune), which speaks plain http.",
    )
    neptune_tls_verify: bool = Field(
        default=True,
        description="Verify the endpoint's TLS certificate",
    )
    neptune_http_timeout: float = Field(
        default=120.0,
        description="HTTP timeout (seconds) for Neptune openCypher calls",
    )
    neptune_discovery_sample_limit: int = Field(
        default=10000,
        description="Row cap when discovering labels/relationship types by "
        "sampling, used when the cluster's summary API is unavailable.",
    )

    def model_post_init(self, __context):
        if self.lakebase_enabled:
            object.__setattr__(self, "database_enabled", True)
            if not self.lakebase_instance_name:
                raise ValueError(
                    "lakebase_instance_name is required when lakebase_enabled=True"
                )
        if self.neptune_use_iam and not self.neptune_region:
            raise ValueError("neptune_region is required when neptune_use_iam=True")

    @property
    def style_presets_volume_path_effective(self) -> Optional[str]:
        """Volume path style presets should use, if any.

        Same fallback rule as precomputed graphs: a deployment that already
        configured a volume gets a correct, non-colliding location without
        another environment variable.
        """
        if self.style_presets_volume_path:
            return self.style_presets_volume_path
        if self.databricks_volume_path:
            return f"{self.databricks_volume_path.rstrip('/')}/style-presets"
        return None

    @property
    def precomputed_graphs_volume_path_effective(self) -> Optional[str]:
        """Volume path the built-in volume provider should use, if any.

        Falls back to a 'precomputed-graphs' subdirectory of the snapshot volume,
        so a deployment that already configured a volume gets a correct,
        non-colliding location without a second environment variable.
        """
        if self.precomputed_graphs_volume_path:
            return self.precomputed_graphs_volume_path
        if self.databricks_volume_path:
            return f"{self.databricks_volume_path.rstrip('/')}/precomputed-graphs"
        return None

    @property
    def neptune_enabled(self) -> bool:
        """Whether this server can serve Neptune-backed contexts."""
        return bool(self.neptune_endpoint)

    @property
    def neptune_base_url(self) -> str:
        """Base URL for Neptune API calls."""
        scheme = "https" if self.neptune_use_tls else "http"
        return f"{scheme}://{self.neptune_endpoint}:{self.neptune_port}"

    @property
    def warehouse_base_url(self) -> str:
        """Get the base URL for warehouse API calls."""
        if self.databricks_mode:
            if not self.databricks_host:
                raise ValueError(
                    "databricks_host is required when databricks_mode=True"
                )
            return f"https://{self.databricks_host}"
        return self.sql_warehouse_url

    @property
    def warehouse_headers(self) -> dict:
        """Get headers for warehouse API calls."""
        if self.databricks_mode:
            if not self.databricks_token:
                raise ValueError(
                    "databricks_token is required when databricks_mode=True"
                )
            return {"Authorization": f"Bearer {self.databricks_token}"}
        return {}

    @property
    def warehouse_id(self) -> str:
        """Get warehouse ID for SQL statements."""
        if self.databricks_mode:
            if not self.databricks_warehouse_id:
                raise ValueError(
                    "databricks_warehouse_id is required when databricks_mode=True"
                )
            return self.databricks_warehouse_id
        return "dev-warehouse"

    @property
    def default_catalog(self) -> str:
        """Get the default catalog for queries."""
        if self.databricks_mode:
            if not self.databricks_catalog:
                raise ValueError(
                    "databricks_catalog is required when databricks_mode=True"
                )
            return self.databricks_catalog
        return "spark_catalog"

    @property
    def default_schema(self) -> str:
        """Get the default schema for queries."""
        if self.databricks_mode:
            if not self.databricks_schema:
                raise ValueError(
                    "databricks_schema is required when databricks_mode=True"
                )
            return self.databricks_schema
        return "default"

    @property
    def allowed_share_domain_list(self) -> list[str]:
        """Get list of allowed domains for wildcard sharing."""
        if self.allowed_share_domains:
            return [
                d.strip().lower()
                for d in self.allowed_share_domains.split(",")
                if d.strip()
            ]
        return []

    @property
    def superuser_email_list(self) -> list[str]:
        """Get lowercased list of superuser emails."""
        if self.superuser_emails:
            return [
                e.strip().lower() for e in self.superuser_emails.split(",") if e.strip()
            ]
        return []

    @property
    def default_behaviors_dict(self) -> dict:
        """Parse default_behaviors into a dict for injection into the frontend.

        Returns an empty dict when unset or malformed. A bad value must not take the
        app down: these are cosmetic UI defaults, and the frontend already falls back
        to its own defaults for any key it doesn't receive.
        """
        if not self.default_behaviors:
            return {}
        try:
            parsed = json.loads(self.default_behaviors)
        except json.JSONDecodeError:
            logger.warning(
                "GRAPH_LAGOON_DEFAULT_BEHAVIORS is not valid JSON; ignoring it."
            )
            return {}
        if not isinstance(parsed, dict):
            logger.warning(
                "GRAPH_LAGOON_DEFAULT_BEHAVIORS must be a JSON object, got %s; "
                "ignoring it.",
                type(parsed).__name__,
            )
            return {}
        return parsed

    @property
    def catalog_schema_pairs(self) -> list[tuple[str, str]]:
        """Get list of (catalog, schema) pairs to search for datasets.

        If catalog_schemas is set, parses it.
        Otherwise falls back to [(default_catalog, default_schema)].
        """
        if self.catalog_schemas:
            pairs = []
            for item in self.catalog_schemas.split(","):
                parts = item.strip().split(".")
                if len(parts) == 2:
                    pairs.append((parts[0], parts[1]))
            if pairs:
                return pairs
        return [(self.default_catalog, self.default_schema)]


@lru_cache()
def get_settings() -> Settings:
    return Settings()

