"""AI-first coverage registry (05 §6).

Every MCP tool mirrors one or more human actions (REST routes), declared here
in ``TOOL_ROUTES`` and stamped on the tool as ``meta.human_equivalent``; every
investigation route either has a tool or a reason in ``AGENT_EXEMPT_ROUTES``.
A reason starting with ``HUMAN_ONLY`` marks a route agents must never reach:
it carries ``forbid_agents`` and has no tool. ``tests/test_agent_registry.py``
enforces all of it, so a new route in ``routers/investigations.py``,
``routers/org.py`` (or an enrichment route in ``routers/graph_contexts.py``)
must land here with its tool or its reason, and a new tool must name its twin.
"""

HUMAN_ONLY = "human-only:"

_CASE = "/api/investigations/{investigation_id}"
_ITEM = f"{_CASE}/items/{{item_id}}"
_ANNOTATION = f"{_CASE}/annotations/{{annotation_id}}"
_ENRICHMENT = "/api/graph-contexts/{context_id}/enrichment/{name}/lookup"

# tool name (``mcp/server.py``) → the human actions it is the twin of.
TOOL_ROUTES: dict[str, list[tuple[str, str]]] = {
    "list_cases": [("GET", "/api/investigations")],
    "create_case": [("POST", "/api/investigations")],
    "get_case": [("GET", _CASE)],
    "update_case": [("PATCH", _CASE)],
    "get_brief": [("GET", f"{_CASE}/brief")],
    "write_brief": [("PUT", f"{_CASE}/brief")],
    "render_report": [("POST", f"{_CASE}/reports"), ("GET", "/api/org/library")],
    "list_items": [("GET", f"{_CASE}/items")],
    "read_item": [("GET", _ITEM), ("GET", f"{_ITEM}/versions"), ("GET", f"{_ITEM}/text")],
    "update_item": [("PATCH", _ITEM)],
    "search_case": [("GET", f"{_CASE}/search")],
    "add_item": [("POST", f"{_CASE}/items"), ("POST", f"{_ITEM}/versions")],
    "add_note": [("POST", f"{_CASE}/items")],
    "add_document": [("POST", f"{_CASE}/items")],
    "add_table": [("POST", f"{_CASE}/items")],
    "save_query": [("POST", f"{_CASE}/items")],
    "import_file": [("POST", f"{_CASE}/items")],
    "create_exploration": [("POST", f"{_CASE}/items")],
    "run_query": [("POST", f"{_ITEM}/run")],
    "join_tables": [("POST", f"{_CASE}/items/join")],
    "compare_tables": [("POST", f"{_CASE}/items/compare")],
    "promote_tables": [("POST", f"{_CASE}/items/promote")],
    "pin_evidence": [("POST", f"{_ITEM}/pin")],
    "list_annotations": [("GET", f"{_CASE}/annotations")],
    "propose_decision": [("POST", f"{_CASE}/annotations")],
    "find_entity_cases": [("GET", "/api/investigations/entities/cases")],
    "list_tasks": [("GET", "/api/investigations/tasks"), ("GET", f"{_CASE}/annotations")],
    "add_task": [("POST", f"{_CASE}/annotations")],
    "update_task": [("PATCH", _ANNOTATION)],
    "annotate": [("POST", f"{_CASE}/annotations")],
    "group": [("POST", f"{_CASE}/annotations"), ("PATCH", _ANNOTATION)],
    "get_graph": [("GET", f"{_CASE}/graph"), ("GET", f"{_ITEM}/snapshot")],
    "search_entities": [("GET", f"{_CASE}/graph")],
    "get_entity": [("GET", f"{_CASE}/graph"), ("GET", f"{_CASE}/annotations")],
    "lookup_enrichment": [("POST", _ENRICHMENT)],
    "run_analysis": [
        ("POST", f"{_CASE}/analysis/trace"),
        ("POST", f"{_CASE}/analysis/paths"),
        ("POST", f"{_CASE}/analysis/er"),
        ("POST", f"{_CASE}/events"),  # links and communities journal like the browser's analyses
    ],
    "list_events": [("GET", f"{_CASE}/events")],
    "changes_since": [("GET", f"{_CASE}/events"), ("GET", f"{_CASE}/items"), ("GET", f"{_CASE}/annotations")],
    "get_playbook": [("GET", "/api/org/library"), ("GET", "/api/org/library/{slug}")],
    "get_case_type": [("GET", "/api/org/case-types"), ("GET", "/api/org/case-types/{slug}")],
}

# (method, path) → the tools that mirror it.
AGENT_TOOL_ROUTES: dict[tuple[str, str], list[str]] = {}
for _tool, _routes in TOOL_ROUTES.items():
    for _route in _routes:
        AGENT_TOOL_ROUTES.setdefault(_route, []).append(_tool)

# (method, path) → why there is no tool.
AGENT_EXEMPT_ROUTES: dict[tuple[str, str], str] = {
    ("DELETE", _CASE): f"{HUMAN_ONLY} deleting a case (05 §6)",
    ("POST", f"{_CASE}/share"): f"{HUMAN_ONLY} sharing a case with new people (05 §6)",
    ("DELETE", f"{_CASE}/share/{{email}}"): f"{HUMAN_ONLY} sharing a case (05 §6)",
    ("POST", f"{_CASE}/decisions"): f"{HUMAN_ONLY} a decision is a person's (05 §6, 06 §1)",
    ("POST", f"{_CASE}/decisions/{{decision_id}}/review"): f"{HUMAN_ONLY} four eyes are a second person's (06 §1)",
    ("POST", f"{_CASE}/reopen"): f"{HUMAN_ONLY} reopening a decided case (05 §3)",
    ("GET", f"{_CASE}/export"): (
        f"{HUMAN_ONLY} what leaves the app is a person's call; "
        "agents read the case through get_brief, list_items and read_item"
    ),
    ("POST", f"{_ITEM}/confirm"): f"{HUMAN_ONLY} a person confirms suggestions (05 §6)",
    ("POST", f"{_ITEM}/reject"): f"{HUMAN_ONLY} a person rejects suggestions (05 §6)",
    ("POST", f"{_ANNOTATION}/confirm"): f"{HUMAN_ONLY} a person confirms suggestions (05 §6)",
    ("POST", f"{_ANNOTATION}/reject"): f"{HUMAN_ONLY} a person rejects suggestions (05 §6)",
    ("POST", f"{_ITEM}/reopen"): f"{HUMAN_ONLY} a person takes back a rejection (UX-1)",
    ("POST", f"{_ANNOTATION}/reopen"): f"{HUMAN_ONLY} a person takes back a rejection (UX-1)",
    ("POST", f"{_CASE}/annotations/status"): f"{HUMAN_ONLY} a person confirms or rejects suggestions in bulk (UX-1)",
    ("POST", f"{_ITEM}/restore"): f"{HUMAN_ONLY} a person restores a removed item, as only people remove them (UX-1)",
    ("GET", "/api/agent-tokens"): f"{HUMAN_ONLY} token management",
    ("POST", "/api/agent-tokens"): f"{HUMAN_ONLY} an agent never mints tokens",
    ("DELETE", "/api/agent-tokens/{token_id}"): f"{HUMAN_ONLY} token management",
    ("DELETE", _ITEM): f"{HUMAN_ONLY} deleting material (agents add and version, never remove)",
    ("DELETE", _ANNOTATION): f"{HUMAN_ONLY} deleting annotations (agents add, never remove)",
    ("GET", "/api/org/authoring"): (
        "authoring help for people writing case types and library docs; agents read the same "
        "through get_case_type, get_playbook and the tool descriptions"
    ),
    ("GET", f"{_ITEM}/content"): (
        "binary never reaches the agent (05 §6) through REST; read_item returns the text extraction, "
        "and images up to agent_image_max_bytes as MCP image content (06 P8)"
    ),
}


def human_only_routes() -> set[tuple[str, str]]:
    return {r for r, why in AGENT_EXEMPT_ROUTES.items() if why.startswith(HUMAN_ONLY)}


def human_equivalent(tool: str) -> list[str]:
    """``meta.human_equivalent`` of a tool: ``"METHOD path"`` per route."""
    return [f"{method} {path}" for method, path in TOOL_ROUTES[tool]]
