"""
Databricks SQL Statements API compatible endpoint.

Implements POST /api/2.0/sql/statements following the Databricks specification.
See: https://docs.databricks.com/api/workspace/statementexecution/executestatement

Also simulates EXTERNAL_LINKS disposition for local dev testing:
- Splits results into chunks and stores them in memory
- Returns external_link URLs pointing to a local download endpoint
- Supports GET polling and chunk manifest endpoints
"""
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional, Any, Literal
from enum import Enum
import asyncio
import threading
import uuid
import re
from datetime import datetime, timedelta, timezone

from pyspark.sql import SparkSession
from src.services.spark import get_spark_session
from src.config import get_settings


router = APIRouter(prefix="/api/2.0/sql", tags=["statements"])

# In-memory store for external links simulation
# Maps statement_id -> { "manifest": ..., "chunks": { index: data_array }, "external_links": [...] }
_chunk_store: dict[str, dict] = {}

# In-memory store for the async (INLINE) cancellable flow used by the Query
# Console. Maps statement_id -> { "state": StatementState, "response":
# StatementResponse | None, "cancel": threading.Event }. Only INLINE statements
# go async; EXTERNAL_LINKS (graph queries) keep the synchronous path.
_statements: dict[str, dict] = {}

# Chunk size for external links simulation (rows per chunk)
EXTERNAL_LINKS_CHUNK_SIZE = 100


# --- Request Models (Databricks spec) ---

class StatementParameter(BaseModel):
    """A parameter for a SQL statement."""
    name: str
    value: Optional[str] = None
    type: Optional[str] = None  # BOOLEAN, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, DATE, TIMESTAMP, STRING, etc.


class StatementExecutionRequest(BaseModel):
    """Request body for executing a SQL statement (Databricks spec)."""
    statement: str = Field(..., description="The SQL statement to execute")
    warehouse_id: str = Field(..., description="Warehouse ID (dummy in dev mode)")
    catalog: Optional[str] = Field(None, description="Default catalog for statement execution")
    schema: Optional[str] = Field(None, description="Default schema for statement execution")
    disposition: Literal["INLINE", "EXTERNAL_LINKS"] = Field(
        "INLINE",
        description="INLINE returns data inline, EXTERNAL_LINKS returns presigned URLs"
    )
    format: Literal["JSON_ARRAY", "ARROW_STREAM", "CSV"] = Field(
        "JSON_ARRAY",
        description="Result format (ARROW_STREAM and CSV only with EXTERNAL_LINKS)"
    )
    wait_timeout: str = Field(
        "10s",
        description="Time to wait for result (0s for async, 5-50s for sync)"
    )
    on_wait_timeout: Literal["CONTINUE", "CANCEL"] = Field(
        "CONTINUE",
        description="Action on timeout"
    )
    row_limit: Optional[int] = Field(None, description="Limit result rows")
    byte_limit: Optional[int] = Field(None, description="Limit result bytes")
    parameters: list[StatementParameter] = Field(
        default_factory=list,
        description="Named parameters for the statement"
    )


# --- Response Models (Databricks spec) ---

class StatementState(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELED = "CANCELED"
    CLOSED = "CLOSED"


class StatementError(BaseModel):
    """Error details for failed statements."""
    error_code: Optional[str] = None
    message: Optional[str] = None


class StatementStatus(BaseModel):
    """Status of statement execution."""
    state: StatementState
    error: Optional[StatementError] = None


class ColumnInfo(BaseModel):
    """Schema column information."""
    name: str
    position: int
    type_name: str
    type_text: str
    type_precision: Optional[int] = None
    type_scale: Optional[int] = None
    type_interval_type: Optional[str] = None


class ResultSchema(BaseModel):
    """Schema of the result set."""
    column_count: int
    columns: list[ColumnInfo]


class ResultChunk(BaseModel):
    """Metadata for a result chunk."""
    chunk_index: int
    row_offset: int
    row_count: int
    byte_count: Optional[int] = None


class ResultManifest(BaseModel):
    """Manifest describing the result set."""
    format: str = "JSON_ARRAY"
    schema: ResultSchema
    total_row_count: int
    total_byte_count: Optional[int] = None
    total_chunk_count: int = 1
    truncated: bool = False
    chunks: Optional[list[ResultChunk]] = None


class ExternalLink(BaseModel):
    """External link for EXTERNAL_LINKS disposition."""
    chunk_index: int
    row_offset: int
    row_count: int
    byte_count: int
    external_link: str
    expiration: str


class ResultData(BaseModel):
    """Result data from statement execution.

    For INLINE disposition: data_array contains the rows directly.
    For EXTERNAL_LINKS disposition: external_links contains presigned URLs.
    """
    chunk_index: int = 0
    row_offset: int = 0
    row_count: int = 0
    byte_count: Optional[int] = None
    data_array: Optional[list[list[Optional[str]]]] = None
    external_links: Optional[list[ExternalLink]] = None
    next_chunk_index: Optional[int] = None
    next_chunk_internal_link: Optional[str] = None


class StatementResponse(BaseModel):
    """Response from statement execution."""
    statement_id: str
    status: StatementStatus
    manifest: Optional[ResultManifest] = None
    result: Optional[ResultData] = None


# --- Helper functions ---

def get_spark() -> SparkSession:
    return get_spark_session()


def parse_wait_timeout(timeout_str: str) -> int:
    """Parse timeout string like '10s' to seconds."""
    if timeout_str.endswith('s'):
        return int(timeout_str[:-1])
    return int(timeout_str)


def substitute_parameters(sql: str, params: list[StatementParameter]) -> str:
    """Substitute named parameters in SQL (Databricks style :name)."""
    result = sql
    for param in params:
        placeholder = f":{param.name}"
        if param.value is None:
            replacement = "NULL"
        elif param.type and param.type.upper() in ("STRING", "CHAR", "VARCHAR"):
            escaped = param.value.replace("'", "''")
            replacement = f"'{escaped}'"
        elif param.type and param.type.upper() in ("DATE", "TIMESTAMP"):
            replacement = f"'{param.value}'"
        else:
            # Try to use value as-is for numeric types
            replacement = param.value
        result = result.replace(placeholder, str(replacement))
    return result


def is_sql_script(sql: str) -> bool:
    """Check if SQL is a scripting block (BEGIN...END)."""
    stripped = sql.strip().upper()
    return stripped.startswith("BEGIN") and stripped.endswith("END")


def validate_sql(sql: str) -> None:
    """Basic SQL validation to prevent dangerous operations.

    SQL scripting blocks (BEGIN...END) are allowed through because
    procedural BFS uses CREATE TEMPORARY VIEW, DECLARE, INSERT, etc.
    """
    # Allow SQL scripting blocks (procedural BFS)
    if is_sql_script(sql):
        return

    sql_upper = sql.upper().strip()

    # Block dangerous operations
    dangerous_patterns = [
        r'\bDROP\b',
        r'\bDELETE\b',
        r'\bTRUNCATE\b',
        r'\bALTER\b',
        r'\bINSERT\b',
        r'\bUPDATE\b',
        r'\bGRANT\b',
        r'\bREVOKE\b',
    ]

    for pattern in dangerous_patterns:
        if re.search(pattern, sql_upper):
            raise ValueError(f"Operation not allowed: {pattern.replace(chr(92), '').replace('b', '')}")


def convert_table_names(sql: str) -> str:
    """Convert Databricks-style table names to Spark local format.

    Databricks uses catalog.schema.table format, but local Spark only
    supports schema.table. This function finds and converts all three-part
    table names to two-part names.

    Example: dev_catalog.graphs.edges_test -> graphs.edges_test
    """
    import re
    # Match catalog.schema.table patterns (identifiers can be backtick-quoted or unquoted)
    # Pattern: word.word.word or `word`.`word`.`word` or mixed
    pattern = r'(?<![.\w`])(`?[\w]+`?)\.(`?[\w]+`?)\.(`?[\w]+`?)(?![.\w])'

    def replace_match(match):
        # Keep only schema.table (parts 2 and 3)
        return f"{match.group(2)}.{match.group(3)}"

    return re.sub(pattern, replace_match, sql)


def spark_type_to_databricks(spark_type: str) -> str:
    """Convert Spark data type string to Databricks type name."""
    type_map = {
        "string": "STRING",
        "int": "INT",
        "integer": "INT",
        "bigint": "LONG",
        "long": "LONG",
        "float": "FLOAT",
        "double": "DOUBLE",
        "boolean": "BOOLEAN",
        "date": "DATE",
        "timestamp": "TIMESTAMP",
        "binary": "BINARY",
        "decimal": "DECIMAL",
        "array": "ARRAY",
        "map": "MAP",
        "struct": "STRUCT",
    }
    # Handle complex types like decimal(10,2) or array<string>
    base_type = spark_type.lower().split("(")[0].split("<")[0]
    return type_map.get(base_type, "STRING")


# --- Main endpoint ---

@router.post(
    "/statements",
    response_model=StatementResponse,
    responses={
        200: {"description": "Statement executed successfully"},
        400: {"description": "Invalid request"},
        500: {"description": "Internal server error"}
    }
)
async def execute_statement(
    request: StatementExecutionRequest,
    spark: SparkSession = Depends(get_spark)
) -> StatementResponse:
    """
    Execute a SQL statement (Databricks API compatible).

    This endpoint emulates the Databricks SQL Statement Execution API.
    In dev mode, warehouse_id can be any non-empty string.

    By default INLINE and EXTERNAL_LINKS statements run SYNCHRONOUSLY: the query
    executes and the full result comes back on this call, holding no per-request
    server state (safe for large/frequent results).

    Opt-in (``async_inline_execution=true``, dev-only): INLINE statements run
    through an async, cancellable flow (background task + poll/cancel endpoints)
    so the Query Console's Cancel button can be exercised locally. A
    ``sleep(<seconds>)`` pseudo-function makes the query dwell in RUNNING for
    that long (cancellable), then is rewritten to the literal so the rest of the
    query still executes — e.g. ``SELECT sleep(8)`` runs 8s then returns 8. This
    cancel is a simulation, not a real Spark job kill. EXTERNAL_LINKS statements
    always use the synchronous path.
    """
    statement_id = str(uuid.uuid4())

    settings = get_settings()
    if request.disposition == "EXTERNAL_LINKS" or not settings.async_inline_execution:
        return _execute_query(statement_id, request, spark)

    # INLINE + async_inline_execution: async + cancellable (dev-only)
    _reap_finished_statements()
    record: dict = {
        "state": StatementState.PENDING,
        "response": None,
        "cancel": threading.Event(),
    }
    _statements[statement_id] = record

    loop = asyncio.get_event_loop()
    task = asyncio.create_task(
        _run_inline_statement(statement_id, request, spark, loop)
    )
    record["task"] = task

    # Honour wait_timeout: block up to that long for completion (Databricks
    # semantics). With wait_timeout=0s (the Query Console default) this returns
    # immediately in RUNNING, exposing the statement_id for polling/cancel.
    wait = parse_wait_timeout(request.wait_timeout)
    elapsed = 0.0
    while elapsed < wait and record["state"] in (
        StatementState.PENDING,
        StatementState.RUNNING,
    ):
        await asyncio.sleep(0.05)
        elapsed += 0.05

    if record["response"] is not None:
        return record["response"]
    return StatementResponse(
        statement_id=statement_id,
        status=StatementStatus(state=record["state"]),
    )


# Cap on retained async INLINE statements. Once a statement reaches a terminal
# state its result is kept only long enough for the client to poll it once;
# older terminal statements are dropped so the map cannot grow without bound
# (which, holding full inline results, would otherwise leak memory in dev).
_MAX_RETAINED_STATEMENTS = 64


def _reap_finished_statements() -> None:
    """Drop terminal statements beyond the retention cap (oldest first).

    dict preserves insertion order, so we walk from the front removing finished
    entries until we're back under the cap. Running/pending entries are kept.
    """
    if len(_statements) <= _MAX_RETAINED_STATEMENTS:
        return
    terminal = (
        StatementState.SUCCEEDED,
        StatementState.FAILED,
        StatementState.CANCELED,
        StatementState.CLOSED,
    )
    to_drop = len(_statements) - _MAX_RETAINED_STATEMENTS
    for sid in list(_statements.keys()):
        if to_drop <= 0:
            break
        if _statements[sid]["state"] in terminal:
            del _statements[sid]
            to_drop -= 1


_SLEEP_RE = re.compile(r"\bsleep\s*\(\s*(\d+(?:\.\d+)?)\s*\)", re.IGNORECASE)


def _extract_sleep_seconds(sql: str) -> float:
    """Largest sleep(n) directive in the SQL (0 if none)."""
    matches = _SLEEP_RE.findall(sql)
    return max((float(m) for m in matches), default=0.0)


def _strip_sleep(sql: str) -> str:
    """Rewrite each sleep(n) to the literal n so the SQL runs on Spark."""
    return _SLEEP_RE.sub(lambda m: m.group(1), sql)


async def _run_inline_statement(
    statement_id: str,
    request: StatementExecutionRequest,
    spark: SparkSession,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Background execution for the async INLINE flow: dwell (cancellable) for
    any sleep(n), then run the rewritten query in a thread and store the result."""
    record = _statements[statement_id]
    record["state"] = StatementState.RUNNING

    sleep_secs = _extract_sleep_seconds(request.statement)
    waited = 0.0
    step = 0.1
    while waited < sleep_secs:
        if record["cancel"].is_set():
            record["state"] = StatementState.CANCELED
            return
        await asyncio.sleep(min(step, sleep_secs - waited))
        waited += step

    if record["cancel"].is_set():
        record["state"] = StatementState.CANCELED
        return

    rewritten = _strip_sleep(request.statement)
    try:
        response = await loop.run_in_executor(
            None, _execute_query, statement_id, request, spark, rewritten
        )
    except Exception as e:  # pragma: no cover - defensive
        import traceback
        traceback.print_exc()
        record["state"] = StatementState.FAILED
        record["response"] = StatementResponse(
            statement_id=statement_id,
            status=StatementStatus(
                state=StatementState.FAILED,
                error=StatementError(
                    error_code="QUERY_EXECUTION_ERROR",
                    message=f"Query execution failed: {e}",
                ),
            ),
        )
        return

    # If cancelled while the query ran, honour the cancellation.
    if record["cancel"].is_set():
        record["state"] = StatementState.CANCELED
        return

    record["response"] = response
    record["state"] = response.status.state


def _execute_query(
    statement_id: str,
    request: StatementExecutionRequest,
    spark: SparkSession,
    statement_override: Optional[str] = None,
) -> StatementResponse:
    """Run a statement synchronously and build its StatementResponse.

    ``statement_override`` (used by the async INLINE flow after stripping any
    sleep directive) replaces ``request.statement`` as the SQL to execute.
    """
    sql_source = (
        statement_override if statement_override is not None else request.statement
    )

    try:
        # Validate SQL
        validate_sql(sql_source)

        # Set catalog/schema if provided
        if request.catalog:
            try:
                spark.sql(f"USE CATALOG {request.catalog}")
            except Exception:
                # If catalog doesn't exist in local Spark, ignore
                pass

        if request.schema:
            try:
                spark.sql(f"USE {request.schema}")
            except Exception:
                # If schema doesn't exist, ignore
                pass

        # Substitute parameters
        final_sql = substitute_parameters(sql_source, request.parameters)

        script_mode = is_sql_script(final_sql)

        # Convert Databricks-style table names (catalog.schema.table -> schema.table)
        final_sql = convert_table_names(final_sql)

        # Debug logging
        print(f"[STATEMENTS] Executing SQL (script={script_mode}):\n{final_sql[:500]}...")

        # Apply row limit if specified (skip for script blocks)
        if request.row_limit and not script_mode:
            # Wrap in subquery to apply limit
            final_sql = f"SELECT * FROM ({final_sql}) __limited LIMIT {request.row_limit}"

        # Execute query
        result_df = spark.sql(final_sql)
        rows = result_df.collect()

        # Build schema info
        columns = []
        for idx, field in enumerate(result_df.schema.fields):
            columns.append(ColumnInfo(
                name=field.name,
                position=idx,
                type_name=spark_type_to_databricks(str(field.dataType)),
                type_text=str(field.dataType),
            ))

        # Convert data to string arrays (Databricks format)
        import json
        from datetime import date, datetime as dt

        def _json_default(obj):
            """Handle date/datetime in json.dumps for nested structures."""
            if isinstance(obj, dt):
                return obj.isoformat()
            if isinstance(obj, date):
                return obj.isoformat()
            return str(obj)

        data_array: list[list[Optional[str]]] = []
        for row in rows:
            row_data: list[Optional[str]] = []
            for col in result_df.columns:
                val = row[col]
                if val is None:
                    row_data.append(None)
                elif hasattr(val, 'asDict'):
                    # Handle Row objects (from NAMED_STRUCT) - serialize as JSON
                    row_data.append(json.dumps(val.asDict(), default=_json_default))
                elif isinstance(val, (dict, list)):
                    row_data.append(json.dumps(val, default=_json_default))
                else:
                    row_data.append(str(val))
            data_array.append(row_data)

        # Check if truncated
        truncated = False
        if request.row_limit and len(rows) >= request.row_limit:
            truncated = True

        if request.disposition == "EXTERNAL_LINKS":
            # Simulate Databricks EXTERNAL_LINKS: split into chunks
            return _build_external_links_response(
                statement_id=statement_id,
                data_array=data_array,
                columns=columns,
                fmt=request.format,
                truncated=truncated,
            )

        # INLINE disposition (default)
        manifest = ResultManifest(
            format=request.format,
            schema=ResultSchema(
                column_count=len(columns),
                columns=columns
            ),
            total_row_count=len(rows),
            total_chunk_count=1,
            truncated=truncated,
            chunks=[ResultChunk(
                chunk_index=0,
                row_offset=0,
                row_count=len(rows),
            )]
        )

        result = ResultData(
            chunk_index=0,
            row_offset=0,
            row_count=len(rows),
            data_array=data_array,
        )

        return StatementResponse(
            statement_id=statement_id,
            status=StatementStatus(state=StatementState.SUCCEEDED),
            manifest=manifest,
            result=result,
        )

    except ValueError as e:
        # SQL validation error
        return StatementResponse(
            statement_id=statement_id,
            status=StatementStatus(
                state=StatementState.FAILED,
                error=StatementError(
                    error_code="INVALID_QUERY",
                    message=str(e)
                )
            )
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        # Query execution error
        return StatementResponse(
            statement_id=statement_id,
            status=StatementStatus(
                state=StatementState.FAILED,
                error=StatementError(
                    error_code="QUERY_EXECUTION_ERROR",
                    message=f"Query execution failed: {str(e)}"
                )
            )
        )


# --- External Links simulation helpers ---

def _build_external_links_response(
    statement_id: str,
    data_array: list[list[Optional[str]]],
    columns: list[ColumnInfo],
    fmt: str,
    truncated: bool,
) -> StatementResponse:
    """Build a response simulating Databricks EXTERNAL_LINKS disposition.

    Splits data into chunks, stores them in memory, and returns
    external_link URLs pointing to the local chunk download endpoint.
    """
    import json

    settings = get_settings()
    base_url = f"http://localhost:{settings.port}"
    total_rows = len(data_array)
    chunk_size = EXTERNAL_LINKS_CHUNK_SIZE

    # Split into chunks
    chunks_data: dict[int, list[list[Optional[str]]]] = {}
    chunk_manifests: list[ResultChunk] = []
    external_links: list[ExternalLink] = []
    expiration = (
        datetime.now(timezone.utc) + timedelta(hours=1)
    ).isoformat()

    chunk_index = 0
    row_offset = 0
    while row_offset < total_rows:
        chunk_rows = data_array[row_offset:row_offset + chunk_size]
        chunk_bytes = len(json.dumps(chunk_rows).encode())
        chunks_data[chunk_index] = chunk_rows

        chunk_manifests.append(ResultChunk(
            chunk_index=chunk_index,
            row_offset=row_offset,
            row_count=len(chunk_rows),
            byte_count=chunk_bytes,
        ))

        external_links.append(ExternalLink(
            chunk_index=chunk_index,
            row_offset=row_offset,
            row_count=len(chunk_rows),
            byte_count=chunk_bytes,
            external_link=(
                f"{base_url}/api/2.0/sql/chunk-data"
                f"/{statement_id}/{chunk_index}"
            ),
            expiration=expiration,
        ))

        row_offset += chunk_size
        chunk_index += 1

    # Handle empty results
    if not chunks_data:
        chunks_data[0] = []
        chunk_manifests.append(ResultChunk(
            chunk_index=0, row_offset=0, row_count=0, byte_count=0,
        ))
        external_links.append(ExternalLink(
            chunk_index=0, row_offset=0, row_count=0, byte_count=0,
            external_link=f"{base_url}/api/2.0/sql/chunk-data/{statement_id}/0",
            expiration=expiration,
        ))

    manifest = ResultManifest(
        format=fmt,
        schema=ResultSchema(
            column_count=len(columns),
            columns=columns,
        ),
        total_row_count=total_rows,
        total_chunk_count=len(chunks_data),
        truncated=truncated,
        chunks=chunk_manifests,
    )

    # Store in memory for later retrieval
    _chunk_store[statement_id] = {
        "manifest": manifest,
        "chunks": chunks_data,
        "external_links": external_links,
        "status": StatementStatus(state=StatementState.SUCCEEDED),
    }

    return StatementResponse(
        statement_id=statement_id,
        status=StatementStatus(state=StatementState.SUCCEEDED),
        manifest=manifest,
        result=ResultData(
            external_links=external_links,
        ),
    )


# --- GET endpoints for external links simulation ---

@router.get("/statements/{statement_id}")
async def get_statement_status(statement_id: str):
    """Poll statement status (simulates Databricks GET statement endpoint)."""
    # Async INLINE flow (Query Console) takes precedence.
    record = _statements.get(statement_id)
    if record is not None:
        state = record["state"]
        if record["response"] is not None:
            # SUCCEEDED/FAILED — return the full stored response (inline data).
            return record["response"]
        # PENDING/RUNNING/CANCELED — no result body yet.
        return StatementResponse(
            statement_id=statement_id,
            status=StatementStatus(state=state),
        )

    stored = _chunk_store.get(statement_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="Statement not found")

    return StatementResponse(
        statement_id=statement_id,
        status=stored["status"],
        manifest=stored["manifest"],
        result=ResultData(
            external_links=stored["external_links"],
        ),
    )


@router.post("/statements/{statement_id}/cancel")
async def cancel_statement(statement_id: str) -> dict:
    """Cancel a running statement (simulates Databricks cancel endpoint).

    Signals the async INLINE background task to stop; if it is still
    PENDING/RUNNING it transitions to CANCELED. Idempotent and best-effort:
    unknown or already-finished statements are a no-op (returns 200), matching
    how the API client treats cancellation.
    """
    record = _statements.get(statement_id)
    if record is not None:
        record["cancel"].set()
        if record["state"] in (StatementState.PENDING, StatementState.RUNNING):
            record["state"] = StatementState.CANCELED
    return {}


@router.get("/statements/{statement_id}/result/chunks/{chunk_index}")
async def get_chunk_manifest(statement_id: str, chunk_index: int):
    """Get chunk manifest with external link (simulates Databricks chunk endpoint)."""
    stored = _chunk_store.get(statement_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="Statement not found")

    links = stored["external_links"]
    matching = [el for el in links if el.chunk_index == chunk_index]
    if not matching:
        raise HTTPException(status_code=404, detail=f"Chunk {chunk_index} not found")

    return {"external_links": [el.model_dump() for el in matching]}


@router.get("/chunk-data/{statement_id}/{chunk_index}")
async def download_chunk_data(statement_id: str, chunk_index: int):
    """Download raw chunk data (simulates presigned URL download).

    This endpoint does NOT require authorization, mimicking
    how presigned URLs work in cloud storage.

    Dev knob: set WAREHOUSE_CHUNK_DELAY_MS to sleep that long per chunk so the
    graph overlay's chunk-download progress bar is observable on localhost
    (real object-storage latency is instant otherwise). No effect in prod.
    """
    import os

    delay_ms = int(os.environ.get("WAREHOUSE_CHUNK_DELAY_MS", "0") or "0")
    if delay_ms > 0:
        await asyncio.sleep(delay_ms / 1000.0)

    stored = _chunk_store.get(statement_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="Statement not found")

    chunks = stored["chunks"]
    if chunk_index not in chunks:
        raise HTTPException(status_code=404, detail=f"Chunk {chunk_index} not found")

    return JSONResponse(content=chunks[chunk_index])


@router.post("/test-scripting", tags=["debug"])
async def test_sql_scripting(
    spark: SparkSession = Depends(get_spark)
) -> dict:
    """Test that SQL scripting (BEGIN/END) works with the current Spark session."""
    test_script = """
BEGIN
  DECLARE x INT DEFAULT 0;
  SET x = 42;
  CREATE OR REPLACE TEMPORARY VIEW test_scripting_result AS
  SELECT x AS value, 'scripting works' AS message;
  SELECT * FROM test_scripting_result;
END
""".strip()

    try:
        result_df = spark.sql(test_script)
        rows = result_df.collect()
        return {
            "status": "ok",
            "scripting_enabled": True,
            "result": [row.asDict() for row in rows],
        }
    except Exception as e:
        import traceback
        return {
            "status": "error",
            "scripting_enabled": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
