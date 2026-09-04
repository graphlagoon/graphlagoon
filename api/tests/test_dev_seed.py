"""The dev seed generator, run in-process against a TestClient (memory mode)."""

import sys

import pytest

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

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.dev import seed as seed_module  # noqa: E402
from graphlagoon.dev.seed import ADMIN_EMAIL, SeedError, make_users, run_seed  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.routers import (  # noqa: E402
    admin,
    admin_groups,
    config,
    explorations,
    graph_contexts,
    query_templates,
)

PARAMS = dict(users=8, contexts=12, explorations=20, graphs=2, seed=1, no_graphs=True)


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SUPERUSER_EMAILS", ADMIN_EMAIL)
    monkeypatch.setenv("GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS", "example.com")
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def warehouse_stub():
    """Stands in for the Spark warehouse: a set of live 3-part table names."""
    return {"tables": set(), "created": []}


@pytest.fixture
def app(env, store, warehouse_stub):
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    for module in (
        config,
        admin,
        admin_groups,
        graph_contexts,
        explorations,
        query_templates,
    ):
        app.include_router(module.router)

    # Minimal stand-ins for the two graph-router endpoints the seed calls when
    # it manages warehouse tables; the real ones need a running Spark.
    @app.get("/api/datasets")
    async def _datasets():
        names = sorted(warehouse_stub["tables"])
        return {
            "tables": names,
            "edge_tables": [n for n in names if "edges_" in n],
            "node_tables": [n for n in names if "nodes_" in n],
        }

    @app.post("/api/dev/random-graph")
    async def _random_graph(payload: dict):
        prefix = f"{payload['catalog']}.{payload['schema_name']}"
        edge = f"{prefix}.edges_{payload['table_name']}"
        node = f"{prefix}.nodes_{payload['table_name']}"
        warehouse_stub["tables"].update({edge, node})
        warehouse_stub["created"].append(payload["table_name"])
        return {"edge_table": edge, "node_table": node}

    return app


@pytest.fixture
def in_process(app, monkeypatch):
    """Route the seed's httpx client into the ASGI app instead of the network."""
    transport = httpx.ASGITransport(app=app)
    original = httpx.AsyncClient.__init__

    def patched(self, *args, **kwargs):
        kwargs["transport"] = transport
        original(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)
    return app


async def _run(**overrides):
    params = {**PARAMS, **overrides}
    return await run_seed("http://testserver", log=lambda *_: None, **params)


class TestRoster:
    def test_deterministic_and_profiled(self):
        import random

        a = make_users(30, random.Random(7))
        b = make_users(30, random.Random(7))
        assert [u.email for u in a] == [u.email for u in b]
        assert len({u.email for u in a}) == 30
        profiles = {u.profile for u in a}
        assert {"power", "normal", "inactive"} <= profiles
        assert all(u.email.endswith("@example.com") for u in a)


@pytest.mark.asyncio
class TestSeed:
    async def test_populates_everything(self, in_process, store):
        stats = await _run()
        assert not stats.skipped
        assert stats.contexts == 12
        assert stats.explorations == 20
        assert len(store.graph_contexts) == 12
        # ~5 % of explorations are deleted afterwards to feed the audit trail
        assert len(store.explorations) == 20 - stats.deletes
        # every generated user made at least one request → registered
        assert len(store.users) >= 9
        emails = {u for u in store.users}
        assert ADMIN_EMAIL in emails
        # at least one inactive user owns nothing (before transfers)
        owners = {c.owner_email for c in store.graph_contexts.values()}
        assert len(emails - owners - {ADMIN_EMAIL}) >= 1
        # shares are valid targets only
        for ctx in store.graph_contexts.values():
            for s in ctx.shares:
                assert s.shared_with_email in {"*", "*@example.com"} or "@" in s.shared_with_email
        actions = {e.action for e in store.usage_logs}
        assert "exploration.delete" in actions
        assert "context.share" in actions or "exploration.share" in actions
        assert stats.transfers >= 1 and "context.transfer" in actions
        assert stats.templates >= 1
        group_names = {g.name for g in store.groups.values()}
        assert {"analysts", "restricted-demo"} <= group_names
        assert "permission.update" in actions
        # The demo deny must never target a seed creator (rerun safety).
        creators = {c.owner_email for c in store.graph_contexts.values()}
        demo = next(
            g for g in store.groups.values() if g.name == "restricted-demo"
        )
        assert not creators & {m.value for m in demo.members}

    async def test_deterministic(self, in_process, store):
        await _run()
        first = sorted(c.title for c in store.graph_contexts.values())
        owners_first = sorted(c.owner_email for c in store.graph_contexts.values())
        InMemoryStore.get_instance().clear_all(keep_usage_logs=False)
        await _run()
        assert sorted(c.title for c in store.graph_contexts.values()) == first
        assert sorted(c.owner_email for c in store.graph_contexts.values()) == owners_first

    async def test_rerun_is_noop(self, in_process, store):
        await _run()
        n = len(store.graph_contexts)
        stats = await _run()
        assert stats.skipped is True
        assert len(store.graph_contexts) == n

    async def test_reset_clears_first(self, in_process, store):
        await _run()
        stats = await _run(reset=True)
        assert not stats.skipped
        assert len(store.graph_contexts) == 12
        assert "admin.clear_all" in {e.action for e in store.usage_logs}

    async def test_refuses_outside_dev_mode(self, in_process, monkeypatch):
        monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "false")
        get_settings.cache_clear()
        with pytest.raises(SeedError, match="dev mode"):
            await _run()


def test_cli_parser_defaults():
    args = seed_module.build_parser().parse_args([])
    assert (args.users, args.contexts, args.explorations, args.graphs, args.seed) == (
        30,
        60,
        200,
        5,
        42,
    )


@pytest.mark.asyncio
class TestWarehouseRepair:
    """PostgreSQL keeps contexts across restarts; the Spark warehouse does not."""

    async def test_rerun_rebuilds_tables_wiped_under_the_contexts(
        self, in_process, store, warehouse_stub
    ):
        await _run(no_graphs=False, graphs=2)
        assert sorted(warehouse_stub["created"]) == ["seed_0", "seed_1"]

        # The warehouse is wiped (make clean, a fresh container, a reset
        # metastore) while the contexts survive in the database.
        warehouse_stub["tables"].clear()
        warehouse_stub["created"].clear()

        stats = await _run(no_graphs=False, graphs=2)
        assert stats.skipped is True  # same parameters: nothing new is seeded
        assert stats.repaired == 2
        assert sorted(warehouse_stub["created"]) == ["seed_0", "seed_1"]
        for ctx in store.graph_contexts.values():
            assert ctx.edge_table_name in warehouse_stub["tables"]

    async def test_rerun_with_live_tables_touches_nothing(
        self, in_process, store, warehouse_stub
    ):
        await _run(no_graphs=False, graphs=2)
        warehouse_stub["created"].clear()

        stats = await _run(no_graphs=False, graphs=2)
        assert stats.skipped is True
        assert stats.repaired == 0
        assert warehouse_stub["created"] == []

    async def test_repairs_graphs_left_by_a_different_seed_run(
        self, in_process, store, warehouse_stub
    ):
        """A `dev-seed-big` env keeps contexts on seed_5..7; a default rerun
        must rebuild those too, not just the ones its own parameters cover."""
        await _run(no_graphs=False, graphs=6)
        warehouse_stub["tables"].clear()
        warehouse_stub["created"].clear()

        # Different parameters → a different tag → not skipped, but the older
        # contexts' tables are still missing and still get rebuilt.
        stats = await _run(no_graphs=False, graphs=2, contexts=4)
        assert not stats.skipped
        assert "seed_5" in warehouse_stub["created"]


def test_graph_payload_depends_only_on_the_index():
    from graphlagoon.dev.seed import graph_payload

    assert graph_payload(6) == graph_payload(6)
    assert graph_payload(6)["table_name"] == "seed_6"
    assert graph_payload(6, "spark_catalog", "graphs")["catalog"] == "spark_catalog"
    assert graph_payload(6)["model"] != graph_payload(7)["model"]
