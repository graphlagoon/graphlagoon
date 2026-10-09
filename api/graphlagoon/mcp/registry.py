"""AI-first coverage registry (03-arquitetura §8.7).

Every investigation route either has an MCP tool (``AGENT_TOOL_ROUTES``) or a
reason it has none (``AGENT_EXEMPT_ROUTES``). A reason starting with
``HUMAN_ONLY`` marks a route agents must never reach: it carries
``forbid_agents`` and has no tool. ``tests/test_agent_registry.py`` enforces
both, so a new route in ``routers/investigations.py`` (or the enrichment
routes, F2.1) must land here with its tool or its reason.
"""

HUMAN_ONLY = "human-only:"

_CASE = "/api/investigations/{investigation_id}"

# (method, path) → MCP tool name (``mcp/server.py``).
AGENT_TOOL_ROUTES: dict[tuple[str, str], str] = {
    ("GET", "/api/investigations"): "list_investigations",
    ("POST", "/api/investigations"): "create_investigation",
    ("GET", _CASE): "get_investigation",
    ("GET", f"{_CASE}/sources"): "get_investigation",
    ("POST", f"{_CASE}/sources"): "add_source",
    ("GET", f"{_CASE}/sources/{{source_id}}/snapshot"): "get_graph",
    ("GET", f"{_CASE}/events"): "list_events",
    ("GET", f"{_CASE}/notes"): "list_notes",
    ("POST", f"{_CASE}/notes"): "add_note",
    ("GET", f"{_CASE}/artifacts"): "list_artifacts",
    ("POST", f"{_CASE}/artifacts"): "upload_artifact",
    ("POST", f"{_CASE}/artifacts/{{artifact_id}}/versions"): "upload_artifact",
    (
        "GET",
        f"{_CASE}/artifacts/{{artifact_id}}/versions/{{version}}/content",
    ): "get_artifact",
    ("GET", f"{_CASE}/proposals"): "list_proposals",
    ("POST", f"{_CASE}/proposals"): "propose",
}

# (method, path) → why there is no tool.
AGENT_EXEMPT_ROUTES: dict[tuple[str, str], str] = {
    ("DELETE", _CASE): f"{HUMAN_ONLY} deleting a case (Q9)",
    ("POST", f"{_CASE}/share"): f"{HUMAN_ONLY} sharing a case (Q9)",
    ("DELETE", f"{_CASE}/share/{{email}}"): f"{HUMAN_ONLY} sharing a case (Q9)",
    (
        "POST",
        f"{_CASE}/artifacts/{{artifact_id}}/versions/{{version}}/approve",
    ): f"{HUMAN_ONLY} approving an artifact (Q9)",
    ("POST", f"{_CASE}/proposals/{{proposal_id}}/accept"): (
        f"{HUMAN_ONLY} a person decides on proposals (03 §8.4)"
    ),
    ("POST", f"{_CASE}/proposals/{{proposal_id}}/reject"): (
        f"{HUMAN_ONLY} a person decides on proposals (03 §8.4)"
    ),
    ("GET", "/api/agent-tokens"): f"{HUMAN_ONLY} token management",
    ("POST", "/api/agent-tokens"): f"{HUMAN_ONLY} an agent never mints tokens",
    ("DELETE", "/api/agent-tokens/{token_id}"): f"{HUMAN_ONLY} token management",
    ("PATCH", _CASE): (
        "title/description are edited in the UI; status and typology go "
        "through `propose`"
    ),
    ("PATCH", f"{_CASE}/state"): (
        "roles go through `propose`; pins are a UI view preference"
    ),
    ("POST", f"{_CASE}/events"): (
        "records client-side analyses (trace.run, …); server analyses journal "
        "themselves (F3.8)"
    ),
    ("DELETE", f"{_CASE}/sources/{{source_id}}"): (
        "removing a source is left to people in the UI (agents add, never delete)"
    ),
    ("PATCH", f"{_CASE}/notes/{{note_id}}"): (
        "notes are edited by their author in the UI; agents add new notes"
    ),
    ("DELETE", f"{_CASE}/notes/{{note_id}}"): (
        "deleting is left to people in the UI (agents add, never delete)"
    ),
}


def human_only_routes() -> set[tuple[str, str]]:
    return {r for r, why in AGENT_EXEMPT_ROUTES.items() if why.startswith(HUMAN_ONLY)}
