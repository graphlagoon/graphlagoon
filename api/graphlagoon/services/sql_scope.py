"""Which tables a query is allowed to touch.

Two tiers, keyed on the ``context.create`` permission:

* **Authors** (hold ``context.create``) may read any table inside the
  configured ``catalog.schema`` allowlist — they can already point a new
  context at any of those tables, so a query reaching them is not an
  escalation.
* **Everyone else** is restricted to the tables of the context they have
  open. Their scope is *proved* by parsing the statement, not trusted.

Cypher needs no check here: the transpiler renders against the context's own
schema provider, so its SQL can only name that context's tables. This module
is for the raw-SQL paths, where the client writes the FROM clause.

Deliberate limit: a ``BEGIN...END`` script cannot be scoped at all — its body
is opaque to the parser and ``EXECUTE IMMEDIATE`` builds SQL at runtime. That
is why scripts are refused unless ``allow_raw_sql_scripts`` is on, and why
enabling it requires read-only warehouse grants (see the deploy guide).
"""

from __future__ import annotations

from typing import Optional

import sqlglot
from sqlglot import exp

# A normalized table reference: lowercase (catalog, schema, table).
TableRef = tuple[str, str, str]


def extract_table_refs(sql: str, dialect: str = "spark") -> Optional[list]:
    """Every real table named by ``sql``, as ``(catalog, schema, table)``
    parts with missing levels left as ``None``.

    CTE names are skipped — they are query-local, not warehouse tables.
    Returns ``None`` when the statement cannot be parsed, which callers must
    treat as "scope unknown" and refuse.
    """
    try:
        statements = sqlglot.parse(sql, dialect=dialect)
    except Exception:
        return None
    if not statements or any(s is None for s in statements):
        return None

    refs: list = []
    for statement in statements:
        cte_names = {
            cte.alias_or_name.lower()
            for cte in statement.find_all(exp.CTE)
            if cte.alias_or_name
        }
        for table in statement.find_all(exp.Table):
            name = table.name
            if not name:
                continue
            # A bare name matching a CTE is that CTE, not a warehouse table.
            if not table.db and not table.catalog and name.lower() in cte_names:
                continue
            refs.append((table.catalog or None, table.db or None, name))
    return refs


def normalize_ref(ref, default_catalog: str, default_schema: str) -> TableRef:
    """Resolve a partially-qualified reference to a lowercase triple.

    A two-part ``schema.table`` takes the default catalog; a bare ``table``
    takes both defaults — matching how the warehouse resolves them.
    """
    catalog, schema, table = ref
    return (
        (catalog or default_catalog).lower(),
        (schema or default_schema).lower(),
        table.lower(),
    )


def normalize_table_name(
    name: str, default_catalog: str, default_schema: str
) -> Optional[TableRef]:
    """Normalize a stored dotted table name (``db.t`` / ``cat.db.t``)."""
    if not name:
        return None
    parts = name.split(".")
    if len(parts) == 1:
        return normalize_ref((None, None, parts[0]), default_catalog, default_schema)
    if len(parts) == 2:
        return normalize_ref(
            (None, parts[0], parts[1]), default_catalog, default_schema
        )
    if len(parts) == 3:
        return normalize_ref(
            (parts[0], parts[1], parts[2]), default_catalog, default_schema
        )
    return None


def context_tables(context, default_catalog: str, default_schema: str) -> set:
    """The normalized tables a context declares (edge + node)."""
    tables = set()
    for name in (
        getattr(context, "edge_table_name", None),
        getattr(context, "node_table_name", None),
    ):
        if not name:
            continue
        normalized = normalize_table_name(name, default_catalog, default_schema)
        if normalized:
            tables.add(normalized)
    return tables


def cte_prefilter_as_statement(cte_text: str, context) -> str:
    """Wrap a CTE pre-filter so its table references can be extracted.

    The pre-filter is raw client SQL spliced into EVERY mode — including a
    procedural ``BEGIN...END`` script, whose final form is opaque to the
    parser. It must therefore be checked here, at the source, while it is
    still a parseable fragment. ``__EDGES__``/``__NODES__`` are the context's
    own tables, so they are substituted rather than treated as foreign.
    """
    edge = getattr(context, "edge_table_name", None) or "__edges__"
    # A nodeless context derives its nodes from the edge table; either way the
    # placeholder resolves to a table the context already owns.
    node = getattr(context, "node_table_name", None) or edge
    text = cte_text.replace("__EDGES__", edge).replace("__NODES__", node)
    return f"WITH {text} SELECT 1 FROM MY_FINAL_EDGES"


def check_scope(
    sql: str,
    context,
    is_author: bool,
    allowed_pairs,
    default_catalog: str,
    default_schema: str,
) -> Optional[str]:
    """``None`` when every table in ``sql`` is in scope, else why it is not.

    ``allowed_pairs`` is the configured ``(catalog, schema)`` allowlist; the
    context's own schemas are always in scope on top of it, so a context
    pointing outside the configured pairs keeps working.
    """
    refs = extract_table_refs(sql)
    if refs is None:
        return (
            "The query could not be parsed, so the tables it reads cannot be "
            "verified."
        )

    own_tables = context_tables(context, default_catalog, default_schema)
    normalized = {normalize_ref(r, default_catalog, default_schema) for r in refs}

    if not is_author:
        outside = normalized - own_tables
        if outside:
            listed = ", ".join(sorted(".".join(t) for t in outside))
            return (
                f"This query reads tables outside the current context: "
                f'{listed}. Without the "Create graph contexts" permission '
                f"a query may only read the context's own tables."
            )
        return None

    allowed_scopes = {(c.lower(), s.lower()) for c, s in allowed_pairs}
    allowed_scopes |= {(c, s) for c, s, _ in own_tables}
    outside = {t for t in normalized if (t[0], t[1]) not in allowed_scopes}
    if outside:
        listed = ", ".join(sorted(".".join(t) for t in outside))
        scopes = ", ".join(sorted(f"{c}.{s}" for c, s in allowed_scopes))
        return (
            f"This query reads tables outside the permitted catalogs: "
            f"{listed}. Allowed: {scopes}."
        )
    return None
