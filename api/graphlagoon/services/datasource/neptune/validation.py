"""Read-only guard for openCypher passed straight through to Neptune.

The warehouse path's security boundary is ``validate_sql_query`` (sqlglot,
SELECT-only). A native-Cypher backend executes the user's text verbatim, so it
needs the equivalent gate — same deny-list spirit, fail-closed: anything that
looks like it could write is rejected rather than parsed into submission.
"""

from __future__ import annotations

import re

# Clauses that create, modify or delete. `LOAD` covers Neptune's bulk loader
# syntax; `CALL` is rejected because Neptune's procedure surface is small,
# unneeded for visualization, and not worth auditing for write side effects.
WRITE_CLAUSE_RE = re.compile(
    r"\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD|CALL|FOREACH)\b",
    re.IGNORECASE,
)


def validate_readonly_opencypher(query: str) -> tuple[bool, str]:
    """Reject anything that could mutate the graph.

    Word boundaries keep property names that merely contain a keyword (``asset``,
    ``offset``) safe. A keyword inside a string literal is a false positive; that
    is the deliberate trade — same one the SQL validator makes — because failing
    closed on a rare valid query beats letting a write through.

    Returns ``(is_valid, error_message)``.
    """
    stripped = (query or "").strip()
    if not stripped:
        return False, "Query must not be empty"

    match = WRITE_CLAUSE_RE.search(stripped)
    if match:
        return False, (
            f"Only read-only queries are allowed: '{match.group(1).upper()}' "
            f"is not permitted"
        )

    return True, ""


def validate_graph_cypher(query: str) -> tuple[bool, str]:
    """Structural gate for queries whose result becomes a graph.

    Deliberately weaker than the warehouse path's ``RETURN r`` requirement: that
    rule exists because the transpiler emits edges as a NAMED_STRUCT column
    named ``r``. Neptune returns real nodes and relationships from any
    projection, so requiring a specific variable name would reject perfectly
    good queries like ``MATCH p = (a)-[:KNOWS]->(b) RETURN p``.
    """
    stripped = (query or "").strip()
    if not stripped:
        return False, "Query must not be empty"

    if not stripped.upper().startswith("MATCH"):
        return False, "Query must start with MATCH"

    if not re.search(r"\bRETURN\b", stripped, re.IGNORECASE):
        return False, "Query must have a RETURN clause"

    return True, ""


def quote_label(label: str) -> str:
    """Backtick-quote a label / relationship type for use inside a pattern.

    Labels cannot be openCypher parameters when they appear in a pattern, so
    they are interpolated — stripping backticks first removes the only
    character that could break out of the quoting.
    """
    return f"`{label.replace('`', '')}`"
