"""Classify warehouse query-failure messages as stale-schema vs. everything else.

A dropped/renamed column or table does not come back from Spark/Databricks as an
HTTP error — it is a normal ``QueryExecutionError`` carrying the warehouse's own
error string (``[UNRESOLVED_COLUMN.WITH_SUGGESTION] ...`` / ``[TABLE_OR_VIEW_NOT_FOUND]``
locally; ``BAD_REQUEST`` with the same substrings on real Databricks). This module
gives that string a stable code so the frontend can show an actionable "your
context's schema may be stale" message instead of the raw Spark text, without the
warehouse's own (non-actionable) error_code — which the API already discards.
"""

import re
from typing import Optional

STALE_SCHEMA_CODE = "STALE_CONTEXT_SCHEMA"
DEFAULT_CODE = "QUERY_EXECUTION_ERROR"

_UNRESOLVED_COLUMN_RE = re.compile(
    r"UNRESOLVED_COLUMN|cannot be resolved", re.IGNORECASE
)
_TABLE_NOT_FOUND_RE = re.compile(
    r"TABLE_OR_VIEW_NOT_FOUND|table or view not found", re.IGNORECASE
)
# Spark surfaces the offending identifier backtick-quoted right after the marker,
# e.g. "A column, variable, or function parameter with name `email` cannot be
# resolved". Best-effort: absent on a generic message, and that's fine.
_BACKTICKED_NAME_RE = re.compile(r"`([^`]+)`")


def classify_query_error(message: str) -> tuple[str, Optional[str], Optional[str]]:
    """Classify a warehouse error message.

    Returns ``(code, hint, unresolved_name)``. ``code`` is ``STALE_CONTEXT_SCHEMA``
    when the message looks like a missing column/table, else the unchanged
    ``QUERY_EXECUTION_ERROR`` — so every non-matching message keeps today's
    behaviour exactly, and existing tests asserting that code stay green.
    """
    if not message:
        return DEFAULT_CODE, None, None

    if _UNRESOLVED_COLUMN_RE.search(message):
        name_match = _BACKTICKED_NAME_RE.search(message)
        unresolved_name = name_match.group(1) if name_match else None
        return (
            STALE_SCHEMA_CODE,
            "This context's stored schema may be out of date — run a schema "
            "check and resync.",
            unresolved_name,
        )

    if _TABLE_NOT_FOUND_RE.search(message):
        return (
            STALE_SCHEMA_CODE,
            "This context's source table could not be found — it may have "
            "been renamed or dropped.",
            None,
        )

    return DEFAULT_CODE, None, None


def query_execution_http_error(
    exc,
    context_id=None,
    fallback_query: Optional[str] = None,
    extra_details: Optional[dict] = None,
):
    """Build the HTTPException for a QueryExecutionError — the single builder
    replacing the hand-rolled 400-with-envelope blocks scattered across the
    graph router.

    Keeps each call site's historical ``details`` shape exactly:
      - ``fallback_query``: some sites want ``e.query or sql`` even when
        ``e.query`` is empty (the table-query endpoints); pass ``sql`` here.
      - ``extra_details``: merged in after ``query`` (e.g. the Cypher endpoint's
        ``transpiled_sql``), so it survives whether or not ``query`` is set.
    Only adds ``hint``/``unresolved_name``/``context_id`` when the message
    classifies as stale — every other message keeps today's shape byte-for-byte.
    """
    from fastapi import HTTPException

    code, hint, unresolved_name = classify_query_error(exc.message)
    code = getattr(exc, "code", None) or code

    query_value = exc.query or fallback_query
    details: dict = {"query": query_value} if query_value else {}
    if extra_details:
        details.update(extra_details)
    if hint:
        details["hint"] = hint
    if unresolved_name:
        details["unresolved_name"] = unresolved_name
    if context_id and code == STALE_SCHEMA_CODE:
        details["context_id"] = str(context_id)

    return HTTPException(
        status_code=400,
        detail={
            "error": {
                "code": code,
                "message": exc.message,
                "details": details,
            }
        },
    )
