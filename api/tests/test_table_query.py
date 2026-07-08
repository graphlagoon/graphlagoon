"""Tests for the generic tabular-query path (Query Console backend).

Covers execute_tabular_query, which runs a read-only SQL statement and returns
raw (columns, rows, truncated) — the primitive behind
POST /graph-contexts/{id}/query/table.
"""

import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# Only stub when the real package is genuinely unavailable — stubbing it while
# it IS installed poisons the import for test_transpile_options.
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

from graphlagoon.models.schemas import (  # noqa: E402
    StatementResponse,
    StatementStatus,
    StatementError,
    StatementResultData,
    StatementResultManifest,
    StatementResultSchema,
    StatementColumnInfo,
)
from graphlagoon.services.graph_operations import (  # noqa: E402
    QueryExecutionError,
    execute_tabular_query,
    parse_tabular_result,
)


# ── Helpers ──────────────────────────────────────────────────────────


def _make_manifest(columns: list[str]) -> StatementResultManifest:
    return StatementResultManifest(
        format="JSON_ARRAY",
        schema=StatementResultSchema(
            column_count=len(columns),
            columns=[
                StatementColumnInfo(
                    name=col, position=i, type_name="STRING", type_text="STRING"
                )
                for i, col in enumerate(columns)
            ],
        ),
        total_row_count=len(columns),
    )


def _make_succeeded_response(columns: list[str], rows: list[list]) -> StatementResponse:
    return StatementResponse(
        statement_id="stmt-1",
        status=StatementStatus(state="SUCCEEDED"),
        manifest=_make_manifest(columns),
        result=StatementResultData(row_count=len(rows), data_array=rows),
    )


def _make_failed_response(message: str) -> StatementResponse:
    return StatementResponse(
        statement_id="stmt-fail",
        status=StatementStatus(
            state="FAILED",
            error=StatementError(error_code="ERR", message=message),
        ),
    )


def _client_returning(response: StatementResponse) -> MagicMock:
    client = MagicMock()
    client.execute_statement = AsyncMock(return_value=response)
    return client


# ── execute_tabular_query ────────────────────────────────────────────


class TestExecuteTabularQuery:
    @pytest.mark.asyncio
    async def test_returns_columns_and_rows(self):
        client = _client_returning(
            _make_succeeded_response(
                ["name", "age"], [["Alice", "30"], ["Bob", "25"]]
            )
        )

        columns, rows, truncated = await execute_tabular_query(
            warehouse_client=client,
            query="SELECT name, age FROM cat.schema.nodes",
            row_limit=1000,
        )

        assert columns == ["name", "age"]
        assert rows == [["Alice", "30"], ["Bob", "25"]]
        assert truncated is False

    @pytest.mark.asyncio
    async def test_passes_row_limit_to_warehouse(self):
        client = _client_returning(_make_succeeded_response(["c"], [["1"]]))

        await execute_tabular_query(
            warehouse_client=client, query="SELECT 1 AS c", row_limit=500
        )

        client.execute_statement.assert_awaited_once()
        _, kwargs = client.execute_statement.call_args
        assert kwargs["row_limit"] == 500

    @pytest.mark.asyncio
    async def test_truncated_when_rows_hit_limit(self):
        client = _client_returning(
            _make_succeeded_response(["c"], [["1"], ["2"]])
        )

        _, _, truncated = await execute_tabular_query(
            warehouse_client=client, query="SELECT c FROM t", row_limit=2
        )

        assert truncated is True

    @pytest.mark.asyncio
    async def test_raises_query_execution_error_on_failure(self):
        client = _client_returning(_make_failed_response("Table not found: nope"))

        with pytest.raises(QueryExecutionError) as exc_info:
            await execute_tabular_query(
                warehouse_client=client, query="SELECT * FROM nope", row_limit=100
            )

        assert "Table not found: nope" in exc_info.value.message
        assert exc_info.value.query == "SELECT * FROM nope"

    @pytest.mark.asyncio
    async def test_empty_result_is_not_truncated(self):
        client = _client_returning(_make_succeeded_response(["c"], []))

        columns, rows, truncated = await execute_tabular_query(
            warehouse_client=client, query="SELECT c FROM t WHERE 1=0", row_limit=100
        )

        assert columns == ["c"]
        assert rows == []
        assert truncated is False


# ── parse_tabular_result (shared by submit/poll paths) ───────────────


class TestParseTabularResult:
    def test_parses_succeeded_response(self):
        resp = _make_succeeded_response(["c"], [["1"], ["2"]])
        columns, rows, truncated = parse_tabular_result(
            resp, query="SELECT c FROM t", row_limit=1000
        )
        assert columns == ["c"]
        assert rows == [["1"], ["2"]]
        assert truncated is False

    def test_truncated_when_rows_hit_limit(self):
        resp = _make_succeeded_response(["c"], [["1"], ["2"]])
        _, _, truncated = parse_tabular_result(resp, row_limit=2)
        assert truncated is True

    def test_raises_on_failed_state(self):
        resp = _make_failed_response("boom")
        with pytest.raises(QueryExecutionError) as exc:
            parse_tabular_result(resp, query="SELECT 1", row_limit=100)
        assert "boom" in exc.value.message


# ── Warehouse submit / cancel (cancellable flow primitives) ──────────


class TestWarehouseCancellableFlow:
    def _client(self):
        from graphlagoon.services.warehouse import WarehouseClient

        client = WarehouseClient.__new__(WarehouseClient)
        client.warehouse_id = "wh-1"
        client.default_catalog = "cat"
        client.default_schema = "sch"
        client.submit_wait_timeout = 5
        return client

    @pytest.mark.asyncio
    async def test_submit_statement_uses_short_wait_and_continue(self):
        client = self._client()
        succeeded = _make_succeeded_response(["c"], [["1"]])
        client._post = AsyncMock(return_value=succeeded.model_dump())

        resp = await client.submit_statement(
            statement="SELECT c FROM t", row_limit=100
        )

        assert resp.status.state == "SUCCEEDED"
        _, kwargs = client._post.call_args
        body = kwargs["json"]
        assert body["wait_timeout"] == "5s"
        assert body["on_wait_timeout"] == "CONTINUE"
        assert body["row_limit"] == 100

    @pytest.mark.asyncio
    async def test_submit_statement_returns_running(self):
        client = self._client()
        running = StatementResponse(
            statement_id="stmt-run",
            status=StatementStatus(state="RUNNING"),
        )
        client._post = AsyncMock(return_value=running.model_dump())

        resp = await client.submit_statement(statement="SELECT 1")
        assert resp.status.state == "RUNNING"
        assert resp.statement_id == "stmt-run"

    @pytest.mark.asyncio
    async def test_cancel_statement_hits_cancel_endpoint(self):
        client = self._client()
        client._post = AsyncMock(return_value={})

        await client.cancel_statement("stmt-x")

        called_url = client._post.call_args[0][0]
        assert called_url.endswith("/statements/stmt-x/cancel")

    @pytest.mark.asyncio
    async def test_cancel_statement_swallows_errors(self):
        client = self._client()
        client._post = AsyncMock(side_effect=RuntimeError("already done"))
        # Must not raise — cancellation is best-effort.
        await client.cancel_statement("stmt-y")
