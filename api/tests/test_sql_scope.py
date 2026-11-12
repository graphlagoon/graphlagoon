"""Table-scope extraction and the one-rule scope decision.

Route-level enforcement lives in test_permission_routes.py; this is the pure
core: which tables a statement really names, and whether they are in scope.
"""

from types import SimpleNamespace

import pytest

from graphlagoon.services.sql_scope import (
    check_scope,
    context_tables,
    extract_table_refs,
    normalize_table_name,
    source_scope,
)

DEFAULTS = ("spark_catalog", "default")
ALLOWED = [("main", "graphs"), ("main", "staging")]


def make_context(edge="main.graphs.edges", node="main.graphs.nodes"):
    return SimpleNamespace(edge_table_name=edge, node_table_name=node)


SOURCES = source_scope(ALLOWED, ["main.kyc", "ext.risk.scores"], *DEFAULTS)


def _scope(sql, context=None, sources=SOURCES):
    return check_scope(
        sql,
        context or make_context(),
        sources,
        default_catalog=DEFAULTS[0],
        default_schema=DEFAULTS[1],
    )


class TestExtractTableRefs:
    def test_simple_select(self):
        assert extract_table_refs("SELECT * FROM a.b.c") == [("a", "b", "c")]

    def test_join_and_subquery(self):
        refs = extract_table_refs(
            "SELECT * FROM a.b.c JOIN d.e.f ON 1=1 " "WHERE x IN (SELECT id FROM g.h.i)"
        )
        assert set(refs) == {("a", "b", "c"), ("d", "e", "f"), ("g", "h", "i")}

    def test_cte_name_is_not_a_table(self):
        refs = extract_table_refs(
            "WITH picked AS (SELECT * FROM a.b.c) SELECT * FROM picked"
        )
        assert refs == [("a", "b", "c")]

    def test_partial_qualification_preserved(self):
        assert extract_table_refs("SELECT * FROM b.c") == [(None, "b", "c")]
        assert extract_table_refs("SELECT * FROM c") == [(None, None, "c")]

    def test_parse_error_returns_none(self):
        assert extract_table_refs("SELECT FROM") is None
        assert extract_table_refs("foo bar baz") is None


class TestNormalization:
    def test_two_part_takes_default_catalog(self):
        assert normalize_table_name("b.c", *DEFAULTS) == ("spark_catalog", "b", "c")

    def test_three_part_kept_and_lowercased(self):
        assert normalize_table_name("A.B.C", *DEFAULTS) == ("a", "b", "c")

    def test_context_tables_collects_both(self):
        assert context_tables(make_context(), *DEFAULTS) == {
            ("main", "graphs", "edges"),
            ("main", "graphs", "nodes"),
        }

    def test_context_tables_include_enrichment_tables(self):
        context = make_context()
        context.enrichment_tables = [{"table": "main.kyc.devices"}]
        assert ("main", "kyc", "devices") in context_tables(context, *DEFAULTS)

    def test_nodeless_context_has_only_the_edge_table(self):
        assert context_tables(make_context(node=None), *DEFAULTS) == {
            ("main", "graphs", "edges")
        }


class TestOneRuleForEveryone:
    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT * FROM main.graphs.edges",
            "SELECT * FROM main.graphs.nodes n JOIN main.graphs.edges e ON 1=1",
            "WITH x AS (SELECT * FROM main.graphs.edges) SELECT * FROM x",
        ],
    )
    def test_context_tables_allowed(self, sql):
        assert _scope(sql) is None

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT * FROM main.graphs.salaries",
            "SELECT * FROM hr.private.salaries",
            "SELECT * FROM main.graphs.edges e JOIN hr.private.s x ON 1=1",
            "SELECT * FROM main.graphs.edges WHERE a IN (SELECT b FROM hr.p.s)",
        ],
    )
    def test_anything_else_denied(self, sql):
        assert _scope(sql) is not None

    def test_case_insensitive_match(self):
        assert _scope("SELECT * FROM MAIN.GRAPHS.EDGES") is None

    def test_allowed_schema_is_not_enough(self):
        # main.staging is allowed for graphs, but no context names this table.
        problem = _scope("SELECT * FROM main.staging.other")
        assert problem is not None and "main.staging.other" in problem

    def test_enrichment_table_inside_sources_is_in_scope(self):
        context = make_context()
        context.enrichment_tables = [{"table": "main.kyc.devices"}, {"table": "ext.risk.scores"}]
        assert _scope("SELECT * FROM main.kyc.devices d JOIN ext.risk.scores s ON 1=1", context) is None

    def test_enrichment_table_outside_sources_drops_out(self):
        # Listed before the settings changed: no longer authorized.
        context = make_context()
        context.enrichment_tables = [{"table": "hr.private.salaries"}]
        assert _scope("SELECT * FROM hr.private.salaries", context) is not None


class TestSourceScope:
    def test_schemas_and_tables(self):
        assert SOURCES.allows(("main", "graphs", "anything"))
        assert SOURCES.allows(("main", "kyc", "devices"))
        assert SOURCES.allows(("ext", "risk", "scores"))
        assert not SOURCES.allows(("ext", "risk", "other"))
        assert not SOURCES.allows(("hr", "private", "salaries"))

    def test_backticks_and_case(self):
        sources = source_scope([("`My-Cat`", "graphs")], ["`X`.Y.Z"], *DEFAULTS)
        assert sources.allows(("my-cat", "graphs", "t"))
        assert sources.allows(("x", "y", "z"))

    def test_malformed_entries_ignored(self):
        sources = source_scope([], ["", "onlyone", "a.b.c.d"], *DEFAULTS)
        assert sources.schemas == frozenset() and sources.tables == frozenset()


class TestBacktickedNames:
    """A context stored as `catalogo`.schema.tabela must match the query that
    names it, quoted or not — sqlglot reports the parts without backticks."""

    def test_normalization_strips_backticks(self):
        assert normalize_table_name("`Catalogo`.schema.tabela", *DEFAULTS) == (
            "catalogo",
            "schema",
            "tabela",
        )

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT * FROM `my-cat`.graphs.edges",
            "SELECT * FROM `my-cat`.`graphs`.`edges`",
        ],
    )
    def test_reads_own_quoted_tables(self, sql):
        context = make_context(edge="`my-cat`.graphs.edges", node=None)
        assert _scope(sql, context=context) is None


class TestFailClosed:
    def test_unparseable_is_refused(self):
        # Defensive: in the routers the SELECT-only validator runs first, so
        # anything reaching check_scope already parsed. If that ever changes,
        # an unparseable statement must not slip through as "no tables".
        assert _scope("SELECT FROM") is not None
