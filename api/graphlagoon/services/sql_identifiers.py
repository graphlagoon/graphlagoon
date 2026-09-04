"""SQL identifier validation and quoting, shared by every SQL builder.

Identifiers (catalog/schema/table/column names) cannot be parameterized in
the Databricks Statement Execution API, so any name that reaches an f-string
SQL builder must be validated and quoted here first. This closes finding A4
(catalog router interpolating URL parameters into SQL) and the stored variant
(hostile table/column names planted in a context's configuration) —
see docs/dev/security-assessment.md.
"""

from __future__ import annotations

import re

# Unquoted-identifier grammar: what Unity Catalog itself accepts for unquoted
# names. Deliberately strict — names needing backtick-quoting in DDL are not
# addressable through the app, which is the safe default for user-shaped input.
_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_]+$")


def validate_identifier_part(name: str) -> str:
    """Return ``name`` if it is a safe bare SQL identifier, else raise.

    Raises:
        ValueError: when the name is empty or contains anything beyond
            ``[A-Za-z0-9_]`` (callers map this to a 400 INVALID_IDENTIFIER).
    """
    if not name or not _IDENTIFIER_RE.match(name):
        raise ValueError(
            f"Invalid SQL identifier: {name!r} "
            "(only letters, digits and underscores are allowed)"
        )
    return name


def escape_identifier(name: str) -> str:
    """Escape embedded backticks WITHOUT wrapping — for templates that
    already place their own backticks around the interpolation."""
    return name.replace("`", "``")


def quote_identifier(name: str) -> str:
    """Backtick-quote a SQL identifier, escaping embedded backticks.

    For names from stored configuration (column names may legitimately hold
    spaces/reserved words); names from request parameters should go through
    ``validate_identifier_part`` instead, or as well.
    """
    escaped = name.replace("`", "``")
    return f"`{escaped}`"


def qualified_name(*parts: str) -> str:
    """Validate each part and return the backtick-quoted dotted name.

    ``qualified_name("cat", "db", "tbl")`` → ``\\`cat\\`.\\`db\\`.\\`tbl\\```.

    Raises:
        ValueError: when any part fails ``validate_identifier_part``.
    """
    return ".".join(quote_identifier(validate_identifier_part(p)) for p in parts)


def qualified_from_dotted(name: str) -> str:
    """Validate a dotted table name (``db.table`` or ``catalog.db.table``)
    and return it backtick-quoted.

    For fully-qualified names arriving as a single string (request bodies,
    stored context configuration).

    Raises:
        ValueError: when the name does not split into 2–3 parts or any part
            fails ``validate_identifier_part``.
    """
    parts = name.split(".")
    if len(parts) not in (2, 3):
        raise ValueError(
            f"Invalid qualified table name: {name!r} "
            "(expected db.table or catalog.db.table)"
        )
    return qualified_name(*parts)
