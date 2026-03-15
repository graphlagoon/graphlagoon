import builtins
from rich import print as rich_print
builtins.print = rich_print

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import logging
import os

# Enable debugpy for VSCode debugging
if os.environ.get("DEBUGPY_ENABLE", "").lower() in ("1", "true"):
    import debugpy
    debugpy_port = int(os.environ.get("DEBUGPY_PORT", "5679"))
    debugpy.listen(("0.0.0.0", debugpy_port))
    print(f"⏳ Waiting for debugger to attach on port {debugpy_port}...")
    if os.environ.get("DEBUGPY_WAIT", "").lower() in ("1", "true"):
        debugpy.wait_for_client()
    print("✅ Debugger attached!")

from src.config import get_settings
from src.services.spark import get_spark_session, stop_spark_session
from src.services.catalog import register_parquet_tables
from src.routers import graph, catalog, statements

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Starting sql-warehouse...")
    logger.info(f"Dev mode: {settings.dev_mode}")
    logger.info(f"Data path: {settings.data_path}")

    # Initialize Spark session
    spark = get_spark_session()
    logger.info("Spark session initialized")

    # Auto-register existing parquet files as catalog tables
    logger.info("Auto-registering parquet tables...")
    result = register_parquet_tables(spark)
    logger.info(f"Auto-registration complete: {result['registered']} registered, {result['skipped']} skipped")

    yield

    # Shutdown
    logger.info("Shutting down sql-warehouse...")
    stop_spark_session()
    logger.info("Spark session stopped")


app = FastAPI(
    title="sql-warehouse",
    description="Graph data warehouse with PySpark and Parquet",
    version="0.1.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(graph.router, tags=["graph"])
app.include_router(catalog.router)
app.include_router(statements.router)  # Databricks-compatible SQL API


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "dev_mode": settings.dev_mode}
