"""AI-first coverage registry (05 §6).

Every investigation route either has an MCP tool (``AGENT_TOOL_ROUTES``) or a
reason it has none (``AGENT_EXEMPT_ROUTES``). A reason starting with
``HUMAN_ONLY`` marks a route agents must never reach: it carries
``forbid_agents`` and has no tool. ``tests/test_agent_registry.py`` enforces
both, so a new route in ``routers/investigations.py`` (or an enrichment route
in ``routers/graph_contexts.py``) must land here with its tool or its reason.
"""

HUMAN_ONLY = "human-only:"

_CASE = "/api/investigations/{investigation_id}"
_ITEM = f"{_CASE}/items/{{item_id}}"
_ANNOTATION = f"{_CASE}/annotations/{{annotation_id}}"

# (method, path) → MCP tool name (``mcp/server.py``).
AGENT_TOOL_ROUTES: dict[tuple[str, str], str] = {
    ("GET", "/api/investigations"): "list_investigations",
    ("POST", "/api/investigations"): "create_investigation",
    ("GET", _CASE): "get_investigation",
    ("GET", f"{_CASE}/items"): "list_items",
    ("POST", f"{_CASE}/items"): "add_item",
    ("GET", _ITEM): "get_item",
    ("GET", f"{_ITEM}/versions"): "get_item",
    ("POST", f"{_ITEM}/versions"): "add_item",
    ("GET", f"{_ITEM}/text"): "get_item",
    ("GET", f"{_ITEM}/snapshot"): "get_graph",
    ("POST", f"{_ITEM}/pin"): "pin_evidence",
    ("POST", f"{_ITEM}/run"): "run_query",
    ("POST", f"{_CASE}/items/join"): "join_tables",
    ("POST", f"{_CASE}/items/compare"): "compare_tables",
    ("POST", f"{_CASE}/items/promote"): "promote_tables",
    ("GET", f"{_CASE}/annotations"): "list_annotations",
    ("POST", f"{_CASE}/annotations"): "annotate",
    ("GET", f"{_CASE}/graph"): "get_graph",
    ("POST", f"{_CASE}/analysis/trace"): "trace_money",
    ("POST", f"{_CASE}/analysis/paths"): "find_paths",
    ("POST", f"{_CASE}/analysis/typologies"): "run_typologies",
    ("POST", f"{_CASE}/analysis/er"): "resolve_entities",
    ("GET", f"{_CASE}/events"): "list_events",
    ("GET", f"{_CASE}/brief"): "get_brief",
    ("PUT", f"{_CASE}/brief"): "write_brief",
    ("GET", f"{_CASE}/search"): "search_case",
    ("POST", "/api/graph-contexts/{context_id}/enrichment/{name}/lookup"): "lookup_enrichment",
}

# (method, path) → why there is no tool.
AGENT_EXEMPT_ROUTES: dict[tuple[str, str], str] = {
    ("DELETE", _CASE): f"{HUMAN_ONLY} deleting a case (05 §6)",
    ("POST", f"{_CASE}/share"): f"{HUMAN_ONLY} sharing a case with new people (05 §6)",
    ("DELETE", f"{_CASE}/share/{{email}}"): f"{HUMAN_ONLY} sharing a case (05 §6)",
    ("POST", f"{_CASE}/decision"): f"{HUMAN_ONLY} the decision is a person's (05 §6, LGPD art. 20)",
    ("POST", f"{_CASE}/reopen"): f"{HUMAN_ONLY} reopening a decided case (05 §3)",
    ("GET", f"{_CASE}/export"): (
        f"{HUMAN_ONLY} exports leave the app unmasked and prepare the communication; "
        "agents read the case through get_brief, list_items and get_item"
    ),
    ("POST", f"{_ITEM}/confirm"): f"{HUMAN_ONLY} a person confirms suggestions (05 §6)",
    ("POST", f"{_ITEM}/reject"): f"{HUMAN_ONLY} a person rejects suggestions (05 §6)",
    ("POST", f"{_ANNOTATION}/confirm"): f"{HUMAN_ONLY} a person confirms suggestions (05 §6)",
    ("POST", f"{_ANNOTATION}/reject"): f"{HUMAN_ONLY} a person rejects suggestions (05 §6)",
    ("GET", "/api/agent-tokens"): f"{HUMAN_ONLY} token management",
    ("POST", "/api/agent-tokens"): f"{HUMAN_ONLY} an agent never mints tokens",
    ("DELETE", "/api/agent-tokens/{token_id}"): f"{HUMAN_ONLY} token management",
    ("PATCH", _CASE): (
        "title/description/settings are edited in the UI; an agent's status change "
        "becomes a suggested status_change annotation (handler); assigning is a "
        "person's (handler raises AGENT_FORBIDDEN)"
    ),
    ("PATCH", _ITEM): "items are edited in the UI; agents add items and versions (F5 widens this)",
    ("DELETE", _ITEM): "deleting is left to people in the UI (agents add, never delete)",
    ("GET", f"{_ITEM}/content"): (
        "binary never reaches the agent (05 §6); get_item returns the text extraction"
    ),
    ("PATCH", _ANNOTATION): "annotations are edited in the UI; agents add new ones (F5 widens this)",
    ("DELETE", _ANNOTATION): "deleting is left to people in the UI (agents add, never delete)",
    ("POST", f"{_CASE}/events"): (
        "records client-side analyses (trace.run, …); the server ones "
        "(trace_money, find_paths) journal themselves"
    ),
}


def human_only_routes() -> set[tuple[str, str]]:
    return {r for r, why in AGENT_EXEMPT_ROUTES.items() if why.startswith(HUMAN_ONLY)}
