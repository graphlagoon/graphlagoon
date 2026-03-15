"""Catalog router for listing databases, tables, and columns."""

from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Request, Query

from graphlagoon.models.schemas import (
    CatalogListResponse,
    DatabaseListResponse,
    TableListResponse,
    TableSchema,
    TablePreviewResponse,
)
from graphlagoon.services.warehouse import get_warehouse_client, WarehouseClient
from graphlagoon.middleware.auth import get_current_user

router = APIRouter(prefix="/api/catalog", tags=["catalog"])


def get_warehouse() -> WarehouseClient:
    """Get warehouse client dependency."""
    return get_warehouse_client()


@router.get("/catalogs", response_model=CatalogListResponse)
async def list_catalogs(
    request: Request, warehouse: WarehouseClient = Depends(get_warehouse)
):
    """List all available catalogs."""
    get_current_user(request)  # Ensure authenticated
    return await warehouse.list_catalogs()


@router.get("/databases", response_model=DatabaseListResponse)
async def list_databases(
    request: Request,
    catalog: Optional[str] = Query(
        default=None, description="Catalog name (uses configured default)"
    ),
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """List all databases in a catalog."""
    get_current_user(request)  # Ensure authenticated
    return await warehouse.list_databases(catalog)


@router.get("/tables", response_model=TableListResponse)
async def list_tables(
    request: Request,
    database: Optional[str] = Query(
        default=None, description="Database/schema name (uses configured default)"
    ),
    catalog: Optional[str] = Query(
        default=None, description="Catalog name (uses configured default)"
    ),
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """List all tables in a database."""
    get_current_user(request)  # Ensure authenticated
    return await warehouse.list_tables(database, catalog)


@router.get("/schema", response_model=TableSchema)
async def get_table_schema(
    request: Request,
    table: str = Query(..., description="Table name"),
    database: Optional[str] = Query(
        default=None, description="Database/schema name (uses configured default)"
    ),
    catalog: Optional[str] = Query(
        default=None, description="Catalog name (uses configured default)"
    ),
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """Get the schema of a table."""
    get_current_user(request)  # Ensure authenticated
    try:
        return await warehouse.get_table_schema(table, database, catalog)
    except Exception as e:
        # Get defaults from warehouse for error message
        actual_catalog = catalog or warehouse.default_catalog
        actual_database = database or warehouse.default_schema
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "TABLE_NOT_FOUND",
                    "message": str(e),
                    "details": {
                        "table": table,
                        "database": actual_database,
                        "catalog": actual_catalog,
                    },
                }
            },
        ) from e


@router.get("/preview", response_model=TablePreviewResponse)
async def preview_table(
    request: Request,
    table: str = Query(..., description="Table name"),
    database: Optional[str] = Query(
        default=None, description="Database/schema name (uses configured default)"
    ),
    catalog: Optional[str] = Query(
        default=None, description="Catalog name (uses configured default)"
    ),
    limit: int = Query(default=100, le=1000, description="Max rows"),
    warehouse: WarehouseClient = Depends(get_warehouse),
):
    """Preview table data."""
    get_current_user(request)  # Ensure authenticated
    try:
        return await warehouse.preview_table(table, database, catalog, limit)
    except Exception as e:
        actual_catalog = catalog or warehouse.default_catalog
        actual_database = database or warehouse.default_schema
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "TABLE_NOT_FOUND",
                    "message": str(e),
                    "details": {
                        "table": table,
                        "database": actual_database,
                        "catalog": actual_catalog,
                    },
                }
            },
        ) from e


@router.post("/refresh")
async def refresh_catalog(
    request: Request, warehouse: WarehouseClient = Depends(get_warehouse)
):
    """Re-register all parquet tables in the Spark catalog.

    This is useful when tables are created after the service starts,
    or when you need to sync the catalog with the filesystem.
    """
    get_current_user(request)  # Ensure authenticated
    return await warehouse.refresh_catalog()
