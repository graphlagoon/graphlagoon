"""BEGIN...END scripts on the raw-SQL path are refused unless opted in.

Security regression tests for finding A3 (docs/dev/security-assessment.md):
``prepare_sql`` used to skip ``validate_sql_query`` for anything shaped like a
compound-statement script, letting arbitrary DML/DDL through as the service
principal. A Databricks script body may hold DML/DDL and ``EXECUTE IMMEDIATE``
builds SQL at runtime, so neither the SELECT-only validator nor the table-scope
check can inspect one. Scripts always run on the Cypher path (there they are
the transpiler's own output); on the raw path they need the explicit
``allow_raw_sql_scripts`` opt-in, whose contract is read-only warehouse grants.
"""

import sys
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# Guarded with try/import: when gsql2rsql IS installed, stubbing would poison
# the import for test_transpile_options (see the same block in other tests).
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

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.models.schemas import GraphQueryRequest  # noqa: E402
from graphlagoon.services.datasource.sql_warehouse import (  # noqa: E402
    SqlWarehouseDatasource,
)


@pytest.fixture(autouse=True)
def default_settings():
    """The flag defaults to off; each test owns the cache it clears."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def datasource():
    return SqlWarehouseDatasource(warehouse_client_getter=MagicMock())


def _prepare(datasource, query, cte_prefilter=None):
    data = GraphQueryRequest(query=query, cte_prefilter=cte_prefilter)
    return datasource.prepare_sql(MagicMock(), data)


class TestScriptRejection:
    def test_script_with_dml_rejected(self, datasource):
        script = "BEGIN\n  INSERT INTO cat.db.t VALUES (1);\nEND"
        with pytest.raises(HTTPException) as exc:
            _prepare(datasource, script)
        assert exc.value.status_code == 400
        assert exc.value.detail["error"]["code"] == "SCRIPT_NOT_ALLOWED"

    def test_script_with_ddl_rejected(self, datasource):
        script = "BEGIN\n  DROP TABLE cat.db.t;\nEND"
        with pytest.raises(HTTPException) as exc:
            _prepare(datasource, script)
        assert exc.value.detail["error"]["code"] == "SCRIPT_NOT_ALLOWED"

    def test_script_rejected_even_with_benign_body(self, datasource):
        # Shape alone decides: the raw path never parses script bodies.
        script = "BEGIN\n  SELECT 1;\nEND"
        with pytest.raises(HTTPException) as exc:
            _prepare(datasource, script)
        assert exc.value.detail["error"]["code"] == "SCRIPT_NOT_ALLOWED"

    def test_script_rejected_case_and_whitespace_insensitive(self, datasource):
        script = "  begin\n  select 1;\n  end  "
        with pytest.raises(HTTPException) as exc:
            _prepare(datasource, script)
        assert exc.value.detail["error"]["code"] == "SCRIPT_NOT_ALLOWED"

    def test_script_rejected_with_cte_prefilter(self, datasource):
        # The old code also skipped the post-splice re-validation for scripts.
        script = "BEGIN\n  DELETE FROM cat.db.t;\nEND"
        with pytest.raises(HTTPException) as exc:
            _prepare(datasource, script, cte_prefilter="SELECT 1")
        assert exc.value.detail["error"]["code"] == "SCRIPT_NOT_ALLOWED"

    def test_plain_select_still_accepted(self, datasource):
        prepared = _prepare(datasource, "SELECT src, dst FROM cat.db.edges LIMIT 10")
        assert "SELECT" in prepared.statement.upper()

    def test_non_script_dml_still_rejected_by_validator(self, datasource):
        with pytest.raises(HTTPException) as exc:
            _prepare(datasource, "INSERT INTO cat.db.t VALUES (1)")
        assert exc.value.detail["error"]["code"] == "INVALID_SQL_QUERY"


class TestRawScriptOptIn:
    """``allow_raw_sql_scripts`` restores the raw-script feature."""

    SCRIPT = "BEGIN\n  SELECT 1;\nEND"

    def test_flag_lets_a_script_through(self, datasource, monkeypatch):
        monkeypatch.setenv("GRAPH_LAGOON_ALLOW_RAW_SQL_SCRIPTS", "true")
        get_settings.cache_clear()
        prepared = _prepare(datasource, self.SCRIPT)
        assert prepared.statement.strip().upper().startswith("BEGIN")

    def test_flag_does_not_weaken_the_single_statement_validator(
        self, datasource, monkeypatch
    ):
        monkeypatch.setenv("GRAPH_LAGOON_ALLOW_RAW_SQL_SCRIPTS", "true")
        get_settings.cache_clear()
        with pytest.raises(HTTPException) as exc:
            _prepare(datasource, "DROP TABLE cat.db.t")
        assert exc.value.detail["error"]["code"] == "INVALID_SQL_QUERY"
