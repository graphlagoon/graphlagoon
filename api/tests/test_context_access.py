"""Tests for get_context_with_access (utils/context_access.py).

The in-memory branch was already exercised through test_superuser.py; what was
never covered is that the two branches agree on *which* exploration shares grant
context access. They did not: the database branch built its share conditions by
hand as exact-match + "*@domain" and omitted the public sentinel "*", so a user
whose only grant was a public exploration share could list explorations but got
403 from every graph endpoint. Both branches now go through the same source of
truth (`share_match_emails` / `user_has_share_access`).
"""

import asyncio
import sys

import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and break
# test_transpile_options.
try:
    import gsql2rsql  # noqa: F401
except ImportError:
    from unittest.mock import MagicMock as _MagicMock

    for _name in (
        "gsql2rsql",
        "gsql2rsql.parser",
        "gsql2rsql.parser.opencypher_parser",
        "gsql2rsql.planner",
        "gsql2rsql.planner.logical_plan",
        "gsql2rsql.planner.subquery_flattening",
        "gsql2rsql.planner.pass_manager",
        "gsql2rsql.renderer",
        "gsql2rsql.renderer.sql_renderer",
        "gsql2rsql.renderer.schema_provider",
        "gsql2rsql.common",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from fastapi import HTTPException  # noqa: E402

from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.utils.context_access import get_context_with_access  # noqa: E402

OWNER = "owner@example.com"
STRANGER = "stranger@example.com"


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def context(store):
    return store.create_graph_context(
        title="ctx",
        edge_table_name="e",
        node_table_name="n",
        owner_email=OWNER,
    )


@pytest.fixture
def exploration(store, context):
    return store.create_exploration(
        graph_context_id=context.id, title="exp", owner_email=OWNER, state={}
    )


def _get(context_id, email):
    return asyncio.run(get_context_with_access(context_id, email))


class TestMemoryBranch:
    def test_owner_allowed(self, store, context):
        assert _get(context.id, OWNER).id == context.id

    def test_stranger_forbidden(self, store, context):
        with pytest.raises(HTTPException) as exc:
            _get(context.id, STRANGER)
        assert exc.value.status_code == 403

    def test_missing_context_is_404(self, store):
        from uuid import uuid4

        with pytest.raises(HTTPException) as exc:
            _get(uuid4(), OWNER)
        assert exc.value.status_code == 404

    def test_context_share_grants_access(self, store, context):
        store.share_graph_context(context.id, STRANGER, permission="read")
        assert _get(context.id, STRANGER).id == context.id

    def test_exploration_share_grants_access(self, store, context, exploration):
        store.share_exploration(exploration.id, STRANGER, permission="read")
        assert _get(context.id, STRANGER).id == context.id

    def test_public_exploration_share_grants_access(
        self, store, context, exploration
    ):
        """The regression this module exists for — mirrored in the DB branch below."""
        store.share_exploration(exploration.id, "*", permission="read")
        assert _get(context.id, "anyone@elsewhere.com").id == context.id

    def test_domain_exploration_share_grants_access(
        self, store, context, exploration
    ):
        store.share_exploration(exploration.id, "*@example.com", permission="read")
        assert _get(context.id, STRANGER).id == context.id


class _CapturingResult:
    """Stands in for a SQLAlchemy Result; always reports "nothing found"."""

    def scalar_one_or_none(self):
        return None


class _CapturingSession:
    """Records every statement handed to execute() so the test can inspect the SQL."""

    def __init__(self, statements):
        self._statements = statements

    async def execute(self, statement):
        self._statements.append(statement)
        return _CapturingResult()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class TestDatabaseBranchSql:
    """The suite runs in memory mode, so the DB branch has no live database to
    talk to. Compiling its statements is still enough to assert the thing that
    actually regressed: which `shared_with_email` values the exploration-share
    lookup accepts.
    """

    @staticmethod
    def _compiled_statements(monkeypatch, user_email):
        import graphlagoon.utils.context_access as mod

        statements = []
        monkeypatch.setattr(mod, "is_database_available", lambda: True)
        monkeypatch.setattr(
            mod, "get_session_maker", lambda: (lambda: _CapturingSession(statements))
        )

        from uuid import uuid4

        # The context lookup returns None, so this raises 404 — by then both
        # statements we care about have already been captured.
        with pytest.raises(HTTPException):
            asyncio.run(get_context_with_access(uuid4(), user_email))

        return [
            str(s.compile(compile_kwargs={"literal_binds": True})) for s in statements
        ]

    def test_context_lookup_runs_first(self, monkeypatch):
        sql = self._compiled_statements(monkeypatch, STRANGER)
        assert len(sql) == 1
        assert "graph_contexts" in sql[0]


class TestDatabaseShareConditions:
    """`share_match_emails` is what the DB branch now builds its IN clause from,
    so pinning its output pins the fix.
    """

    def test_includes_public_sentinel_and_domain(self):
        from graphlagoon.utils.sharing import share_match_emails

        values = share_match_emails(STRANGER)
        assert STRANGER in values
        assert "*" in values, "public sentinel must grant access"
        assert "*@example.com" in values

    def test_matches_memory_branch_semantics(self):
        """Every value share_match_emails returns must also satisfy the predicate
        the in-memory branch uses — otherwise the two branches disagree again.
        """
        from graphlagoon.utils.sharing import email_matches_share, share_match_emails

        for value in share_match_emails(STRANGER):
            assert email_matches_share(STRANGER, value) is True
