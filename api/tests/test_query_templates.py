"""Permission-matrix tests for query template endpoints (memory mode).

Visibility model:
- "shared": visible to everyone with context access; created/edited/deleted by
  anyone with context write access.
- "private": visible and mutable only by its creator; creatable by anyone with
  context access (including exploration-share-only users).
"""

import sys

import pytest

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
    QueryTemplateCreate,
    QueryTemplateUpdate,
)

OWNER = "owner@example.com"
WRITER = "writer@example.com"  # context share, write
READER = "reader@example.com"  # context share, read
EXP_WRITER = "exp-writer@example.com"  # exploration share only (write)
STRANGER = "stranger@example.com"  # no access at all


@pytest.fixture
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from graphlagoon.routers.query_templates import router

    app = FastAPI()
    app.include_router(router)
    yield TestClient(app)


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def context(store):
    """A context owned by OWNER with the full cast of shares."""
    ctx = store.create_graph_context(
        title="ctx",
        edge_table_name="e",
        node_table_name="n",
        owner_email=OWNER,
    )
    store.share_graph_context(ctx.id, WRITER, permission="write")
    store.share_graph_context(ctx.id, READER, permission="read")
    exploration = store.create_exploration(
        graph_context_id=ctx.id, title="exp", owner_email=OWNER, state={}
    )
    store.share_exploration(exploration.id, EXP_WRITER, permission="write")
    return ctx


def _headers(email):
    return {"X-Forwarded-Email": email}


def _templates_url(context, template_id=None):
    base = f"/api/graph-contexts/{context.id}/query-templates"
    return f"{base}/{template_id}" if template_id else base


def _create(client, context, email, visibility="shared", name="tpl"):
    return client.post(
        _templates_url(context),
        json={
            "name": name,
            "query_type": "cypher",
            "query": "MATCH (n) RETURN n",
            "visibility": visibility,
        },
        headers=_headers(email),
    )


class TestSchemas:
    def test_create_defaults_to_shared(self):
        data = QueryTemplateCreate(name="t", query_type="cypher", query="q")
        assert data.visibility == "shared"

    def test_create_accepts_private(self):
        data = QueryTemplateCreate(
            name="t", query_type="cypher", query="q", visibility="private"
        )
        assert data.visibility == "private"

    def test_create_rejects_unknown_visibility(self):
        with pytest.raises(Exception):
            QueryTemplateCreate(
                name="t", query_type="cypher", query="q", visibility="team"
            )

    def test_update_visibility_defaults_to_none(self):
        assert QueryTemplateUpdate().visibility is None


class TestCreate:
    def test_owner_creates_shared(self, client, context):
        resp = _create(client, context, OWNER, "shared")
        assert resp.status_code == 201
        assert resp.json()["visibility"] == "shared"

    def test_write_sharer_creates_shared(self, client, context):
        assert _create(client, context, WRITER, "shared").status_code == 201

    def test_read_sharer_cannot_create_shared(self, client, context):
        assert _create(client, context, READER, "shared").status_code == 403

    def test_exploration_sharer_cannot_create_shared(self, client, context):
        assert _create(client, context, EXP_WRITER, "shared").status_code == 403

    def test_read_sharer_creates_private(self, client, context):
        resp = _create(client, context, READER, "private")
        assert resp.status_code == 201
        assert resp.json()["visibility"] == "private"
        assert resp.json()["owner_email"] == READER

    def test_exploration_sharer_creates_private(self, client, context):
        """The capability that motivated this feature."""
        assert _create(client, context, EXP_WRITER, "private").status_code == 201

    def test_stranger_cannot_create_anything(self, client, context):
        assert _create(client, context, STRANGER, "private").status_code == 403


class TestList:
    def test_shared_templates_visible_to_all_with_access(self, client, context):
        _create(client, context, OWNER, "shared")
        for email in (OWNER, WRITER, READER, EXP_WRITER):
            resp = client.get(_templates_url(context), headers=_headers(email))
            assert resp.status_code == 200
            assert len(resp.json()) == 1

    def test_private_template_hidden_from_others(self, client, context):
        _create(client, context, READER, "private")

        assert (
            len(client.get(_templates_url(context), headers=_headers(READER)).json())
            == 1
        )
        # Even the context owner does not see someone else's private template.
        assert (
            len(client.get(_templates_url(context), headers=_headers(OWNER)).json())
            == 0
        )

    def test_list_mixes_shared_and_own_private(self, client, context):
        _create(client, context, OWNER, "shared", name="shared-tpl")
        _create(client, context, READER, "private", name="my-tpl")

        names = {
            t["name"]
            for t in client.get(
                _templates_url(context), headers=_headers(READER)
            ).json()
        }
        assert names == {"shared-tpl", "my-tpl"}


class TestUpdate:
    def test_write_sharer_updates_others_shared_template(self, client, context):
        """Changed behavior: mutate rights come from context write, not creatorship."""
        tpl = _create(client, context, OWNER, "shared").json()
        resp = client.put(
            _templates_url(context, tpl["id"]),
            json={"name": "renamed"},
            headers=_headers(WRITER),
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "renamed"

    def test_read_sharer_cannot_update_shared(self, client, context):
        tpl = _create(client, context, OWNER, "shared").json()
        resp = client.put(
            _templates_url(context, tpl["id"]),
            json={"name": "renamed"},
            headers=_headers(READER),
        )
        assert resp.status_code == 403

    def test_creator_updates_own_private(self, client, context):
        tpl = _create(client, context, READER, "private").json()
        resp = client.put(
            _templates_url(context, tpl["id"]),
            json={"name": "renamed"},
            headers=_headers(READER),
        )
        assert resp.status_code == 200

    def test_others_private_template_is_404_not_403(self, client, context):
        """Existence of someone else's private template must not leak."""
        tpl = _create(client, context, READER, "private").json()
        resp = client.put(
            _templates_url(context, tpl["id"]),
            json={"name": "renamed"},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 404

    def test_only_creator_changes_visibility(self, client, context):
        tpl = _create(client, context, OWNER, "shared").json()
        resp = client.put(
            _templates_url(context, tpl["id"]),
            json={"visibility": "private"},
            headers=_headers(WRITER),
        )
        assert resp.status_code == 403

    def test_creator_promotes_private_to_shared(self, client, context):
        tpl = _create(client, context, OWNER, "private").json()
        resp = client.put(
            _templates_url(context, tpl["id"]),
            json={"visibility": "shared"},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 200
        assert resp.json()["visibility"] == "shared"

    def test_read_sharer_cannot_promote_own_private_to_shared(self, client, context):
        """Flipping private→shared is creating a shared template — needs write.

        (Creator-only visibility rule passes, but the shared mutate gate must
        still hold: a read-sharer's template that becomes shared would otherwise
        bypass the create gate.)
        """
        tpl = _create(client, context, READER, "private").json()
        resp = client.put(
            _templates_url(context, tpl["id"]),
            json={"visibility": "shared"},
            headers=_headers(READER),
        )
        assert resp.status_code == 403


class TestDelete:
    def test_write_sharer_deletes_others_shared_template(self, client, context):
        tpl = _create(client, context, OWNER, "shared").json()
        resp = client.delete(
            _templates_url(context, tpl["id"]), headers=_headers(WRITER)
        )
        assert resp.status_code == 200

    def test_read_sharer_cannot_delete_shared(self, client, context):
        tpl = _create(client, context, OWNER, "shared").json()
        resp = client.delete(
            _templates_url(context, tpl["id"]), headers=_headers(READER)
        )
        assert resp.status_code == 403

    def test_creator_deletes_own_private(self, client, context):
        tpl = _create(client, context, READER, "private").json()
        resp = client.delete(
            _templates_url(context, tpl["id"]), headers=_headers(READER)
        )
        assert resp.status_code == 200

    def test_others_private_template_delete_is_404(self, client, context):
        tpl = _create(client, context, READER, "private").json()
        resp = client.delete(
            _templates_url(context, tpl["id"]), headers=_headers(OWNER)
        )
        assert resp.status_code == 404


class TestMigration:
    @staticmethod
    def _load_migration():
        import importlib.util
        from pathlib import Path

        import graphlagoon

        path = (
            Path(graphlagoon.__file__).parent
            / "alembic"
            / "versions"
            / "008_add_template_visibility.py"
        )
        spec = importlib.util.spec_from_file_location("migration_008", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_008_chains_onto_the_current_head(self):
        module = self._load_migration()
        assert module.revision == "008"
        assert module.down_revision == "007"

    def test_008_targets_the_right_table_and_column(self):
        import inspect

        source = inspect.getsource(self._load_migration().upgrade)
        assert "query_templates" in source
        assert "visibility" in source

    def test_db_model_has_the_column(self):
        from graphlagoon.db.models import QueryTemplate

        assert "visibility" in QueryTemplate.__table__.columns
