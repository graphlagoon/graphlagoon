"""Tests for verbose error handling in graph query endpoints.

Verifies that ALL exceptions (not just QueryExecutionError) are caught
and returned as structured 400 responses with full traceback, exception type,
and query details — so the frontend can display useful debugging info.
"""

import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
if "gsql2rsql" not in sys.modules:
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
    ColumnConfig,
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
    execute_graph_query_with_nodes,
    _parse_statement_result,
)


# ── Helpers ──────────────────────────────────────────────────────────


def _make_column_config(**overrides) -> ColumnConfig:
    return ColumnConfig(**overrides)


def _make_manifest(columns: list[str]) -> StatementResultManifest:
    """Build a manifest with given column names."""
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
        total_row_count=1,
    )


def _make_succeeded_response(
    columns: list[str], rows: list[list], statement_id: str = "stmt-1"
) -> StatementResponse:
    """Build a SUCCEEDED StatementResponse with data."""
    return StatementResponse(
        statement_id=statement_id,
        status=StatementStatus(state="SUCCEEDED"),
        manifest=_make_manifest(columns),
        result=StatementResultData(
            row_count=len(rows),
            data_array=rows,
        ),
    )


def _make_failed_response(
    message: str = "Some DB error", error_code: str = "ERR_001"
) -> StatementResponse:
    return StatementResponse(
        statement_id="stmt-fail",
        status=StatementStatus(
            state="FAILED",
            error=StatementError(error_code=error_code, message=message),
        ),
    )


# ── _parse_statement_result ──────────────────────────────────────────


class TestParseStatementResult:
    def test_raises_query_execution_error_on_failed_state(self):
        result = _make_failed_response("Table not found: edges_xyz")
        with pytest.raises(QueryExecutionError) as exc_info:
            _parse_statement_result(result, query="SELECT * FROM edges_xyz")

        assert "Table not found: edges_xyz" in exc_info.value.message
        assert exc_info.value.query == "SELECT * FROM edges_xyz"

    def test_raises_unknown_error_when_no_error_object(self):
        result = StatementResponse(
            statement_id="stmt-x",
            status=StatementStatus(state="FAILED"),
        )
        with pytest.raises(QueryExecutionError, match="Unknown error"):
            _parse_statement_result(result)

    def test_returns_empty_when_no_manifest(self):
        result = StatementResponse(
            statement_id="stmt-ok",
            status=StatementStatus(state="SUCCEEDED"),
        )
        columns, rows = _parse_statement_result(result)
        assert columns == []
        assert rows == []

    def test_returns_columns_and_rows_on_success(self):
        result = _make_succeeded_response(["r"], [['{"src": "a", "dst": "b"}']])
        columns, rows = _parse_statement_result(result)
        assert columns == ["r"]
        assert len(rows) == 1


# ── execute_graph_query_with_nodes ───────────────────────────────────


class TestExecuteGraphQueryWithNodes:
    """Test that errors in each step are wrapped with context."""

    @pytest.mark.asyncio
    async def test_edge_query_fails_raises_query_execution_error(self):
        """When the edge query fails at Databricks level, raises QueryExecutionError."""
        client = MagicMock()
        client.execute_statement = AsyncMock(
            return_value=_make_failed_response("Permission denied on table")
        )

        with pytest.raises(QueryExecutionError) as exc_info:
            await execute_graph_query_with_nodes(
                warehouse_client=client,
                node_table="cat.schema.nodes",
                query="SELECT r FROM cat.schema.edges",
                limit=100,
                column_config=_make_column_config(),
            )

        assert "Permission denied on table" in exc_info.value.message

    @pytest.mark.asyncio
    async def test_edge_processing_error_includes_context(self):
        """When process_graph_query_result raises, error includes columns/rows info."""
        edge_response = _make_succeeded_response(
            columns=["r"],
            # Malformed: 'r' column data that will cause processing to fail
            rows=[["not-valid-json-{{{"]],
        )
        client = MagicMock()
        client.execute_statement = AsyncMock(return_value=edge_response)

        # process_graph_query_result won't fail on invalid strings (it skips them),
        # so we mock it to raise
        with patch(
            "graphlagoon.services.graph_operations.process_graph_query_result",
            side_effect=KeyError("missing_col"),
        ):
            with pytest.raises(RuntimeError) as exc_info:
                await execute_graph_query_with_nodes(
                    warehouse_client=client,
                    node_table="cat.schema.nodes",
                    query="SELECT r FROM cat.schema.edges",
                    limit=100,
                    column_config=_make_column_config(),
                )

            error_msg = str(exc_info.value)
            assert "Failed to process edge query result" in error_msg
            assert "columns=" in error_msg
            assert "row_count=" in error_msg

    @pytest.mark.asyncio
    async def test_node_query_http_error_includes_context(self):
        """When the node query HTTP call raises, error includes table/count."""
        import json

        edge_data = json.dumps(
            {"edge_id": "e1", "src": "n1", "dst": "n2", "relationship_type": "KNOWS"}
        )
        edge_response = _make_succeeded_response(columns=["r"], rows=[[edge_data]])

        call_count = 0

        async def mock_execute(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return edge_response
            # Node query fails with HTTP error
            raise RuntimeError("Connection refused to warehouse")

        client = MagicMock()
        client.execute_statement = AsyncMock(side_effect=mock_execute)

        with pytest.raises(RuntimeError) as exc_info:
            await execute_graph_query_with_nodes(
                warehouse_client=client,
                node_table="cat.schema.nodes",
                query="SELECT r FROM cat.schema.edges",
                limit=100,
                column_config=_make_column_config(),
            )

        error_msg = str(exc_info.value)
        assert "Node query execution failed" in error_msg
        assert "node_table=cat.schema.nodes" in error_msg
        assert "Connection refused" in error_msg

    @pytest.mark.asyncio
    async def test_node_query_fails_at_databricks_level(self):
        """When the node query returns FAILED state, raises QueryExecutionError."""
        import json

        edge_data = json.dumps(
            {"edge_id": "e1", "src": "n1", "dst": "n2", "relationship_type": "KNOWS"}
        )
        edge_response = _make_succeeded_response(columns=["r"], rows=[[edge_data]])
        node_fail = _make_failed_response("Column node_id not found in table")

        call_count = 0

        async def mock_execute(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return edge_response
            return node_fail

        client = MagicMock()
        client.execute_statement = AsyncMock(side_effect=mock_execute)

        with pytest.raises(QueryExecutionError) as exc_info:
            await execute_graph_query_with_nodes(
                warehouse_client=client,
                node_table="cat.schema.nodes",
                query="SELECT r FROM edges",
                limit=100,
                column_config=_make_column_config(),
            )

        assert "Column node_id not found" in exc_info.value.message

    @pytest.mark.asyncio
    async def test_node_processing_error_includes_context(self):
        """When process_nodes_result raises, error includes columns/rows info."""
        import json

        edge_data = json.dumps(
            {"edge_id": "e1", "src": "n1", "dst": "n2", "relationship_type": "KNOWS"}
        )
        edge_response = _make_succeeded_response(columns=["r"], rows=[[edge_data]])
        node_response = _make_succeeded_response(
            columns=["node_id", "node_type"],
            rows=[["n1", "Person"], ["n2", "Person"]],
        )

        call_count = 0

        async def mock_execute(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return edge_response
            return node_response

        client = MagicMock()
        client.execute_statement = AsyncMock(side_effect=mock_execute)

        with patch(
            "graphlagoon.services.graph_operations.process_nodes_result",
            side_effect=TypeError("unexpected None in row"),
        ):
            with pytest.raises(RuntimeError) as exc_info:
                await execute_graph_query_with_nodes(
                    warehouse_client=client,
                    node_table="cat.schema.nodes",
                    query="SELECT r FROM edges",
                    limit=100,
                    column_config=_make_column_config(),
                )

            error_msg = str(exc_info.value)
            assert "Failed to process node query result" in error_msg
            assert "columns=" in error_msg
            assert "unexpected None" in error_msg

    @pytest.mark.asyncio
    async def test_successful_execution(self):
        """Happy path: both queries succeed and return proper GraphResponse."""
        import json

        edge_data = json.dumps(
            {"edge_id": "e1", "src": "n1", "dst": "n2", "relationship_type": "KNOWS"}
        )
        edge_response = _make_succeeded_response(columns=["r"], rows=[[edge_data]])
        node_response = _make_succeeded_response(
            columns=["node_id", "node_type"],
            rows=[["n1", "Person"], ["n2", "Person"]],
        )

        call_count = 0

        async def mock_execute(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return edge_response
            return node_response

        client = MagicMock()
        client.execute_statement = AsyncMock(side_effect=mock_execute)

        result = await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.schema.nodes",
            query="SELECT r FROM edges",
            limit=100,
            column_config=_make_column_config(),
        )

        assert len(result.edges) == 1
        assert result.edges[0].edge_id == "e1"
        assert len(result.nodes) == 2


# ── Router-level error handling (integration-like) ───────────────────


class TestRouterErrorHandling:
    """Test that the router catches all exceptions and returns structured 400s.

    Uses patch on execute_graph_query_with_nodes to simulate different failures.
    Tests are on the endpoint function directly (no HTTP client needed).
    """

    @pytest.fixture
    def mock_context(self):
        """Create a mock graph context with proper attributes."""
        ctx = MagicMock()
        ctx.id = "ctx-123"
        ctx.edge_table_name = "cat.schema.edges"
        ctx.node_table_name = "cat.schema.nodes"
        ctx.column_config = None
        ctx.owner_email = "test@example.com"
        ctx.shared_emails = []
        ctx.shared_domains = []
        return ctx

    @pytest.fixture
    def mock_warehouse(self):
        return MagicMock()

    @pytest.mark.asyncio
    async def test_query_endpoint_catches_query_execution_error(
        self, mock_context, mock_warehouse
    ):
        """QueryExecutionError returns 400 with message and query."""
        from fastapi import HTTPException
        from graphlagoon.routers.graph import execute_graph_query

        request = MagicMock()
        request.state = MagicMock()
        request.state.user_email = "test@example.com"

        data = MagicMock()
        data.query = "SELECT * FROM edges"
        data.cte_prefilter = None
        data.use_external_links = False

        with (
            patch(
                "graphlagoon.routers.graph.get_current_user",
                return_value="test@example.com",
            ),
            patch(
                "graphlagoon.routers.graph.get_context_with_access",
                new_callable=AsyncMock,
                return_value=mock_context,
            ),
            patch(
                "graphlagoon.routers.graph.validate_sql_query",
                return_value=(True, ""),
            ),
            patch(
                "graphlagoon.routers.graph.merge_column_config",
                return_value={},
            ),
            patch(
                "graphlagoon.routers.graph.execute_graph_query_with_nodes",
                new_callable=AsyncMock,
                side_effect=QueryExecutionError(
                    "Table not found: edges_bad", query="SELECT * FROM edges_bad"
                ),
            ),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await execute_graph_query(
                    context_id=mock_context.id,
                    data=data,
                    request=request,
                    warehouse=mock_warehouse,
                )

            assert exc_info.value.status_code == 400
            error = exc_info.value.detail["error"]
            assert error["code"] == "QUERY_EXECUTION_ERROR"
            assert "Table not found" in error["message"]
            assert error["details"]["query"] == "SELECT * FROM edges_bad"

    @pytest.mark.asyncio
    async def test_query_endpoint_catches_generic_exception_with_traceback(
        self, mock_context, mock_warehouse
    ):
        """Non-QueryExecutionError returns 400 with traceback and exception_type."""
        from fastapi import HTTPException
        from graphlagoon.routers.graph import execute_graph_query

        request = MagicMock()
        request.state = MagicMock()
        request.state.user_email = "test@example.com"

        data = MagicMock()
        data.query = "SELECT * FROM edges"
        data.cte_prefilter = None
        data.use_external_links = False

        with (
            patch(
                "graphlagoon.routers.graph.get_current_user",
                return_value="test@example.com",
            ),
            patch(
                "graphlagoon.routers.graph.get_context_with_access",
                new_callable=AsyncMock,
                return_value=mock_context,
            ),
            patch(
                "graphlagoon.routers.graph.validate_sql_query",
                return_value=(True, ""),
            ),
            patch(
                "graphlagoon.routers.graph.merge_column_config",
                return_value={},
            ),
            patch(
                "graphlagoon.routers.graph.execute_graph_query_with_nodes",
                new_callable=AsyncMock,
                side_effect=RuntimeError(
                    "Failed to process edge query result (columns=['r'], "
                    "row_count=1, first_row=['bad']): KeyError('missing_col')"
                ),
            ),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await execute_graph_query(
                    context_id=mock_context.id,
                    data=data,
                    request=request,
                    warehouse=mock_warehouse,
                )

            assert exc_info.value.status_code == 400
            error = exc_info.value.detail["error"]
            assert error["code"] == "QUERY_EXECUTION_ERROR"
            assert "RuntimeError" in error["message"]
            assert "Failed to process edge query result" in error["message"]
            assert error["details"]["exception_type"] == "RuntimeError"
            assert "traceback" in error["details"]
            assert isinstance(error["details"]["traceback"], list)
            assert error["details"]["query"] == "SELECT * FROM edges"

    @pytest.mark.asyncio
    async def test_query_endpoint_catches_httpx_error_with_traceback(
        self, mock_context, mock_warehouse
    ):
        """httpx errors (warehouse HTTP failures) also get caught with traceback."""
        from fastapi import HTTPException
        from graphlagoon.routers.graph import execute_graph_query

        request = MagicMock()
        request.state = MagicMock()
        request.state.user_email = "test@example.com"

        data = MagicMock()
        data.query = "SELECT * FROM edges"
        data.cte_prefilter = None
        data.use_external_links = False

        with (
            patch(
                "graphlagoon.routers.graph.get_current_user",
                return_value="test@example.com",
            ),
            patch(
                "graphlagoon.routers.graph.get_context_with_access",
                new_callable=AsyncMock,
                return_value=mock_context,
            ),
            patch(
                "graphlagoon.routers.graph.validate_sql_query",
                return_value=(True, ""),
            ),
            patch(
                "graphlagoon.routers.graph.merge_column_config",
                return_value={},
            ),
            patch(
                "graphlagoon.routers.graph.execute_graph_query_with_nodes",
                new_callable=AsyncMock,
                side_effect=ConnectionError(
                    "Cannot connect to warehouse at https://db.net"
                ),
            ),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await execute_graph_query(
                    context_id=mock_context.id,
                    data=data,
                    request=request,
                    warehouse=mock_warehouse,
                )

            assert exc_info.value.status_code == 400
            error = exc_info.value.detail["error"]
            assert error["code"] == "QUERY_EXECUTION_ERROR"
            assert "ConnectionError" in error["message"]
            assert error["details"]["exception_type"] == "ConnectionError"
            assert len(error["details"]["traceback"]) > 0
