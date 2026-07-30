"""SQL validation service using sqlglot.

Validates that user-provided SQL is read-only (SELECT only) and blocks
dangerous DDL/DML statements (deny list approach).
"""

from typing import Optional

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError


# Statement types that are NOT allowed (deny list)
_DENIED_EXPRESSION_TYPES = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Drop,
    exp.Create,
    exp.Alter,
    exp.AlterColumn,
    exp.TruncateTable,
    exp.Command,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
    exp.Grant,
    exp.SetItem,
)

# Top-level statement types that ARE allowed
_ALLOWED_TOP_LEVEL = (
    exp.Select,
    exp.Union,
    exp.Intersect,
    exp.Except,
)


def validate_sql_query(sql: str) -> tuple[bool, str]:
    """Validate that a SQL query is a safe, read-only SELECT.

    Uses sqlglot to parse the query (Spark dialect) and checks:
    1. Exactly one statement (no multi-statement injection)
    2. Top-level must be SELECT/UNION/INTERSECT/EXCEPT
    3. No DML/DDL nodes anywhere in the AST (defense-in-depth)

    Args:
        sql: The raw SQL string to validate.

    Returns:
        (is_valid, error_message) tuple. error_message is empty when valid.
    """
    if not sql or not sql.strip():
        return False, "Empty SQL query"

    try:
        statements = sqlglot.parse(sql, dialect="spark")
    except ParseError as e:
        return False, f"SQL syntax error: {e}"

    if not statements:
        return False, "Empty SQL query"

    # Must be exactly one statement
    if len(statements) > 1:
        return False, "Only a single SQL statement is allowed"

    statement = statements[0]
    if statement is None:
        return False, "Failed to parse SQL statement"

    # Top-level must be a SELECT-like statement
    if not isinstance(statement, _ALLOWED_TOP_LEVEL):
        return False, "Only SELECT statements are allowed"

    # Walk entire AST to reject any DML/DDL subexpressions
    for node in statement.walk():
        if isinstance(node, _DENIED_EXPRESSION_TYPES):
            return (
                False,
                f"Statement contains disallowed operation: {type(node).__name__}",
            )

    return True, ""


def sanitize_string_literal(value: str) -> str:
    """Sanitize a value for safe interpolation inside SQL single quotes.

    Escapes single quotes (SQL standard) and backslashes (Spark escape char),
    and strips null bytes.

    Args:
        value: The raw string value.

    Returns:
        Sanitized string safe for use inside SQL single-quoted literals.
    """
    sanitized = value.replace("\0", "")
    sanitized = sanitized.replace("\\", "\\\\")
    sanitized = sanitized.replace("'", "''")
    return sanitized


def extract_query_limit(sql: str) -> Optional[int]:
    """Return the top-level LIMIT of a SELECT, or None if it has none.

    The graph query endpoints take the LIMIT from the user's own SQL rather
    than a parameter, so this is the only way to know whether a result that
    came back "full" was actually capped — which is what tells the client the
    graph is truncated.

    Parsed with sqlglot rather than a regex so a LIMIT inside a CTE or a
    subquery is not mistaken for the outer one. Returns None when the query
    cannot be parsed or the limit is not a plain integer (e.g. a parameter),
    in which case the caller simply cannot claim truncation.
    """
    try:
        parsed = sqlglot.parse_one(sql, dialect="spark")
    except Exception:
        return None
    if parsed is None:
        return None

    limit = parsed.args.get("limit")
    if limit is None:
        return None

    try:
        return int(limit.expression.this)
    except (AttributeError, TypeError, ValueError):
        return None
