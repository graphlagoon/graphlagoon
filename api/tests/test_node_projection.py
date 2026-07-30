"""Tests for the node-query column projection (Phase 1 of the initial-load work).

The node query used to be an unconditional ``SELECT n.*``, pulling every column
of the node table on every graph load. Node ``properties`` dominate the payload
(scan cost, wire size, and the client's reactive-wrap cost) while contributing
nothing to rendering, so contexts that declare ``node_properties`` now get a
narrowed projection.

The narrowing is opt-in by data: a context with no configured properties keeps
``SELECT n.*``, because we have not been told which columns matter and silently
dropping them would break tooltips and the data table.
"""

import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock as _MagicMock

import pytest

# Stub gsql2rsql only when genuinely absent — stubbing it while installed
# poisons the import for test_transpile_options (see test_graph_error_handling).
try:
    import gsql2rsql  # noqa: F401
except ImportError:
    for _name in (
        "gsql2rsql",
        "gsql2rsql.parser",
        "gsql2rsql.parser.opencypher_parser",
        "gsql2rsql.planner",
        "gsql2rsql.planner.logical_plan",
        "gsql2rsql.planner.subquery_flattening",
        "gsql2rsql.planner.pass_manager",
        "gsql2rsql.renderer",
        "gsql2rsql.renderer.sql_renderer",
        "gsql2rsql.renderer.schema_provider",
        "gsql2rsql.common",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from graphlagoon.models.schemas import (  # noqa: E402
    ColumnConfig,
    PropertyColumn,
    StatementResponse,
    StatementStatus,
    StatementResultData,
    StatementResultManifest,
    StatementResultSchema,
    StatementColumnInfo,
)
from graphlagoon.routers.graph import resolve_node_columns  # noqa: E402
from graphlagoon.services.graph_operations import (  # noqa: E402
    build_node_projection,
    execute_graph_query_with_nodes,
    harvest_nodes_from_result,
    process_nodes_result,
)


def _make_response(columns: list[str], rows: list[list]) -> StatementResponse:
    return StatementResponse(
        statement_id="stmt-1",
        status=StatementStatus(state="SUCCEEDED"),
        manifest=StatementResultManifest(
            format="JSON_ARRAY",
            schema=StatementResultSchema(
                column_count=len(columns),
                columns=[
                    StatementColumnInfo(
                        name=col,
                        position=i,
                        type_name="STRING",
                        type_text="STRING",
                    )
                    for i, col in enumerate(columns)
                ],
            ),
            total_row_count=len(rows),
        ),
        result=StatementResultData(row_count=len(rows), data_array=rows),
    )


def _warehouse_returning_edge_then_node():
    """Warehouse stub: first call answers edges, second answers nodes.

    Returns (client, captured_statements) where captured_statements records the
    SQL of every submitted statement, so tests can assert on the node query the
    funnel actually built.
    """
    edge_row = [
        '{"edge_id": "e1", "src": "n1", "dst": "n2",' ' "relationship_type": "KNOWS"}'
    ]
    responses = [
        _make_response(["r"], [edge_row]),
        _make_response(
            ["node_id", "node_type", "name"],
            [["n1", "Person", "Alice"], ["n2", "Person", "Bob"]],
        ),
    ]
    captured: list[str] = []

    async def _execute(statement, **kwargs):
        captured.append(statement)
        return responses[min(len(captured) - 1, len(responses) - 1)]

    client = _MagicMock()
    client.execute_statement = AsyncMock(side_effect=_execute)
    return client, captured


DEFAULT_CONFIG = ColumnConfig()

CUSTOM_CONFIG = ColumnConfig(
    node_id_col="id",
    node_type_col="label",
)


class TestBuildNodeProjection:
    def test_none_keeps_select_star(self):
        """No configured properties → historical behaviour, unchanged."""
        assert build_node_projection(DEFAULT_CONFIG, None) == "n.*"

    def test_projects_structural_columns_plus_properties(self):
        sql = build_node_projection(DEFAULT_CONFIG, ["name", "age"])
        assert sql == "n.`node_id`, n.`node_type`, n.`name`, n.`age`"

    def test_uses_the_contexts_own_structural_column_names(self):
        sql = build_node_projection(CUSTOM_CONFIG, ["name"])
        assert sql == "n.`id`, n.`label`, n.`name`"

    def test_empty_list_yields_structural_columns_only(self):
        """The 'types-only' projection Phase 2 needs: renderable, no properties."""
        assert build_node_projection(DEFAULT_CONFIG, []) == "n.`node_id`, n.`node_type`"

    def test_deduplicates_property_that_repeats_a_structural_column(self):
        """Selecting the same column twice is a SQL error on some engines."""
        sql = build_node_projection(DEFAULT_CONFIG, ["node_id", "name"])
        assert sql == "n.`node_id`, n.`node_type`, n.`name`"

    def test_deduplicates_repeated_properties(self):
        sql = build_node_projection(DEFAULT_CONFIG, ["name", "name"])
        assert sql == "n.`node_id`, n.`node_type`, n.`name`"

    def test_quotes_columns_needing_escaping(self):
        """Names with spaces/reserved words must survive; backticks are escaped."""
        sql = build_node_projection(DEFAULT_CONFIG, ["full name", "we`ird"])
        assert "n.`full name`" in sql
        assert "n.`we``ird`" in sql

    def test_every_column_is_qualified_by_the_join_alias(self):
        """The node query joins a VALUES relation, so bare names are ambiguous."""
        sql = build_node_projection(DEFAULT_CONFIG, ["name", "age"])
        for part in sql.split(", "):
            assert part.startswith("n.")


class TestResolveNodeColumns:
    def test_no_properties_returns_none(self):
        ctx = SimpleNamespace(node_properties=[])
        assert resolve_node_columns(ctx) is None

    def test_missing_attribute_returns_none(self):
        assert resolve_node_columns(SimpleNamespace()) is None

    def test_reads_pydantic_property_columns(self):
        ctx = SimpleNamespace(
            node_properties=[
                PropertyColumn(name="name", data_type="string"),
                PropertyColumn(name="age", data_type="int"),
            ]
        )
        assert resolve_node_columns(ctx) == ["name", "age"]

    def test_reads_dict_shaped_property_columns(self):
        """Contexts round-trip as dicts through the in-memory store."""
        ctx = SimpleNamespace(node_properties=[{"name": "name", "data_type": "string"}])
        assert resolve_node_columns(ctx) == ["name"]

    def test_skips_entries_without_a_name(self):
        ctx = SimpleNamespace(node_properties=[{"data_type": "string"}])
        assert resolve_node_columns(ctx) is None


class TestProjectionRoundTrip:
    """The narrowed projection must still parse into the same Node shape."""

    def test_narrowed_result_populates_properties(self):
        columns = ["node_id", "node_type", "name"]
        rows = [["n1", "Person", "Alice"]]

        nodes = process_nodes_result(columns, rows, DEFAULT_CONFIG)

        assert len(nodes) == 1
        assert nodes[0].node_id == "n1"
        assert nodes[0].node_type == "Person"
        assert nodes[0].properties == {"name": "Alice"}

    def test_structural_only_result_yields_null_properties(self):
        """Phase 2 relies on this: renderable nodes carrying no properties."""
        nodes = process_nodes_result(
            ["node_id", "node_type"], [["n1", "Person"]], DEFAULT_CONFIG
        )

        assert nodes[0].node_id == "n1"
        assert nodes[0].node_type == "Person"
        assert nodes[0].properties is None


class TestFunnelAppliesProjection:
    """The projection must reach the SQL the warehouse actually receives."""

    @pytest.mark.asyncio
    async def test_node_columns_narrow_the_executed_node_query(self):
        client, captured = _warehouse_returning_edge_then_node()

        await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
            node_columns=["name"],
        )

        node_query = captured[1]
        assert "n.`node_id`, n.`node_type`, n.`name`" in node_query
        assert "SELECT n.*" not in node_query

    @pytest.mark.asyncio
    async def test_default_keeps_select_star(self):
        """Omitting node_columns must not change the historical query."""
        client, captured = _warehouse_returning_edge_then_node()

        await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
        )

        assert "SELECT n.*" in captured[1]

    @pytest.mark.asyncio
    async def test_narrowed_projection_still_returns_usable_nodes(self):
        """Narrowing is invisible to the response contract."""
        client, _ = _warehouse_returning_edge_then_node()

        response = await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
            node_columns=["name"],
        )

        assert len(response.edges) == 1
        assert {n.node_id for n in response.nodes} == {"n1", "n2"}
        assert response.nodes[0].properties == {"name": "Alice"}

    @pytest.mark.asyncio
    async def test_join_condition_survives_narrowing(self):
        """The VALUES join is what makes large id sets fast — keep it."""
        client, captured = _warehouse_returning_edge_then_node()

        await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
            node_columns=["name"],
        )

        node_query = captured[1]
        assert "JOIN (VALUES" in node_query
        assert "_node_ids._id" in node_query


class TestHarvestNodesFromResult:
    """Reuse node rows the query already returned (transpiled Cypher path)."""

    def test_harvests_node_struct_by_id_column(self):
        rows = [['{"node_id": "n1", "node_type": "Person", "name": "Alice"}']]

        harvested = harvest_nodes_from_result(["a"], rows, DEFAULT_CONFIG)

        assert set(harvested) == {"n1"}
        assert harvested["n1"].node_type == "Person"
        assert harvested["n1"].properties == {"name": "Alice"}

    def test_ignores_the_edge_column(self):
        """'r' is the edge struct — process_graph_query_result owns it."""
        rows = [['{"node_id": "n1", "node_type": "Person"}']]

        assert harvest_nodes_from_result(["r"], rows, DEFAULT_CONFIG) == {}

    def test_ignores_structs_without_the_node_id_column(self):
        """Scalar/aggregate projections must not be mistaken for nodes."""
        rows = [['{"count": 3, "label": "x"}']]

        assert harvest_nodes_from_result(["agg"], rows, DEFAULT_CONFIG) == {}

    def test_ignores_non_struct_values(self):
        rows = [["plain string", "42"]]

        assert harvest_nodes_from_result(["a", "b"], rows, DEFAULT_CONFIG) == {}

    def test_harvests_from_collected_lists(self):
        """collect(a) renders as an array of structs."""
        rows = [
            [
                '[{"node_id": "n1", "node_type": "Person"},'
                ' {"node_id": "n2", "node_type": "Person"}]'
            ]
        ]

        harvested = harvest_nodes_from_result(["nodes"], rows, DEFAULT_CONFIG)

        assert set(harvested) == {"n1", "n2"}

    def test_prefers_the_richest_struct_for_a_repeated_node(self):
        """The same node in two projections: keep the one with properties."""
        rows = [
            ['{"node_id": "n1"}', '{"node_id": "n1", "name": "Alice"}'],
        ]

        harvested = harvest_nodes_from_result(["a", "b"], rows, DEFAULT_CONFIG)

        assert harvested["n1"].properties == {"name": "Alice"}

    def test_uses_the_contexts_own_column_names(self):
        rows = [['{"id": "n1", "label": "Person"}']]

        harvested = harvest_nodes_from_result(["a"], rows, CUSTOM_CONFIG)

        assert harvested["n1"].node_type == "Person"

    def test_tolerates_rows_shorter_than_the_column_list(self):
        harvested = harvest_nodes_from_result(["a", "b"], [[]], DEFAULT_CONFIG)

        assert harvested == {}


class TestFunnelSkipsRedundantNodeQuery:
    @pytest.mark.asyncio
    async def test_no_node_query_when_every_node_was_harvested(self):
        """The whole point: a Cypher result carrying its nodes costs 1 query."""
        edge_and_nodes = [
            '{"edge_id": "e1", "src": "n1", "dst": "n2",'
            ' "relationship_type": "KNOWS"}',
            '{"node_id": "n1", "node_type": "Person", "name": "Alice"}',
            '{"node_id": "n2", "node_type": "Person", "name": "Bob"}',
        ]
        captured: list[str] = []

        async def _execute(statement, **kwargs):
            captured.append(statement)
            return _make_response(["r", "a", "b"], [edge_and_nodes])

        client = _MagicMock()
        client.execute_statement = AsyncMock(side_effect=_execute)

        response = await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="MATCH ... RETURN r, a, b",
            limit=None,
            column_config=DEFAULT_CONFIG,
        )

        assert len(captured) == 1, "a second warehouse round-trip still ran"
        assert {n.node_id for n in response.nodes} == {"n1", "n2"}
        assert response.metadata.node_query_ms == 0.0

    @pytest.mark.asyncio
    async def test_fetches_only_the_nodes_that_were_not_harvested(self):
        """Partial harvest: the follow-up query must shrink, not disappear."""
        first_row = [
            '{"edge_id": "e1", "src": "n1", "dst": "n2",'
            ' "relationship_type": "KNOWS"}',
            '{"node_id": "n1", "node_type": "Person", "name": "Alice"}',
        ]
        captured: list[str] = []

        async def _execute(statement, **kwargs):
            captured.append(statement)
            if len(captured) == 1:
                return _make_response(["r", "a"], [first_row])
            return _make_response(
                ["node_id", "node_type", "name"], [["n2", "Person", "Bob"]]
            )

        client = _MagicMock()
        client.execute_statement = AsyncMock(side_effect=_execute)

        response = await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="MATCH ... RETURN r, a",
            limit=None,
            column_config=DEFAULT_CONFIG,
        )

        node_query = captured[1]
        assert "('n2')" in node_query
        assert "('n1')" not in node_query, "already-harvested node re-fetched"
        assert {n.node_id for n in response.nodes} == {"n1", "n2"}

    @pytest.mark.asyncio
    async def test_subgraph_path_is_unaffected(self):
        """Edges-only results harvest nothing: the node query runs as before."""
        client, captured = _warehouse_returning_edge_then_node()

        response = await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
        )

        assert len(captured) == 2
        assert {n.node_id for n in response.nodes} == {"n1", "n2"}


class TestHarvestedValuesMatchFetchedValues:
    """Both paths must yield identical property values for the same node.

    Struct fields survive JSON decoding as real numbers/booleans, while
    top-level columns arrive from the statements API already stringified. Left
    unnormalised, a property would change type depending on whether the query
    returned node variables — silently breaking client-side property filters
    and sorting, which compare raw values.
    """

    def test_numbers_inside_structs_are_stringified(self):
        rows = [['{"node_id": "n1", "node_type": "T", "score": 1.5}']]

        harvested = harvest_nodes_from_result(["a"], rows, DEFAULT_CONFIG)

        assert harvested["n1"].properties == {"score": "1.5"}

    def test_booleans_use_python_str_like_the_warehouse(self):
        """Verified empirically: the warehouse emits 'True', not 'true'."""
        rows = [['{"node_id": "n1", "node_type": "T", "flag": true}']]

        harvested = harvest_nodes_from_result(["a"], rows, DEFAULT_CONFIG)

        assert harvested["n1"].properties == {"flag": "True"}

    def test_integers_are_stringified(self):
        rows = [['{"node_id": "n1", "node_type": "T", "count": 42}']]

        harvested = harvest_nodes_from_result(["a"], rows, DEFAULT_CONFIG)

        assert harvested["n1"].properties == {"count": "42"}

    def test_nested_containers_stay_decoded(self):
        """Containers are dicts/lists on BOTH paths — do not stringify them."""
        rows = [['{"node_id": "n1", "node_type": "T", "tags": ["a", "b"]}']]

        harvested = harvest_nodes_from_result(["a"], rows, DEFAULT_CONFIG)

        assert harvested["n1"].properties == {"tags": ["a", "b"]}

    def test_harvested_matches_process_nodes_result_exactly(self):
        """The equivalence that matters, asserted end to end."""
        struct_rows = [['{"node_id": "n1", "node_type": "T", "score": 1.5}']]
        harvested = harvest_nodes_from_result(["a"], struct_rows, DEFAULT_CONFIG)

        # Same node arriving through the node query: the statements API has
        # already applied str() to every scalar column.
        fetched = process_nodes_result(
            ["node_id", "node_type", "score"], [["n1", "T", "1.5"]], DEFAULT_CONFIG
        )

        assert harvested["n1"].properties == fetched[0].properties
        assert harvested["n1"].node_type == fetched[0].node_type


class TestNodeBatchColumnNarrowing:
    """The /nodes/batch `columns` field may only narrow the projection.

    On a 100-column table, enriching every node with every column costs more
    than the single request progressive loading replaced (~36 MB for 19k
    nodes), so the client asks for the handful it actually displays.
    """

    @staticmethod
    def _resolve(context_props, requested):
        """Mirror of the endpoint's narrowing rule, kept in one place."""
        from graphlagoon.routers.graph import resolve_node_columns

        node_columns = resolve_node_columns(
            SimpleNamespace(node_properties=context_props)
        )
        if requested is not None and node_columns is not None:
            allowed = set(node_columns)
            node_columns = [c for c in dict.fromkeys(requested) if c in allowed]
        return node_columns

    def test_narrows_to_the_requested_subset(self):
        props = [{"name": n, "data_type": "string"} for n in ("a", "b", "c")]

        assert self._resolve(props, ["a", "c"]) == ["a", "c"]

    def test_drops_columns_the_context_does_not_expose(self):
        props = [{"name": "a", "data_type": "string"}]

        assert self._resolve(props, ["a", "secret_salary"]) == ["a"]

    def test_cannot_widen_beyond_the_context(self):
        props = [{"name": n, "data_type": "string"} for n in ("a", "b")]

        # Asking for everything under the sun still yields only a, b.
        assert self._resolve(props, ["a", "b", "c", "d"]) == ["a", "b"]

    def test_deduplicates_requested_columns(self):
        props = [{"name": "a", "data_type": "string"}]

        assert self._resolve(props, ["a", "a"]) == ["a"]

    def test_omitting_columns_keeps_the_full_context_projection(self):
        props = [{"name": n, "data_type": "string"} for n in ("a", "b")]

        assert self._resolve(props, None) == ["a", "b"]

    def test_unconfigured_context_ignores_requested_columns(self):
        # No allow-list to validate against: honouring arbitrary names would
        # let a caller probe the table schema by seeing which ones error.
        assert self._resolve([], ["anything"]) is None

    def test_injection_attempt_is_neutralised_by_quoting(self):
        """Defence in depth: even a name that slips through is inert."""
        sql = build_node_projection(DEFAULT_CONFIG, ["x`); DROP TABLE t; --"])

        # Escaped and wrapped: one identifier, not a statement boundary.
        assert "n.`x``); DROP TABLE t; --`" in sql
        assert sql.count("`") % 2 == 0


class TestPartialResultCallback:
    """The funnel publishes a renderable intermediate before the full fetch.

    Measured on a 100-column table: the partial lands at ~4.6s versus ~10.4s
    for the complete result, so the user sees a graph roughly twice as early.
    """

    @pytest.mark.asyncio
    async def test_publishes_a_partial_before_the_full_result(self):
        client, captured = _warehouse_returning_edge_then_node()
        partials = []

        response = await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
            node_columns=["name"],
            on_partial=partials.append,
        )

        assert len(partials) == 1
        partial = partials[0]
        # The partial must be renderable: same edges, nodes carrying types.
        assert len(partial.edges) == len(response.edges)
        assert {n.node_id for n in partial.nodes} == {n.node_id for n in response.nodes}
        assert partial.properties_deferred is True
        # ...and the full result still arrives complete.
        assert response.nodes[0].properties is not None

    @pytest.mark.asyncio
    async def test_partial_query_selects_only_structural_columns(self):
        client, captured = _warehouse_returning_edge_then_node()

        await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
            node_columns=["name"],
            on_partial=lambda _p: None,
        )

        # captured[1] is the partial (types-only) query, captured[2] the full one.
        assert "n.`node_id`, n.`node_type`" in captured[1]
        assert "n.`name`" not in captured[1]
        assert "n.`name`" in captured[2]

    @pytest.mark.asyncio
    async def test_no_partial_without_a_callback(self):
        """Default behaviour is unchanged: one node query, no extra round-trip."""
        client, captured = _warehouse_returning_edge_then_node()

        await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
        )

        assert len(captured) == 2  # edges + nodes only

    @pytest.mark.asyncio
    async def test_types_mode_skips_the_partial(self):
        """In types mode the main query already IS the types query."""
        client, captured = _warehouse_returning_edge_then_node()
        partials = []

        await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
            nodes_mode="types",
            on_partial=partials.append,
        )

        assert partials == []
        assert len(captured) == 2

    @pytest.mark.asyncio
    async def test_a_failing_partial_does_not_fail_the_job(self):
        """Best effort: the full fetch below still produces the real result."""
        client, _ = _warehouse_returning_edge_then_node()

        def explode(_partial):
            raise RuntimeError("callback blew up")

        response = await execute_graph_query_with_nodes(
            warehouse_client=client,
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
            on_partial=explode,
        )

        assert {n.node_id for n in response.nodes} == {"n1", "n2"}


class TestExtractQueryLimit:
    """The query endpoints take the cap from the user's SQL, not a parameter."""

    def test_reads_a_top_level_limit(self):
        from graphlagoon.services.sql_validation import extract_query_limit

        assert extract_query_limit("SELECT x AS r FROM t LIMIT 500") == 500

    def test_returns_none_without_a_limit(self):
        from graphlagoon.services.sql_validation import extract_query_limit

        assert extract_query_limit("SELECT x AS r FROM t") is None

    def test_ignores_a_limit_inside_a_cte(self):
        """A regex would grab the inner 5; only the outer cap truncates."""
        from graphlagoon.services.sql_validation import extract_query_limit

        sql = "WITH c AS (SELECT 1 LIMIT 5) SELECT x AS r FROM c LIMIT 99"
        assert extract_query_limit(sql) == 99

    def test_unparseable_sql_yields_none(self):
        """Cannot claim truncation for a query we do not understand."""
        from graphlagoon.services.sql_validation import extract_query_limit

        assert extract_query_limit("NOT SQL AT ALL (((") is None


class TestTruncationReporting:
    """A truncated graph looks exactly like a complete one — say so."""

    @staticmethod
    def _warehouse(edge_count: int):
        rows = [
            [
                '{"edge_id": "e%d", "src": "n%d", "dst": "n%d",'
                ' "relationship_type": "R"}' % (i, i, i + 1)
            ]
            for i in range(edge_count)
        ]
        node_rows = [[f"n{i}", "T", "x"] for i in range(edge_count + 1)]
        responses = [
            _make_response(["r"], rows),
            _make_response(["node_id", "node_type", "name"], node_rows),
        ]
        captured: list[str] = []

        async def _execute(statement, **kwargs):
            captured.append(statement)
            return responses[min(len(captured) - 1, len(responses) - 1)]

        client = _MagicMock()
        client.execute_statement = AsyncMock(side_effect=_execute)
        return client

    @pytest.mark.asyncio
    async def test_flags_truncation_when_the_cap_is_hit(self):
        response = await execute_graph_query_with_nodes(
            warehouse_client=self._warehouse(10),
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
        )

        assert response.truncated is True
        assert response.total_count == 10

    @pytest.mark.asyncio
    async def test_does_not_flag_a_result_under_the_cap(self):
        response = await execute_graph_query_with_nodes(
            warehouse_client=self._warehouse(3),
            node_table="cat.sch.nodes",
            query="SELECT ... AS r FROM edges LIMIT 10",
            limit=10,
            column_config=DEFAULT_CONFIG,
        )

        assert response.truncated is False
        assert response.total_count == 3

    @pytest.mark.asyncio
    async def test_reads_the_cap_from_the_query_when_no_limit_is_passed(self):
        """The query endpoints pass limit=None — the cap lives in the SQL."""
        response = await execute_graph_query_with_nodes(
            warehouse_client=self._warehouse(10),
            node_table="cat.sch.nodes",
            query="SELECT foo AS r FROM edges LIMIT 10",
            limit=None,
            column_config=DEFAULT_CONFIG,
        )

        assert response.truncated is True

    @pytest.mark.asyncio
    async def test_no_truncation_claim_without_any_cap(self):
        """No LIMIT anywhere: we genuinely do not know, so do not claim."""
        response = await execute_graph_query_with_nodes(
            warehouse_client=self._warehouse(10),
            node_table="cat.sch.nodes",
            query="SELECT foo AS r FROM edges",
            limit=None,
            column_config=DEFAULT_CONFIG,
        )

        assert response.truncated is False
        assert response.total_count == 10
