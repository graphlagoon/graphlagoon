"""Tests for graphlagoon.services.warehouse_errors — classifying warehouse
failure messages as stale-schema vs. everything else."""

from graphlagoon.services.warehouse_errors import (
    DEFAULT_CODE,
    STALE_SCHEMA_CODE,
    classify_query_error,
)


class TestClassifyQueryError:
    def test_empty_message(self):
        code, hint, name = classify_query_error("")
        assert code == DEFAULT_CODE
        assert hint is None
        assert name is None

    def test_unresolved_column_local_spark(self):
        message = (
            "Query execution failed: [UNRESOLVED_COLUMN.WITH_SUGGESTION] A "
            "column, variable, or function parameter with name `email` cannot "
            "be resolved. Did you mean one of the following? [`name`, `id`]"
        )
        code, hint, name = classify_query_error(message)
        assert code == STALE_SCHEMA_CODE
        assert hint is not None
        assert name == "email"

    def test_cannot_be_resolved_without_marker(self):
        message = "column `score` cannot be resolved given input columns"
        code, hint, name = classify_query_error(message)
        assert code == STALE_SCHEMA_CODE
        assert name == "score"

    def test_table_or_view_not_found(self):
        message = "[TABLE_OR_VIEW_NOT_FOUND] Table or view not found: cat.db.old_nodes"
        code, hint, name = classify_query_error(message)
        assert code == STALE_SCHEMA_CODE
        assert hint is not None
        assert name is None  # no column name to extract

    def test_databricks_bad_request_still_matches_on_substring(self):
        message = (
            "BAD_REQUEST: [UNRESOLVED_COLUMN.WITH_SUGGESTION] cannot resolve "
            "`legacy_score` SQLSTATE: 42703"
        )
        code, _, name = classify_query_error(message)
        assert code == STALE_SCHEMA_CODE
        assert name == "legacy_score"

    def test_generic_message_unchanged(self):
        message = "Table not found: edges_bad"
        code, hint, name = classify_query_error(message)
        assert code == DEFAULT_CODE
        assert hint is None
        assert name is None

    def test_unrelated_sql_error_unchanged(self):
        message = "division by zero"
        code, hint, name = classify_query_error(message)
        assert code == DEFAULT_CODE
