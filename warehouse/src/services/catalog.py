"""Catalog service for listing databases, tables, and columns."""
import logging
from pathlib import Path
from pyspark.sql import SparkSession

from src.config import get_settings
from src.models.schemas import (
    CatalogInfo, DatabaseInfo, TableInfo, ColumnInfo, TableSchema,
    CatalogListResponse, DatabaseListResponse, TableListResponse
)

logger = logging.getLogger(__name__)
settings = get_settings()


def list_catalogs(spark: SparkSession) -> CatalogListResponse:
    """List all available catalogs."""
    try:
        # In Spark, the default catalog is spark_catalog
        # Additional catalogs can be configured
        catalogs = []

        # Always include spark_catalog
        catalogs.append(CatalogInfo(name="spark_catalog"))

        # Try to get other catalogs if available
        try:
            result = spark.sql("SHOW CATALOGS").collect()
            for row in result:
                name = row[0]
                if name != "spark_catalog":
                    catalogs.append(CatalogInfo(name=name))
        except Exception:
            # SHOW CATALOGS might not be supported in all Spark versions
            pass

        return CatalogListResponse(catalogs=catalogs)
    except Exception as e:
        # Return at least the default catalog
        return CatalogListResponse(catalogs=[CatalogInfo(name="spark_catalog")])


def list_databases(spark: SparkSession, catalog: str = "spark_catalog") -> DatabaseListResponse:
    """List all databases in a catalog.

    Note: This mocks Databricks behavior. The catalog parameter is accepted
    but ignored - we always use spark_catalog internally.
    """
    databases = []

    try:
        # Always use spark_catalog (Databricks mock)
        # The catalog parameter is accepted but ignored for compatibility

        # Get all databases
        result = spark.sql("SHOW DATABASES").collect()

        for row in result:
            db_name = row[0] if isinstance(row[0], str) else row.namespace

            # Get database details
            try:
                desc_result = spark.sql(f"DESCRIBE DATABASE {db_name}").collect()
                description = None
                location = None
                for desc_row in desc_result:
                    if desc_row[0] == "Description":
                        description = desc_row[1]
                    elif desc_row[0] == "Location":
                        location = desc_row[1]

                databases.append(DatabaseInfo(
                    name=db_name,
                    catalog=catalog,
                    description=description,
                    location=location
                ))
            except Exception:
                databases.append(DatabaseInfo(
                    name=db_name,
                    catalog=catalog
                ))

    except Exception as e:
        # Return empty list on error
        pass

    return DatabaseListResponse(databases=databases)


def list_tables(spark: SparkSession, database: str, catalog: str = "spark_catalog") -> TableListResponse:
    """List all tables in a database.

    Note: This mocks Databricks behavior. The catalog parameter is accepted
    but ignored - we always use spark_catalog internally.
    """
    tables = []

    try:
        # Always use spark_catalog (Databricks mock)
        spark.sql(f"USE {database}")

        # Get all tables
        result = spark.sql(f"SHOW TABLES IN {database}").collect()

        for row in result:
            table_name = row.tableName if hasattr(row, 'tableName') else row[1]
            is_temp = row.isTemporary if hasattr(row, 'isTemporary') else False

            # Get table type
            table_type = "MANAGED"
            try:
                desc_result = spark.sql(f"DESCRIBE EXTENDED {database}.{table_name}").collect()
                for desc_row in desc_result:
                    if desc_row[0] == "Type":
                        table_type = desc_row[1]
                        break
            except Exception:
                pass

            tables.append(TableInfo(
                name=table_name,
                database=database,
                catalog=catalog,
                table_type=table_type,
                is_temporary=is_temp
            ))

    except Exception as e:
        # Return empty list on error
        pass

    return TableListResponse(tables=tables)


def get_table_schema(
    spark: SparkSession,
    table: str,
    database: str,
    catalog: str = "spark_catalog"
) -> TableSchema:
    """Get the schema of a table.

    Note: This mocks Databricks behavior. In our local Spark setup, all tables
    are registered under 'spark_catalog', but the client may pass a different
    catalog name (e.g., 'dev_catalog'). We ignore the catalog parameter and
    always use the default spark_catalog.
    """
    columns = []

    try:
        # Build full table name - always use spark_catalog (Databricks mock)
        # The catalog parameter is accepted but ignored for compatibility
        full_table_name = f"{database}.{table}"

        # Get table schema using DESCRIBE
        result = spark.sql(f"DESCRIBE {full_table_name}").collect()

        for row in result:
            col_name = row[0]
            # Skip partition info and empty rows
            if col_name.startswith("#") or col_name == "" or col_name == "col_name":
                continue

            columns.append(ColumnInfo(
                name=col_name,
                data_type=row[1] if len(row) > 1 else "unknown",
                nullable=True,  # Spark doesn't easily expose nullability in DESCRIBE
                comment=row[2] if len(row) > 2 and row[2] else None
            ))

    except Exception as e:
        raise ValueError(f"Could not get schema for table {table}: {str(e)}")

    return TableSchema(
        table_name=table,
        database=database,
        catalog=catalog,
        columns=columns
    )


def preview_table(
    spark: SparkSession,
    table: str,
    database: str,
    catalog: str = "spark_catalog",
    limit: int = 100
) -> dict:
    """Preview table data.

    Note: This mocks Databricks behavior. The catalog parameter is accepted
    but ignored - we always use spark_catalog internally.
    """
    try:
        # Build full table name - always use spark_catalog (Databricks mock)
        full_table_name = f"{database}.{table}"

        df = spark.sql(f"SELECT * FROM {full_table_name} LIMIT {limit}")
        columns = df.columns
        rows = [[str(v) if v is not None else None for v in row] for row in df.collect()]

        return {
            "columns": columns,
            "rows": rows,
            "row_count": len(rows)
        }
    except Exception as e:
        raise ValueError(f"Could not preview table {table}: {str(e)}")


def register_parquet_tables(spark: SparkSession) -> dict:
    """
    Auto-register all existing parquet files as tables in the Spark catalog.

    Scans the data_path directory and registers any parquet directories
    as external tables in the appropriate database.

    Returns a dict with registration stats.
    """
    # Resolve the data path to an absolute path
    # If relative, resolve relative to the current working directory
    data_dir = Path(settings.data_path)
    if not data_dir.is_absolute():
        # Try to resolve relative to the module location (sql-warehouse directory)
        module_dir = Path(__file__).parent.parent.parent  # src/services/catalog.py -> sql-warehouse/
        data_dir = (module_dir / settings.data_path).resolve()

    registered = 0
    skipped = 0
    errors = []

    logger.info(f"Scanning data directory: {data_dir}")

    if not data_dir.exists():
        logger.warning(f"Data directory does not exist: {data_dir}")
        return {"registered": 0, "skipped": 0, "errors": [f"Data directory not found: {data_dir}"]}

    # Group tables by database (schema)
    tables_by_db: dict[str, list[tuple[str, str, str]]] = {}  # db -> [(table_name, file_name, path)]

    found_dirs = list(data_dir.iterdir())
    logger.info(f"Found {len(found_dirs)} items in data directory")

    for table_dir in found_dirs:
        if not table_dir.is_dir():
            logger.debug(f"Skipping non-directory: {table_dir.name}")
            continue

        file_name = table_dir.name
        if not (file_name.startswith("edges_") or file_name.startswith("nodes_")):
            logger.debug(f"Skipping non-table directory: {file_name}")
            continue

        logger.info(f"Processing table directory: {file_name}")

        # Parse file name to extract database and table
        # Format: edges_catalog__schema__table or nodes_catalog__schema__table
        prefix = "edges_" if file_name.startswith("edges_") else "nodes_"
        name_part = file_name[len(prefix):]
        parts = name_part.split("__")

        if len(parts) == 3:
            catalog, schema, table_suffix = parts
            db_name = schema
            table_name = f"{prefix}{table_suffix}"
        else:
            # Legacy format - use default database
            db_name = "default"
            table_name = file_name

        if db_name not in tables_by_db:
            tables_by_db[db_name] = []
        tables_by_db[db_name].append((table_name, file_name, str(table_dir.absolute())))

    # Register tables for each database
    for db_name, tables in tables_by_db.items():
        # Create database if it doesn't exist
        db_created = False
        try:
            spark.sql(f"CREATE DATABASE IF NOT EXISTS {db_name}")
            logger.info(f"Ensured database exists: {db_name}")
            db_created = True
        except Exception as e:
            logger.warning(f"Could not create database {db_name}: {e}")
            # Will try to register in default database instead

        for table_name, file_name, path in tables:
            # If database creation failed, use default database with prefixed name
            if db_created:
                full_table_name = f"{db_name}.{table_name}"
                check_db = db_name
            else:
                # Fallback: use default database with db_name prefix
                full_table_name = f"default.{db_name}_{table_name}"
                check_db = "default"
                table_name = f"{db_name}_{table_name}"

            # Register (or re-register) as external parquet table
            # Drop first to fix tables with stale/broken paths
            try:
                spark.sql(f"DROP TABLE IF EXISTS {full_table_name}")
                spark.sql(f"""
                    CREATE TABLE {full_table_name}
                    USING parquet
                    LOCATION '{path}'
                """)
                logger.info(f"Registered table: {full_table_name} -> {path}")
                registered += 1
            except Exception as e:
                error_msg = f"Failed to register {full_table_name}: {e}"
                logger.warning(error_msg)
                errors.append(error_msg)

    result = {
        "registered": registered,
        "skipped": skipped,
        "errors": errors
    }
    logger.info(f"Auto-registration complete: {result}")
    return result
