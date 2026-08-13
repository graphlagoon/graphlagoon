"""CTE pre-filter service for edge table filtering.

Allows users to define SQL CTEs that pre-filter the edge table before
OpenCypher transpilation or raw SQL query execution. The user defines
a MY_FINAL_EDGES CTE that replaces the original edge table in the final SQL.

Placeholders:
  __EDGES__ — replaced with the actual edge table name from the context
  __NODES__ — replaced with the actual node table name from the context
"""

import re

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

from graphlagoon.services.sql_validation import _DENIED_EXPRESSION_TYPES


def validate_cte_prefilter(cte_text: str) -> tuple[bool, str]:
    """Validate that user-provided CTE text is safe and well-formed.

    The CTE text should be written WITHOUT the leading WITH keyword.
    It must define a CTE named MY_FINAL_EDGES.

    Args:
        cte_text: CTE definitions, e.g.
            'MY_FINAL_EDGES AS (SELECT * FROM __EDGES__ WHERE x = 1)'

    Returns:
        (is_valid, error_message) tuple.
    """
    if not cte_text or not cte_text.strip():
        return False, "Empty CTE pre-filter text"

    # Replace placeholders with dummy names so sqlglot can parse
    parseable = cte_text.replace("__EDGES__", "dummy_edges")
    parseable = parseable.replace("__NODES__", "dummy_nodes")

    # Wrap as a full SQL statement for parsing
    wrapped = f"WITH {parseable} SELECT 1 FROM MY_FINAL_EDGES"

    try:
        statements = sqlglot.parse(wrapped, dialect="spark")
    except ParseError as e:
        return False, f"CTE syntax error: {e}"

    if not statements or statements[0] is None:
        return False, "Failed to parse CTE"

    statement = statements[0]

    # Walk AST to reject DML/DDL
    for node in statement.walk():
        if isinstance(node, _DENIED_EXPRESSION_TYPES):
            return (
                False,
                f"CTE contains disallowed operation: {type(node).__name__}",
            )

    # Check that MY_FINAL_EDGES is defined
    with_clause = statement.find(exp.With)
    if not with_clause:
        return False, "Failed to parse CTE definitions"

    cte_names = [
        cte.alias.lower() for cte in with_clause.find_all(exp.CTE) if cte.alias
    ]

    if "my_final_edges" not in cte_names:
        return (
            False,
            "CTE must define MY_FINAL_EDGES. "
            "Example: MY_FINAL_EDGES AS (SELECT * FROM __EDGES__ WHERE ...)",
        )

    return True, ""


def _cte_text_to_temp_views(cte_resolved: str) -> str:
    """Convert a WITH-less CTE definition list into CREATE TEMP VIEW statements.

    A procedural ``BEGIN...END`` script is a multi-statement compound block; a
    ``WITH`` clause cannot scope it, so the user CTEs are instead materialized as
    ``CREATE OR REPLACE TEMPORARY VIEW`` statements injected inside the block.
    Views are visible to every subsequent statement (including numbered-views
    ``EXECUTE IMMEDIATE`` bodies and ``temp_tables`` CREATE/INSERT blocks).

    Definition order is preserved so a helper CTE that a later CTE
    references is created first.

    Args:
        cte_resolved: CTE definitions (without leading WITH), placeholders
            already resolved to real table names.

    Returns:
        Newline-joined ``CREATE OR REPLACE TEMPORARY VIEW <name> AS <select>;``
        statements, one per CTE.
    """
    wrapped = f"WITH {cte_resolved} SELECT 1 FROM MY_FINAL_EDGES"
    statement = sqlglot.parse_one(wrapped, dialect="spark")
    with_clause = statement.find(exp.With)

    view_stmts: list[str] = []
    for cte in with_clause.find_all(exp.CTE):
        name = cte.alias
        # cte.this is the inner query (SELECT ...); render it without the alias
        # wrapper so it becomes the view body.
        body = cte.this.sql(dialect="spark")
        view_stmts.append(f"CREATE OR REPLACE TEMPORARY VIEW {name} AS {body};")
    return "\n".join(view_stmts)


def apply_cte_prefilter(
    sql: str,
    cte_prefilter: str,
    edge_table_name: str,
    node_table_name: str,
) -> str:
    """Apply a CTE pre-filter to a SQL query.

    Uses string-based replacement to avoid sqlglot issues with table aliases,
    RECURSIVE CTEs, and Spark-specific SQL features (NAMED_STRUCT, ARRAY, etc.).

    Steps:
      1. Replace __EDGES__/__NODES__ placeholders in CTE text.
      2. Replace edge table references in SQL with MY_FINAL_EDGES.
      3. Merge the user CTE into the SQL. For a single ``WITH...SELECT`` query
         the CTE is prepended/merged into the WITH clause; for a procedural
         ``BEGIN...END`` script the CTEs are injected as CREATE TEMP VIEW
         statements inside the block (a WITH clause cannot scope a compound
         block — see _cte_text_to_temp_views).

    Args:
        sql: The original SQL query (from transpiler or user).
        cte_prefilter: CTE definitions without leading WITH.
        edge_table_name: Actual edge table name (e.g. 'catalog.schema.edges').
        node_table_name: Actual node table name (for __NODES__ placeholder).

    Returns:
        Final SQL with CTE applied and edge table replaced.
    """
    # 1. Replace placeholders in CTE text
    cte_resolved = cte_prefilter.replace("__EDGES__", edge_table_name)
    cte_resolved = cte_resolved.replace("__NODES__", node_table_name)

    # 2. Replace edge table references in SQL with MY_FINAL_EDGES
    # Use regex with word-boundary-like guards to avoid partial matches
    # (e.g. don't replace inside 'fraud.edges_ieee_cis_backup')
    table_pattern = re.compile(
        r"(?<![.\w])" + re.escape(edge_table_name) + r"(?![.\w])"
    )
    sql_modified = table_pattern.sub("MY_FINAL_EDGES", sql)

    # 3. Merge user CTE into the SQL
    cte_text = cte_resolved.strip()
    stripped = sql_modified.strip()
    upper = stripped.upper()

    if upper.startswith("BEGIN") and upper.endswith("END"):
        # Procedural BFS script: inject the user CTEs as temp views right after
        # BEGIN so every statement in the block reads the pre-filtered edges.
        # Split on the leading BEGIN keyword rather than re.sub — the view
        # block may contain backslashes/group-like text that re.sub would
        # misinterpret as replacement escapes.
        view_block = _cte_text_to_temp_views(cte_text)
        indented = "\n".join(f"  {line}" for line in view_block.split("\n"))
        rest = stripped[len("BEGIN") :]
        result = f"BEGIN\n{indented}{rest}"
    elif upper.startswith("WITH RECURSIVE"):
        # Insert user CTE after "WITH RECURSIVE" keyword
        result = re.sub(
            r"^(WITH\s+RECURSIVE\s+)",
            r"\1" + cte_text + ", ",
            stripped,
            count=1,
            flags=re.IGNORECASE,
        )
    elif upper.startswith("WITH"):
        # Insert user CTE after "WITH" keyword
        result = re.sub(
            r"^(WITH\s+)",
            r"\1" + cte_text + ", ",
            stripped,
            count=1,
            flags=re.IGNORECASE,
        )
    else:
        # No existing WITH clause — prepend
        result = f"WITH {cte_text} {stripped}"

    return result
