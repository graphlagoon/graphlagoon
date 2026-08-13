"""The datasource abstraction: one interface per graph backend.

A "datasource" is whatever can answer graph questions for a context — today a
SQL warehouse (Databricks / the local Spark emulator) reached through
transpiled Cypher, tomorrow a native graph database such as Amazon Neptune
reached through openCypher directly.

Everything above this layer speaks the normalized
:class:`~graphlagoon.models.schemas.GraphResponse` (``nodes`` + ``edges``), so
routers, async jobs, explorations, snapshots and the entire frontend stay
backend-agnostic.

Deliberately NOT on the interface: raw SQL execution, transpile-to-SQL and
schema drift. Those are meaningless for a native graph database, so instead of
forcing every backend to implement ``raise NotImplementedError`` they live on
the concrete SQL implementation and are gated at the router with
:func:`require_capability`.
"""

from __future__ import annotations

import traceback as _traceback
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, ClassVar, Optional

from fastapi import HTTPException

from graphlagoon.models.schemas import (
    CypherQueryRequest,
    ExpandRequest,
    GraphQueryRequest,
    GraphResponse,
    Node,
    SchemaDiscoveryResponse,
    SubgraphRequest,
    TableQueryRequest,
    TableQueryResponse,
    TableQueryStatusResponse,
)


@dataclass(frozen=True)
class DatasourceCapabilities:
    """What a backend can do beyond the core graph operations.

    Every flag defaults to False so a new backend opts in explicitly rather
    than silently inheriting SQL-warehouse affordances it cannot honour. The
    frontend keeps its own copy of this matrix (``useDatasourceCapabilities``)
    to decide what to render; this one decides what the API accepts.
    """

    supports_sql: bool = False
    """Raw SQL graph queries (``/query``) and the console's ``sql`` mode."""

    supports_transpile: bool = False
    """Cypher→SQL transpilation: the review flow, VLP rendering modes,
    materialization strategies and procedural BFS options."""

    supports_cte_prefilter: bool = False
    """User-supplied CTE pre-filters spliced into the generated SQL."""

    supports_schema_drift: bool = False
    """A stored table/column snapshot that can drift from the live source."""

    supports_catalog: bool = False
    """Catalog/database/table browsing and table-based context validation."""

    supports_external_links: bool = False
    """Databricks EXTERNAL_LINKS chunked result download."""

    supports_progressive_load: bool = False
    """``nodes_mode="types"`` + deferred property enrichment."""

    supports_random_generator: bool = False
    """The dev-only random graph generator writes here."""


@dataclass
class PreparedGraphQuery:
    """A validated, backend-ready statement plus how it was produced.

    Preparing and executing are separate steps because the async job endpoints
    must return the transpiled SQL to the client *before* the query finishes.
    For a native-Cypher backend ``statement`` is the user's own query and
    ``transpiled_sql`` stays None.
    """

    statement: str
    transpiled_sql: Optional[str] = None
    transpilation_ms: Optional[float] = None


class DatasourceError(Exception):
    """Base for datasource wiring failures (not query failures)."""


class UnknownDatasourceError(DatasourceError):
    """The context names a datasource type this build does not implement."""


class DatasourceNotConfiguredError(DatasourceError):
    """The datasource type is known but the server has no connection settings."""


@dataclass
class GraphExecutionFailure(Exception):
    """An unexpected backend failure, carrying the statement that caused it.

    ``QueryExecutionError`` covers failures the backend reported *about the
    query*; this wraps everything else (connection resets, result-processing
    bugs) so the router can still report which statement was running and the
    original traceback — the traceback is captured at wrap time, inside the
    ``except`` block that saw the original error.
    """

    original: Exception
    statement: Optional[str] = None
    traceback_lines: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.traceback_lines:
            self.traceback_lines = _traceback.format_exc().split("\n")
        super().__init__(str(self.original))

    @property
    def message(self) -> str:
        return f"{type(self.original).__name__}: {self.original}"

    @property
    def exception_type(self) -> str:
        return type(self.original).__name__


class GraphDatasource(ABC):
    """One graph backend.

    Implementations own everything backend-specific: how a query is validated
    and prepared, how canned operations (subgraph, expand, node fetch) are
    expressed, and how results become nodes/edges. They raise
    :class:`~graphlagoon.services.graph_operations.QueryExecutionError` for
    query-level failures and :class:`GraphExecutionFailure` for everything
    else; the router turns both into the shared 400 envelope.
    """

    type_name: ClassVar[str]
    capabilities: ClassVar[DatasourceCapabilities]

    # ── Query preparation ────────────────────────────────────────────────

    @abstractmethod
    def prepare_cypher(self, context, data: CypherQueryRequest) -> PreparedGraphQuery:
        """Validate (and for SQL backends transpile) an OpenCypher query.

        Raises HTTPException(400) on invalid input.
        """

    @abstractmethod
    async def execute_prepared(
        self,
        context,
        prepared: PreparedGraphQuery,
        *,
        use_external_links: bool = False,
        nodes_mode: str = "full",
        on_submit=None,
        progress_callback=None,
        on_partial=None,
    ) -> GraphResponse:
        """Run a prepared statement and return the normalized graph."""

    # ── Canned graph operations ──────────────────────────────────────────

    @abstractmethod
    async def get_subgraph(self, context, data: SubgraphRequest) -> GraphResponse:
        """Return an arbitrary sample of the graph."""

    @abstractmethod
    async def expand(self, context, data: ExpandRequest) -> GraphResponse:
        """BFS expansion from a starting node, depth 1-2."""

    @abstractmethod
    async def fetch_nodes(
        self,
        context,
        node_ids: list[str],
        columns: Optional[list[str]] = None,
    ) -> tuple[list[Node], float]:
        """Fetch nodes by id. Returns (nodes, query_ms)."""

    # ── Tabular / console mode ───────────────────────────────────────────

    @abstractmethod
    async def submit_table_query(
        self, context, data: TableQueryRequest
    ) -> TableQueryResponse:
        """Run an arbitrary projection and return raw columns/rows.

        May return ``status="running"`` with a ``statement_id`` when the
        backend supports a poll/cancel flow.
        """

    @abstractmethod
    async def get_table_query_status(
        self, context, statement_id: str, row_limit: int
    ) -> TableQueryStatusResponse:
        """Poll an in-flight table query."""

    @abstractmethod
    async def cancel_statement(self, statement_id: str) -> None:
        """Best-effort, idempotent cancel of a submitted statement."""

    # ── Discovery ────────────────────────────────────────────────────────

    @abstractmethod
    async def discover_types(self, request: Any) -> SchemaDiscoveryResponse:
        """Discover the node types / relationship types available."""

    # ── SQL-only surface (overridden by SQL backends) ────────────────────

    def prepare_sql(self, context, data: GraphQueryRequest) -> PreparedGraphQuery:
        """Validate a raw SQL graph query. Only SQL backends implement this."""
        raise NotImplementedError(f"{self.type_name} does not execute raw SQL queries")


def invalid_request(
    code: str, message: str, details: Optional[dict] = None
) -> HTTPException:
    """Build the shared 400 envelope for a request a datasource can't accept.

    Used for everything caught *before* execution (bad Cypher, a write query, a
    rejected transpile option). Failures that happen during execution travel as
    ``QueryExecutionError`` / ``GraphExecutionFailure`` instead.
    """
    return HTTPException(
        status_code=400,
        detail={"error": {"code": code, "message": message, "details": details or {}}},
    )


def require_capability(datasource: GraphDatasource, flag: str, operation: str) -> None:
    """Reject an operation the context's datasource cannot perform.

    The frontend already hides these affordances for backends that lack them,
    so reaching here means a stale client or a direct API call — a clean 400
    beats a confusing failure deeper in the stack.
    """
    if getattr(datasource.capabilities, flag, False):
        return

    raise HTTPException(
        status_code=400,
        detail={
            "error": {
                "code": "DATASOURCE_UNSUPPORTED_OPERATION",
                "message": (
                    f"{operation} is not supported by the "
                    f"'{datasource.type_name}' datasource"
                ),
                "details": {
                    "datasource_type": datasource.type_name,
                    "operation": operation,
                    "capability": flag,
                },
            }
        },
    )
