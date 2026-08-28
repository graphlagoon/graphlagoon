"""Tests for writer-authored custom metrics (GraphContext.metric_definitions).

The backend stores and shape-validates definitions; it never executes them.
The one rule that matters for safety lives in context_to_response: only users
with write access receive the definitions — a read-only user always gets [].
"""

import sys
from uuid import uuid4

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

from pydantic import ValidationError  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.models.schemas import (  # noqa: E402
    GraphContextCreate,
    GraphContextUpdate,
    MetricDefinition,
)

SUPERUSER = "admin@example.com"
OWNER = "owner@example.com"
WRITER = "writer@example.com"
READER = "reader@example.com"
STRANGER = "stranger@example.com"

A_METRIC = {
    "id": "m-1",
    "name": "Email domain",
    "target": "node",
    "value_type": "string",
    "code": "const m=/@([^@\\s]+)$/.exec(String(item.properties.email??''));"
    " return m?m[1].toLowerCase():null;",
    "description": "Domain part of the e-mail",
    "auto_run": False,
    "show_in_table": False,
}

ANOTHER_METRIC = {
    "id": "m-2",
    "name": "Neighbour mean degree",
    "target": "node",
    "value_type": "number",
    "code": "const ns=ctx.neighbors(item.id);"
    " return ns.length?ns.reduce((s,n)=>s+ctx.degreeOf(n),0)/ns.length:0;",
    "auto_run": False,
    "show_in_table": False,
}


def _headers(email):
    return {"X-Forwarded-Email": email}


class TestSchemas:
    def test_create_defaults_to_empty_list(self):
        data = GraphContextCreate(title="t", edge_table_name="e", node_table_name="n")
        assert data.metric_definitions == []

    def test_create_accepts_definitions(self):
        data = GraphContextCreate(
            title="t",
            edge_table_name="e",
            node_table_name="n",
            metric_definitions=[A_METRIC],
        )
        assert [m.model_dump() for m in data.metric_definitions] == [A_METRIC]

    def test_value_type_defaults_to_number(self):
        d = MetricDefinition(id="x", name="n", target="node", code="return 1;")
        assert d.value_type == "number"
        assert d.description is None

    def test_name_is_stripped(self):
        d = MetricDefinition(id="x", name="  Spaced  ", target="node", code="return 1;")
        assert d.name == "Spaced"

    @pytest.mark.parametrize(
        "overrides",
        [
            {"name": ""},
            {"name": "   "},
            {"name": "x" * 81},
            {"code": ""},
            {"code": "x" * 20_001},
            {"target": "graph"},
            {"value_type": "date"},
            {"id": ""},
            {"id": "has space"},
            {"id": "semi;colon"},
            {"id": "x" * 65},
            {"description": "d" * 501},
        ],
    )
    def test_rejects_out_of_shape_definitions(self, overrides):
        with pytest.raises(ValidationError):
            MetricDefinition(**{**A_METRIC, **overrides})

    def test_rejects_unknown_keys_silently_dropped_or_kept_consistently(self):
        """The model is typed (not opaque): unknown keys never reach storage."""
        d = MetricDefinition(**{**A_METRIC, "someFutureField": True})
        assert "someFutureField" not in d.model_dump()

    def test_update_defaults_to_none(self):
        """None means 'not provided' — the router skips it, leaving the column alone."""
        assert GraphContextUpdate().metric_definitions is None

    def test_update_accepts_empty_list(self):
        """[] is a real value (delete-all), distinct from None (not provided)."""
        assert GraphContextUpdate(metric_definitions=[]).metric_definitions == []

    def test_update_rejects_duplicate_ids(self):
        with pytest.raises(ValidationError, match="duplicate metric definition id"):
            GraphContextUpdate(
                metric_definitions=[A_METRIC, {**ANOTHER_METRIC, "id": "m-1"}]
            )

    def test_update_rejects_duplicate_names_case_insensitively(self):
        with pytest.raises(ValidationError, match="duplicate metric definition name"):
            GraphContextUpdate(
                metric_definitions=[
                    A_METRIC,
                    {**ANOTHER_METRIC, "name": "EMAIL DOMAIN"},
                ]
            )

    def test_create_rejects_duplicate_ids(self):
        with pytest.raises(ValidationError):
            GraphContextCreate(
                title="t",
                edge_table_name="e",
                node_table_name="n",
                metric_definitions=[A_METRIC, {**ANOTHER_METRIC, "id": "m-1"}],
            )


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
        assert self._create().metric_definitions == []

    def test_create_stores_definitions_and_round_trips(self):
        context = self._create(metric_definitions=[A_METRIC])
        assert self.store.get_graph_context(context.id).metric_definitions == [A_METRIC]

    def test_update_replaces_definitions(self):
        context = self._create(metric_definitions=[A_METRIC])
        self.store.update_graph_context(context.id, metric_definitions=[ANOTHER_METRIC])
        assert self.store.get_graph_context(context.id).metric_definitions == [
            ANOTHER_METRIC
        ]

    def test_contexts_do_not_share_a_default_list(self):
        a = self._create()
        b = self._create()
        a.metric_definitions.append(A_METRIC)
        assert b.metric_definitions == []

    def test_update_of_another_field_leaves_definitions_intact(self):
        context = self._create(metric_definitions=[A_METRIC])
        self.store.update_graph_context(context.id, title="renamed")
        fetched = self.store.get_graph_context(context.id)
        assert fetched.title == "renamed"
        assert fetched.metric_definitions == [A_METRIC]


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
            / "013_add_context_metric_definitions.py"
        )
        spec = importlib.util.spec_from_file_location("migration_013", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_013_chains_onto_012(self):
        module = self._load_migration()
        assert module.revision == "013"
        assert module.down_revision == "012"

    def test_013_targets_the_right_table_and_column(self):
        import inspect

        source = inspect.getsource(self._load_migration().upgrade)
        assert "graph_contexts" in source
        assert "metric_definitions" in source

    def test_db_model_has_the_column(self):
        from graphlagoon.db.models import GraphContext

        assert "metric_definitions" in GraphContext.__table__.columns


# ---------------------------------------------------------------------------
# Visibility through the HTTP API (memory mode)
# ---------------------------------------------------------------------------


@pytest.fixture
def superuser_env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", SUPERUSER)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from graphlagoon.routers import graph_contexts

    app = FastAPI()
    app.include_router(graph_contexts.router)
    yield TestClient(app)


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def context(store):
    """Owned by OWNER, one read share (READER), one write share (WRITER)."""
    ctx = store.create_graph_context(
        title="ctx",
        edge_table_name="e",
        node_table_name="n",
        owner_email=OWNER,
        metric_definitions=[A_METRIC],
    )
    store.share_graph_context(ctx.id, READER, "read")
    store.share_graph_context(ctx.id, WRITER, "write")
    return ctx


def _get(client, context, email):
    resp = client.get(f"/api/graph-contexts/{context.id}", headers=_headers(email))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _list_one(client, context, email):
    resp = client.get("/api/graph-contexts", headers=_headers(email))
    assert resp.status_code == 200, resp.text
    items = [i for i in resp.json() if i["id"] == str(context.id)]
    assert len(items) == 1
    return items[0]


class TestVisibility:
    def test_owner_sees_definitions_on_get_and_list(self, client, context):
        assert _get(client, context, OWNER)["metric_definitions"] == [A_METRIC]
        assert _list_one(client, context, OWNER)["metric_definitions"] == [A_METRIC]

    def test_write_share_sees_definitions(self, client, context):
        body = _get(client, context, WRITER)
        assert body["has_write_access"] is True
        assert body["metric_definitions"] == [A_METRIC]
        assert _list_one(client, context, WRITER)["metric_definitions"] == [A_METRIC]

    def test_read_share_gets_empty_list_on_get_and_list(self, client, context):
        """The safety rule: readers never receive another user's code."""
        body = _get(client, context, READER)
        assert body["has_write_access"] is False
        assert body["metric_definitions"] == []
        assert _list_one(client, context, READER)["metric_definitions"] == []

    def test_public_share_is_read_only_and_hides_definitions(
        self, client, store, context
    ):
        store.share_graph_context(context.id, "*", "write")
        body = _get(client, context, STRANGER)
        assert body["has_write_access"] is False
        assert body["metric_definitions"] == []

    def test_superuser_sees_definitions(self, client, context, superuser_env):
        assert _get(client, context, SUPERUSER)["metric_definitions"] == [A_METRIC]


class TestWrites:
    def test_reader_cannot_write_definitions(self, client, context):
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"metric_definitions": [ANOTHER_METRIC]},
            headers=_headers(READER),
        )
        assert resp.status_code == 403
        assert _get(client, context, OWNER)["metric_definitions"] == [A_METRIC]

    def test_write_share_can_replace_definitions(self, client, context):
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"metric_definitions": [A_METRIC, ANOTHER_METRIC]},
            headers=_headers(WRITER),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["metric_definitions"] == [
            A_METRIC,
            {**ANOTHER_METRIC, "description": None},
        ]

    def test_owner_clears_with_empty_list(self, client, context):
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"metric_definitions": []},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 200
        assert resp.json()["metric_definitions"] == []

    def test_invalid_definition_is_422(self, client, context):
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"metric_definitions": [{**A_METRIC, "target": "graph"}]},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 422

    def test_update_of_title_only_leaves_definitions_intact(self, client, context):
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"title": "renamed"},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 200
        assert resp.json()["title"] == "renamed"
        assert resp.json()["metric_definitions"] == [A_METRIC]

    def test_create_with_definitions(self, client):
        resp = client.post(
            "/api/graph-contexts",
            json={
                "title": "new",
                "edge_table_name": "cat.db.edges",
                "node_table_name": "cat.db.nodes",
                "metric_definitions": [A_METRIC],
            },
            headers=_headers(OWNER),
        )
        assert resp.status_code in (200, 201), resp.text
        assert resp.json()["metric_definitions"] == [A_METRIC]

    def test_unknown_context_is_404(self, client):
        resp = client.get(f"/api/graph-contexts/{uuid4()}", headers=_headers(OWNER))
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# auto_run field and the two feature flags
# ---------------------------------------------------------------------------


@pytest.fixture
def custom_metrics_disabled(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_CUSTOM_METRICS_ENABLED", "false")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def auto_run_disabled(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_CUSTOM_METRICS_AUTO_RUN_ENABLED", "false")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class TestAutoRun:
    def test_defaults_to_false(self):
        d = MetricDefinition(id="x", name="n", target="node", code="return 1;")
        assert d.auto_run is False
        assert d.model_dump()["auto_run"] is False

    def test_round_trips_true(self, client, context):
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"metric_definitions": [{**A_METRIC, "auto_run": True}]},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["metric_definitions"][0]["auto_run"] is True

    def test_rejects_non_boolean(self):
        with pytest.raises(ValidationError):
            MetricDefinition(**{**A_METRIC, "auto_run": "yes"})

    def test_show_in_table_defaults_false_and_round_trips(self, client, context):
        assert MetricDefinition(**A_METRIC).show_in_table is False
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"metric_definitions": [{**A_METRIC, "show_in_table": True}]},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["metric_definitions"][0]["show_in_table"] is True
        with pytest.raises(ValidationError):
            MetricDefinition(**{**A_METRIC, "show_in_table": 1})


class TestFeatureFlags:
    def test_flags_default_on_and_are_exposed_in_config(self):
        get_settings.cache_clear()
        try:
            s = get_settings()
            assert s.custom_metrics_enabled is True
            assert s.custom_metrics_auto_run_enabled is True
        finally:
            get_settings.cache_clear()

    def test_config_endpoint_exposes_both_flags(self, auto_run_disabled):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from graphlagoon.routers import config as config_router

        app = FastAPI()
        app.include_router(config_router.router)
        resp = TestClient(app).get("/api/config", headers=_headers(OWNER))
        assert resp.status_code == 200
        body = resp.json()
        assert body["custom_metrics_enabled"] is True
        assert body["custom_metrics_auto_run_enabled"] is False

    def test_disabled_hides_definitions_even_from_writers(
        self, client, context, custom_metrics_disabled
    ):
        assert _get(client, context, OWNER)["metric_definitions"] == []
        assert _list_one(client, context, OWNER)["metric_definitions"] == []

    def test_disabled_rejects_writes_but_allows_empty_list(
        self, client, context, custom_metrics_disabled
    ):
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"metric_definitions": [ANOTHER_METRIC]},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "CUSTOM_METRICS_DISABLED"
        # The stored definitions are untouched (visible again once re-enabled)
        get_settings.cache_clear()
        import os

        os.environ.pop("GRAPH_LAGOON_CUSTOM_METRICS_ENABLED", None)
        assert _get(client, context, OWNER)["metric_definitions"] == [A_METRIC]

        # A full-object PUT carrying [] must not break while disabled
        os.environ["GRAPH_LAGOON_CUSTOM_METRICS_ENABLED"] = "false"
        get_settings.cache_clear()
        resp = client.put(
            f"/api/graph-contexts/{context.id}",
            json={"title": "renamed", "metric_definitions": []},
            headers=_headers(OWNER),
        )
        assert resp.status_code == 200

    def test_disabled_rejects_create_with_definitions(
        self, client, custom_metrics_disabled
    ):
        resp = client.post(
            "/api/graph-contexts",
            json={
                "title": "new",
                "edge_table_name": "cat.db.edges",
                "node_table_name": "cat.db.nodes",
                "metric_definitions": [A_METRIC],
            },
            headers=_headers(OWNER),
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"]["code"] == "CUSTOM_METRICS_DISABLED"
