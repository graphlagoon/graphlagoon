"""Audit service (memory mode) + behavioural check that audited handlers log."""

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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore, USAGE_LOG_MAX_ENTRIES  # noqa: E402
from graphlagoon.routers import explorations, graph_contexts  # noqa: E402
from graphlagoon.services import audit  # noqa: E402
from graphlagoon.services.audit import AuditAction, MAX_METADATA_BYTES  # noqa: E402

OWNER = "owner@example.com"
OTHER = "other@example.com"


def _headers(email):
    return {"X-Forwarded-Email": email}


@pytest.fixture
def store():
    InMemoryStore.reset()
    yield InMemoryStore.get_instance()
    InMemoryStore.reset()


@pytest.fixture
def client(store, monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    get_settings.cache_clear()
    app = FastAPI()
    app.include_router(graph_contexts.router)
    app.include_router(explorations.router)
    yield TestClient(app)
    get_settings.cache_clear()


class TestService:
    @pytest.mark.asyncio
    async def test_record_and_list_newest_first(self, store):
        await audit.record(OWNER, AuditAction.CONTEXT_DELETE, metadata={"a": 1})
        await audit.record(OTHER, AuditAction.CONTEXT_SHARE)
        page = await audit.list_entries()
        assert [e["action"] for e in page["items"]] == [
            "context.share",
            "context.delete",
        ]
        assert page["total"] == 2
        assert page["items"][1]["metadata"] == {"a": 1}
        assert page["items"][0]["created_at"]

    @pytest.mark.asyncio
    async def test_filters_and_pagination(self, store):
        for i in range(7):
            await audit.record(
                OWNER if i % 2 else OTHER, AuditAction.CONTEXT_DELETE, metadata={"i": i}
            )
        page = await audit.list_entries(user_email=OWNER, page=1, page_size=2)
        assert page["total"] == 3
        assert [e["metadata"]["i"] for e in page["items"]] == [5, 3]
        page2 = await audit.list_entries(user_email=OWNER, page=2, page_size=2)
        assert [e["metadata"]["i"] for e in page2["items"]] == [1]
        assert (await audit.list_entries(action="nope"))["total"] == 0

    @pytest.mark.asyncio
    async def test_page_size_is_capped(self, store):
        page = await audit.list_entries(page_size=10_000)
        assert page["page_size"] == audit.MAX_PAGE_SIZE

    @pytest.mark.asyncio
    async def test_metadata_is_bounded(self, store):
        await audit.record(
            OWNER, AuditAction.CONTEXT_DELETE, metadata={"blob": "x" * 100_000}
        )
        meta = store.usage_logs[-1].log_metadata
        assert meta["_truncated"] is True
        assert len(meta["_preview"]) < MAX_METADATA_BYTES

    @pytest.mark.asyncio
    async def test_unserialisable_metadata_does_not_raise(self, store):
        await audit.record(OWNER, AuditAction.CONTEXT_DELETE, metadata={"o": object()})
        assert store.usage_logs[-1].log_metadata is not None

    def test_store_is_bounded(self, store):
        for i in range(USAGE_LOG_MAX_ENTRIES + 10):
            store.record_usage(OWNER, "x")
        assert len(store.usage_logs) == USAGE_LOG_MAX_ENTRIES


class TestHandlersLog:
    """Every AUDITED_ROUTE reachable in memory mode leaves an entry."""

    def test_context_share_unshare_delete(self, client, store):
        ctx = store.create_graph_context("t", "e", "n", OWNER)
        assert (
            client.post(
                f"/api/graph-contexts/{ctx.id}/share",
                json={"email": OTHER, "permission": "write"},
                headers=_headers(OWNER),
            ).status_code
            == 200
        )
        assert (
            client.delete(
                f"/api/graph-contexts/{ctx.id}/share/{OTHER}", headers=_headers(OWNER)
            ).status_code
            == 200
        )
        assert (
            client.delete(
                f"/api/graph-contexts/{ctx.id}", headers=_headers(OWNER)
            ).status_code
            == 200
        )
        assert [e.action for e in store.usage_logs] == [
            "context.share",
            "context.unshare",
            "context.delete",
        ]
        assert all(e.user_email == OWNER for e in store.usage_logs)
        assert all(e.resource_id == ctx.id for e in store.usage_logs)

    def test_exploration_share_unshare_delete(self, client, store):
        ctx = store.create_graph_context("t", "e", "n", OWNER)
        exp = store.create_exploration(ctx.id, "x", OWNER, {})
        client.post(
            f"/api/explorations/{exp.id}/share",
            json={"email": OTHER, "permission": "read"},
            headers=_headers(OWNER),
        )
        client.delete(
            f"/api/explorations/{exp.id}/share/{OTHER}", headers=_headers(OWNER)
        )
        client.delete(f"/api/explorations/{exp.id}", headers=_headers(OWNER))
        assert [e.action for e in store.usage_logs] == [
            "exploration.share",
            "exploration.unshare",
            "exploration.delete",
        ]

    def test_denied_actions_leave_no_trace(self, client, store):
        ctx = store.create_graph_context("t", "e", "n", OWNER)
        assert (
            client.delete(
                f"/api/graph-contexts/{ctx.id}", headers=_headers(OTHER)
            ).status_code
            == 403
        )
        assert list(store.usage_logs) == []
