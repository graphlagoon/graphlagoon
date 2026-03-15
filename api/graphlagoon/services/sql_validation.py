"""SQL validation service using sqlglot.

Validates that user-provided SQL is read-only (SELECT only) and blocks
dangerous DDL/DML statements (deny list approach).
"""

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
