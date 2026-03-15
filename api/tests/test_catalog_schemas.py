"""Tests for multi catalog.schema support in Settings and WarehouseClient."""

import sys
from unittest.mock import AsyncMock

import pytest

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# gsql2rsql is optional (only needed for Cypher transpilation).
# MagicMock modules allow any attribute access (e.g. OpenCypherParser).
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

from graphlagoon.config import Settings  # noqa: E402
from graphlagoon.models.schemas import (  # noqa: E402
    StatementResponse,
    StatementStatus,
    StatementResultData,
)


# ── Settings.catalog_schema_pairs ─────────────────────────────────


class TestCatalogSchemaPairs:
    def test_default_fallback(self):
        """Without catalog_schemas, falls back to (default_catalog, default_schema)."""
        settings = Settings(databricks_mode=False)
        assert settings.catalog_schema_pairs == [("spark_catalog", "default")]

    def test_single_pair(self):
        settings = Settings(
            databricks_mode=False,
            catalog_schemas="my_cat.my_schema",
        )
        assert settings.catalog_schema_pairs == [("my_cat", "my_schema")]

    def test_multiple_pairs(self):
        settings = Settings(
            databricks_mode=False,
            catalog_schemas="cat_a.schema_1,cat_b.schema_2",
        )
        assert settings.catalog_schema_pairs == [
            ("cat_a", "schema_1"),
            ("cat_b", "schema_2"),
        ]

    def test_whitespace_trimmed(self):
        settings = Settings(
            databricks_mode=False,
            catalog_schemas="  cat_a.schema_1 , cat_b.schema_2  ",
        )
        assert settings.catalog_schema_pairs == [
            ("cat_a", "schema_1"),
            ("cat_b", "schema_2"),
        ]

    def test_invalid_entries_skipped(self):
        """Entries without exactly one dot are silently ignored."""
        settings = Settings(
            databricks_mode=False,
            catalog_schemas="good.entry,bad_no_dot,too.many.dots,ok.pair",
        )
        assert settings.catalog_schema_pairs == [
            ("good", "entry"),
            ("ok", "pair"),
        ]

    def test_all_invalid_falls_back_to_default(self):
        """If all entries are malformed, falls back to default pair."""
        settings = Settings(
            databricks_mode=False,
            catalog_schemas="no_dot,also_bad",
        )
        assert settings.catalog_schema_pairs == [("spark_catalog", "default")]

    def test_databricks_mode_fallback(self):
        """In Databricks mode without catalog_schemas, uses databricks defaults."""
        settings = Settings(
            databricks_mode=True,
            databricks_host="test.databricks.net",
            databricks_token="tok",
            databricks_warehouse_id="wh1",
            databricks_catalog="prod_cat",
            databricks_schema="prod_schema",
        )
        assert settings.catalog_schema_pairs == [("prod_cat", "prod_schema")]

    def test_databricks_mode_with_catalog_schemas(self):
        """catalog_schemas overrides databricks defaults."""
        settings = Settings(
            databricks_mode=True,
            databricks_host="test.databricks.net",
            databricks_token="tok",
            databricks_warehouse_id="wh1",
            databricks_catalog="prod_cat",
            databricks_schema="prod_schema",
            catalog_schemas="cat_a.s1,cat_b.s2",
        )
        assert settings.catalog_schema_pairs == [
            ("cat_a", "s1"),
            ("cat_b", "s2"),
        ]


# ── WarehouseClient.list_datasets ─────────────────────────────────


def _make_statement_response(rows, state="SUCCEEDED"):
    """Helper to build a StatementResponse with given data rows."""
    result = None
    if rows is not None:
        result = StatementResultData(
            row_count=len(rows),
            data_array=rows,
        )
    return StatementResponse(
        statement_id="test-stmt",
        status=StatementStatus(state=state),
        result=result,
    )


class TestListDatasetsSpark:
    """Tests for list_datasets in local Spark mode (databricks_mode=False)."""

    @pytest.mark.asyncio
    async def test_single_schema(self):
        """Single default schema returns 3-part names."""
        from graphlagoon.services.warehouse import WarehouseClient

        settings = Settings(databricks_mode=False)
        client = WarehouseClient(settings=settings)

        # Mock execute_statement to return tables for "default" schema
        show_tables_response = _make_statement_response(
            [
                ["default", "edges_test", "false"],
                ["default", "nodes_test", "false"],
                ["default", "other_table", "false"],
            ]
        )
        client.execute_statement = AsyncMock(return_value=show_tables_response)

        result = await client.list_datasets()

        assert result.edge_tables == ["spark_catalog.default.edges_test"]
        assert result.node_tables == ["spark_catalog.default.nodes_test"]

    @pytest.mark.skip(reason="Mock missing SHOW DATABASES — needs fix")
    @pytest.mark.asyncio
    async def test_multiple_schemas(self):
        """Multiple catalog.schema pairs returns union of tables."""
        from graphlagoon.services.warehouse import WarehouseClient

        settings = Settings(
            databricks_mode=False,
            catalog_schemas="spark_catalog.default,spark_catalog.graphs",
        )
        client = WarehouseClient(settings=settings)

        responses = {
            "SHOW TABLES IN default": _make_statement_response(
                [
                    ["default", "edges_a", "false"],
                    ["default", "nodes_a", "false"],
                ]
            ),
            "SHOW TABLES IN graphs": _make_statement_response(
                [
                    ["graphs", "edges_b", "false"],
                    ["graphs", "nodes_b", "false"],
                ]
            ),
        }

        async def mock_execute(statement, **kwargs):
            return responses[statement]

        client.execute_statement = AsyncMock(side_effect=mock_execute)

        result = await client.list_datasets()

        assert "spark_catalog.default.edges_a" in result.edge_tables
        assert "spark_catalog.graphs.edges_b" in result.edge_tables
        assert "spark_catalog.default.nodes_a" in result.node_tables
        assert "spark_catalog.graphs.nodes_b" in result.node_tables
        assert len(result.edge_tables) == 2
        assert len(result.node_tables) == 2

    @pytest.mark.asyncio
    async def test_deduplication(self):
        """Duplicate tables across schemas are deduplicated."""
        from graphlagoon.services.warehouse import WarehouseClient

        settings = Settings(
            databricks_mode=False,
            # Same schema listed twice
            catalog_schemas="spark_catalog.default,spark_catalog.default",
        )
        client = WarehouseClient(settings=settings)

        response = _make_statement_response(
            [
                ["default", "edges_x", "false"],
            ]
        )
        client.execute_statement = AsyncMock(return_value=response)

        result = await client.list_datasets()

        assert result.edge_tables == ["spark_catalog.default.edges_x"]

    @pytest.mark.asyncio
    async def test_empty_schema(self):
        """Schema with no matching tables returns empty lists."""
        from graphlagoon.services.warehouse import WarehouseClient

        settings = Settings(databricks_mode=False)
        client = WarehouseClient(settings=settings)

        response = _make_statement_response(
            [
                ["default", "users", "false"],
                ["default", "orders", "false"],
            ]
        )
        client.execute_statement = AsyncMock(return_value=response)

        result = await client.list_datasets()

        assert result.edge_tables == []
        assert result.node_tables == []


class TestListDatasetsDatabricks:
    """Tests for list_datasets in Databricks mode."""

    @pytest.mark.asyncio
    async def test_single_catalog_schema(self):
        """Single catalog.schema returns 3-part names."""
        from graphlagoon.services.warehouse import WarehouseClient

        settings = Settings(
            databricks_mode=True,
            databricks_host="test.databricks.net",
            databricks_token="tok",
            databricks_warehouse_id="wh1",
            databricks_catalog="prod",
            databricks_schema="graphs",
        )
        client = WarehouseClient(settings=settings)

        response = _make_statement_response(
            [
                ["graphs", "edges_main"],
                ["graphs", "nodes_main"],
            ]
        )
        client.execute_statement = AsyncMock(return_value=response)

        result = await client.list_datasets()

        assert result.edge_tables == ["prod.graphs.edges_main"]
        assert result.node_tables == ["prod.graphs.nodes_main"]

    @pytest.mark.asyncio
    async def test_multiple_catalog_schemas(self):
        """Multiple pairs query each catalog's information_schema."""
        from graphlagoon.services.warehouse import WarehouseClient

        settings = Settings(
            databricks_mode=True,
            databricks_host="test.databricks.net",
            databricks_token="tok",
            databricks_warehouse_id="wh1",
            databricks_catalog="prod",
            databricks_schema="graphs",
            catalog_schemas="cat_a.schema_1,cat_b.schema_2",
        )
        client = WarehouseClient(settings=settings)

        call_count = 0

        async def mock_execute(statement, **kwargs):
            nonlocal call_count
            call_count += 1
            if "cat_a" in statement:
                return _make_statement_response(
                    [
                        ["schema_1", "edges_alpha"],
                        ["schema_1", "nodes_alpha"],
                    ]
                )
            else:
                return _make_statement_response(
                    [
                        ["schema_2", "edges_beta"],
                        ["schema_2", "nodes_beta"],
                    ]
                )

        client.execute_statement = AsyncMock(side_effect=mock_execute)

        result = await client.list_datasets()

        assert call_count == 2
        assert "cat_a.schema_1.edges_alpha" in result.edge_tables
        assert "cat_b.schema_2.edges_beta" in result.edge_tables
        assert "cat_a.schema_1.nodes_alpha" in result.node_tables
        assert "cat_b.schema_2.nodes_beta" in result.node_tables

    @pytest.mark.asyncio
    async def test_error_propagation(self):
        """Errors from Databricks queries are propagated."""
        from graphlagoon.services.warehouse import WarehouseClient
        from graphlagoon.models.schemas import StatementError

        settings = Settings(
            databricks_mode=True,
            databricks_host="test.databricks.net",
            databricks_token="tok",
            databricks_warehouse_id="wh1",
            databricks_catalog="prod",
            databricks_schema="graphs",
        )
        client = WarehouseClient(settings=settings)

        error_response = StatementResponse(
            statement_id="test-stmt",
            status=StatementStatus(
                state="FAILED",
                error=StatementError(message="Access denied"),
            ),
        )
        client.execute_statement = AsyncMock(return_value=error_response)

        with pytest.raises(Exception, match="Access denied"):
            await client.list_datasets()

    @pytest.mark.asyncio
    async def test_results_sorted(self):
        """Results are returned sorted alphabetically."""
        from graphlagoon.services.warehouse import WarehouseClient

        settings = Settings(
            databricks_mode=True,
            databricks_host="test.databricks.net",
            databricks_token="tok",
            databricks_warehouse_id="wh1",
            databricks_catalog="prod",
            databricks_schema="graphs",
            catalog_schemas="cat_b.s2,cat_a.s1",
        )
        client = WarehouseClient(settings=settings)

        async def mock_execute(statement, **kwargs):
            if "cat_a" in statement:
                return _make_statement_response(
                    [
                        ["s1", "edges_zzz"],
                    ]
                )
            else:
                return _make_statement_response(
                    [
                        ["s2", "edges_aaa"],
                    ]
                )

        client.execute_statement = AsyncMock(side_effect=mock_execute)

        result = await client.list_datasets()

        # Sorted lexicographically: cat_a < cat_b
        assert result.edge_tables == [
            "cat_a.s1.edges_zzz",
            "cat_b.s2.edges_aaa",
        ]
