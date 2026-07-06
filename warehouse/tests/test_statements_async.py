"""Tests for the async, cancellable INLINE flow of the local warehouse.

The Query Console submits INLINE statements with wait_timeout=0s and then polls
GET /statements/{id} and may POST /statements/{id}/cancel. These tests exercise
that flow (submit → RUNNING → poll → SUCCEEDED, plus cancellation) using a fake
Spark session, and the sleep(n) directive that lets a dev query dwell in RUNNING
long enough to see the Cancel button / elapsed timer. EXTERNAL_LINKS (graph
queries) must stay synchronous.
"""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest  # noqa: E402
from src.routers import statements as s  # noqa: E402


@pytest.fixture(autouse=True)
def _enable_async_inline():
    """The async, cancellable INLINE flow is opt-in (default off). Enable it for
    these tests by mutating the cached settings; restore afterwards."""
    settings = s.get_settings()
    prev = settings.async_inline_execution
    settings.async_inline_execution = True
    yield
    settings.async_inline_execution = prev


# ── Fake Spark (no real session needed) ──────────────────────────────


class _Field:
    def __init__(self, name):
        self.name = name
        self.dataType = "int"


class _Schema:
    fields = [_Field("c")]


class _Row:
    def __init__(self, d):
        self._d = d

    def __getitem__(self, k):
        return self._d[k]


class _DF:
    columns = ["c"]
    schema = _Schema()

    def collect(self):
        return [_Row({"c": 8})]


class FakeSpark:
    def sql(self, q):
        return _DF()


def _req(statement, wait="0s", disposition="INLINE"):
    return s.StatementExecutionRequest(
        statement=statement,
        warehouse_id="w",
        wait_timeout=wait,
        disposition=disposition,
        format="JSON_ARRAY",
    )


_RUNNING = (s.StatementState.PENDING, s.StatementState.RUNNING)


# ── sleep(n) directive helpers ───────────────────────────────────────


def test_extract_sleep_seconds():
    assert s._extract_sleep_seconds("SELECT sleep(8)") == 8.0
    assert s._extract_sleep_seconds("SELECT SLEEP( 2.5 )") == 2.5
    assert s._extract_sleep_seconds("SELECT sleep(3), sleep(5)") == 5.0
    assert s._extract_sleep_seconds("SELECT 1") == 0.0


def test_strip_sleep_rewrites_to_literal():
    assert s._strip_sleep("SELECT sleep(8)") == "SELECT 8"
    assert s._strip_sleep("SELECT sleep(4) AS t, * FROM n") == "SELECT 4 AS t, * FROM n"
    assert s._strip_sleep("SELECT 1") == "SELECT 1"


# ── async INLINE flow ────────────────────────────────────────────────


def test_submit_running_then_poll_succeeded():
    async def go():
        resp = await s.execute_statement(_req("SELECT sleep(1)"), FakeSpark())
        assert resp.status.state in _RUNNING
        sid = resp.statement_id

        st = await s.get_statement_status(sid)
        assert st.status.state in _RUNNING

        await asyncio.sleep(1.6)
        st = await s.get_statement_status(sid)
        assert st.status.state == s.StatementState.SUCCEEDED
        assert st.result.data_array == [["8"]]

    asyncio.run(go())


def test_cancel_while_running_transitions_to_canceled():
    async def go():
        resp = await s.execute_statement(_req("SELECT sleep(10)"), FakeSpark())
        sid = resp.statement_id
        assert resp.status.state in _RUNNING

        await asyncio.sleep(0.3)
        await s.cancel_statement(sid)

        st = await s.get_statement_status(sid)
        assert st.status.state == s.StatementState.CANCELED

        # The background task must not resurrect the statement after cancel.
        await asyncio.sleep(0.5)
        st = await s.get_statement_status(sid)
        assert st.status.state == s.StatementState.CANCELED

    asyncio.run(go())


def test_fast_query_without_sleep_succeeds():
    async def go():
        resp = await s.execute_statement(_req("SELECT 1"), FakeSpark())
        await asyncio.sleep(0.2)
        st = await s.get_statement_status(resp.statement_id)
        assert st.status.state == s.StatementState.SUCCEEDED

    asyncio.run(go())


def test_cancel_unknown_statement_is_noop():
    async def go():
        # Must not raise for an unknown id (idempotent, best-effort).
        result = await s.cancel_statement("does-not-exist")
        assert result == {}

    asyncio.run(go())


def test_external_links_stays_synchronous():
    async def go():
        resp = await s.execute_statement(
            _req("SELECT 1", disposition="EXTERNAL_LINKS"), FakeSpark()
        )
        # Returns terminal state on the first call — no polling needed.
        assert resp.status.state == s.StatementState.SUCCEEDED

    asyncio.run(go())


def test_inline_is_synchronous_and_stateless_when_flag_off():
    """Default behaviour: INLINE runs synchronously (SUCCEEDED on the first
    call) and leaves NO entry in the in-memory statement map — so large/frequent
    results can't leak memory. Overrides the autouse fixture for this test."""
    settings = s.get_settings()
    settings.async_inline_execution = False
    try:
        before = len(s._statements)

        async def go():
            resp = await s.execute_statement(_req("SELECT 1"), FakeSpark())
            assert resp.status.state == s.StatementState.SUCCEEDED
            assert resp.result.data_array == [["8"]]

        asyncio.run(go())
        # No per-statement server state was retained.
        assert len(s._statements) == before
    finally:
        settings.async_inline_execution = True


def test_reaper_caps_retained_statements():
    """Even with the async flag on, terminal statements beyond the cap are
    reaped so the map cannot grow without bound."""
    s._statements.clear()
    terminal = s.StatementState.SUCCEEDED
    for i in range(s._MAX_RETAINED_STATEMENTS + 20):
        s._statements[f"stmt-{i}"] = {"state": terminal, "response": None}
    s._reap_finished_statements()
    assert len(s._statements) <= s._MAX_RETAINED_STATEMENTS
    s._statements.clear()
