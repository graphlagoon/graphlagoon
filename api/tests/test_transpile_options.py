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
