import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Depends
from pyspark.sql import SparkSession

from src.services.spark import get_spark_session
from src.services.graph import list_tables, generate_random_graph
from src.models.schemas import (
    DatasetsResponse, RandomGraphRequest, RandomGraphResponse, ErrorResponse
)
from src.config import get_settings

router = APIRouter()
settings = get_settings()


def get_spark() -> SparkSession:
    return get_spark_session()


@router.post("/datasets", response_model=DatasetsResponse)
async def list_datasets(spark: SparkSession = Depends(get_spark)):
    """List all available edge and node tables."""
    edge_tables, node_tables = list_tables(spark)
    return DatasetsResponse(
        edge_tables=edge_tables,
        node_tables=node_tables
    )


@router.post(
    "/graph/random",
    response_model=RandomGraphResponse,
    responses={400: {"model": ErrorResponse}}
)
async def create_random_graph(
    request: RandomGraphRequest,
    spark: SparkSession = Depends(get_spark)
):
    """Generate a random graph for testing (dev mode only)."""
    if not settings.dev_mode:
        raise HTTPException(
            status_code=403,
            detail={
                "error": {
                    "code": "FORBIDDEN",
                    "message": "Random graph generation is only available in dev mode",
                    "details": {}
                }
            }
        )

    try:
        result = generate_random_graph(spark, request)
        return result
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "GENERATION_FAILED",
                    "message": f"Failed to generate random graph: {str(e)}",
                    "details": {}
                }
            }
        )


@router.delete("/dev/clear-all")
async def clear_all_tables():
    """Clear all parquet tables (dev mode only)."""
    if not settings.dev_mode:
        raise HTTPException(
            status_code=403,
            detail={
                "error": {
                    "code": "FORBIDDEN",
                    "message": "Clear all data is only available in dev mode",
                    "details": {}
                }
            }
        )

    # Resolve data_path to absolute (same logic as get_table_path in services/graph.py)
    data_dir = Path(settings.data_path)
    if not data_dir.is_absolute():
        module_dir = Path(__file__).parent.parent.parent  # src/routers/graph.py -> sql-warehouse/
        data_dir = (module_dir / settings.data_path).resolve()

    deleted_count = 0
    spark = get_spark()

    # 1. Drop all edge/node tables from Spark catalog (covers stale entries)
    try:
        databases = [row[0] for row in spark.sql("SHOW DATABASES").collect()]
        for db in databases:
            try:
                tables = spark.sql(f"SHOW TABLES IN {db}").collect()
                for row in tables:
                    table_name = row.tableName if hasattr(row, 'tableName') else row[1]
                    if table_name.startswith("edges_") or table_name.startswith("nodes_"):
                        try:
                            spark.sql(f"DROP TABLE IF EXISTS {db}.{table_name}")
                            deleted_count += 1
                        except Exception:
                            pass
            except Exception:
                pass
    except Exception:
        pass

    # 2. Delete parquet files from disk
    if data_dir.exists():
        for item in data_dir.iterdir():
            if item.is_dir() and (item.name.startswith("edges_") or item.name.startswith("nodes_")):
                shutil.rmtree(item)

    return {"status": "cleared", "deleted_tables": deleted_count}
