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

# Bare grammar: what SQL accepts with no quoting at all. A stored dotted
# table name is spliced into transpiled SQL as written, so each of its parts
# must either match this or be written in backticks.
_BARE_RE = re.compile(r"^[A-Za-z0-9_]+$")

# A name the app quotes itself: letters (accented ones too), digits,
# underscores and hyphens — Unity Catalog accepts `my-catalog`, and a catalog
# like that is only reachable in backticks. Still nothing that could close a
# backtick or a string literal (``WHERE table_catalog = '...'``).
_NAME_RE = re.compile(r"^[\w-]+$")


def _unquote(name: str) -> str:
    """A name written in backticks, without them; anything else unchanged."""
    if len(name) >= 2 and name[0] == "`" and name[-1] == "`":
        return name[1:-1]
    return name


def validate_identifier_part(name: str) -> str:
    """Return ``name`` without its backticks if it is a safe identifier, else raise.

    Accepts a bare name (``users``, ``my-catalog``) or one written in
    backticks (```my-catalog```), as Databricks users type them. Callers
    quote the result with ``quote_identifier`` before interpolating it.

    Raises:
        ValueError: when the name is empty or holds anything beyond letters,
            digits, underscores and hyphens (callers map this to a 400
            INVALID_IDENTIFIER).
    """
    inner = _unquote(name or "")
    if not inner or not _NAME_RE.match(inner):
        raise ValueError(
            f"Invalid SQL identifier: {name!r} "
            "(only letters, digits, underscores and hyphens are allowed)"
        )
    return inner


def split_qualified(name: str) -> list[str]:
    """Split a stored dotted name into its parts, without backticks.

    ```my-cat`.db.t`` → ``["my-cat", "db", "t"]``. A part that needs quoting
    must carry its backticks (``my-cat.db.t`` is refused): the stored name is
    also used as written by the Cypher transpiler and the CTE pre-filter.

    Raises:
        ValueError: when a part is empty or fails the rules above.
    """
    parts = []
    for part in (name or "").split("."):
        if _BARE_RE.match(part):
            parts.append(part)
        elif part and _NAME_RE.match(part):
            raise ValueError(
                f"Invalid table name: {name!r} — write {part!r} in backticks "
                f"(`{part}`)"
            )
        else:
            # Quoted (```my-cat```), or invalid either way.
            parts.append(validate_identifier_part(part))
    return parts


def dotted_name(*parts: str) -> str:
    """Join name parts into a storable dotted name, backticking only the parts
    that need it: ``("my-cat", "db", "t")`` → ```my-cat`.db.t``."""
    return ".".join(p if _BARE_RE.match(p) else quote_identifier(p) for p in parts)


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

    Parts may be written in backticks (```my-cat`.db.t``).

    Raises:
        ValueError: when the name does not split into 2–3 parts or any part
            fails ``split_qualified``.
    """
    parts = split_qualified(name)
    if len(parts) not in (2, 3):
        raise ValueError(
            f"Invalid qualified table name: {name!r} "
            "(expected db.table or catalog.db.table)"
        )
    return qualified_name(*parts)
