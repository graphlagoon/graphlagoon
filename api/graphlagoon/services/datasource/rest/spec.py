"""Specification for a REST-backed graph connection.

A parent app registers one spec per external graph-serving API when calling
``create_mountable_app(rest_connections=[...])`` — the same registration idiom
as similarity endpoints. Each spec becomes a named datasource instance: a graph
context records ``datasource_type="rest"`` plus the spec's ``name``, and every
query against that context is one HTTP request to the API described here.

The spec has two very different halves:

* ``ui`` — what the context-creation picker and the query editor show. This is
  the ONLY part ever serialized to the frontend.
* everything else — transport, auth, request building, response mapping.
  These fields may hold secrets and callables; they never leave the process.

Trust model: connections are declared by the developer embedding the app, in
code. The query text a user types is opaque to Graph Lagoon — there is no
read-only guard the way the SQL and openCypher paths have, because there is no
grammar to inspect. Enforcing safety (read-only endpoints, scoping, rate
limits) is the responsibility of the API the spec points at.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from urllib.parse import urlparse

# Contexts persist the connection name; keep it a tame slug so it is safe in
# composite registry keys, testids and URLs alike.
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,49}$")


@dataclass
class RestRequest:
    """What a request builder returns.

    Builders describe the request; the datasource owns everything operational —
    the HTTP client, auth headers, timeouts, error mapping and response
    mapping. That split keeps builders pure functions of their typed input,
    which is also what makes them trivially unit-testable.
    """

    path: str
    method: str = "POST"
    json_body: Any = None
    params: Optional[dict] = None


@dataclass
class RestConnectionUI:
    """Copy for the context-creation picker and the query editor.

    Mirrors the frontend's ``DatasourceCopy`` framing: say what the connection
    is *for* (workload), what you get, and what you give up — not how it is
    built.
    """

    label: str  # product/service name, e.g. "Fraud Graph Service"
    kind: str = "REST API"
    tagline: str = ""  # the workload line, e.g. "Operational · curated subgraph"
    description: str = ""  # what you get
    caveat: str = ""  # what you give up
    query_language: str = "query"  # editor label, e.g. "Gremlin", "internal DSL"
    query_placeholder: str = ""
    example_query: str = ""


@dataclass
class RestConnectionSpec:
    """A named REST graph connection.

    Response contract: the API answers with::

        {"nodes": [{"id", "label", "properties"}, ...],
         "edges": [{"id", "source", "target", "label", "properties"}, ...]}

    An API with a different shape declares ``response_mapper``, a callable that
    receives the decoded JSON and returns that shape.

    Canned operations (expand-from-node, initial subgraph, fetch-by-id, type
    discovery) cannot be invented against an arbitrary API, so each is opt-in:
    declare the corresponding builder and the operation lights up; leave it
    ``None`` and the UI hides it while the API answers 400. Capabilities are
    therefore *derived* from what is declared — there is no override knob to
    drift out of sync.
    """

    name: str
    ui: RestConnectionUI

    # ── Transport ────────────────────────────────────────────────────────
    base_url: str
    query_path: str = "/query"
    headers: dict[str, str] = field(default_factory=dict)
    # Called once per request and merged over the static headers — the slot for
    # rotating bearer tokens, mirroring the header_provider idiom the warehouse
    # client already uses.
    headers_provider: Optional[Callable[[], dict[str, str]]] = None
    timeout_seconds: float = 30.0
    verify_tls: bool = True

    # ── Request building ─────────────────────────────────────────────────
    # (query, parameters, limits) -> RestRequest. Default when None:
    # POST {query_path} with body {"query", "parameters", "limits"}.
    request_builder: Optional[Callable[[str, Optional[dict], dict], RestRequest]] = None

    # ── Response handling ────────────────────────────────────────────────
    # decoded JSON -> {"nodes": [...], "edges": [...]}. None = the API already
    # answers in the contract shape.
    response_mapper: Optional[Callable[[Any], dict]] = None

    # ── Canned operations (absence == capability off) ────────────────────
    expand_builder: Optional[Callable[[Any], RestRequest]] = None
    subgraph_builder: Optional[Callable[[Any], RestRequest]] = None
    fetch_nodes_builder: Optional[Callable[[list[str]], RestRequest]] = None
    # Must answer {"node_types": [...], "relationship_types": [...]} directly
    # (the response_mapper does not apply — discovery is not a graph).
    discover_types_builder: Optional[Callable[[Any], RestRequest]] = None

    def rest_ops(self) -> dict[str, bool]:
        """Per-connection operation flags, derived from the declared builders."""
        return {
            "expand": self.expand_builder is not None,
            "subgraph": self.subgraph_builder is not None,
            "fetch_nodes": self.fetch_nodes_builder is not None,
            "schema_discovery": self.discover_types_builder is not None,
        }

    def ui_payload(self) -> dict[str, Any]:
        """The frontend-facing description of this connection.

        Deliberately rebuilt field-by-field instead of ``asdict(self)`` so that
        transport and auth fields can never leak into the config payload by
        accident.
        """
        return {
            "type": "rest",
            "name": self.name,
            "label": self.ui.label,
            "kind": self.ui.kind,
            "tagline": self.ui.tagline,
            "description": self.ui.description,
            "caveat": self.ui.caveat,
            "query_language": self.ui.query_language,
            "query_placeholder": self.ui.query_placeholder,
            "example_query": self.ui.example_query,
            "capabilities": self.rest_ops(),
        }


def validate_spec(spec: RestConnectionSpec) -> None:
    """Reject a malformed spec at registration time.

    Failing here means failing at app construction — the dev sees the error on
    startup, not the first user at query time.
    """
    if not _NAME_RE.match(spec.name or ""):
        raise ValueError(
            f"Invalid REST connection name {spec.name!r}: must match "
            f"{_NAME_RE.pattern} (lowercase slug, max 50 chars)"
        )
    if not spec.ui.label or not spec.ui.label.strip():
        raise ValueError(f"REST connection '{spec.name}': ui.label is required")

    parsed = urlparse(spec.base_url or "")
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(
            f"REST connection '{spec.name}': base_url must be an http(s) URL, "
            f"got {spec.base_url!r}"
        )
    if spec.timeout_seconds <= 0:
        raise ValueError(
            f"REST connection '{spec.name}': timeout_seconds must be positive"
        )
    for attr in (
        "headers_provider",
        "request_builder",
        "response_mapper",
        "expand_builder",
        "subgraph_builder",
        "fetch_nodes_builder",
        "discover_types_builder",
    ):
        value = getattr(spec, attr)
        if value is not None and not callable(value):
            raise ValueError(f"REST connection '{spec.name}': {attr} must be callable")
