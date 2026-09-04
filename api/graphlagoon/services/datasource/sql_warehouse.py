"""SQL warehouse datasource: Cypher transpiled to Spark SQL over two tables.

This is the original — and until now only — backend: a context names an edge
table and a node table, Cypher is transpiled by gsql2rsql, and the resulting
SQL runs through the Databricks-compatible statements API (Databricks itself,
or the local PySpark emulator in dev).

The code here is a move, not a rewrite: it is the query-building and execution
logic that used to live inline in ``routers/graph.py``, relocated behind the
:class:`~graphlagoon.services.datasource.base.GraphDatasource` interface so
other backends can take its place per context.
"""

from __future__ import annotations

import time
from typing import Any, ClassVar, Optional

from graphlagoon.models.schemas import (
    ColumnConfig,
    CypherQueryRequest,
    ExpandRequest,
    GraphQueryRequest,
    GraphResponse,
    Node,
    QueryMetadata,
    SchemaDiscoveryResponse,
    SubgraphRequest,
    TableQueryRequest,
    TableQueryResponse,
    TableQueryStatusResponse,
)
from graphlagoon.config import get_settings
from graphlagoon.services.cte_prefilter import (
    apply_cte_prefilter,
    validate_cte_prefilter,
)
from graphlagoon.services.cypher import transpile_cypher_to_sql, validate_cypher_query
from graphlagoon.services.datasource.base import (
    DatasourceCapabilities,
    GraphDatasource,
    GraphExecutionFailure,
    PreparedGraphQuery,
    invalid_request as _invalid,
)
from graphlagoon.services.graph_operations import (
    QueryExecutionError,
    execute_graph_query_with_nodes,
    fetch_nodes_by_ids,
    merge_column_config,
    parse_tabular_result,
    resolve_node_table,
)
from graphlagoon.services.sql_identifiers import (
    escape_identifier,
    qualified_from_dotted,
    quote_identifier,
)
from graphlagoon.services.sql_validation import (
    sanitize_string_literal,
    validate_sql_query,
)
from graphlagoon.services.warehouse import get_warehouse_client


def build_edge_named_struct(column_config, table_alias: str = "") -> str:
    """Build a NAMED_STRUCT projection for an edge row.

    The struct is keyed by the context's OWN column names (edge_id_col,
    src_col, dst_col, relationship_type_col) — NOT the normalized
    'src'/'dst'/'relationship_type' aliases. This matters because
    ``process_graph_query_result`` reads the struct back through the same
    ``ColumnConfig`` (``item.get(column_config.src_col)`` etc.). If the struct
    were keyed by the normalized names while the context uses a custom schema
    (e.g. ``source_node_id``/``target_node_id``/``edge_type``), every lookup
    would miss, producing edges with empty src/dst, no node ids to fetch (empty
    graph), and a blank edge-type dropdown. Keying by the context's column names
    keeps subgraph/expand consistent with the transpiled cypher path for ANY
    schema. An empty ``edge_id_col`` (context with no edge id column) is
    omitted from the struct; ``_get_edge_id`` generates composite ids instead.

    Args:
        column_config: The merged :class:`ColumnConfig` for the context.
        table_alias: Optional table alias to qualify each column (e.g. ``"e"``
            for the expand queries). Empty for the unqualified subgraph query.
    """
    prefix = f"{table_alias}." if table_alias else ""
    cols = [
        c
        for c in (
            column_config.edge_id_col,
            column_config.src_col,
            column_config.dst_col,
            column_config.relationship_type_col,
        )
        if c
    ]
    fields = ", ".join(
        # Escape both positions: the string literal AND the backticked
        # identifier — an embedded backtick/quote in a stored column name must
        # not break out of either (stored variant of finding A4).
        f"'{sanitize_string_literal(col)}', {prefix}{quote_identifier(col)}"
        for col in cols
    )
    return f"NAMED_STRUCT({fields})"


def resolve_node_columns(context) -> Optional[list[str]]:
    """Derive the node-query projection from a context's configured properties.

    Returns ``None`` when the context declares no ``node_properties``, which
    keeps the historical ``SELECT n.*`` — the context has not told us which
    columns matter, so narrowing could silently drop data the user expects to
    see in tooltips and the data table.

    When properties ARE configured they are the complete set the UI can display,
    so selecting anything beyond them is pure waste on every graph load.
    """
    props = getattr(context, "node_properties", None)
    if not props:
        return None

    names: list[str] = []
    for prop in props:
        # Contexts round-trip through both Pydantic models and raw dicts
        # (memory store vs DB), so accept either shape.
        name = (
            prop.get("name") if isinstance(prop, dict) else getattr(prop, "name", None)
        )
        if name:
            names.append(name)

    return names or None


def _safe_table_name(name: str) -> str:
    """Validate and backtick-quote a stored table name before interpolation.

    Context table names are validated at create time nowadays, but contexts
    stored before that validation (or written directly to the store) must not
    reach the SQL builders unchecked.
    """
    try:
        return qualified_from_dotted(name)
    except ValueError as e:
        raise _invalid("INVALID_CONTEXT_TABLES", str(e))


def _is_script(sql: str) -> bool:
    """A BEGIN...END block from procedural BFS — not a parseable SELECT."""
    stripped = sql.strip().upper()
    return stripped.startswith("BEGIN") and stripped.endswith("END")


def _manifest_counts(response) -> tuple[Optional[int], Optional[int]]:
    """Extract (total_chunk_count, total_row_count) from a warehouse response's
    manifest, if present — used to report result-set shape to the client."""
    manifest = getattr(response, "manifest", None)
    if manifest is None:
        return None, None
    return (
        getattr(manifest, "total_chunk_count", None),
        getattr(manifest, "total_row_count", None),
    )


class SqlWarehouseDatasource(GraphDatasource):
    """Query a graph stored as an edge table + a node table."""

    type_name: ClassVar[str] = "sql_warehouse"
    capabilities: ClassVar[DatasourceCapabilities] = DatasourceCapabilities(
        supports_sql=True,
        supports_transpile=True,
        supports_cte_prefilter=True,
        supports_schema_drift=True,
        supports_catalog=True,
        supports_external_links=True,
        supports_progressive_load=True,
        supports_random_generator=True,
    )

    def __init__(self, warehouse_client_getter=get_warehouse_client):
        # A getter, not the client itself: the warehouse singleton is
        # (re)configured at startup and swapped wholesale by tests, so resolving
        # it per call keeps this datasource a thin, stateless adapter.
        self._get_warehouse = warehouse_client_getter

    @property
    def warehouse(self):
        return self._get_warehouse()

    # ── Query preparation ────────────────────────────────────────────────

    def prepare_cypher(self, context, data: CypherQueryRequest) -> PreparedGraphQuery:
        """Validate + transpile Cypher, apply any CTE pre-filter, re-validate."""
        is_valid, error_msg = validate_cypher_query(data.query)
        if not is_valid:
            raise _invalid("INVALID_CYPHER_QUERY", error_msg)

        t0 = time.perf_counter()
        try:
            sql = transpile_cypher_to_sql(
                data.query,
                context,
                vlp_rendering_mode=data.vlp_rendering_mode,
                materialization_strategy=data.materialization_strategy,
                procedural_optimizations=data.procedural_optimizations,
            )
        except ValueError as e:
            # Inconsistent procedural optimization flags (e.g. mutually
            # exclusive undirected strategies) surface as a clean 400.
            raise _invalid("INVALID_TRANSPILE_OPTIONS", str(e))
        transpilation_ms = (time.perf_counter() - t0) * 1000

        sql = self._apply_prefilter(context, sql, data.cte_prefilter)

        # Defense-in-depth: validate the transpiled SQL.
        if not _is_script(sql):
            is_valid, error_msg = validate_sql_query(sql)
            if not is_valid:
                raise _invalid(
                    "INVALID_TRANSPILED_SQL",
                    f"Transpiled SQL failed validation: {error_msg}",
                    {"transpiled_sql": sql},
                )

        return PreparedGraphQuery(
            statement=sql,
            transpiled_sql=sql,
            transpilation_ms=transpilation_ms,
        )

    def prepare_sql(self, context, data: GraphQueryRequest) -> PreparedGraphQuery:
        """Validate a raw SQL graph query and apply any CTE pre-filter.

        A client-supplied ``BEGIN...END`` script is refused unless
        ``allow_raw_sql_scripts`` is on: a Databricks compound statement body
        may hold DML/DDL, and neither the SELECT-only validator nor the
        table-scope check can see inside one (``EXECUTE IMMEDIATE`` runs SQL
        built at runtime). Scripts still run on the Cypher path, where they
        are the transpiler's own output rather than client text.
        """
        if _is_script(data.query):
            if not get_settings().allow_raw_sql_scripts:
                raise _invalid(
                    "SCRIPT_NOT_ALLOWED",
                    "BEGIN...END scripts cannot be executed as raw SQL. Run "
                    "the original Cypher query instead (the Cypher endpoints "
                    "transpile and execute scripts server-side), or ask an "
                    "administrator to enable "
                    "GRAPH_LAGOON_ALLOW_RAW_SQL_SCRIPTS.",
                )
            # Opt-in: neither validation nor scoping can inspect a script, so
            # read-only Unity Catalog grants are the enforcing layer here.
            return PreparedGraphQuery(
                statement=self._apply_prefilter(
                    context, data.query, data.cte_prefilter
                )
            )

        is_valid, error_msg = validate_sql_query(data.query)
        if not is_valid:
            raise _invalid("INVALID_SQL_QUERY", error_msg)

        final_query = self._apply_prefilter(context, data.query, data.cte_prefilter)

        if data.cte_prefilter:
            # Re-validate after the CTE is spliced in.
            is_valid, error_msg = validate_sql_query(final_query)
            if not is_valid:
                raise _invalid(
                    "INVALID_SQL_QUERY",
                    f"SQL with CTE failed validation: {error_msg}",
                )

        return PreparedGraphQuery(statement=final_query)

    def transpile_only(self, context, data) -> str:
        """Transpile Cypher to SQL without executing it (review flow).

        Deliberately does NOT run ``validate_sql_query``: nothing is executed,
        and showing the user the SQL a rejected query produced is more useful
        than hiding it behind a validation error.
        """
        is_valid, error_msg = validate_cypher_query(data.query)
        if not is_valid:
            raise _invalid("INVALID_CYPHER_QUERY", error_msg)

        try:
            sql = transpile_cypher_to_sql(
                data.query,
                context,
                vlp_rendering_mode=data.vlp_rendering_mode,
                materialization_strategy=data.materialization_strategy,
                procedural_optimizations=data.procedural_optimizations,
            )
        except ValueError as e:
            raise _invalid("INVALID_TRANSPILE_OPTIONS", str(e))

        return self._apply_prefilter(context, sql, data.cte_prefilter)

    def _apply_prefilter(self, context, sql: str, cte_prefilter) -> str:
        """Splice a user CTE in front of the query, if one was supplied."""
        if not cte_prefilter:
            return sql

        is_valid, error_msg = validate_cte_prefilter(cte_prefilter)
        if not is_valid:
            raise _invalid("INVALID_CTE_PREFILTER", error_msg)

        # resolve_node_table so a user CTE referencing __NODES__ keeps working
        # on nodeless contexts (expands to the derived virtual node table).
        return apply_cte_prefilter(
            sql,
            cte_prefilter,
            context.edge_table_name,
            resolve_node_table(context),
        )

    # ── Execution ────────────────────────────────────────────────────────

    def _column_config(self, context) -> ColumnConfig:
        return ColumnConfig(**merge_column_config(context))

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
        # limit is None: the cap lives in the statement's own LIMIT clause,
        # which execute_graph_query_with_nodes reads back for truncation.
        return await self._execute(
            context,
            prepared.statement,
            limit=None,
            use_external_links=use_external_links,
            nodes_mode=nodes_mode,
            on_submit=on_submit,
            progress_callback=progress_callback,
            on_partial=on_partial,
        )

    async def _execute(
        self,
        context,
        query: str,
        *,
        limit: Optional[int],
        use_external_links: bool = False,
        nodes_mode: str = "full",
        on_submit=None,
        progress_callback=None,
        on_partial=None,
    ) -> GraphResponse:
        # Nodeless contexts: the derived virtual node table is 2 columns wide,
        # so "types" and "full" projections are identical — but "full" keeps
        # properties_deferred=False in the response, so no client (even a stale
        # one) ever enters the property-enrichment loop for nodes that will
        # never have properties.
        if not context.node_table_name:
            nodes_mode = "full"
        try:
            return await execute_graph_query_with_nodes(
                warehouse_client=self.warehouse,
                node_table=resolve_node_table(context),
                query=query,
                limit=limit,
                column_config=self._column_config(context),
                use_external_links=use_external_links,
                node_columns=resolve_node_columns(context),
                nodes_mode=nodes_mode,
                on_submit=on_submit,
                progress_callback=progress_callback,
                on_partial=on_partial,
            )
        except QueryExecutionError:
            # Already classified (e.g. the stale-structural-column guard) —
            # wrapping would lose its `.code` and turn an actionable 400 into
            # an opaque one.
            raise
        except Exception as e:
            raise GraphExecutionFailure(e, statement=query)

    # ── Canned graph operations ──────────────────────────────────────────

    async def get_subgraph(self, context, data: SubgraphRequest) -> GraphResponse:
        column_config = self._column_config(context)

        edge_conditions = []
        # No relationship type column ⇒ no filter to build: every edge carries
        # the constant type, so any requested type filter matches all rows.
        if data.edge_types and column_config.relationship_type_col:
            types_str = ", ".join(
                [f"'{sanitize_string_literal(t)}'" for t in data.edge_types]
            )
            edge_conditions.append(
                f"{quote_identifier(column_config.relationship_type_col)} "
                f"IN ({types_str})"
            )

        where_clause = (
            f"WHERE {' AND '.join(edge_conditions)}" if edge_conditions else ""
        )
        order_clause = "ORDER BY RAND()" if not edge_conditions else ""

        # NAMED_STRUCT keyed by the context's own column names so the result
        # maps correctly for any schema (see build_edge_named_struct).
        query = f"""
        SELECT {build_edge_named_struct(column_config)} AS r
        FROM {_safe_table_name(context.edge_table_name)}
        {where_clause}
        {order_clause}
        LIMIT {int(data.edge_limit)}
    """

        return await self._execute(
            context,
            query,
            limit=data.edge_limit,
            nodes_mode=data.nodes_mode,
        )

    async def expand(self, context, data: ExpandRequest) -> GraphResponse:
        column_config = self._column_config(context)

        # Escaped once here: every use below sits inside its own backticks.
        node_id_col = escape_identifier(column_config.node_id_col)
        src_col = escape_identifier(column_config.src_col)
        dst_col = escape_identifier(column_config.dst_col)
        rel_type_col = escape_identifier(column_config.relationship_type_col)

        edge_type_filter = ""
        final_edge_filter = ""
        # rel_type_col="" means the table has no type column — skip the
        # filter (the single constant type matches every edge anyway).
        if data.edge_types and rel_type_col:
            types_str = ", ".join(
                [f"'{sanitize_string_literal(t)}'" for t in data.edge_types]
            )
            edge_type_filter = f"AND `{rel_type_col}` IN ({types_str})"
            final_edge_filter = f"AND e.`{rel_type_col}` IN ({types_str})"

        edge_table = _safe_table_name(context.edge_table_name)
        node_table = (
            _safe_table_name(context.node_table_name)
            if context.node_table_name
            else context.node_table_name
        )
        safe_node_id = sanitize_string_literal(data.node_id)

        if data.depth == 1:
            # Depth 1: simple query without recursion
            if data.directed:
                neighbor_query = f"""
                SELECT DISTINCT e.`{dst_col}` AS node_id
                FROM {edge_table} e
                WHERE e.`{src_col}` = '{safe_node_id}'
                    {edge_type_filter}
            """
            else:
                neighbor_query = f"""
                SELECT DISTINCT
                    CASE
                        WHEN e.`{src_col}` = '{safe_node_id}' THEN e.`{dst_col}`
                        ELSE e.`{src_col}`
                    END AS node_id
                FROM {edge_table} e
                WHERE (e.`{src_col}` = '{safe_node_id}'
                    OR e.`{dst_col}` = '{safe_node_id}')
                    {edge_type_filter}
            """

            query = f"""
            WITH visited_nodes AS (
                SELECT '{safe_node_id}' AS node_id
                UNION
                {neighbor_query}
            )
            SELECT {build_edge_named_struct(column_config, "e")} AS r
            FROM {edge_table} e
            WHERE e.`{src_col}` IN (SELECT node_id FROM visited_nodes)
              AND e.`{dst_col}` IN (SELECT node_id FROM visited_nodes)
              {final_edge_filter}
            LIMIT {data.edge_limit}
        """
        else:
            # Depth > 1: recursive CTE for multi-hop BFS
            if data.directed:
                recursive_join = f"""
                SELECT
                    e.`{dst_col}` AS node_id,
                    n.depth + 1 AS depth,
                    CONCAT(n.path, ARRAY(e.`{dst_col}`)) AS path
                FROM neighbors n
                JOIN {edge_table} e ON e.`{src_col}` = n.node_id
                WHERE n.depth < {data.depth}
                    AND NOT array_contains(n.path, e.`{dst_col}`)
                    {edge_type_filter}
            """
            else:
                recursive_join = f"""
                SELECT
                    CASE
                        WHEN e.`{src_col}` = n.node_id THEN e.`{dst_col}`
                        ELSE e.`{src_col}`
                    END AS node_id,
                    n.depth + 1 AS depth,
                    CONCAT(n.path, ARRAY(
                        CASE
                            WHEN e.`{src_col}` = n.node_id THEN e.`{dst_col}`
                            ELSE e.`{src_col}`
                        END
                    )) AS path
                FROM neighbors n
                JOIN {edge_table} e ON (e.`{src_col}` = n.node_id OR e.`{dst_col}` = n.node_id)
                WHERE n.depth < {data.depth}
                    AND NOT array_contains(n.path,
                        CASE
                            WHEN e.`{src_col}` = n.node_id THEN e.`{dst_col}`
                            ELSE e.`{src_col}`
                        END
                    )
                    {edge_type_filter}
            """

            # The seed's only job is anchoring the BFS at the clicked node. A
            # nodeless context has no table to anchor against, so seed with the
            # id literally — an id absent from the edge table just yields zero
            # edges, the same observable result, without scanning anything.
            if node_table:
                seed = f"""
                SELECT
                    `{node_id_col}` AS node_id,
                    0 AS depth,
                    ARRAY(`{node_id_col}`) AS path
                FROM {node_table}
                WHERE `{node_id_col}` = '{safe_node_id}'
            """
            else:
                seed = f"""
                SELECT
                    '{safe_node_id}' AS node_id,
                    0 AS depth,
                    ARRAY('{safe_node_id}') AS path
            """

            query = f"""
            WITH RECURSIVE neighbors AS (
                {seed}

                UNION ALL

                {recursive_join}
            ),
            visited_nodes AS (
                SELECT DISTINCT node_id FROM neighbors
            )
            SELECT {build_edge_named_struct(column_config, "e")} AS r
            FROM {edge_table} e
            WHERE e.`{src_col}` IN (SELECT node_id FROM visited_nodes)
              AND e.`{dst_col}` IN (SELECT node_id FROM visited_nodes)
              {final_edge_filter}
            LIMIT {data.edge_limit}
        """

        return await self._execute(context, query, limit=data.edge_limit)

    async def fetch_nodes(
        self,
        context,
        node_ids: list[str],
        columns: Optional[list[str]] = None,
    ) -> tuple[list[Node], float]:
        node_columns = resolve_node_columns(context)
        if columns is not None and node_columns is not None:
            # Intersect with what the context exposes: the request can only ever
            # narrow, never widen. Unknown names are dropped rather than rejected,
            # so a stale client asking for a removed column still gets the rest.
            allowed = set(node_columns)
            node_columns = [c for c in dict.fromkeys(columns) if c in allowed]
        # When the context configures no properties there is no allow-list to
        # check against, so `columns` is ignored entirely and the query stays
        # SELECT n.*. Honouring arbitrary names here would let a caller probe the
        # table's schema by observing which ones error — the quoting in
        # build_node_projection stops injection, but not that.

        nodes, query_ms, _ = await fetch_nodes_by_ids(
            warehouse_client=self.warehouse,
            node_table=resolve_node_table(context),
            node_ids=node_ids,
            column_config=self._column_config(context),
            node_columns=node_columns,
        )
        return nodes, query_ms

    # ── Tabular / console mode ───────────────────────────────────────────

    def prepare_table_query(
        self, context, data: TableQueryRequest
    ) -> tuple[str, Optional[str], Optional[float]]:
        """Validate/transpile a console query. Returns (sql, transpiled_sql, ms)."""
        transpiled_sql: Optional[str] = None
        transpilation_ms: Optional[float] = None

        if data.mode == "cypher":
            # We deliberately skip the validate_cypher_query "RETURN r" gate —
            # arbitrary projections are the whole point of this endpoint. The
            # transpiler rejects invalid Cypher, and validate_sql_query below is
            # the read-only security boundary.
            t0 = time.perf_counter()
            try:
                sql = transpile_cypher_to_sql(
                    data.query,
                    context,
                    vlp_rendering_mode=data.vlp_rendering_mode,
                    materialization_strategy=data.materialization_strategy,
                    procedural_optimizations=data.procedural_optimizations,
                )
            except Exception as e:
                raise _invalid(
                    "CYPHER_TRANSPILE_ERROR",
                    f"{type(e).__name__}: {e}",
                    {"query": data.query},
                )
            transpilation_ms = (time.perf_counter() - t0) * 1000
            sql = self._apply_prefilter(context, sql, data.cte_prefilter)
            transpiled_sql = sql
        else:
            sql = data.query

        # Security boundary: read-only SELECT only (both modes).
        is_valid, error_msg = validate_sql_query(sql)
        if not is_valid:
            raise _invalid(
                "INVALID_SQL_QUERY",
                error_msg,
                {"query": sql} if data.mode == "sql" else {"transpiled_sql": sql},
            )

        return sql, transpiled_sql, transpilation_ms

    async def submit_table_query(
        self, context, data: TableQueryRequest
    ) -> TableQueryResponse:
        sql, transpiled_sql, transpilation_ms = self.prepare_table_query(context, data)

        # Submit for the cancellable poll flow. The statement runs with a short
        # wait_timeout: if it finishes in time we return the rows inline on this
        # first call (fast path); otherwise we return status="running" +
        # statement_id so the client can poll and cancel.
        t_exec_start = time.perf_counter()
        response = await self.warehouse.submit_statement(
            statement=sql,
            row_limit=data.row_limit,
        )

        state = response.status.state

        if state in ("PENDING", "RUNNING"):
            return TableQueryResponse(
                status="running",
                statement_id=response.statement_id,
                transpiled_sql=transpiled_sql,
                metadata=QueryMetadata(
                    transpilation_ms=(
                        round(transpilation_ms, 2)
                        if transpilation_ms is not None
                        else None
                    ),
                    total_ms=None,
                ),
            )

        # Terminal state — SUCCEEDED returns rows; anything else is an error.
        columns, rows, truncated = parse_tabular_result(
            response, query=sql, row_limit=data.row_limit
        )

        execution_ms = (time.perf_counter() - t_exec_start) * 1000
        total_ms = execution_ms + (transpilation_ms or 0.0)
        chunk_count, total_row_count = _manifest_counts(response)

        return TableQueryResponse(
            status="succeeded",
            statement_id=response.statement_id,
            columns=columns,
            rows=rows,
            row_count=len(rows),
            truncated=truncated,
            total_chunk_count=chunk_count,
            total_row_count=total_row_count,
            transpiled_sql=transpiled_sql,
            metadata=QueryMetadata(
                transpilation_ms=(
                    round(transpilation_ms, 2) if transpilation_ms is not None else None
                ),
                total_ms=round(total_ms, 2),
            ),
        )

    async def get_table_query_status(
        self, context, statement_id: str, row_limit: int
    ) -> TableQueryStatusResponse:
        response = await self.warehouse.get_statement(statement_id)
        state = response.status.state

        if state in ("PENDING", "RUNNING"):
            return TableQueryStatusResponse(status="running", statement_id=statement_id)

        if state in ("CANCELED", "CLOSED"):
            return TableQueryStatusResponse(
                status="canceled", statement_id=statement_id
            )

        columns, rows, truncated = parse_tabular_result(
            response, query=None, row_limit=row_limit
        )
        chunk_count, total_row_count = _manifest_counts(response)

        return TableQueryStatusResponse(
            status="succeeded",
            statement_id=statement_id,
            columns=columns,
            rows=rows,
            row_count=len(rows),
            truncated=truncated,
            total_chunk_count=chunk_count,
            total_row_count=total_row_count,
        )

    async def cancel_statement(self, statement_id: str) -> None:
        await self.warehouse.cancel_statement(statement_id)

    # ── Discovery ────────────────────────────────────────────────────────

    async def discover_types(self, request: Any) -> SchemaDiscoveryResponse:
        return await self.warehouse.discover_schema(
            edge_table=request.edge_table,
            node_table=request.node_table,
            columns=request.columns,
        )
