"""Table-scope extraction and the two-tier scope decision.

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
)

DEFAULTS = ("spark_catalog", "default")
ALLOWED = [("main", "graphs"), ("main", "staging")]


def make_context(edge="main.graphs.edges", node="main.graphs.nodes"):
    return SimpleNamespace(edge_table_name=edge, node_table_name=node)


def _scope(sql, is_author, context=None):
    return check_scope(
        sql,
        context or make_context(),
        is_author=is_author,
        allowed_pairs=ALLOWED,
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

    def test_nodeless_context_has_only_the_edge_table(self):
        assert context_tables(make_context(node=None), *DEFAULTS) == {
            ("main", "graphs", "edges")
        }


class TestReaderTier:
    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT * FROM main.graphs.edges",
            "SELECT * FROM main.graphs.nodes n JOIN main.graphs.edges e ON 1=1",
            "WITH x AS (SELECT * FROM main.graphs.edges) SELECT * FROM x",
        ],
    )
    def test_context_tables_allowed(self, sql):
        assert _scope(sql, is_author=False) is None

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
        assert _scope(sql, is_author=False) is not None

    def test_case_insensitive_match(self):
        assert _scope("SELECT * FROM MAIN.GRAPHS.EDGES", is_author=False) is None


class TestAuthorTier:
    def test_other_table_inside_allowlist(self):
        assert _scope("SELECT * FROM main.staging.other", is_author=True) is None

    def test_outside_allowlist_denied(self):
        problem = _scope("SELECT * FROM hr.private.salaries", is_author=True)
        assert problem is not None and "hr.private.salaries" in problem

    def test_context_schema_always_in_scope(self):
        # A context pointing outside the configured pairs keeps working.
        context = make_context(edge="other.zone.edges", node=None)
        assert (
            _scope("SELECT * FROM other.zone.edges", is_author=True, context=context)
            is None
        )


class TestFailClosed:
    def test_unparseable_is_refused_for_both_tiers(self):
        # Defensive: in the routers the SELECT-only validator runs first, so
        # anything reaching check_scope already parsed. If that ever changes,
        # an unparseable statement must not slip through as "no tables".
        assert _scope("SELECT FROM", is_author=False) is not None
        assert _scope("SELECT FROM", is_author=True) is not None
