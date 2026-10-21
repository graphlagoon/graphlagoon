"""The generated references of the docs site match the code: the MCP tool
reference (docs/guide/agents-mcp-tools.md) and the REST spec
(docs/public/openapi.json). After changing a tool, a route or a schema, run
``make docs-api`` (or ``python -m graphlagoon.dev.api_docs``)."""

import pytest

pytest.importorskip("mcp")

from graphlagoon.dev import api_docs  # noqa: E402


def test_every_mcp_tool_is_in_a_group_of_the_reference():
    grouped = [name for _, names in api_docs.GROUPS for name in names]
    assert len(grouped) == len(set(grouped))
    from graphlagoon.mcp.registry import TOOL_ROUTES

    assert set(grouped) == set(TOOL_ROUTES)


def test_the_committed_references_are_current():
    if not api_docs.ROOT.joinpath("docs").exists():
        pytest.skip("docs not checked out")
    stale = [str(p.relative_to(api_docs.ROOT)) for p in api_docs.stale()]
    assert not stale, f"regenerate with `make docs-api`: {stale}"
