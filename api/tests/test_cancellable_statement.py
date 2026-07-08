"""Tests for the cancellable INLINE execute path.

When ``execute_statement`` is called with ``on_submit`` it must switch from the
single blocking POST to a submit→poll flow so the warehouse ``statement_id`` is
exposed *before* the query finishes — that id is what lets the graph query job
cancel the underlying warehouse statement. Without ``on_submit`` the original
single-POST behaviour must be untouched (this is the path real Databricks and
every other caller use, so it must not regress).
"""

from unittest.mock import AsyncMock

import pytest

from graphlagoon.config import Settings
from graphlagoon.models.schemas import (
    StatementResponse,
    StatementStatus,
    StatementResultData,
)
from graphlagoon.services.warehouse import WarehouseClient


def _resp(state, statement_id="stmt-1", rows=None):
    result = None
    if rows is not None:
        result = StatementResultData(row_count=len(rows), data_array=rows)
    return StatementResponse(
        statement_id=statement_id,
        status=StatementStatus(state=state),
        result=result,
    )


def _client():
    # poll_interval 0 keeps the test instant; databricks_mode=False is irrelevant
    # here since we mock the HTTP methods, but keeps construction cheap.
    settings = Settings(
        databricks_mode=False,
        warehouse_poll_interval=0,
        warehouse_max_poll_time=30,
    )
    return WarehouseClient(settings=settings)


@pytest.mark.asyncio
async def test_on_submit_captures_id_before_completion_and_polls_to_terminal():
    """With on_submit: submit returns RUNNING (id exposed immediately), then we
    poll get_statement until SUCCEEDED and return the final inline result."""
    client = _client()

    client.submit_statement = AsyncMock(
        return_value=_resp("RUNNING", statement_id="stmt-42")
    )
    # First poll still RUNNING, second poll SUCCEEDED with data.
    client.get_statement = AsyncMock(
        side_effect=[
            _resp("RUNNING", statement_id="stmt-42"),
            _resp("SUCCEEDED", statement_id="stmt-42", rows=[["a", "b"]]),
        ]
    )
    # execute_statement must NOT fall back to the blocking single POST.
    client._post = AsyncMock(side_effect=AssertionError("blocking POST used"))

    captured = []
    result = await client.execute_statement(
        statement="SELECT 1", on_submit=lambda sid: captured.append(sid)
    )

    # The id was handed to on_submit before the query finished — this is what
    # makes cancellation possible on the inline path.
    assert captured == ["stmt-42"]
    assert result.status.state == "SUCCEEDED"
    assert result.result.data_array == [["a", "b"]]
    client.submit_statement.assert_awaited_once()
    assert client.get_statement.await_count == 2


@pytest.mark.asyncio
async def test_without_on_submit_uses_single_blocking_post():
    """No on_submit → unchanged behaviour: one blocking POST, no submit/poll.
    Guards the Databricks / default path against regression."""
    client = _client()

    client._post = AsyncMock(
        return_value=_resp("SUCCEEDED", rows=[["x"]]).model_dump()
    )
    client.submit_statement = AsyncMock(
        side_effect=AssertionError("submit_statement used on blocking path")
    )
    client.get_statement = AsyncMock(
        side_effect=AssertionError("get_statement used on blocking path")
    )

    result = await client.execute_statement(statement="SELECT 1")

    assert result.status.state == "SUCCEEDED"
    client._post.assert_awaited_once()
    # Single POST to the statements endpoint, no polling.
    args, _ = client._post.await_args
    assert args[0] == "/api/2.0/sql/statements"


@pytest.mark.asyncio
async def test_fast_query_completes_on_first_submit_without_polling():
    """If the query already finished by the time submit returns (SUCCEEDED),
    the id is still surfaced and we return immediately without polling."""
    client = _client()

    client.submit_statement = AsyncMock(
        return_value=_resp("SUCCEEDED", statement_id="fast-1", rows=[["done"]])
    )
    client.get_statement = AsyncMock(
        side_effect=AssertionError("should not poll a finished statement")
    )

    captured = []
    result = await client.execute_statement(
        statement="SELECT 1", on_submit=lambda sid: captured.append(sid)
    )

    assert captured == ["fast-1"]
    assert result.result.data_array == [["done"]]
    client.get_statement.assert_not_awaited()
