"""Tests for per-context default behaviors (GraphContext.default_behaviors)."""

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


class TestSchemas:
    def test_create_defaults_to_empty_dict(self):
        """Omitting the field must not be an error — it's optional."""
        data = GraphContextCreate(
            title="t", edge_table_name="e", node_table_name="n"
        )
        assert data.default_behaviors == {}

    def test_create_accepts_behaviors(self):
        data = GraphContextCreate(
            title="t",
            edge_table_name="e",
            node_table_name="n",
            default_behaviors={"viewMode": "3d", "mapStylePan": False},
        )
        assert data.default_behaviors == {"viewMode": "3d", "mapStylePan": False}

    def test_create_passes_unknown_keys_through_opaquely(self):
        """The backend doesn't gatekeep the shape — the frontend validates keys.

        This is what lets a new frontend behavior work without a backend change.
        """
        data = GraphContextCreate(
            title="t",
            edge_table_name="e",
            node_table_name="n",
            default_behaviors={"someFutureBehavior": True},
        )
        assert data.default_behaviors == {"someFutureBehavior": True}

    def test_update_defaults_to_none(self):
        """None means 'not provided' — the router skips it, leaving the column alone."""
        assert GraphContextUpdate().default_behaviors is None

    def test_update_accepts_behaviors(self):
        data = GraphContextUpdate(default_behaviors={"viewMode": "3d"})
        assert data.default_behaviors == {"viewMode": "3d"}


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

    def test_defaults_to_empty_dict(self):
        context = self._create()
        assert context.default_behaviors == {}

    def test_create_stores_behaviors(self):
        context = self._create(default_behaviors={"viewMode": "3d"})
        assert context.default_behaviors == {"viewMode": "3d"}

        # And survives a round-trip through the store.
        fetched = self.store.get_graph_context(context.id)
        assert fetched.default_behaviors == {"viewMode": "3d"}

    def test_update_replaces_behaviors(self):
        context = self._create(default_behaviors={"viewMode": "3d"})

        self.store.update_graph_context(
            context.id, default_behaviors={"viewMode": "2d-proj"}
        )

        assert self.store.get_graph_context(context.id).default_behaviors == {
            "viewMode": "2d-proj"
        }

    def test_contexts_do_not_share_a_default_dict(self):
        """A mutable default_factory bug would make all contexts alias one dict."""
        a = self._create()
        b = self._create()

        a.default_behaviors["viewMode"] = "3d"

        assert b.default_behaviors == {}

    def test_update_of_another_field_leaves_behaviors_intact(self):
        context = self._create(default_behaviors={"viewMode": "3d"})

        self.store.update_graph_context(context.id, title="renamed")

        fetched = self.store.get_graph_context(context.id)
        assert fetched.title == "renamed"
        assert fetched.default_behaviors == {"viewMode": "3d"}

    def test_unknown_context_id_returns_none(self):
        assert self.store.get_graph_context(uuid4()) is None


class TestMigration:
    """graph_contexts had no free-form JSON field, so this needed a real migration."""

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
            / "007_add_context_default_behaviors.py"
        )
        spec = importlib.util.spec_from_file_location("migration_007", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_007_chains_onto_the_current_head(self):
        module = self._load_migration()

        assert module.revision == "007"
        # 006 was head before this change; a wrong down_revision silently orphans it.
        assert module.down_revision == "006"

    def test_007_targets_the_right_table_and_column(self):
        import inspect

        source = inspect.getsource(self._load_migration().upgrade)

        assert "graph_contexts" in source
        assert "default_behaviors" in source

    def test_db_model_has_the_column(self):
        from graphlagoon.db.models import GraphContext

        assert "default_behaviors" in GraphContext.__table__.columns
