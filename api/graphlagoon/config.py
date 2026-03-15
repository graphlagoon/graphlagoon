from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from functools import lru_cache
from typing import Optional


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

    def model_post_init(self, __context):
        if self.lakebase_enabled:
            object.__setattr__(self, "database_enabled", True)
            if not self.lakebase_instance_name:
                raise ValueError(
                    "lakebase_instance_name is required when lakebase_enabled=True"
                )

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
