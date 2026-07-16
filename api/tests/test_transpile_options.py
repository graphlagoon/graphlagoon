"""Tests for procedural BFS optimization wiring in the cypher transpiler.

Verifies that ``transpile_cypher_to_sql`` forwards a
``ProceduralBFSOptions`` payload to gsql2rsql's ``SQLRenderer`` as a
``ProceduralBFSOptimizations`` instance — but only in procedural mode.

These exercise the real gsql2rsql package (a local editable dependency), so
they run in local dev; the API test suite is not part of CI.
"""

from unittest.mock import MagicMock

import pytest

import graphlagoon.services.cypher as cyp
from graphlagoon.models.schemas import ProceduralBFSOptions


class _CaptureRenderer:
    """Stand-in for SQLRenderer that records the kwargs it was built with."""

    last_kwargs: dict | None = None

    def __init__(self, **kwargs):
        _CaptureRenderer.last_kwargs = kwargs

    def render_plan(self, _plan):
        return "SELECT 1"


@pytest.fixture
def patched_pipeline(monkeypatch):
    """Stub the parse/plan pipeline so only the renderer wiring is exercised."""
    _CaptureRenderer.last_kwargs = None
    monkeypatch.setattr(cyp, "build_schema_provider", lambda _ctx: MagicMock())
    monkeypatch.setattr(cyp, "OpenCypherParser", lambda: MagicMock())
    monkeypatch.setattr(cyp, "LogicalPlan", MagicMock())
    monkeypatch.setattr(cyp, "optimize_plan", lambda *a, **k: None)
    monkeypatch.setattr(cyp, "SQLRenderer", _CaptureRenderer)


def test_procedural_options_forwarded_in_procedural_mode(patched_pipeline):
    opts = ProceduralBFSOptions(
        visited_not_exists=False,
        undirected_union_all=True,
        undirected_doubled_adjacency=False,
    )
    cyp.transpile_cypher_to_sql(
        "MATCH (n) RETURN n",
        MagicMock(),
        vlp_rendering_mode="procedural",
        materialization_strategy="temp_tables",
        procedural_optimizations=opts,
    )
    passed = _CaptureRenderer.last_kwargs["procedural_optimizations"]
    assert passed is not None
    assert passed.visited_not_exists is False
    assert passed.undirected_union_all is True
    assert passed.undirected_doubled_adjacency is False


def test_procedural_options_ignored_in_cte_mode(patched_pipeline):
    cyp.transpile_cypher_to_sql(
        "MATCH (n) RETURN n",
        MagicMock(),
        vlp_rendering_mode="cte",
        procedural_optimizations=ProceduralBFSOptions(),
    )
    assert _CaptureRenderer.last_kwargs["procedural_optimizations"] is None


def test_no_options_passes_none(patched_pipeline):
    cyp.transpile_cypher_to_sql(
        "MATCH (n) RETURN n",
        MagicMock(),
        vlp_rendering_mode="procedural",
    )
    assert _CaptureRenderer.last_kwargs["procedural_optimizations"] is None


def test_mutually_exclusive_flags_raise_value_error(patched_pipeline):
    # gsql2rsql rejects doubled_adjacency + union_all both ON at construction.
    bad = ProceduralBFSOptions(
        undirected_doubled_adjacency=True,
        undirected_union_all=True,
    )
    with pytest.raises(ValueError):
        cyp.transpile_cypher_to_sql(
            "MATCH (n) RETURN n",
            MagicMock(),
            vlp_rendering_mode="procedural",
            procedural_optimizations=bad,
        )


# ── Integration: procedural mode + CTE pre-filter combined ──────────
#
# Regression for the bug where enabling both the (default) procedural BFS mode
# and the CTE edge pre-filter produced malformed SQL: apply_cte_prefilter
# assumed a single WITH...SELECT and prepended `WITH ... BEGIN...END`. These
# exercise the REAL gsql2rsql transpiler (a local editable dependency); skip if
# an earlier module poisoned sys.modules with a MagicMock stub.
from types import SimpleNamespace  # noqa: E402

_real_gsql2rsql = pytest.importorskip("gsql2rsql")


def _make_context():
    """Minimal GraphContextModel stand-in for the real transpiler."""
    return SimpleNamespace(
        node_structure={"node_id_col": "node_id", "node_type_col": "node_type"},
        edge_structure={
            "edge_id_col": "edge_id",
            "src_col": "src",
            "dst_col": "dst",
            "relationship_type_col": "relationship_type",
        },
        node_properties=[],
        edge_properties=[],
        node_types=["Person"],
        relationship_types=["KNOWS"],
        node_table_name="cat.sch.nodes",
        edge_table_name="cat.sch.edges",
    )


@pytest.mark.skipif(
    isinstance(_real_gsql2rsql, MagicMock),
    reason="gsql2rsql stubbed by an earlier test module; real package unavailable",
)
def test_procedural_plus_cte_prefilter_yields_valid_script():
    """A variable-length Cypher query in procedural mode + a CTE pre-filter
    must produce a valid BEGIN...END script whose body reads the pre-filtered
    MY_FINAL_EDGES view, not the raw edge table (outside the view definition).

    The bug this guards: apply_cte_prefilter used to prepend
    `WITH MY_FINAL_EDGES AS (...)` before the BEGIN...END block (invalid SQL)
    and rewrite the edge table to a CTE name that was out of scope inside the
    procedural body.
    """
    from graphlagoon.services.cte_prefilter import apply_cte_prefilter

    context = _make_context()
    # A variable-length relationship forces procedural BFS rendering.
    sql = cyp.transpile_cypher_to_sql(
        "MATCH (a:Person)-[r:KNOWS*1..2]->(b:Person) RETURN r",
        context,
        vlp_rendering_mode="procedural",
        materialization_strategy="numbered_views",
        procedural_optimizations=ProceduralBFSOptions(),
    )
    # Sanity: the transpiler really emitted a procedural script.
    assert sql.strip().upper().startswith("BEGIN")
    assert sql.strip().upper().endswith("END")

    final = apply_cte_prefilter(
        sql,
        "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__ WHERE relationship_type = 'KNOWS')",
        context.edge_table_name,
        context.node_table_name,
    )

    stripped = final.strip()
    upper = stripped.upper()
    # Still a compound block, no WITH prepended before BEGIN.
    assert upper.startswith("BEGIN")
    assert upper.endswith("END")
    assert not upper.startswith("WITH")
    # CTE injected as a temp view as the first statement inside the block.
    assert "CREATE OR REPLACE TEMPORARY VIEW MY_FINAL_EDGES AS" in upper
    first_stmt = stripped[len("BEGIN"):].lstrip()
    assert first_stmt.upper().startswith(
        "CREATE OR REPLACE TEMPORARY VIEW MY_FINAL_EDGES AS"
    )
    # The BFS body (incl. the EXECUTE IMMEDIATE string) reads the view.
    assert "FROM MY_FINAL_EDGES E" in upper
    # The only raw edge-table reference is the view definition itself — every
    # line mentioning the edge table also creates/defines MY_FINAL_EDGES.
    edge_ref_lines = [
        line for line in final.split("\n") if context.edge_table_name in line
    ]
    assert edge_ref_lines, "expected the view definition to read the edge table"
    for line in edge_ref_lines:
        assert "MY_FINAL_EDGES" in line.upper()
