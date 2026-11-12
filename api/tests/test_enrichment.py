"""Enrichment tables on graph contexts and their lookup (investigations F2.1)."""

import sys

import pytest

try:
    import gsql2rsql  # noqa: F401
except ImportError:
    from unittest.mock import MagicMock as _MagicMock

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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from graphlagoon.config import get_settings  # noqa: E402
from graphlagoon.db.memory_store import InMemoryStore  # noqa: E402
from graphlagoon.middleware.auth import AuthMiddleware  # noqa: E402
from graphlagoon.models.schemas import (  # noqa: E402
    GraphContextUpdate,
    StatementResponse,
)
from graphlagoon.routers import graph_contexts  # noqa: E402
from graphlagoon.services import enrichment  # noqa: E402

OWNER = "owner@example.com"
WRITER = "writer@example.com"
READER = "reader@example.com"
DEVICES = {
    "name": "devices",
    "label": "Dispositivos",
    "table": "main.graphs.devices",
    "key_column": "account_id",
    "match_node_types": ["Conta"],
    "cardinality": "many",
    "columns": ["device_id", "ip"],
    "promote": {"node_type": "Dispositivo", "id_column": "device_id", "edge_type": "USOU"},
}


class TestValidation:
    @pytest.mark.parametrize(
        "change",
        [
            {"name": "Bad Name"},
            {"table": "main.graphs.devices; DROP TABLE x"},
            {"table": "devices"},
            {"columns": ["ip`, secret"]},
            {"columns": []},
            {"key_column": "a b"},
            {"promote": {"node_type": "D", "id_column": "other", "edge_type": "E"}},
        ],
    )
    def test_rejects(self, change):
        with pytest.raises(ValidationError):
            GraphContextUpdate(enrichment_tables=[{**DEVICES, **change}])

    def test_rejects_duplicate_names(self):
        with pytest.raises(ValidationError):
            GraphContextUpdate(enrichment_tables=[DEVICES, DEVICES])


class TestQuery:
    def test_identifiers_quoted_and_keys_parameterized(self):
        sql, params = enrichment.build_query(DEVICES, ["1' OR '1'='1", "2"], 11)
        assert sql == (
            "SELECT `account_id`, `device_id`, `ip` FROM `main`.`graphs`.`devices` "
            "WHERE `account_id` IN (:k0, :k1) LIMIT 11"
        )
        assert params[0] == {"name": "k0", "value": "1' OR '1'='1", "type": "STRING"}

    @pytest.mark.parametrize("keys", [[], [""], [{"a": 1}], ["x" * 201], [True]])
    def test_malformed_keys(self, keys):
        with pytest.raises(enrichment.EnrichmentError) as exc:
            enrichment.clean_keys(keys)
        assert exc.value.code == "INVALID_KEY"

    def test_key_limit(self, monkeypatch):
        monkeypatch.setenv("GRAPH_LAGOON_ENRICHMENT_MAX_KEYS", "2")
        get_settings.cache_clear()
        try:
            assert enrichment.clean_keys(["a", "a", "b"]) == ["a", "b"]
            with pytest.raises(enrichment.EnrichmentError) as exc:
                enrichment.clean_keys(["a", "b", "c"])
            assert exc.value.code == "TOO_MANY_KEYS"
        finally:
            get_settings.cache_clear()


class _Warehouse:
    """Answers with an extra undeclared column, which must not leave."""

    def __init__(self):
        self.calls = []

    async def execute_statement(self, statement, parameters=None, **_):
        self.calls.append((statement, parameters))
        rows = [["1", "d1", "10.0.0.1", "s3cr3t"], ["1", "d2", "10.0.0.2", "x"]]
        rows += [["2", "d3", "10.0.0.3", "y"]]
        names = ["account_id", "device_id", "ip", "password"]
        return StatementResponse(
            statement_id="s",
            status={"state": "SUCCEEDED"},
            manifest={
                "schema": {
                    "column_count": 4,
                    "columns": [
                        {"name": n, "type_name": "STRING", "type_text": "STRING", "position": i}
                        for i, n in enumerate(names)
                    ],
                },
                "total_row_count": len(rows),
            },
            result={"data_array": rows},
        )


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_DEV_MODE", "true")
    monkeypatch.setenv("GRAPH_LAGOON_CATALOG_SCHEMAS", "main.graphs")
    get_settings.cache_clear()
    InMemoryStore.reset()
    store = InMemoryStore.get_instance()
    warehouse = _Warehouse()
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(graph_contexts.router)
    app.dependency_overrides[graph_contexts.get_warehouse] = lambda: warehouse
    yield TestClient(app), store, warehouse
    InMemoryStore.reset()
    get_settings.cache_clear()


def _h(email):
    return {"X-Forwarded-Email": email}


def _restrict_context_create_to(store, *emails):
    group = store.create_group(
        "authors", members=[{"kind": "email", "value": e} for e in emails]
    )
    store.set_permission(
        "context.create", "restricted", [{"group_id": group.id, "effect": "allow"}]
    )


def test_writer_without_context_create_cannot_attach_but_can_remove(env):
    client, store, _ = env
    _restrict_context_create_to(store, OWNER)
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[DEVICES]
    )
    store.share_graph_context(ctx.id, WRITER, "write")
    url = f"/api/graph-contexts/{ctx.id}"
    added = [DEVICES, {**DEVICES, "name": "kyc"}]
    r = client.put(url, json={"enrichment_tables": added}, headers=_h(WRITER))
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "PERMISSION_DENIED"
    # Saving the context unchanged, or removing a table, needs no author.
    r = client.put(url, json={"enrichment_tables": [DEVICES]}, headers=_h(WRITER))
    assert r.status_code == 200, r.text
    r = client.put(url, json={"enrichment_tables": []}, headers=_h(WRITER))
    assert r.status_code == 200 and r.json()["enrichment_tables"] == []


def test_author_limited_to_the_allowlist(env):
    client, store, _ = env
    ctx = store.create_graph_context("pix", "main.graphs.e", "main.graphs.n", OWNER)
    url = f"/api/graph-contexts/{ctx.id}"
    outside = {**DEVICES, "table": "hr.private.salaries"}
    r = client.put(url, json={"enrichment_tables": [outside]}, headers=_h(OWNER))
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_SCOPE_DENIED"
    r = client.put(url, json={"enrichment_tables": [DEVICES]}, headers=_h(OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["enrichment_tables"][0]["promote"]["node_type"] == "Dispositivo"


def test_reader_without_context_create_looks_up_declared_columns_only(env):
    client, store, warehouse = env
    _restrict_context_create_to(store, OWNER)
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[DEVICES]
    )
    store.share_graph_context(ctx.id, READER, "read")
    url = f"/api/graph-contexts/{ctx.id}/enrichment/devices/lookup"
    r = client.post(url, json={"keys": ["1", "2"]}, headers=_h(READER))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows"]["1"] == [
        {"device_id": "d1", "ip": "10.0.0.1"},
        {"device_id": "d2", "ip": "10.0.0.2"},
    ]
    assert "s3cr3t" not in r.text and body["truncated"] is False
    assert warehouse.calls[0][1][1]["value"] == "2"
    entries = [e for e in store.usage_logs if e.action == "enrichment.read"]
    assert entries[0].log_metadata["rows"] == 3
    # Unknown table, and someone without access to the context.
    missing = f"/api/graph-contexts/{ctx.id}/enrichment/nope/lookup"
    assert client.post(missing, json={"keys": ["1"]}, headers=_h(READER)).status_code == 404
    assert client.post(url, json={"keys": ["1"]}, headers=_h(WRITER)).status_code == 403


def test_row_limit_truncates(env, monkeypatch):
    client, store, _ = env
    monkeypatch.setenv("GRAPH_LAGOON_ENRICHMENT_MAX_ROWS", "2")
    get_settings.cache_clear()
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[DEVICES]
    )
    url = f"/api/graph-contexts/{ctx.id}/enrichment/devices/lookup"
    body = client.post(url, json={"keys": ["1", "2"]}, headers=_h(OWNER)).json()
    assert body["truncated"] is True and "2" not in body["rows"]


# --- Authorized tables and edge enrichment queries -------------------------------

TX_QUERY = {
    "name": "tx_risk",
    "label": "Transaction risk",
    "table": "main.graphs.transactions",
    "query": {
        "sql": (
            "SELECT e.edge_id, t.risk, c.channel FROM graph_edges e "
            "JOIN main.graphs.transactions t ON t.tx_id = e.props['tx_id'] "
            "JOIN main.graphs.channels c ON c.id = t.channel_id"
        ),
        "run": "auto",
    },
}
CHANNELS = {"name": "channels", "label": "Channels", "table": "main.graphs.channels"}


class TestEntryShapes:
    def test_bare_table_and_query_only_entries_are_valid(self):
        GraphContextUpdate(enrichment_tables=[CHANNELS, TX_QUERY])

    def test_lookup_and_query_together(self):
        GraphContextUpdate(enrichment_tables=[{**DEVICES, "query": TX_QUERY["query"]}])

    @pytest.mark.parametrize(
        "entry",
        [
            {**CHANNELS, "columns": ["a"]},
            {**CHANNELS, "match_node_types": ["Conta"]},
            {**DEVICES, "match_node_types": []},
            {**CHANNELS, "table": "main.graphs.graph_edges"},
            {**CHANNELS, "query": {"sql": "DELETE FROM main.graphs.e"}},
            {**CHANNELS, "query": {"sql": "SELECT 1 AS edge_id; SELECT 2"}},
            {**CHANNELS, "query": {"sql": "WITH graph_edges AS (SELECT 1) SELECT * FROM graph_edges"}},
            {**CHANNELS, "query": {"sql": "SELECT 1", "target": "paths"}},
            {**CHANNELS, "query": {"sql": "SELECT 1", "extra": True}},
        ],
    )
    def test_rejects(self, entry):
        with pytest.raises(ValidationError):
            GraphContextUpdate(enrichment_tables=[entry])


class TestSplice:
    CTES = "graph_edges AS (X), graph_nodes AS (Y)"

    def test_prepends_with(self):
        out = enrichment.splice_virtual_ctes("SELECT * FROM graph_edges;", self.CTES)
        assert out == f"WITH {self.CTES} SELECT * FROM graph_edges"

    def test_merges_into_author_with(self):
        sql = "with x AS (SELECT * FROM graph_edges) SELECT * FROM x"
        out = enrichment.splice_virtual_ctes(sql, self.CTES)
        assert out == f"with {self.CTES}, x AS (SELECT * FROM graph_edges) SELECT * FROM x"

    def test_recursive_and_leading_comments(self):
        sql = "-- why\n/* note */ WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r"
        out = enrichment.splice_virtual_ctes(sql, self.CTES)
        assert out == f"WITH RECURSIVE {self.CTES}, r AS (SELECT 1) SELECT * FROM r"

    def test_parameters_carry_the_batch_without_quotes(self):
        from graphlagoon.models.schemas import EnrichmentRunEdge, EnrichmentRunNode

        spec = {"query": {"sql": "SELECT edge_id FROM graph_edges", "node_props": False}}
        edges = [EnrichmentRunEdge(edge_id="e1", src="a", dst="b", relationship_type="PAYS",
                                   properties={"memo": "it's", "n": 3, "big": "x" * 2000})]
        nodes = [EnrichmentRunNode(node_id="a", node_type="Conta", properties={"name": "A"})]
        sql, params = enrichment.build_run_statement(spec, edges, nodes)
        assert sql.startswith("WITH graph_edges AS (")
        assert "it's" not in sql and "'" not in params[0]["value"]
        import json

        sent = json.loads(params[0]["value"])
        assert sent[0]["props"] == {"memo": "it's", "n": "3"}
        assert json.loads(params[1]["value"])[0]["props"] == {}


class _QueryWarehouse:
    def __init__(self, names=("edge_id", "risk", "channel"), rows=None, state="SUCCEEDED"):
        self.calls = []
        self.names = list(names)
        self.rows = rows if rows is not None else [
            ["e1", "0.9", "pix"], ["e1", "0.1", "ted"], ["zz", "1", "x"], ["e2", "0.2", None],
        ]
        self.state = state

    async def execute_statement(self, statement, parameters=None, **_):
        self.calls.append((statement, parameters))
        if self.state == "BOOM":
            raise RuntimeError("Request failed to warehouse: SELECT secret")
        return StatementResponse(
            statement_id="s",
            status={"state": self.state, "error": {"message": "TABLE_OR_VIEW_NOT_FOUND"}}
            if self.state != "SUCCEEDED" else {"state": "SUCCEEDED"},
            manifest={
                "schema": {
                    "column_count": len(self.names),
                    "columns": [
                        {"name": n, "type_name": "STRING", "type_text": "STRING", "position": i}
                        for i, n in enumerate(self.names)
                    ],
                },
                "total_row_count": len(self.rows),
            },
            result={"data_array": self.rows},
        )


BATCH = {
    "edges": [
        {"edge_id": "e1", "src": "a", "dst": "b", "relationship_type": "PAYS", "properties": {"tx_id": "t1"}},
        {"edge_id": "e2", "src": "b", "dst": "c", "relationship_type": "PAYS"},
    ],
    "nodes": [{"node_id": "a", "node_type": "Conta"}],
}


def _query_context(store):
    return store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER,
        enrichment_tables=[CHANNELS, TX_QUERY],
    )


def test_author_query_may_only_read_authorized_tables(env):
    client, store, _ = env
    ctx = store.create_graph_context("pix", "main.graphs.e", "main.graphs.n", OWNER)
    url = f"/api/graph-contexts/{ctx.id}"
    # channels is in the catalog allowlist but not listed in the context.
    r = client.put(url, json={"enrichment_tables": [TX_QUERY]}, headers=_h(OWNER))
    assert r.status_code == 403
    error = r.json()["detail"]["error"]
    assert error["code"] == "ENRICHMENT_SCOPE_DENIED" and "main.graphs.channels" in error["message"]
    # Listing it authorizes the join; the context's own edge table is always readable.
    own = {**TX_QUERY, "query": {"sql": "SELECT e.edge_id, x.k FROM graph_edges e JOIN main.graphs.e x ON x.id = e.edge_id"}}
    r = client.put(url, json={"enrichment_tables": [CHANNELS, TX_QUERY, {**own, "name": "own"}]}, headers=_h(OWNER))
    assert r.status_code == 200, r.text
    saved = r.json()["enrichment_tables"]
    assert saved[1]["query"]["run"] == "auto" and saved[0]["key_column"] is None


def test_writer_without_context_create_cannot_change_a_query(env):
    client, store, _ = env
    _restrict_context_create_to(store, OWNER)
    ctx = _query_context(store)
    store.share_graph_context(ctx.id, WRITER, "write")
    url = f"/api/graph-contexts/{ctx.id}"
    changed = {**TX_QUERY, "query": {**TX_QUERY["query"], "sql": "SELECT edge_id FROM graph_edges"}}
    r = client.put(url, json={"enrichment_tables": [CHANNELS, changed]}, headers=_h(WRITER))
    assert r.status_code == 403
    r = client.put(url, json={"enrichment_tables": [CHANNELS]}, headers=_h(WRITER))
    assert r.status_code == 200, r.text


def test_reader_runs_a_query_over_the_sent_edges(env):
    client, store, _ = env
    _restrict_context_create_to(store, OWNER)
    ctx = _query_context(store)
    store.share_graph_context(ctx.id, READER, "read")
    warehouse = _QueryWarehouse()
    client.app.dependency_overrides[graph_contexts.get_warehouse] = lambda: warehouse
    r = client.post(f"/api/graph-contexts/{ctx.id}/enrichment/tx_risk/run", json=BATCH, headers=_h(READER))
    assert r.status_code == 200, r.text
    body = r.json()
    # First row per edge wins; an id that was not sent is dropped.
    assert body["rows"] == {"e1": {"risk": "0.9", "channel": "pix"}, "e2": {"risk": "0.2", "channel": None}}
    assert body["columns"] == ["risk", "channel"] and body["truncated"] is False
    statement, params = warehouse.calls[0]
    assert statement.startswith("WITH graph_edges AS (") and "t1" not in statement
    assert '"tx_id": "t1"' in params[0]["value"]
    entry = [e for e in store.usage_logs if e.action == "enrichment.run"][0]
    assert entry.log_metadata == {
        "query": "tx_risk", "target": "edges", "edges": 2, "nodes": 1, "rows": 2, "truncated": False,
    }
    # Someone without access to the context.
    r = client.post(f"/api/graph-contexts/{ctx.id}/enrichment/tx_risk/run", json=BATCH, headers=_h(WRITER))
    assert r.status_code == 403


@pytest.mark.parametrize(
    "warehouse, status, code",
    [
        (_QueryWarehouse(names=("id", "risk")), 400, "ENRICHMENT_RESULT_NO_KEY"),
        (_QueryWarehouse(state="FAILED"), 502, "ENRICHMENT_QUERY_FAILED"),
        (_QueryWarehouse(state="BOOM"), 502, "ENRICHMENT_QUERY_FAILED"),
    ],
)
def test_run_errors_are_structured(env, warehouse, status, code):
    client, store, _ = env
    ctx = _query_context(store)
    client.app.dependency_overrides[graph_contexts.get_warehouse] = lambda: warehouse
    r = client.post(f"/api/graph-contexts/{ctx.id}/enrichment/tx_risk/run", json=BATCH, headers=_h(OWNER))
    assert r.status_code == status
    assert r.json()["detail"]["error"]["code"] == code
    assert "secret" not in r.text


def test_run_limits_and_entry_kinds(env, monkeypatch):
    client, store, _ = env
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER,
        enrichment_tables=[CHANNELS, TX_QUERY, DEVICES],
    )
    base = f"/api/graph-contexts/{ctx.id}/enrichment"
    monkeypatch.setenv("GRAPH_LAGOON_ENRICHMENT_MAX_KEYS", "1")
    get_settings.cache_clear()
    r = client.post(f"{base}/tx_risk/run", json=BATCH, headers=_h(OWNER))
    assert r.json()["detail"]["error"]["code"] == "TOO_MANY_KEYS"
    get_settings.cache_clear()
    monkeypatch.delenv("GRAPH_LAGOON_ENRICHMENT_MAX_KEYS")
    r = client.post(f"{base}/devices/run", json=BATCH, headers=_h(OWNER))
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_NOT_QUERY"
    r = client.post(f"{base}/tx_risk/lookup", json={"keys": ["1"]}, headers=_h(OWNER))
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_NOT_LOOKUP"
    long = {**BATCH, "edges": [{**BATCH["edges"][0], "edge_id": "x" * 1001}]}
    r = client.post(f"{base}/tx_risk/run", json=long, headers=_h(OWNER))
    assert r.json()["detail"]["error"]["code"] == "INVALID_KEY"


def test_run_reproves_scope_of_a_stored_query(env):
    client, store, _ = env
    # Stored before the join's table was removed from the list (or written by hand).
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[TX_QUERY],
    )
    r = client.post(f"/api/graph-contexts/{ctx.id}/enrichment/tx_risk/run", json=BATCH, headers=_h(OWNER))
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_SCOPE_DENIED"


def test_a_query_can_target_nodes(env):
    client, store, _ = env
    node_query = {
        "name": "node_risk",
        "label": "Account risk",
        "table": "main.graphs.accounts",
        "query": {
            "sql": "SELECT n.node_id, a.risk FROM graph_nodes n JOIN main.graphs.accounts a ON a.id = n.node_id",
            "target": "nodes",
        },
    }
    ctx = store.create_graph_context(
        "pix", "main.graphs.e", "main.graphs.n", OWNER, enrichment_tables=[node_query],
    )
    warehouse = _QueryWarehouse(names=("node_id", "risk"), rows=[["a", "high"], ["b", "low"], ["zz", "x"]])
    client.app.dependency_overrides[graph_contexts.get_warehouse] = lambda: warehouse
    url = f"/api/graph-contexts/{ctx.id}/enrichment/node_risk/run"
    body = {"nodes": [{"node_id": "a", "node_type": "Conta"}], "edges": []}
    r = client.post(url, json=body, headers=_h(OWNER))
    assert r.status_code == 200, r.text
    assert r.json()["target"] == "nodes" and r.json()["rows"] == {"a": {"risk": "high"}}
    # Nothing to enrich, or a result keyed the wrong way.
    r = client.post(url, json={"edges": BATCH["edges"]}, headers=_h(OWNER))
    assert r.json()["detail"]["error"]["code"] == "INVALID_KEY"
    client.app.dependency_overrides[graph_contexts.get_warehouse] = lambda: _QueryWarehouse()
    r = client.post(url, json=body, headers=_h(OWNER))
    assert r.json()["detail"]["error"]["code"] == "ENRICHMENT_RESULT_NO_KEY"


def test_several_queries_for_edges_and_nodes_on_one_table(env):
    client, store, _ = env
    ctx = store.create_graph_context("pix", "main.graphs.e", "main.graphs.n", OWNER)
    sql_e = "SELECT e.edge_id, t.risk FROM graph_edges e JOIN main.graphs.tx t ON t.id = e.edge_id"
    sql_n = "SELECT n.node_id, count(*) AS c FROM graph_nodes n JOIN main.graphs.tx t ON t.acct = n.node_id GROUP BY n.node_id"
    entries = [
        {"name": "risk", "label": "Risk", "table": "main.graphs.tx", "query": {"sql": sql_e, "run": "auto"}},
        {"name": "risk_manual", "label": "Risk by hand", "table": "main.graphs.tx", "query": {"sql": sql_e}},
        {"name": "activity", "label": "Activity", "table": "main.graphs.tx", "query": {"sql": sql_n, "target": "nodes", "run": "auto"}},
    ]
    r = client.put(f"/api/graph-contexts/{ctx.id}", json={"enrichment_tables": entries}, headers=_h(OWNER))
    assert r.status_code == 200, r.text
    saved = r.json()["enrichment_tables"]
    assert [(t["name"], t["query"]["target"]) for t in saved] == [
        ("risk", "edges"), ("risk_manual", "edges"), ("activity", "nodes"),
    ]
