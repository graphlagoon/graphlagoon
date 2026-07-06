"""In-memory async-job registry for cancellable, progress-reporting queries.

The graph query flow (``/query``, ``/cypher``) submits work as a background
asyncio task tracked here so the frontend can poll progress and cancel it —
mirroring the submit → poll → cancel shape the table path gets from the
warehouse's async statement flow, but hosted on the API side because the graph
path also downloads result chunks and processes nodes/edges here.

Cancellation both cancels the asyncio task (stopping API-side processing and
download) and cancels the underlying warehouse statement(s) so the warehouse
stops burning compute.
"""

import asyncio
import logging
import uuid
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

# statement_id/job_id -> job record.
_jobs: dict[str, dict[str, Any]] = {}


def create_job() -> tuple[str, dict[str, Any]]:
    """Register a new job and return (job_id, record)."""
    job_id = str(uuid.uuid4())
    record: dict[str, Any] = {
        "state": "running",  # running | succeeded | failed | canceled
        # progress: {"phase": str, "chunks_done": int, "chunks_total": int}
        "progress": None,
        "result": None,  # the coroutine's return value on success
        "error": None,  # {"code", "message", "details"} on failure
        "task": None,  # the asyncio.Task
        "statement_ids": [],  # underlying warehouse statements, for cancel
        "cancel_requested": False,
    }
    _jobs[job_id] = record
    return job_id, record


def get_job(job_id: str) -> Optional[dict[str, Any]]:
    return _jobs.get(job_id)


def start_job(
    record: dict[str, Any],
    coro_factory: Callable[[], Awaitable[Any]],
) -> None:
    """Run ``coro_factory()`` as the job's background task, capturing the
    result / error / cancellation into the record."""

    async def runner() -> None:
        try:
            result = await coro_factory()
            if record["cancel_requested"]:
                record["state"] = "canceled"
                return
            record["result"] = result
            record["state"] = "succeeded"
        except asyncio.CancelledError:
            record["state"] = "canceled"
            raise
        except Exception as e:  # noqa: BLE001 — surface any failure to the poller
            logger.warning(f"async job failed: {type(e).__name__}: {e}")
            record["state"] = "failed"
            record["error"] = {
                "code": getattr(e, "code", "QUERY_EXECUTION_ERROR"),
                "message": getattr(e, "message", str(e)),
                "details": {"query": getattr(e, "query", None)},
            }

    record["task"] = asyncio.create_task(runner())


async def cancel_job(job_id: str, warehouse=None) -> bool:
    """Cancel a running job: flag it, cancel the asyncio task, and best-effort
    cancel any underlying warehouse statements. Idempotent; returns whether a
    job was found."""
    record = _jobs.get(job_id)
    if record is None:
        return False

    record["cancel_requested"] = True
    if record["state"] == "running":
        record["state"] = "canceled"

    task = record.get("task")
    if task is not None and not task.done():
        task.cancel()

    if warehouse is not None:
        for sid in list(record["statement_ids"]):
            try:
                await warehouse.cancel_statement(sid)
            except Exception as e:  # noqa: BLE001 — best effort
                logger.warning(f"warehouse cancel_statement({sid}) failed: {e}")

    return True
