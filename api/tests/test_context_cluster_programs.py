"""Tests for context-level cluster programs (GraphContext.cluster_programs)."""

import sys
from uuid import uuid4

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and break
# test_transpile_options (this file is collected before it alphabetically).
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

from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.models.schemas import (  # noqa: E402
    GraphContextCreate,
    GraphContextUpdate,
)

A_PROGRAM = {
    "program_id": "abc-123",
    "program_name": "My Program",
    "code": "return [];",
    "scope": "context",
    "created_at": "2026-07-17T00:00:00Z",
    "updated_at": "2026-07-17T00:00:00Z",
}


class TestSchemas:
    def test_create_defaults_to_empty_list(self):
        """Omitting the field must not be an error — it's optional."""
        data = GraphContextCreate(
            title="t", edge_table_name="e", node_table_name="n"
        )
        assert data.cluster_programs == []

    def test_create_accepts_programs(self):
        data = GraphContextCreate(
            title="t",
            edge_table_name="e",
            node_table_name="n",
            cluster_programs=[A_PROGRAM],
        )
        assert data.cluster_programs == [A_PROGRAM]

    def test_create_passes_unknown_keys_through_opaquely(self):
        """The backend doesn't gatekeep the program shape — the frontend owns it."""
        program = {**A_PROGRAM, "someFutureField": True}
        data = GraphContextCreate(
            title="t",
            edge_table_name="e",
            node_table_name="n",
            cluster_programs=[program],
        )
        assert data.cluster_programs == [program]

    def test_update_defaults_to_none(self):
        """None means 'not provided' — the router skips it, leaving the column alone."""
        assert GraphContextUpdate().cluster_programs is None

    def test_update_accepts_programs(self):
        data = GraphContextUpdate(cluster_programs=[A_PROGRAM])
        assert data.cluster_programs == [A_PROGRAM]

    def test_update_accepts_empty_list(self):
        """[] is a real value (delete-all), distinct from None (not provided)."""
        data = GraphContextUpdate(cluster_programs=[])
        assert data.cluster_programs == []


class TestMemoryStore:
    """The in-memory backend (`make dev`, database_enabled=false)."""

    def setup_method(self):
        InMemoryStore.reset()
        self.store = InMemoryStore.get_instance()

    def _create(self, **kwargs):
        return self.store.create_graph_context(
            title="t",
            edge_table_name="e",
            node_table_name="n",
            owner_email="a@b.com",
            **kwargs,
        )

    def test_defaults_to_empty_list(self):
        context = self._create()
        assert context.cluster_programs == []

    def test_create_stores_programs(self):
        context = self._create(cluster_programs=[A_PROGRAM])
        assert context.cluster_programs == [A_PROGRAM]

        # And survives a round-trip through the store.
        fetched = self.store.get_graph_context(context.id)
        assert fetched.cluster_programs == [A_PROGRAM]

    def test_update_replaces_programs(self):
        context = self._create(cluster_programs=[A_PROGRAM])

        other = {**A_PROGRAM, "program_id": "def-456", "program_name": "Other"}
        self.store.update_graph_context(context.id, cluster_programs=[other])

        assert self.store.get_graph_context(context.id).cluster_programs == [other]

    def test_contexts_do_not_share_a_default_list(self):
        """A mutable default_factory bug would make all contexts alias one list."""
        a = self._create()
        b = self._create()

        a.cluster_programs.append(A_PROGRAM)

        assert b.cluster_programs == []

    def test_update_of_another_field_leaves_programs_intact(self):
        context = self._create(cluster_programs=[A_PROGRAM])

        self.store.update_graph_context(context.id, title="renamed")

        fetched = self.store.get_graph_context(context.id)
        assert fetched.title == "renamed"
        assert fetched.cluster_programs == [A_PROGRAM]

    def test_unknown_context_id_returns_none(self):
        assert self.store.get_graph_context(uuid4()) is None


class TestMigration:
    @staticmethod
    def _load_migration():
        # alembic/versions is not an importable package (filenames start with a digit),
        # so load the module from its path — the same way alembic itself does.
        import importlib.util
        from pathlib import Path

        import graphlagoon

        path = (
            Path(graphlagoon.__file__).parent
            / "alembic"
            / "versions"
            / "009_add_context_cluster_programs.py"
        )
        spec = importlib.util.spec_from_file_location("migration_009", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_009_chains_onto_the_current_head(self):
        module = self._load_migration()

        assert module.revision == "009"
        # 008 was head before this change; a wrong down_revision silently orphans it.
        assert module.down_revision == "008"

    def test_009_targets_the_right_table_and_column(self):
        import inspect

        source = inspect.getsource(self._load_migration().upgrade)

        assert "graph_contexts" in source
        assert "cluster_programs" in source

    def test_db_model_has_the_column(self):
        from graphlagoon.db.models import GraphContext

        assert "cluster_programs" in GraphContext.__table__.columns
