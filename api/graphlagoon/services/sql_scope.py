"""Which tables a query is allowed to touch.

One rule for everyone: a query may read only the tables its context declares,
the graph's edge and node tables and the context's authorized enrichment
tables. Nobody reaches a table no context names, whatever their permissions.
The scope is *proved* by parsing the statement, not trusted.

Which tables a context may authorize for enrichment is a deployment setting
(``SourceScope``): the catalog.schema pairs allowed for graphs
(``catalog_schemas``) plus the extra schemas and tables allowed for enrichment
only (``enrichment_sources``). An enrichment table that falls outside it, for
example after the settings changed, stops being part of the context's scope.

Cypher needs no check here: the transpiler renders against the context's own
schema provider, so its SQL can only name that context's tables. This module
is for the raw-SQL paths, where the client writes the FROM clause.

Deliberate limit: a ``BEGIN...END`` script cannot be scoped at all — its body
is opaque to the parser and ``EXECUTE IMMEDIATE`` builds SQL at runtime. That
is why scripts are refused unless ``allow_raw_sql_scripts`` is on, and why
enabling it requires read-only warehouse grants (see the deploy guide).
"""

from __future__ import annotations

from dataclasses import dataclass
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
        _bare(catalog or default_catalog),
        _bare(schema or default_schema),
        _bare(table),
    )


def _bare(part: str) -> str:
    """A name part as the parser reports it: no backticks, lowercase. Stored
    names and settings may carry backticks (```my-cat`.db.t``); sqlglot strips
    them from the statement, so both sides must match without them."""
    return part.strip("`").lower()


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


@dataclass(frozen=True)
class SourceScope:
    """The tables a context may authorize for enrichment: whole
    ``(catalog, schema)`` pairs and single ``(catalog, schema, table)``s."""

    schemas: frozenset = frozenset()
    tables: frozenset = frozenset()

    def allows(self, ref: TableRef) -> bool:
        return (ref[0], ref[1]) in self.schemas or ref in self.tables

    def describe(self) -> str:
        names = sorted(f"{c}.{s}.*" for c, s in self.schemas)
        names += sorted(".".join(t) for t in self.tables)
        return ", ".join(names) or "nothing"


def source_scope(
    graph_pairs, enrichment_sources, default_catalog: str, default_schema: str
) -> SourceScope:
    """``graph_pairs`` are the catalog.schema pairs allowed for graphs;
    ``enrichment_sources`` are ``catalog.schema`` or ``catalog.schema.table``
    strings allowed for enrichment only."""
    schemas = {(_bare(c), _bare(s)) for c, s in graph_pairs}
    tables = set()
    for source in enrichment_sources:
        parts = [p.strip() for p in source.strip().split(".")]
        if len(parts) == 2 and all(parts):
            schemas.add((_bare(parts[0]), _bare(parts[1])))
        elif len(parts) == 3 and all(parts):
            ref = normalize_table_name(".".join(parts), default_catalog, default_schema)
            if ref:
                tables.add(ref)
    return SourceScope(frozenset(schemas), frozenset(tables))


def current_source_scope() -> SourceScope:
    """``source_scope`` from the running settings."""
    from graphlagoon.config import get_settings

    settings = get_settings()
    return source_scope(
        settings.catalog_schema_pairs,
        settings.enrichment_source_list,
        settings.default_catalog,
        settings.default_schema,
    )


def context_tables(
    context,
    default_catalog: str,
    default_schema: str,
    sources: Optional[SourceScope] = None,
) -> set:
    """The normalized tables a context declares (edge, node and enrichment).
    With ``sources``, an enrichment table outside it is left out: it is listed
    but no longer authorized."""
    tables = set()
    for name in (
        getattr(context, "edge_table_name", None),
        getattr(context, "node_table_name", None),
    ):
        normalized = normalize_table_name(name, default_catalog, default_schema) if name else None
        if normalized:
            tables.add(normalized)
    for spec in getattr(context, "enrichment_tables", None) or []:
        name = spec.get("table")
        normalized = normalize_table_name(name, default_catalog, default_schema) if name else None
        if normalized and (sources is None or sources.allows(normalized)):
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
    sources: Optional[SourceScope],
    default_catalog: str,
    default_schema: str,
) -> Optional[str]:
    """``None`` when every table in ``sql`` is one the context declares (see
    ``context_tables``), else why it is not. Same rule for every caller."""
    refs = extract_table_refs(sql)
    if refs is None:
        return (
            "The query could not be parsed, so the tables it reads cannot be "
            "verified."
        )

    own_tables = context_tables(context, default_catalog, default_schema, sources)
    normalized = {normalize_ref(r, default_catalog, default_schema) for r in refs}
    outside = normalized - own_tables
    if outside:
        listed = ", ".join(sorted(".".join(t) for t in outside))
        return (
            f"This query reads tables outside the current context: {listed}. "
            "A query may only read the context's graph tables and its "
            "authorized enrichment tables; a context author can add a table "
            "under Enrichment tables."
        )
    return None
