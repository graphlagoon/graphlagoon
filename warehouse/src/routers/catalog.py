"""Catalog router for listing databases, tables, and columns."""
from fastapi import APIRouter, HTTPException, Depends, Query
from pyspark.sql import SparkSession

from src.services.spark import get_spark_session
from src.services.catalog import (
    list_catalogs, list_databases, list_tables, get_table_schema, preview_table,
    register_parquet_tables
)
from src.models.schemas import (
    CatalogListResponse, DatabaseListResponse, TableListResponse,
    TableSchema, ErrorResponse
)

router = APIRouter(prefix="/catalog", tags=["catalog"])


def get_spark() -> SparkSession:
    return get_spark_session()


@router.get("/catalogs", response_model=CatalogListResponse)
async def get_catalogs(spark: SparkSession = Depends(get_spark)):
    """List all available catalogs."""
    return list_catalogs(spark)


@router.get("/databases", response_model=DatabaseListResponse)
async def get_databases(
    catalog: str = Query(default="spark_catalog", description="Catalog name"),
    spark: SparkSession = Depends(get_spark)
):
    """List all databases in a catalog."""
    return list_databases(spark, catalog)


@router.get("/tables", response_model=TableListResponse)
async def get_tables(
    database: str = Query(..., description="Database/schema name"),
    catalog: str = Query(default="spark_catalog", description="Catalog name"),
    spark: SparkSession = Depends(get_spark)
):
    """List all tables in a database."""
    return list_tables(spark, database, catalog)


@router.get(
    "/schema",
    response_model=TableSchema,
    responses={404: {"model": ErrorResponse}}
)
async def get_schema(
    table: str = Query(..., description="Table name"),
    database: str = Query(..., description="Database/schema name"),
    catalog: str = Query(default="spark_catalog", description="Catalog name"),
    spark: SparkSession = Depends(get_spark)
):
    """Get the schema of a table."""
    try:
        return get_table_schema(spark, table, database, catalog)
    except ValueError as e:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "TABLE_NOT_FOUND",
                    "message": str(e),
                    "details": {"table": table, "database": database, "catalog": catalog}
                }
            }
        )


@router.get("/preview")
async def get_preview(
    table: str = Query(..., description="Table name"),
    database: str = Query(..., description="Database/schema name"),
    catalog: str = Query(default="spark_catalog", description="Catalog name"),
    limit: int = Query(default=100, le=1000, description="Max rows to return"),
    spark: SparkSession = Depends(get_spark)
):
    """Preview table data."""
    try:
        return preview_table(spark, table, database, catalog, limit)
    except ValueError as e:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "TABLE_NOT_FOUND",
                    "message": str(e),
                    "details": {"table": table, "database": database, "catalog": catalog}
                }
            }
        )


@router.post("/refresh")
async def refresh_catalog(spark: SparkSession = Depends(get_spark)):
    """Re-register all parquet tables in the Spark catalog.

    This is useful when tables are created after the service starts,
    or when you need to sync the catalog with the filesystem.
    """
    result = register_parquet_tables(spark)
    return {
        "status": "success",
        "registered": result["registered"],
        "skipped": result["skipped"],
        "errors": result["errors"]
    }
