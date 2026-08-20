"""RestDatasource behaviour against a mocked remote API.

Uses ``httpx.MockTransport`` so the real client, header merging, error
translation and response mapping all run — only the network is faked.
"""

import json

import httpx
import pytest
from fastapi import HTTPException

from graphlagoon.models.schemas import (
    ExpandRequest,
    SubgraphRequest,
    TableQueryRequest,
)
from graphlagoon.services.datasource.base import GraphExecutionFailure
from graphlagoon.services.datasource.rest import (
    RestConnectionSpec,
    RestConnectionUI,
    RestDatasource,
    RestRequest,
    clear_rest_registry,
    get_rest_connection,
    register_rest_connection,
    validate_spec,
)
from graphlagoon.services.datasource.rest.mapping import (
    ResponseContractError,
    flatten_nodes_tabular,
    to_graph_payload,
)
from graphlagoon.services.graph_operations import QueryExecutionError

BASE_URL = "https://graph-api.test"

CONTRACT_GRAPH = {
    "nodes": [
        {"id": "a", "label": "Person", "properties": {"name": "Alice"}},
        {"id": "b", "label": "Person", "properties": {"name": "Bob"}},
    ],
    "edges": [
        {"id": "e1", "source": "a", "target": "b", "label": "KNOWS"},
    ],
}


def make_spec(**overrides) -> RestConnectionSpec:
    defaults = dict(
        name="fraud-api",
        ui=RestConnectionUI(label="Fraud Graph Service"),
        base_url=BASE_URL,
    )
    defaults.update(overrides)
    return RestConnectionSpec(**defaults)


class FakeRemote:
    """Records every request and replies with a canned response."""

    def __init__(self, payload=None, status=200, text_body=None):
        self.payload = payload if payload is not None else CONTRACT_GRAPH
        self.status = status
        self.text_body = text_body
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.text_body is not None:
            return httpx.Response(self.status, text=self.text_body)
        return httpx.Response(self.status, json=self.payload)

    def body(self, index=-1):
        return json.loads(self.requests[index].content)


def make_datasource(spec=None, remote=None):
    spec = spec or make_spec()
    remote = remote or FakeRemote()
    ds = RestDatasource(spec)
    ds._client = httpx.AsyncClient(
        base_url=BASE_URL, transport=httpx.MockTransport(remote.handler)
    )
    return ds, remote


async def run_query(ds, query="all frauds since 2024"):
    prepared = ds.prepare_cypher(None, _cypher_request(query))
    return await ds.execute_prepared(None, prepared)


def _cypher_request(query):
    from graphlagoon.models.schemas import CypherQueryRequest

    return CypherQueryRequest(query=query)


def error_code(exc_info):
    return exc_info.value.detail["error"]["code"]


# ── Spec validation ──────────────────────────────────────────────────────


class TestSpecValidation:
    def test_valid_spec_passes(self):
        validate_spec(make_spec())

    @pytest.mark.parametrize(
        "name", ["", "UPPER", "has space", "-leading", "a" * 51, "café"]
    )
    def test_bad_slug_rejected(self, name):
        with pytest.raises(ValueError, match="name"):
            validate_spec(make_spec(name=name))

    def test_label_required(self):
        with pytest.raises(ValueError, match="ui.label"):
            validate_spec(make_spec(ui=RestConnectionUI(label="  ")))

    @pytest.mark.parametrize("url", ["", "not-a-url", "ftp://x", "http://"])
    def test_base_url_must_be_http(self, url):
        with pytest.raises(ValueError, match="base_url"):
            validate_spec(make_spec(base_url=url))

    def test_timeout_must_be_positive(self):
        with pytest.raises(ValueError, match="timeout"):
            validate_spec(make_spec(timeout_seconds=0))

    def test_builders_must_be_callable(self):
        with pytest.raises(ValueError, match="expand_builder"):
            validate_spec(make_spec(expand_builder="not callable"))

    def test_rest_ops_derived_from_builders(self):
        bare = make_spec()
        assert bare.rest_ops() == {
            "expand": False,
            "subgraph": False,
            "fetch_nodes": False,
            "schema_discovery": False,
        }
        full = make_spec(
            expand_builder=lambda r: RestRequest(path="/expand"),
            subgraph_builder=lambda r: RestRequest(path="/subgraph"),
        )
        ops = full.rest_ops()
        assert ops["expand"] and ops["subgraph"]
        assert not ops["fetch_nodes"] and not ops["schema_discovery"]

    def test_ui_payload_never_leaks_transport_or_auth(self):
        spec = make_spec(
            headers={"Authorization": "Bearer SECRET"},
            headers_provider=lambda: {"X-Token": "SECRET2"},
        )
        payload = spec.ui_payload()
        serialized = json.dumps(payload)
        assert "SECRET" not in serialized
        assert "base_url" not in payload
        assert "headers" not in payload
        assert BASE_URL not in serialized
        # And what SHOULD be there is there.
        assert payload["name"] == "fraud-api"
        assert payload["label"] == "Fraud Graph Service"
        assert payload["capabilities"] == spec.rest_ops()


# ── Registry ─────────────────────────────────────────────────────────────


class TestRegistry:
    def setup_method(self):
        clear_rest_registry()

    def teardown_method(self):
        clear_rest_registry()

    def test_register_and_lookup(self):
        spec = make_spec()
        register_rest_connection(spec)
        assert get_rest_connection("fraud-api") is spec
        assert get_rest_connection("nope") is None

    def test_same_object_is_idempotent(self):
        spec = make_spec()
        register_rest_connection(spec)
        register_rest_connection(spec)  # no error

    def test_different_spec_same_name_rejected(self):
        register_rest_connection(make_spec())
        with pytest.raises(ValueError, match="already registered"):
            register_rest_connection(make_spec())

    def test_invalid_spec_rejected_at_registration(self):
        with pytest.raises(ValueError):
            register_rest_connection(make_spec(base_url="nope"))


# ── Contract mapping (pure) ──────────────────────────────────────────────


class TestContractMapping:
    def test_maps_contract_shape(self):
        nodes, edges = to_graph_payload(CONTRACT_GRAPH)
        assert set(nodes) == {"a", "b"}
        assert nodes["a"].node_type == "Person"
        assert nodes["a"].properties == {"name": "Alice"}
        assert edges["e1"].src == "a" and edges["e1"].dst == "b"
        assert edges["e1"].relationship_type == "KNOWS"

    def test_defensive_defaults(self):
        nodes, edges = to_graph_payload(
            {
                "nodes": [{"id": 7}],
                "edges": [{"source": 7, "target": 7}],
            }
        )
        assert nodes["7"].node_type == ""
        assert nodes["7"].properties == {}
        (edge,) = edges.values()
        assert edge.src == "7" and edge.edge_id  # synthesized id

    def test_missing_node_id_is_strict(self):
        with pytest.raises(ResponseContractError, match=r"nodes\[0\]"):
            to_graph_payload({"nodes": [{"label": "x"}], "edges": []})

    def test_missing_edge_endpoint_is_strict(self):
        with pytest.raises(ResponseContractError, match="target"):
            to_graph_payload({"nodes": [], "edges": [{"source": "a"}]})

    def test_non_object_payload_rejected(self):
        with pytest.raises(ResponseContractError):
            to_graph_payload([1, 2, 3])

    def test_duplicate_node_keeps_richer_copy(self):
        nodes, _ = to_graph_payload(
            {
                "nodes": [
                    {"id": "a", "label": "Person"},
                    {"id": "a", "label": "Person", "properties": {"x": 1}},
                ],
                "edges": [],
            }
        )
        assert nodes["a"].properties == {"x": 1}

    def test_flatten_nodes_tabular(self):
        nodes, _ = to_graph_payload(CONTRACT_GRAPH)
        columns, rows, truncated = flatten_nodes_tabular(list(nodes.values()), 10)
        assert columns == ["node_id", "label", "name"]
        assert ["a", "Person", "Alice"] in rows
        assert not truncated

    def test_flatten_stringifies_every_cell(self):
        # TableQueryResponse.rows is list[list[Optional[str]]] — a float cell
        # is a 500 at response validation. Found live, kept as a regression.
        nodes, _ = to_graph_payload(
            {
                "nodes": [
                    {
                        "id": "a",
                        "label": "Account",
                        "properties": {
                            "risk": 0.37,
                            "count": 3,
                            "active": True,
                            "gone": None,
                            "tags": ["x", "y"],
                        },
                    }
                ],
                "edges": [],
            }
        )
        _, rows, _ = flatten_nodes_tabular(list(nodes.values()), 10)
        for cell in rows[0]:
            assert cell is None or isinstance(cell, str)
        assert "0.37" in rows[0]

    def test_flatten_truncates(self):
        nodes, _ = to_graph_payload(CONTRACT_GRAPH)
        _, rows, truncated = flatten_nodes_tabular(list(nodes.values()), 1)
        assert len(rows) == 1
        assert truncated


# ── Query execution ──────────────────────────────────────────────────────


class TestQueryExecution:
    @pytest.mark.asyncio
    async def test_default_request_shape(self):
        ds, remote = make_datasource()
        await run_query(ds, "find frauds")
        req = remote.requests[0]
        assert req.url.path == "/query"
        assert req.method == "POST"
        assert remote.body() == {
            "query": "find frauds",
            "parameters": None,
            "limits": {},
        }

    @pytest.mark.asyncio
    async def test_contract_response_becomes_graph(self):
        ds, _ = make_datasource()
        graph = await run_query(ds)
        assert {n.node_id for n in graph.nodes} == {"a", "b"}
        assert len(graph.edges) == 1
        assert graph.metadata.edge_query_ms is not None

    @pytest.mark.asyncio
    async def test_static_and_dynamic_headers_merge(self):
        spec = make_spec(
            headers={"X-Api-Key": "static", "X-Base": "1"},
            headers_provider=lambda: {"X-Api-Key": "dynamic-wins"},
        )
        ds, remote = make_datasource(spec=spec)
        await run_query(ds)
        headers = remote.requests[0].headers
        assert headers["x-api-key"] == "dynamic-wins"
        assert headers["x-base"] == "1"

    @pytest.mark.asyncio
    async def test_custom_request_builder(self):
        spec = make_spec(
            request_builder=lambda q, p, limits: RestRequest(
                path="/v2/search", method="GET", params={"q": q}
            )
        )
        ds, remote = make_datasource(spec=spec)
        await run_query(ds, "abc")
        req = remote.requests[0]
        assert req.url.path == "/v2/search"
        assert req.method == "GET"
        assert req.url.params["q"] == "abc"

    @pytest.mark.asyncio
    async def test_response_mapper_transforms_foreign_shape(self):
        foreign = {
            "vertices": [{"key": "n1", "type": "Account"}],
            "links": [],
        }

        def mapper(data):
            return {
                "nodes": [
                    {"id": v["key"], "label": v["type"]} for v in data["vertices"]
                ],
                "edges": data["links"],
            }

        ds, _ = make_datasource(
            spec=make_spec(response_mapper=mapper),
            remote=FakeRemote(payload=foreign),
        )
        graph = await run_query(ds)
        assert graph.nodes[0].node_id == "n1"
        assert graph.nodes[0].node_type == "Account"

    @pytest.mark.asyncio
    async def test_mapper_crash_is_execution_failure(self):
        def mapper(data):
            raise KeyError("bug in the mapper")

        ds, _ = make_datasource(spec=make_spec(response_mapper=mapper))
        with pytest.raises(GraphExecutionFailure) as exc_info:
            await run_query(ds)
        assert "bug in the mapper" in str(exc_info.value.original)

    @pytest.mark.asyncio
    async def test_dangling_endpoints_get_placeholders(self):
        payload = {
            "nodes": [{"id": "a", "label": "Person"}],
            "edges": [{"source": "a", "target": "ghost", "label": "KNOWS"}],
        }
        ds, _ = make_datasource(remote=FakeRemote(payload=payload))
        graph = await run_query(ds)
        ids = {n.node_id for n in graph.nodes}
        assert ids == {"a", "ghost"}
        ghost = next(n for n in graph.nodes if n.node_id == "ghost")
        assert ghost.node_type == ""

    def test_empty_query_rejected(self):
        ds, _ = make_datasource()
        with pytest.raises(HTTPException) as exc_info:
            ds.prepare_cypher(None, _cypher_request("   "))
        assert error_code(exc_info) == "EMPTY_QUERY"

    def test_cte_prefilter_rejected(self):
        from graphlagoon.models.schemas import CypherQueryRequest

        ds, _ = make_datasource()
        with pytest.raises(HTTPException) as exc_info:
            ds.prepare_cypher(
                None, CypherQueryRequest(query="x", cte_prefilter="EDGES AS (...)")
            )
        assert error_code(exc_info) == "DATASOURCE_UNSUPPORTED_OPERATION"


# ── Error taxonomy ───────────────────────────────────────────────────────


class TestErrorMapping:
    @pytest.mark.asyncio
    async def test_timeout_is_query_error(self):
        def handler(request):
            raise httpx.ReadTimeout("slow")

        ds, _ = make_datasource()
        ds._client = httpx.AsyncClient(
            base_url=BASE_URL, transport=httpx.MockTransport(handler)
        )
        with pytest.raises(QueryExecutionError) as exc_info:
            await run_query(ds)
        assert exc_info.value.code == "REST_TIMEOUT"

    @pytest.mark.asyncio
    async def test_remote_4xx_is_query_error(self):
        ds, _ = make_datasource(
            remote=FakeRemote(status=422, payload={"detail": "bad query"})
        )
        with pytest.raises(QueryExecutionError) as exc_info:
            await run_query(ds)
        assert exc_info.value.code == "REST_REMOTE_ERROR"
        assert "422" in exc_info.value.message

    @pytest.mark.asyncio
    async def test_remote_5xx_is_execution_failure(self):
        ds, _ = make_datasource(remote=FakeRemote(status=503, text_body="down"))
        with pytest.raises(GraphExecutionFailure):
            await run_query(ds)

    @pytest.mark.asyncio
    async def test_connect_error_is_execution_failure(self):
        def handler(request):
            raise httpx.ConnectError("refused")

        ds, _ = make_datasource()
        ds._client = httpx.AsyncClient(
            base_url=BASE_URL, transport=httpx.MockTransport(handler)
        )
        with pytest.raises(GraphExecutionFailure):
            await run_query(ds)

    @pytest.mark.asyncio
    async def test_non_json_body_is_invalid_response(self):
        ds, _ = make_datasource(remote=FakeRemote(text_body="<html>oops</html>"))
        with pytest.raises(QueryExecutionError) as exc_info:
            await run_query(ds)
        assert exc_info.value.code == "REST_INVALID_RESPONSE"

    @pytest.mark.asyncio
    async def test_contract_violation_is_invalid_response(self):
        ds, _ = make_datasource(
            remote=FakeRemote(payload={"nodes": "not-a-list", "edges": []})
        )
        with pytest.raises(QueryExecutionError) as exc_info:
            await run_query(ds)
        assert exc_info.value.code == "REST_INVALID_RESPONSE"

    @pytest.mark.asyncio
    async def test_rest_codes_never_classify_as_stale_schema(self):
        """A REST context must never be told its 'context schema is stale'."""
        ds, _ = make_datasource(
            remote=FakeRemote(status=400, payload={"error": "TABLE_OR_VIEW_NOT_FOUND"})
        )
        with pytest.raises(QueryExecutionError) as exc_info:
            await run_query(ds)
        assert exc_info.value.code == "REST_REMOTE_ERROR"


# ── Canned operations ────────────────────────────────────────────────────


class TestCannedOperations:
    @pytest.mark.asyncio
    async def test_undeclared_expand_is_unsupported(self):
        ds, _ = make_datasource()
        with pytest.raises(HTTPException) as exc_info:
            await ds.expand(None, ExpandRequest(node_id="a"))
        assert error_code(exc_info) == "DATASOURCE_UNSUPPORTED_OPERATION"

    @pytest.mark.asyncio
    async def test_undeclared_subgraph_is_unsupported(self):
        ds, _ = make_datasource()
        with pytest.raises(HTTPException) as exc_info:
            await ds.get_subgraph(None, SubgraphRequest())
        assert error_code(exc_info) == "DATASOURCE_UNSUPPORTED_OPERATION"

    @pytest.mark.asyncio
    async def test_undeclared_fetch_nodes_is_unsupported(self):
        ds, _ = make_datasource()
        with pytest.raises(HTTPException) as exc_info:
            await ds.fetch_nodes(None, ["a"])
        assert error_code(exc_info) == "DATASOURCE_UNSUPPORTED_OPERATION"

    @pytest.mark.asyncio
    async def test_undeclared_discovery_is_unsupported(self):
        ds, _ = make_datasource()
        with pytest.raises(HTTPException) as exc_info:
            await ds.discover_types(None)
        assert error_code(exc_info) == "DATASOURCE_UNSUPPORTED_OPERATION"

    @pytest.mark.asyncio
    async def test_declared_expand_runs(self):
        spec = make_spec(
            expand_builder=lambda r: RestRequest(
                path="/expand",
                json_body={"node": r.node_id, "depth": r.depth},
            )
        )
        ds, remote = make_datasource(spec=spec)
        graph = await ds.expand(None, ExpandRequest(node_id="a", depth=2))
        assert remote.body() == {"node": "a", "depth": 2}
        assert len(graph.nodes) == 2

    @pytest.mark.asyncio
    async def test_expand_enforces_edge_limit_defensively(self):
        many_edges = {
            "nodes": [{"id": str(i)} for i in range(10)],
            "edges": [
                {"id": f"e{i}", "source": str(i), "target": str((i + 1) % 10)}
                for i in range(10)
            ],
        }
        spec = make_spec(expand_builder=lambda r: RestRequest(path="/expand"))
        ds, _ = make_datasource(spec=spec, remote=FakeRemote(payload=many_edges))
        graph = await ds.expand(None, ExpandRequest(node_id="0", edge_limit=4))
        assert len(graph.edges) == 4
        assert graph.truncated

    @pytest.mark.asyncio
    async def test_declared_fetch_nodes_runs(self):
        spec = make_spec(
            fetch_nodes_builder=lambda ids: RestRequest(
                path="/nodes", json_body={"ids": ids}
            )
        )
        ds, remote = make_datasource(spec=spec)
        nodes, elapsed = await ds.fetch_nodes(None, ["a", "b"])
        assert remote.body() == {"ids": ["a", "b"]}
        assert {n.node_id for n in nodes} == {"a", "b"}
        assert elapsed >= 0

    @pytest.mark.asyncio
    async def test_declared_discovery_runs(self):
        spec = make_spec(discover_types_builder=lambda r: RestRequest(path="/schema"))
        ds, _ = make_datasource(
            spec=spec,
            remote=FakeRemote(
                payload={
                    "node_types": ["Person", "Account"],
                    "relationship_types": ["KNOWS"],
                }
            ),
        )
        result = await ds.discover_types(None)
        assert result.node_types == ["Account", "Person"]
        assert result.relationship_types == ["KNOWS"]


# ── Console / table mode ─────────────────────────────────────────────────


class TestTableMode:
    @pytest.mark.asyncio
    async def test_inline_result_with_no_statement_id(self):
        ds, _ = make_datasource()
        response = await ds.submit_table_query(
            None, TableQueryRequest(query="all", mode="cypher")
        )
        assert response.status == "succeeded"
        assert response.statement_id is None
        assert response.transpiled_sql is None
        assert response.columns[:2] == ["node_id", "label"]
        assert response.row_count == 2

    @pytest.mark.asyncio
    async def test_row_limit_passed_and_enforced(self):
        ds, remote = make_datasource()
        response = await ds.submit_table_query(
            None, TableQueryRequest(query="all", mode="cypher", row_limit=1)
        )
        assert remote.body()["limits"] == {"rows": 1}
        assert response.row_count == 1
        assert response.truncated

    @pytest.mark.asyncio
    async def test_sql_mode_rejected(self):
        ds, _ = make_datasource()
        with pytest.raises(HTTPException) as exc_info:
            await ds.submit_table_query(
                None, TableQueryRequest(query="SELECT 1", mode="sql")
            )
        assert error_code(exc_info) == "DATASOURCE_UNSUPPORTED_OPERATION"

    @pytest.mark.asyncio
    async def test_cancel_is_a_noop(self):
        ds, _ = make_datasource()
        await ds.cancel_statement("anything")  # must not raise
