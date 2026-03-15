import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional, Any, Callable, Awaitable, Union

import httpx

from graphlagoon.config import Settings
from graphlagoon.models.schemas import (
    DatasetsResponse,
    RandomGraphRequest,
    RandomGraphResponse,
    CatalogListResponse,
    DatabaseListResponse,
    TableListResponse,
    TableSchema,
    TablePreviewResponse,
    SchemaDiscoveryResponse,
    ColumnConfig,
    StatementResponse,
    StatementResultData,
    ExternalLinkInfo,
)

logger = logging.getLogger(__name__)

# Type for header provider: callable that returns auth token string
# Can be sync (returns str) or async (returns Awaitable[str])
HeaderProvider = Callable[[], Union[str, Awaitable[str]]]

# Global state for lazy initialization
_settings: Optional[Settings] = None
_warehouse_client: Optional["WarehouseClient"] = None
_header_provider: Optional[HeaderProvider] = None


def configure_warehouse(
    settings: Settings,
    header_provider: Optional[HeaderProvider] = None,
) -> None:
    """Configure warehouse with given settings. Call before first use.

    Args:
        settings: Warehouse configuration settings.
        header_provider: Optional async/sync callable that returns auth token string.
                        When provided, this will be called before each request
                        to get a fresh token (useful for token refresh scenarios).
                        The token is automatically wrapped in Authorization: Bearer header.
    """
    global _settings, _warehouse_client, _header_provider
    _settings = settings
    _header_provider = header_provider

    # Reset client if reconfiguring
    if _warehouse_client is not None:
        # Note: async close should be done via close_warehouse_client()
        _warehouse_client = None


def _get_settings() -> Settings:
    """Get settings, using defaults if not configured."""
    global _settings
    if _settings is None:
        from graphlagoon.config import get_settings

        _settings = get_settings()
    return _settings


def _get_header_provider() -> Optional[HeaderProvider]:
    """Get configured header provider."""
    global _header_provider
    return _header_provider


class WarehouseClient:
    """HTTP client for SQL warehouse (local sql-warehouse or Databricks)."""

    def __init__(
        self,
        settings: Optional[Settings] = None,
        header_provider: Optional[HeaderProvider] = None,
    ):
        if settings is None:
            settings = _get_settings()
        if header_provider is None:
            header_provider = _get_header_provider()

        self._settings = settings
        self._header_provider = header_provider
        self.base_url = settings.warehouse_base_url
        self.warehouse_id = settings.warehouse_id
        self.databricks_mode = settings.databricks_mode
        self.default_catalog = settings.default_catalog
        self.default_schema = settings.default_schema
        self.catalog_schema_pairs = settings.catalog_schema_pairs
        self.http_timeout = settings.warehouse_http_timeout
        self.wait_timeout = settings.warehouse_wait_timeout
        self.max_poll_time = settings.warehouse_max_poll_time
        self.poll_interval = settings.warehouse_poll_interval

        # Only get static headers if no dynamic provider is configured
        # This allows using header_provider without requiring databricks_token in settings
        if self._header_provider is not None:
            self._static_headers = {}
            self.client = httpx.AsyncClient(timeout=self.http_timeout)
        else:
            self._static_headers = settings.warehouse_headers
            self.client = httpx.AsyncClient(
                timeout=self.http_timeout, headers=self._static_headers
            )

    async def _get_headers(self) -> dict:
        """Get headers for request. Calls provider if configured, else returns static headers."""
        if self._header_provider is None:
            return self._static_headers

        # Call the provider - it may be sync or async
        import inspect
        import logging

        logger = logging.getLogger(__name__)

        try:
            result = self._header_provider()

            # Check for awaitable (coroutine, Future, Task, etc.)
            if inspect.isawaitable(result):
                token = await result
            else:
                token = result

            # Validate token
            if token is None:
                logger.error("header_provider returned None")
                raise ValueError(
                    "header_provider returned None - expected a token string"
                )

            if not isinstance(token, str):
                logger.error(
                    f"header_provider returned {type(token).__name__}, expected str"
                )
                raise TypeError(
                    f"header_provider must return str, got {type(token).__name__}"
                )

            if not token.strip():
                logger.error("header_provider returned empty string")
                raise ValueError("header_provider returned empty token string")
            token = token.replace("Bearer ", "").strip()
            # Convert token string to Authorization header
            return {"Authorization": f"Bearer {token}"}

        except Exception as e:
            logger.error(f"Error calling header_provider: {type(e).__name__}: {e}")
            # Re-raise with more context
            raise RuntimeError(
                f"Failed to get auth token from header_provider: {e}"
            ) from e

    async def close(self):
        await self.client.aclose()

    async def _post(self, path: str, json: Optional[dict] = None) -> dict:
        """Make POST request to warehouse."""
        import logging

        logger = logging.getLogger(__name__)

        url = f"{self.base_url}{path}"
        try:
            headers = await self._get_headers() if self._header_provider else None
        except Exception as e:
            logger.error(f"Failed to get headers for POST {path}: {e}")
            raise

        try:
            response = await self.client.post(url, json=json or {}, headers=headers)
        except httpx.ConnectError as e:
            logger.error(f"Connection error to {url}: {e}")
            raise RuntimeError(
                f"Cannot connect to warehouse at {self.base_url}: {e}"
            ) from e
        except httpx.TimeoutException as e:
            logger.error(f"Timeout connecting to {url}: {e}")
            raise RuntimeError(
                f"Timeout connecting to warehouse at {self.base_url}: {e}"
            ) from e
        except httpx.RequestError as e:
            logger.error(f"Request error to {url}: {e}")
            raise RuntimeError(f"Request failed to warehouse: {e}") from e

        if response.status_code >= 400:
            try:
                error_data = response.json()
                # Handle both local and Databricks error formats
                if "detail" in error_data:
                    error_msg = (
                        error_data.get("detail", {})
                        .get("error", {})
                        .get("message", str(error_data))
                    )
                elif "message" in error_data:
                    error_msg = error_data.get("message")
                else:
                    error_msg = str(error_data)
            except Exception:
                error_msg = response.text
            logger.error(
                f"Warehouse error {response.status_code} for {path}: {error_msg}"
            )
            raise httpx.HTTPStatusError(
                f"Warehouse error ({response.status_code}): {error_msg}",
                request=response.request,
                response=response,
            )

        try:
            return response.json()
        except Exception as e:
            logger.error(
                f"Failed to parse JSON response from {path}: {e}, body: {response.text[:500]}"
            )
            raise RuntimeError(f"Invalid JSON response from warehouse: {e}") from e

    async def _get(self, path: str, params: Optional[dict] = None) -> dict:
        """Make GET request to warehouse."""
        import logging

        logger = logging.getLogger(__name__)

        url = f"{self.base_url}{path}"
        try:
            headers = await self._get_headers() if self._header_provider else None
        except Exception as e:
            logger.error(f"Failed to get headers for GET {path}: {e}")
            raise

        try:
            response = await self.client.get(url, params=params, headers=headers)
        except httpx.ConnectError as e:
            logger.error(f"Connection error to {url}: {e}")
            raise RuntimeError(
                f"Cannot connect to warehouse at {self.base_url}: {e}"
            ) from e
        except httpx.TimeoutException as e:
            logger.error(f"Timeout connecting to {url}: {e}")
            raise RuntimeError(
                f"Timeout connecting to warehouse at {self.base_url}: {e}"
            ) from e
        except httpx.RequestError as e:
            logger.error(f"Request error to {url}: {e}")
            raise RuntimeError(f"Request failed to warehouse: {e}") from e

        if response.status_code >= 400:
            try:
                error_data = response.json()
                if "detail" in error_data:
                    error_msg = (
                        error_data.get("detail", {})
                        .get("error", {})
                        .get("message", str(error_data))
                    )
                elif "message" in error_data:
                    error_msg = error_data.get("message")
                else:
                    error_msg = str(error_data)
            except Exception:
                error_msg = response.text
            logger.error(
                f"Warehouse error {response.status_code} for {path}: {error_msg}"
            )
            raise httpx.HTTPStatusError(
                f"Warehouse error ({response.status_code}): {error_msg}",
                request=response.request,
                response=response,
            )

        try:
            return response.json()
        except Exception as e:
            logger.error(
                f"Failed to parse JSON response from {path}: {e}, body: {response.text[:500]}"
            )
            raise RuntimeError(f"Invalid JSON response from warehouse: {e}") from e

    async def _delete(self, path: str) -> dict:
        """Make DELETE request to warehouse."""
        import logging

        logger = logging.getLogger(__name__)

        url = f"{self.base_url}{path}"
        try:
            headers = await self._get_headers() if self._header_provider else None
        except Exception as e:
            logger.error(f"Failed to get headers for DELETE {path}: {e}")
            raise

        try:
            response = await self.client.delete(url, headers=headers)
        except httpx.ConnectError as e:
            logger.error(f"Connection error to {url}: {e}")
            raise RuntimeError(
                f"Cannot connect to warehouse at {self.base_url}: {e}"
            ) from e
        except httpx.TimeoutException as e:
            logger.error(f"Timeout connecting to {url}: {e}")
            raise RuntimeError(
                f"Timeout connecting to warehouse at {self.base_url}: {e}"
            ) from e
        except httpx.RequestError as e:
            logger.error(f"Request error to {url}: {e}")
            raise RuntimeError(f"Request failed to warehouse: {e}") from e

        if response.status_code >= 400:
            try:
                error_data = response.json()
                error_msg = error_data.get("message", str(error_data))
            except Exception:
                error_msg = response.text
            logger.error(
                f"Warehouse error {response.status_code} for DELETE {path}: {error_msg}"
            )
            raise httpx.HTTPStatusError(
                f"Warehouse error ({response.status_code}): {error_msg}",
                request=response.request,
                response=response,
            )

        try:
            return response.json()
        except Exception as e:
            logger.error(f"Failed to parse JSON response from DELETE {path}: {e}")
            raise RuntimeError(f"Invalid JSON response from warehouse: {e}") from e

    async def list_datasets(self) -> DatasetsResponse:
        """List available edge and node tables.

        In Databricks mode: searches configured catalog_schema_pairs.
        In local mode: discovers all schemas dynamically via SHOW DATABASES.
        Returns 3-part names: catalog.schema.table.
        """
        edge_tables: list[str] = []
        node_tables: list[str] = []

        if self.databricks_mode:
            for catalog, schema in self.catalog_schema_pairs:
                await self._list_datasets_databricks(
                    catalog,
                    schema,
                    edge_tables,
                    node_tables,
                )
        else:
            # Discover all schemas dynamically in local Spark mode
            schemas = await self._list_spark_schemas()
            for schema in schemas:
                await self._list_datasets_spark(
                    self.default_catalog,
                    schema,
                    edge_tables,
                    node_tables,
                )

        return DatasetsResponse(
            edge_tables=sorted(set(edge_tables)),
            node_tables=sorted(set(node_tables)),
        )

    async def _list_spark_schemas(self) -> list[str]:
        """List all available schemas/databases in local Spark."""
        result = await self.execute_statement(statement="SHOW DATABASES")
        schemas = []
        if result.status.state == "SUCCEEDED" and result.result:
            for row in result.result.data_array:
                if row and row[0]:
                    schemas.append(row[0])
        return schemas or [self.default_schema]

    async def _list_datasets_databricks(
        self,
        catalog: str,
        schema: str,
        edge_tables: list[str],
        node_tables: list[str],
    ) -> None:
        """Search for edge/node tables in a Databricks catalog.schema."""
        query = f"""
            SELECT table_schema, table_name
            FROM {catalog}.information_schema.tables
            WHERE table_catalog = '{catalog.replace("`", "")}'
              AND table_schema = '{schema}'
              AND (table_name LIKE '%edge%' OR table_name LIKE '%node%')
            ORDER BY table_schema, table_name
        """
        result = await self.execute_statement(statement=query)
        if result.status.state == "SUCCEEDED" and result.result:
            for row in result.result.data_array:
                s = row[0]
                table_name = row[1]
                if s and table_name:
                    full_name = f"{catalog}.{s}.{table_name}"
                    if "edge" in table_name:
                        edge_tables.append(full_name)
                    elif "node" in table_name:
                        node_tables.append(full_name)
        elif result.status.error:
            raise Exception(result.status.error.message)

    async def _list_datasets_spark(
        self,
        catalog: str,
        schema: str,
        edge_tables: list[str],
        node_tables: list[str],
    ) -> None:
        """Search for edge/node tables in a local Spark schema."""
        result = await self.execute_statement(
            statement=f"SHOW TABLES IN {schema}",
        )
        if result.status.state == "SUCCEEDED" and result.result:
            for row in result.result.data_array:
                # SHOW TABLES returns: database, tableName, isTemporary
                s = row[0] if len(row) > 0 else schema
                table_name = row[1] if len(row) > 1 else row[0]
                if table_name:
                    full_name = f"{catalog}.{s}.{table_name}"
                    if "edge" in table_name:
                        edge_tables.append(full_name)
                    if "node" in table_name:
                        node_tables.append(full_name)

    async def create_random_graph(
        self, request: RandomGraphRequest
    ) -> RandomGraphResponse:
        """Generate a random graph (dev mode only - not available in Databricks)."""
        if self.databricks_mode:
            raise NotImplementedError(
                "Random graph generation is not available in Databricks mode. "
                "Use existing tables or create data via Databricks notebooks."
            )
        data = await self._post("/graph/random", json=request.model_dump())
        return RandomGraphResponse(**data)

    async def clear_all_tables(self) -> dict:
        """Clear all parquet tables (dev mode only - not available in Databricks)."""
        if self.databricks_mode:
            raise NotImplementedError(
                "Clear all tables is not available in Databricks mode. "
                "Manage table lifecycle via Databricks workspace."
            )
        return await self._delete("/dev/clear-all")

    async def discover_schema(
        self,
        edge_table: str,
        node_table: str,
        columns: ColumnConfig,
    ) -> SchemaDiscoveryResponse:
        """Discover distinct node_types and relationship_types from tables.

        Uses the Databricks-compatible statements API to query distinct values.
        sql-warehouse handles catalog.schema.table -> schema.table conversion.
        """
        import logging

        logger = logging.getLogger(__name__)
        errors: list[str] = []

        # Query distinct node types
        node_types: list[str] = []
        node_query = f"SELECT DISTINCT `{columns.node_type_col}` FROM {node_table}"
        try:
            result = await self.execute_statement(statement=node_query)
            if result.status.state == "SUCCEEDED" and result.result:
                node_types = sorted(
                    [row[0] for row in result.result.data_array if row[0] is not None]
                )
            elif result.status.state != "SUCCEEDED":
                error_msg = (
                    result.status.error.message
                    if result.status.error
                    else "Unknown error"
                )
                errors.append(f"Node types query failed: {error_msg}")
                logger.warning(f"discover_schema node_types query failed: {error_msg}")
        except Exception as e:
            errors.append(f"Node types query error: {e}")
            logger.warning(f"discover_schema node_types exception: {e}")

        # Query distinct relationship types
        relationship_types: list[str] = []
        edge_query = (
            f"SELECT DISTINCT `{columns.relationship_type_col}` FROM {edge_table}"
        )
        try:
            result = await self.execute_statement(statement=edge_query)
            if result.status.state == "SUCCEEDED" and result.result:
                relationship_types = sorted(
                    [row[0] for row in result.result.data_array if row[0] is not None]
                )
            elif result.status.state != "SUCCEEDED":
                error_msg = (
                    result.status.error.message
                    if result.status.error
                    else "Unknown error"
                )
                errors.append(f"Relationship types query failed: {error_msg}")
                logger.warning(
                    f"discover_schema relationship_types query failed: {error_msg}"
                )
        except Exception as e:
            errors.append(f"Relationship types query error: {e}")
            logger.warning(f"discover_schema relationship_types exception: {e}")

        # If both queries failed, raise so the user sees the error
        if errors and not node_types and not relationship_types:
            raise Exception("; ".join(errors))

        return SchemaDiscoveryResponse(
            node_types=node_types, relationship_types=relationship_types
        )

    # Catalog methods - implemented via SQL queries
    async def list_catalogs(self) -> CatalogListResponse:
        """List all available catalogs using SHOW CATALOGS."""
        from graphlagoon.models.schemas import CatalogInfo

        catalogs: list[CatalogInfo] = []

        try:
            result = await self.execute_statement(statement="SHOW CATALOGS")
            if result.status.state == "SUCCEEDED" and result.result:
                for row in result.result.data_array:
                    if row[0]:
                        catalogs.append(CatalogInfo(name=row[0]))
        except Exception:
            # Fallback: local Spark may not support SHOW CATALOGS
            catalogs.append(CatalogInfo(name="spark_catalog"))

        return CatalogListResponse(catalogs=catalogs)

    async def list_databases(
        self, catalog: Optional[str] = None
    ) -> DatabaseListResponse:
        """List all databases in a catalog using SHOW SCHEMAS."""
        from graphlagoon.models.schemas import DatabaseInfo

        databases: list[DatabaseInfo] = []

        if catalog is None:
            catalog = self.default_catalog

        try:
            # Try SHOW SCHEMAS IN catalog first (Databricks style)
            result = await self.execute_statement(
                statement=f"SHOW SCHEMAS IN {catalog}"
            )
            if result.status.state != "SUCCEEDED" or not result.result:
                # Fallback to SHOW SCHEMAS (local Spark)
                result = await self.execute_statement(statement="SHOW SCHEMAS")

            if result.status.state == "SUCCEEDED" and result.result:
                for row in result.result.data_array:
                    db_name = row[0]
                    if db_name:
                        databases.append(
                            DatabaseInfo(
                                name=db_name,
                                catalog=catalog,
                                description=None,
                                location=None,
                            )
                        )
        except Exception:
            pass

        return DatabaseListResponse(databases=databases)

    async def list_tables(
        self, database: Optional[str] = None, catalog: Optional[str] = None
    ) -> TableListResponse:
        """List all tables in a database using SHOW TABLES."""
        from graphlagoon.models.schemas import TableInfo

        tables: list[TableInfo] = []

        if catalog is None:
            catalog = self.default_catalog
        if database is None:
            database = self.default_schema

        try:
            # Try catalog.database format first (Databricks style)
            result = await self.execute_statement(
                statement=f"SHOW TABLES IN {catalog}.{database}"
            )
            if result.status.state != "SUCCEEDED" or not result.result:
                # Fallback to just database (local Spark)
                result = await self.execute_statement(
                    statement=f"SHOW TABLES IN {database}"
                )

            if result.status.state == "SUCCEEDED" and result.result:
                for row in result.result.data_array:
                    # SHOW TABLES returns: database, tableName, isTemporary
                    table_name = row[1] if len(row) > 1 else row[0]
                    is_temp = row[2] == "true" if len(row) > 2 else False
                    if table_name:
                        tables.append(
                            TableInfo(
                                name=table_name,
                                database=database,
                                catalog=catalog,
                                table_type="MANAGED",
                                is_temporary=is_temp,
                            )
                        )
        except Exception:
            pass

        return TableListResponse(tables=tables)

    async def get_table_schema(
        self, table: str, database: Optional[str] = None, catalog: Optional[str] = None
    ) -> TableSchema:
        """Get the schema of a table using DESCRIBE TABLE."""
        from graphlagoon.models.schemas import ColumnInfo

        columns: list[ColumnInfo] = []

        if catalog is None:
            catalog = self.default_catalog
        if database is None:
            database = self.default_schema

        # Try catalog.database.table format first
        full_table_name = f"{catalog}.{database}.{table}"
        result = await self.execute_statement(
            statement=f"DESCRIBE TABLE {full_table_name}"
        )

        if result.status.state != "SUCCEEDED" or not result.result:
            # Fallback to database.table
            full_table_name = f"{database}.{table}"
            result = await self.execute_statement(
                statement=f"DESCRIBE TABLE {full_table_name}"
            )

        if result.status.state == "SUCCEEDED" and result.result:
            for row in result.result.data_array:
                col_name = row[0]
                col_type = row[1] if len(row) > 1 else "string"
                comment = row[2] if len(row) > 2 else None

                # Skip partition info rows (they start with #)
                if (
                    col_name
                    and not col_name.startswith("#")
                    and not col_name.startswith("Part")
                ):
                    columns.append(
                        ColumnInfo(
                            name=col_name,
                            data_type=col_type or "string",
                            nullable=True,
                            comment=comment,
                        )
                    )

        return TableSchema(
            table_name=table, database=database, catalog=catalog, columns=columns
        )

    async def preview_table(
        self,
        table: str,
        database: Optional[str] = None,
        catalog: Optional[str] = None,
        limit: int = 100,
    ) -> TablePreviewResponse:
        """Preview table data using SELECT query."""
        if catalog is None:
            catalog = self.default_catalog
        if database is None:
            database = self.default_schema

        # Try catalog.database.table format first
        full_table_name = f"{catalog}.{database}.{table}"
        result = await self.execute_statement(
            statement=f"SELECT * FROM {full_table_name} LIMIT {limit}"
        )

        if result.status.state != "SUCCEEDED" or not result.result:
            # Fallback to database.table
            full_table_name = f"{database}.{table}"
            result = await self.execute_statement(
                statement=f"SELECT * FROM {full_table_name} LIMIT {limit}"
            )

        columns: list[str] = []
        rows: list[list[Optional[str]]] = []

        if result.status.state == "SUCCEEDED":
            if result.manifest:
                columns = [col.name for col in result.manifest.schema.columns]
            if result.result:
                rows = result.result.data_array

        return TablePreviewResponse(columns=columns, rows=rows, row_count=len(rows))

    async def refresh_catalog(self) -> dict:
        """Re-register all parquet tables in the Spark catalog.

        Note: This is a dev-only operation specific to local Spark.
        In production Databricks, tables are managed automatically.
        """
        if self.databricks_mode:
            # No-op in Databricks - tables are managed automatically
            return {
                "status": "skipped",
                "message": "Catalog refresh not needed in Databricks mode",
            }
        return await self._post("/catalog/refresh")

    # Databricks-compatible SQL Statements API
    async def execute_statement(
        self,
        statement: str,
        catalog: Optional[str] = None,
        schema: Optional[str] = None,
        row_limit: Optional[int] = None,
        parameters: Optional[list[dict[str, Any]]] = None,
    ) -> StatementResponse:
        """Execute a SQL statement using Databricks-compatible API.

        Works with both local sql-warehouse and real Databricks.
        Uses the configured warehouse_id from settings.

        Args:
            statement: The SQL query to execute
            catalog: Default catalog for the query (uses configured default if None)
            schema: Default schema for the query (uses configured default if None)
            row_limit: Maximum rows to return
            parameters: Named parameters list [{"name": "x", "value": "1", "type": "INT"}]
        """
        # Use default catalog and schema from settings
        if catalog is None:
            catalog = self.default_catalog
        if schema is None:
            schema = self.default_schema

        request_body = {
            "statement": statement,
            "warehouse_id": self.warehouse_id,
            "disposition": "INLINE",
            "format": "JSON_ARRAY",
            "wait_timeout": f"{self.wait_timeout}s",
        }
        if catalog:
            request_body["catalog"] = catalog
        if schema:
            request_body["schema"] = schema
        if row_limit:
            request_body["row_limit"] = row_limit
        if parameters:
            request_body["parameters"] = parameters

        data = await self._post("/api/2.0/sql/statements", json=request_body)

        # Parse response with validation error handling
        try:
            return StatementResponse(**data)
        except Exception as e:
            logger.error(f"Failed to parse StatementResponse: {e}")
            logger.error(
                f"Response data keys: {list(data.keys()) if isinstance(data, dict) else type(data)}"
            )
            if isinstance(data, dict):
                status = data.get("status", {})
                logger.error(f"Status: {status}")
            raise RuntimeError(
                f"Invalid response from warehouse (failed to parse StatementResponse): {e}"
            ) from e

    async def _get_no_auth(self, url: str) -> bytes:
        """Download from presigned URL WITHOUT Authorization header.

        Presigned URLs contain embedded credentials and must NOT include
        an Authorization header, which would cause 403 errors.
        """
        async with httpx.AsyncClient(timeout=self.http_timeout) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.content

    async def _download_external_chunk(
        self,
        link_info: ExternalLinkInfo,
        statement_id: str,
    ) -> list[list[Optional[str]]]:
        """Download a single chunk from its presigned URL.

        Handles expiration checking and 403 retry with fresh URL.
        """
        url = link_info.external_link

        # Check expiration before downloading
        try:
            expiry = datetime.fromisoformat(link_info.expiration.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) >= expiry:
                logger.warning(
                    f"External link for chunk {link_info.chunk_index} expired, "
                    "fetching fresh URL"
                )
                url = await self._refresh_chunk_url(
                    statement_id, link_info.chunk_index, url
                )
        except (ValueError, KeyError) as e:
            logger.warning(f"Could not parse expiration '{link_info.expiration}': {e}")

        # Download data WITHOUT Authorization header
        try:
            raw_bytes = await self._get_no_auth(url)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 403:
                logger.warning(
                    f"403 downloading chunk {link_info.chunk_index}, "
                    "refreshing URL and retrying"
                )
                url = await self._refresh_chunk_url(
                    statement_id, link_info.chunk_index, url
                )
                raw_bytes = await self._get_no_auth(url)
            else:
                raise

        # Parse JSON array
        try:
            rows = json.loads(raw_bytes)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"Invalid JSON in external chunk {link_info.chunk_index}: {e}"
            ) from e

        if not isinstance(rows, list):
            raise RuntimeError(
                f"Expected JSON array from chunk {link_info.chunk_index}, "
                f"got {type(rows).__name__}"
            )

        return rows

    async def _refresh_chunk_url(
        self,
        statement_id: str,
        chunk_index: int,
        fallback_url: str,
    ) -> str:
        """Fetch a fresh presigned URL for a chunk from Databricks."""
        chunk_data = await self._get(
            f"/api/2.0/sql/statements/{statement_id}/result/chunks/{chunk_index}"
        )
        links = chunk_data.get("external_links", [])
        if links:
            return links[0].get("external_link", fallback_url)
        raise RuntimeError(f"Failed to refresh URL for chunk {chunk_index}")

    async def execute_statement_external(
        self,
        statement: str,
        catalog: Optional[str] = None,
        schema: Optional[str] = None,
        row_limit: Optional[int] = None,
        parameters: Optional[list[dict[str, Any]]] = None,
        poll_interval: Optional[float] = None,
        max_poll_time: Optional[float] = None,
    ) -> StatementResponse:
        """Execute SQL with EXTERNAL_LINKS disposition for large results.

        Handles the complete flow:
        1. Submit with disposition=EXTERNAL_LINKS
        2. Poll for completion if state is PENDING/RUNNING
        3. Fetch all chunk manifests
        4. Download data from presigned URLs (no auth header)
        5. Combine into a single StatementResponse with inline data_array

        Works with both Databricks and local warehouse (which simulates
        external links for dev testing).
        """

        if catalog is None:
            catalog = self.default_catalog
        if schema is None:
            schema = self.default_schema
        if poll_interval is None:
            poll_interval = self.poll_interval
        if max_poll_time is None:
            max_poll_time = self.max_poll_time

        # Step 1: Submit with EXTERNAL_LINKS disposition
        request_body: dict[str, Any] = {
            "statement": statement,
            "warehouse_id": self.warehouse_id,
            "disposition": "EXTERNAL_LINKS",
            "format": "JSON_ARRAY",
            "wait_timeout": f"{self.wait_timeout}s",
        }
        if catalog:
            request_body["catalog"] = catalog
        if schema:
            request_body["schema"] = schema
        if row_limit:
            request_body["row_limit"] = row_limit
        if parameters:
            request_body["parameters"] = parameters

        data = await self._post("/api/2.0/sql/statements", json=request_body)

        try:
            response = StatementResponse(**data)
        except Exception as e:
            logger.error(f"Failed to parse StatementResponse: {e}")
            raise RuntimeError(f"Invalid response from warehouse: {e}") from e

        # Step 2: Poll if not yet completed
        statement_id = response.statement_id
        elapsed = 0.0

        while response.status.state in ("PENDING", "RUNNING"):
            if elapsed >= max_poll_time:
                try:
                    await self._post(f"/api/2.0/sql/statements/{statement_id}/cancel")
                except Exception:
                    pass
                raise RuntimeError(
                    f"Statement {statement_id} did not complete within "
                    f"{max_poll_time}s (state: {response.status.state})"
                )

            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

            poll_data = await self._get(f"/api/2.0/sql/statements/{statement_id}")
            try:
                response = StatementResponse(**poll_data)
            except Exception as e:
                logger.error(f"Failed to parse poll response: {e}")
                raise RuntimeError(f"Invalid poll response from warehouse: {e}") from e

        # Step 3: Check for failure
        if response.status.state != "SUCCEEDED":
            return response  # Caller handles errors via _parse_statement_result

        # Step 4: Download all chunks from external links
        all_rows: list[list[Optional[str]]] = []

        initial_links = (
            response.result.external_links
            if response.result and response.result.external_links
            else []
        )

        for link_info in initial_links:
            chunk_rows = await self._download_external_chunk(link_info, statement_id)
            all_rows.extend(chunk_rows)

        # Fetch additional chunks not in the initial response
        if response.manifest and response.manifest.total_chunk_count:
            fetched = {el.chunk_index for el in initial_links}
            for chunk_idx in range(response.manifest.total_chunk_count):
                if chunk_idx in fetched:
                    continue
                chunk_manifest = await self._get(
                    f"/api/2.0/sql/statements/{statement_id}/result/chunks/{chunk_idx}"
                )
                links_data = chunk_manifest.get("external_links", [])
                for eli_data in links_data:
                    eli = ExternalLinkInfo(**eli_data)
                    chunk_rows = await self._download_external_chunk(eli, statement_id)
                    all_rows.extend(chunk_rows)

        # Step 5: Construct inline-compatible response
        inline_result = StatementResultData(
            chunk_index=0,
            row_offset=0,
            row_count=len(all_rows),
            data_array=all_rows,
        )

        return StatementResponse(
            statement_id=response.statement_id,
            status=response.status,
            manifest=response.manifest,
            result=inline_result,
        )


def get_warehouse_client() -> WarehouseClient:
    """Get warehouse client singleton."""
    global _warehouse_client
    if _warehouse_client is None:
        _warehouse_client = WarehouseClient()
    return _warehouse_client


async def close_warehouse_client():
    """Close warehouse client."""
    global _warehouse_client
    if _warehouse_client is not None:
        await _warehouse_client.close()
        _warehouse_client = None
