"""What people (and the AI they ask for help) need to write the org's data
(06): the case type schema, the report placeholders, the file-mapping
operators, the kinds an agent may write as suggestions and the agent's tools.

``GET /api/org/authoring`` serves it to the admin area, whose help popovers and
"Ask an AI" prompts are built from it, so they never drift from the code.
"""

from __future__ import annotations

from typing import Any


def _tool_summary(description: str) -> str:
    """The first sentence of a tool's description, on one line."""
    text = " ".join((description or "").split())
    end = text.find(". ")
    return text if end < 0 else text[: end + 1]


async def agent_tools() -> list[dict[str, str]]:
    """``[{name, summary}]`` of the MCP tools (names only without the ``mcp`` extra)."""
    from graphlagoon.mcp.registry import TOOL_ROUTES

    try:
        from graphlagoon.mcp.server import build_server

        tools = await build_server().list_tools()
        return sorted(({"name": t.name, "summary": _tool_summary(t.description)} for t in tools), key=lambda t: t["name"])
    except ImportError:
        return [{"name": name, "summary": ""} for name in sorted(TOOL_ROUTES)]


async def catalog() -> dict[str, Any]:
    from graphlagoon.models.schemas import CaseTypeSpec, FileEnrichmentSpec
    from graphlagoon.services import case_annotations, case_items, file_mapping, reports
    from graphlagoon.services.cases import DEFAULT_SUGGEST_KINDS

    suggestible = [k for k in case_annotations.KINDS if k != "decision_proposal"] + list(case_items.SUBKINDS)
    return {
        "case_type_schema": CaseTypeSpec.model_json_schema(),
        "report_placeholders": [{"key": k, "description": v} for k, v in reports.PLACEHOLDERS.items()],
        "mapping": {
            "converters": [*file_mapping.CONVERTERS, "date:<format>"],
            "normalizers": list(file_mapping.NORMALIZERS),
            "when_ops": list(file_mapping.WHEN_OPS),
            "enrichment_schema": FileEnrichmentSpec.model_json_schema(),
        },
        "suggest_kinds": {"all": suggestible, "default": list(DEFAULT_SUGGEST_KINDS)},
        "agent_tools": await agent_tools(),
    }
