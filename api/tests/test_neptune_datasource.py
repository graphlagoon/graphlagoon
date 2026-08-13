"""NeptuneDatasource behaviour against a mocked Neptune HTTP endpoint.

Uses ``httpx.MockTransport`` so the real client, signing-free request path and
error translation all run — only the network is faked.
"""

import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from graphlagoon.services.datasource.neptune.client import NeptuneClient
from graphlagoon.services.datasource.neptune.datasource import NeptuneDatasource
from graphlagoon.services.graph_operations import QueryExecutionError

BASE_URL = "https://neptune.test:8182"


def node(node_id, labels, props=None):
    return {
        "~id": node_id,
        "~entityType": "node",
        "~labels": labels,
        "~properties": props or {},
    }


def rel(edge_id, start, end, rel_type):
    return {
        "~id": edge_id,
        "~entityType": "relationship",
        "~start": start,
        "~end": end,
        "~type": rel_type,
        "~properties": {},
    }


class FakeNeptune:
    """Records every openCypher request and replies with canned results."""

    def __init__(self, results=None, summary=None, error=None):
        self.results = results if results is not None else []
        self.summary = summary
        self.error = error
        self.requests = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path

        if path == "/pg/statistics/summary":
            if self.summary is None:
                return httpx.Response(404, json={"code": "StatisticsNotAvailable"})
            return httpx.Response(200, json={"payload": {"graphSummary": self.summary}})

        if path == "/openCypher":
            body = json.loads(request.content)
            params = body.get("parameters")
            self.requests.append(
                {
                    "query": body["query"],
                    "parameters": json.loads(params) if params else None,
                }
            )
            if self.error is not None:
                return httpx.Response(400, json=self.error)
            results = self.results
            if callable(results):
                results = results(body["query"])
            return httpx.Response(200, json={"results": results})

        return httpx.Response(404, json={"code": "NotFound"})

    @property
    def last_query(self):
        return self.requests[-1]["query"]

    @property
    def last_parameters(self):
        return self.requests[-1]["parameters"]


def build(fake: FakeNeptune, **kwargs) -> NeptuneDatasource:
    client = NeptuneClient(BASE_URL)
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
    return NeptuneDatasource(client, **kwargs)


CONTEXT = SimpleNamespace(id="ctx-1", datasource_type="neptune")


def request(**kwargs):
    """A duck-typed request object; only the fields the datasource reads."""
    defaults = {
        "query": "MATCH (n) RETURN n",
        "cte_prefilter": None,
        "use_external_links": False,
        "mode": "cypher",
        "row_limit": 1000,
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


class TestPrepareCypher:
    def test_passes_the_query_through_untranspiled(self):
        ds = build(FakeNeptune())
        prepared = ds.prepare_cypher(CONTEXT, request(query="MATCH (n) RETURN n"))
        assert prepared.statement == "MATCH (n) RETURN n"
        assert prepared.transpiled_sql is None
        assert prepared.transpilation_ms is None

    def test_accepts_a_path_projection_without_return_r(self):
        """The warehouse path's 'RETURN r' rule is a transpiler artifact."""
        ds = build(FakeNeptune())
        prepared = ds.prepare_cypher(
            CONTEXT, request(query="MATCH p = (a)-[:KNOWS]->(b) RETURN p")
        )
        assert prepared.statement.endswith("RETURN p")

    @pytest.mark.parametrize(
        "query",
        [
            "CREATE (n:Person) RETURN n",
            "MATCH (n) DETACH DELETE n",
            "MATCH (n) SET n.x = 1 RETURN n",
            "MATCH (n) REMOVE n:Person RETURN n",
            "MERGE (n:Person) RETURN n",
            "MATCH (n) CALL db.labels() RETURN n",
        ],
    )
    def test_rejects_writes(self, query):
        ds = build(FakeNeptune())
        with pytest.raises(HTTPException) as exc:
            ds.prepare_cypher(CONTEXT, request(query=query))
        assert exc.value.status_code == 400
        assert exc.value.detail["error"]["code"] == "INVALID_CYPHER_QUERY"

    def test_rejects_a_query_not_starting_with_match(self):
        ds = build(FakeNeptune())
        with pytest.raises(HTTPException) as exc:
            ds.prepare_cypher(CONTEXT, request(query="RETURN 1"))
        assert "must start with MATCH" in exc.value.detail["error"]["message"]

    def test_rejects_a_cte_prefilter(self):
        ds = build(FakeNeptune())
        with pytest.raises(HTTPException) as exc:
            ds.prepare_cypher(CONTEXT, request(cte_prefilter="WITH x AS (SELECT 1)"))
        assert exc.value.detail["error"]["code"] == "DATASOURCE_UNSUPPORTED_OPERATION"


class TestExecute:
    @pytest.mark.asyncio
    async def test_returns_nodes_and_edges(self):
        fake = FakeNeptune(
            [
                {
                    "a": node("n1", ["Person"], {"name": "Alice"}),
                    "r": rel("e1", "n1", "n2", "KNOWS"),
                    "b": node("n2", ["Person"], {"name": "Bob"}),
                }
            ]
        )
        ds = build(fake)
        prepared = ds.prepare_cypher(
            CONTEXT, request(query="MATCH (a)-[r]->(b) RETURN a, r, b")
        )
        result = await ds.execute_prepared(CONTEXT, prepared)

        assert {n.node_id for n in result.nodes} == {"n1", "n2"}
        assert [e.relationship_type for e in result.edges] == ["KNOWS"]
        assert result.metadata.node_count == 2
        assert result.metadata.edge_count == 1

    @pytest.mark.asyncio
    async def test_fetches_endpoints_the_query_did_not_project(self):
        def results(query):
            if "IN $ids" in query:
                return [{"n": node("n1", ["Person"])}, {"n": node("n2", ["Person"])}]
            return [{"r": rel("e1", "n1", "n2", "KNOWS")}]

        fake = FakeNeptune(results)
        ds = build(fake)
        prepared = ds.prepare_cypher(
            CONTEXT, request(query="MATCH ()-[r]->() RETURN r")
        )
        result = await ds.execute_prepared(CONTEXT, prepared)

        assert {n.node_id for n in result.nodes} == {"n1", "n2"}
        assert len(fake.requests) == 2
        assert fake.last_parameters == {"ids": ["n1", "n2"]}

    @pytest.mark.asyncio
    async def test_no_follow_up_when_every_endpoint_was_returned(self):
        fake = FakeNeptune(
            [
                {
                    "a": node("n1", ["P"]),
                    "r": rel("e1", "n1", "n2", "K"),
                    "b": node("n2", ["P"]),
                }
            ]
        )
        ds = build(fake)
        prepared = ds.prepare_cypher(
            CONTEXT, request(query="MATCH (a)-[r]->(b) RETURN a, r, b")
        )
        await ds.execute_prepared(CONTEXT, prepared)
        assert len(fake.requests) == 1

    @pytest.mark.asyncio
    async def test_flags_truncation_from_the_querys_own_limit(self):
        fake = FakeNeptune([{"n": node(f"n{i}", ["P"])} for i in range(5)])
        ds = build(fake)
        prepared = ds.prepare_cypher(
            CONTEXT, request(query="MATCH (n) RETURN n LIMIT 5")
        )
        result = await ds.execute_prepared(CONTEXT, prepared)
        assert result.truncated is True


class TestGeneratedQueries:
    @pytest.mark.asyncio
    async def test_subgraph_without_type_filter(self):
        fake = FakeNeptune()
        ds = build(fake)
        await ds.get_subgraph(
            CONTEXT, SimpleNamespace(edge_limit=250, edge_types=[], nodes_mode="full")
        )
        assert fake.last_query == "MATCH (a)-[r]->(b)  RETURN a, r, b LIMIT 250"
        assert fake.last_parameters is None

    @pytest.mark.asyncio
    async def test_subgraph_with_type_filter_parameterizes_the_types(self):
        fake = FakeNeptune()
        ds = build(fake)
        await ds.get_subgraph(
            CONTEXT,
            SimpleNamespace(
                edge_limit=100, edge_types=["KNOWS", "OWNS"], nodes_mode="full"
            ),
        )
        assert "WHERE type(r) IN $types" in fake.last_query
        assert fake.last_parameters == {"types": ["KNOWS", "OWNS"]}

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "directed,depth,expected_pattern",
        [
            (True, 1, "-[r*1..1]->"),
            (True, 2, "-[r*1..2]->"),
            (False, 1, "-[r*1..1]-"),
            (False, 2, "-[r*1..2]-"),
        ],
    )
    async def test_expand_pattern_covers_direction_and_depth(
        self, directed, depth, expected_pattern
    ):
        fake = FakeNeptune()
        ds = build(fake)
        await ds.expand(
            CONTEXT,
            SimpleNamespace(
                node_id="n1",
                depth=depth,
                edge_limit=50,
                directed=directed,
                edge_types=[],
            ),
        )
        assert expected_pattern in fake.last_query
        assert fake.last_parameters == {"node_id": "n1"}

    @pytest.mark.asyncio
    async def test_expand_quotes_relationship_types_in_the_pattern(self):
        fake = FakeNeptune()
        ds = build(fake)
        await ds.expand(
            CONTEXT,
            SimpleNamespace(
                node_id="n1",
                depth=1,
                edge_limit=50,
                directed=True,
                edge_types=["KNOWS", "WORKS AT"],
            ),
        )
        assert "[r:`KNOWS`|`WORKS AT`*1..1]" in fake.last_query

    @pytest.mark.asyncio
    async def test_expand_strips_backticks_from_type_names(self):
        """Backticks are the only way to break out of the quoting."""
        fake = FakeNeptune()
        ds = build(fake)
        await ds.expand(
            CONTEXT,
            SimpleNamespace(
                node_id="n1",
                depth=1,
                edge_limit=50,
                directed=True,
                edge_types=["EVIL`] - () DETACH DELETE n //"],
            ),
        )
        assert "DETACH DELETE" in fake.last_query  # interpolated as a label name…
        assert "`]" not in fake.last_query  # …but it cannot close the bracket

    @pytest.mark.asyncio
    async def test_fetch_nodes_uses_a_parameterized_id_list(self):
        fake = FakeNeptune([{"n": node("n1", ["P"])}])
        ds = build(fake)
        nodes, _ = await ds.fetch_nodes(CONTEXT, ["n1", "n2"], columns=["name"])
        assert fake.last_query == "MATCH (n) WHERE id(n) IN $ids RETURN n"
        assert fake.last_parameters == {"ids": ["n1", "n2"]}
        assert [n.node_id for n in nodes] == ["n1"]


class TestTableMode:
    @pytest.mark.asyncio
    async def test_cypher_projection_returns_rows_inline(self):
        fake = FakeNeptune([{"name": "Alice", "n": 3}, {"name": "Bob", "n": 5}])
        ds = build(fake)
        response = await ds.submit_table_query(
            CONTEXT, request(query="MATCH (p:Person) RETURN p.name AS name, 1 AS n")
        )
        assert response.status == "succeeded"
        # No statement id means the client never enters the poll/cancel flow.
        assert response.statement_id is None
        assert response.columns == ["name", "n"]
        assert response.row_count == 2
        assert response.transpiled_sql is None

    @pytest.mark.asyncio
    async def test_sql_mode_is_rejected(self):
        ds = build(FakeNeptune())
        with pytest.raises(HTTPException) as exc:
            await ds.submit_table_query(CONTEXT, request(mode="sql", query="SELECT 1"))
        assert exc.value.detail["error"]["code"] == "DATASOURCE_UNSUPPORTED_OPERATION"

    @pytest.mark.asyncio
    async def test_write_query_is_rejected(self):
        ds = build(FakeNeptune())
        with pytest.raises(HTTPException) as exc:
            await ds.submit_table_query(CONTEXT, request(query="MATCH (n) DELETE n"))
        assert exc.value.detail["error"]["code"] == "INVALID_CYPHER_QUERY"


class TestErrorTranslation:
    @pytest.mark.asyncio
    async def test_malformed_query_becomes_invalid_cypher(self):
        fake = FakeNeptune(
            error={
                "requestId": "req-1",
                "code": "MalformedQueryException",
                "detailedMessage": "Invalid input 'RETURNN'",
            }
        )
        ds = build(fake)
        prepared = ds.prepare_cypher(CONTEXT, request())
        with pytest.raises(QueryExecutionError) as exc:
            await ds.execute_prepared(CONTEXT, prepared)
        assert exc.value.code == "INVALID_CYPHER_QUERY"
        assert "Invalid input" in exc.value.message

    @pytest.mark.asyncio
    async def test_other_failures_are_generic_execution_errors(self):
        fake = FakeNeptune(
            error={
                "requestId": "req-2",
                "code": "TimeLimitExceededException",
                "detailedMessage": "Query exceeded the time limit",
            }
        )
        ds = build(fake)
        prepared = ds.prepare_cypher(CONTEXT, request())
        with pytest.raises(QueryExecutionError) as exc:
            await ds.execute_prepared(CONTEXT, prepared)
        assert exc.value.code == "QUERY_EXECUTION_ERROR"

    @pytest.mark.asyncio
    async def test_never_reports_stale_context_schema(self):
        """That diagnosis is Spark-specific and meaningless for a schemaless DB."""
        fake = FakeNeptune(
            error={
                "code": "BadRequestException",
                "detailedMessage": (
                    "[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column named `email` "
                    "cannot be resolved"
                ),
            }
        )
        ds = build(fake)
        prepared = ds.prepare_cypher(CONTEXT, request())
        with pytest.raises(QueryExecutionError) as exc:
            await ds.execute_prepared(CONTEXT, prepared)
        assert exc.value.code == "QUERY_EXECUTION_ERROR"


class TestDiscovery:
    @pytest.mark.asyncio
    async def test_prefers_the_summary_api(self):
        fake = FakeNeptune(
            summary={"nodeLabels": ["Person", "Company"], "edgeLabels": ["WORKS_AT"]}
        )
        ds = build(fake)
        result = await ds.discover_types(SimpleNamespace())
        assert result.node_types == ["Company", "Person"]
        assert result.relationship_types == ["WORKS_AT"]
        # The summary answered it — no scan was needed.
        assert fake.requests == []

    @pytest.mark.asyncio
    async def test_falls_back_to_sampling_when_no_summary(self):
        def results(query):
            if "labels(n)" in query:
                return [{"label": "Person"}, {"label": "Company"}]
            return [{"label": "WORKS_AT"}]

        fake = FakeNeptune(results, summary=None)
        ds = build(fake, discovery_sample_limit=500)
        result = await ds.discover_types(SimpleNamespace())

        assert result.node_types == ["Company", "Person"]
        assert result.relationship_types == ["WORKS_AT"]
        assert "LIMIT 500" in fake.requests[0]["query"]

    @pytest.mark.asyncio
    async def test_one_sided_discovery_failure_keeps_the_other_side(self):
        """A graph with labels but a failing edge scan still reports its labels."""

        def handler(request):
            if request.url.path == "/pg/statistics/summary":
                return httpx.Response(404, json={"code": "StatisticsNotAvailable"})
            query = json.loads(request.content)["query"]
            if "labels(n)" in query:
                return httpx.Response(200, json={"results": [{"label": "Person"}]})
            return httpx.Response(500, json={"code": "InternalFailureException"})

        client = NeptuneClient(BASE_URL)
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        ds = NeptuneDatasource(client)

        result = await ds.discover_types(SimpleNamespace())
        assert result.node_types == ["Person"]
        assert result.relationship_types == []
