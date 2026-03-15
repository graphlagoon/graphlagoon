from pyspark.sql import SparkSession
from typing import Optional
import logging
import os

from src.config import get_settings

logger = logging.getLogger(__name__)

_spark_session: Optional[SparkSession] = None


def get_spark_session() -> SparkSession:
    """Get or create the SparkSession singleton."""
    global _spark_session

    if _spark_session is None:
        settings = get_settings()
        logger.info(f"Creating SparkSession with master: {settings.spark_master}")

        # Ensure warehouse directory exists
        warehouse_path = os.path.abspath(settings.warehouse_path)
        os.makedirs(warehouse_path, exist_ok=True)

        builder = (
            SparkSession.builder
            .appName("sql-warehouse")
            .master(settings.spark_master)
            # Warehouse path for managed tables
            .config("spark.sql.warehouse.dir", warehouse_path)
            # General optimizations
            .config("spark.sql.adaptive.enabled", "true")
            .config("spark.sql.parquet.compression.codec", "snappy")
            # Enable cross-join for complex queries
            .config("spark.sql.crossJoin.enabled", "true")
            # Enable SQL scripting (BEGIN/END, DECLARE, WHILE, etc.)
            .config("spark.sql.scripting.enabled", "true")
        )

        # Try to enable Hive support if available (provides CREATE DATABASE support)
        try:
            _spark_session = builder.enableHiveSupport().getOrCreate()
            logger.info("SparkSession created with Hive support")
        except Exception as e:
            logger.warning(f"Could not enable Hive support: {e}")
            _spark_session = builder.getOrCreate()
            logger.info("SparkSession created without Hive support")

        # Set log level
        _spark_session.sparkContext.setLogLevel("WARN")
        logger.info(f"SparkSession created with warehouse at: {warehouse_path}")

    return _spark_session


def stop_spark_session() -> None:
    """Stop the SparkSession."""
    global _spark_session

    if _spark_session is not None:
        logger.info("Stopping SparkSession")
        _spark_session.stop()
        _spark_session = None
