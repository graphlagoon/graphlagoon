"""Composite edge ids for contexts without an edge id column (debt #28).

Without ``edge_id_col`` the id used to be ``src@type@dst``: parallel edges
between one node pair (two transactions, say) collided onto one id and all but
the first were dropped by the dedup in ``process_graph_query_result``. The id
now appends a stable sha256 digest of the row's other columns, sorted by name.
Rows identical in every column still share an id (accepted: they are
indistinguishable). Ids must be stable across processes — saved snapshots are
matched against re-fetched edges by id.
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# Stub gsql2rsql only when genuinely unavailable — see the note in
# test_graph_error_handling.py.
try:
    import gsql2rsql  # noqa: F401

    HAS_TRANSPILER = True
except ImportError:  # pragma: no cover - depends on the environment
    from unittest.mock import MagicMock as _MagicMock

    HAS_TRANSPILER = False
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
        "gsql2rsql.common.exceptions",
        "gsql2rsql.common.schema",
    ):
        sys.modules[_name] = _MagicMock()

from graphlagoon.models.schemas import (  # noqa: E402
    ColumnConfig,
    ExpandRequest,
    SubgraphRequest,
)
from graphlagoon.services.datasource.sql_warehouse import (  # noqa: E402
    SqlWarehouseDatasource,
    build_edge_named_struct,
    edge_identity_columns,
)
from graphlagoon.services.graph_operations import (  # noqa: E402
    EDGE_ID_DIGEST_LEN,
    _get_edge_id,
    process_graph_query_result,
)

API_DIR = Path(__file__).resolve().parents[1]

# Typeless edge table with no edge id column: the shape that made #28 real.
TYPELESS = ColumnConfig(edge_id_col="", relationship_type_col="")


def make_context(**overrides):
    base = dict(
        node_table_name="",
        edge_table_name="cat.sch.transactions",
        node_structure={"node_id_col": "node_id", "node_type_col": ""},
        edge_structure={
            "edge_id_col": "",
            "src_col": "src",
            "dst_col": "dst",
            "relationship_type_col": "",
        },
        node_properties=[],
        edge_properties=[
            {"name": "amount", "data_type": "double"},
            {"name": "ts", "data_type": "string"},
        ],
        node_types=["Node"],
        relationship_types=["RELATED_TO"],
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def typeless_id(row: dict) -> str:
    return _get_edge_id(row, "", "src", "dst", "")


def edges_of(items: list[dict], config: ColumnConfig = TYPELESS):
    response, _ = process_graph_query_result(
        ["r"], [[json.dumps(item)] for item in items], config
    )
    return response.edges


class TestParallelEdges:
    def test_two_transactions_between_same_pair_get_distinct_ids(self):
        tx1 = {"src": "acc1", "dst": "acc2", "amount": 100.0, "ts": "2026-01-01"}
        tx2 = {"src": "acc1", "dst": "acc2", "amount": 250.0, "ts": "2026-01-02"}
        assert typeless_id(tx1) != typeless_id(tx2)

    def test_both_parallel_edges_survive_processing(self):
        edges = edges_of(
            [
                {"src": "acc1", "dst": "acc2", "amount": 100.0, "ts": "2026-01-01"},
                {"src": "acc1", "dst": "acc2", "amount": 250.0, "ts": "2026-01-02"},
            ]
        )
        assert len(edges) == 2
        assert len({e.edge_id for e in edges}) == 2
        assert sorted(e.properties["amount"] for e in edges) == [100.0, 250.0]

    def test_typed_parallel_edges_also_distinct(self):
        config = ColumnConfig(edge_id_col="")
        edges = edges_of(
            [
                {"src": "a", "dst": "b", "relationship_type": "PAID", "amount": 1},
                {"src": "a", "dst": "b", "relationship_type": "PAID", "amount": 2},
            ],
            config,
        )
        assert len(edges) == 2
        assert all(e.edge_id.startswith("a@PAID@b@") for e in edges)

    def test_fully_identical_rows_still_collide(self):
        """Accepted and documented: nothing distinguishes the two rows."""
        row = {"src": "acc1", "dst": "acc2", "amount": 100.0, "ts": "2026-01-01"}
        assert len(edges_of([row, dict(row)])) == 1


class TestIdShape:
    def test_structural_only_row_keeps_bare_composite(self):
        """Backward compatible: no extra columns ⇒ the pre-#28 id."""
        assert typeless_id({"src": "a", "dst": "b"}) == "a@@b"
        assert (
            _get_edge_id(
                {"src": "a", "dst": "b", "relationship_type": "T"},
                "",
                "src",
                "dst",
                "relationship_type",
            )
            == "a@T@b"
        )

    def test_null_only_extras_keep_bare_composite(self):
        assert typeless_id({"src": "a", "dst": "b", "amount": None}) == "a@@b"

    def test_edge_id_column_wins(self):
        row = {"edge_id": "e-42", "src": "a", "dst": "b", "amount": 1}
        assert _get_edge_id(row, "edge_id", "src", "dst", "") == "e-42"

    def test_digest_is_sha256_of_sorted_canonical_json(self):
        row = {"src": "a", "dst": "b", "ts": "t1", "amount": 1.5}
        canonical = json.dumps(
            {"amount": "1.5", "ts": "t1"},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        assert typeless_id(row) == f"a@@b@{digest[:EDGE_ID_DIGEST_LEN]}"

    def test_golden_value(self):
        """Pinned literal: if this changes, every saved snapshot's composite
        ids stop matching re-fetched edges. Change it only deliberately."""
        row = {"src": "acc1", "dst": "acc2", "amount": 100.0, "ts": "2026-01-01"}
        assert (
            typeless_id(row)
            == "acc1@@acc2@"
            + hashlib.sha256(b'{"amount":"100.0","ts":"2026-01-01"}').hexdigest()[:16]
        )


class TestStability:
    def test_column_order_does_not_matter(self):
        a = {"src": "x", "dst": "y", "amount": 5, "ts": "t", "memo": "m"}
        b = {"memo": "m", "ts": "t", "dst": "y", "amount": 5, "src": "x"}
        assert typeless_id(a) == typeless_id(b)

    def test_null_and_absent_column_hash_the_same(self):
        assert typeless_id({"src": "x", "dst": "y", "amount": 5}) == typeless_id(
            {"src": "x", "dst": "y", "amount": 5, "memo": None}
        )

    def test_scalar_and_its_string_form_hash_the_same(self):
        """A struct field decoded as a number and the same value delivered as
        a string (statements API top-level rendering) must not split ids."""
        assert typeless_id({"src": "x", "dst": "y", "amount": 1.5}) == typeless_id(
            {"src": "x", "dst": "y", "amount": "1.5"}
        )
        assert typeless_id({"src": "x", "dst": "y", "flag": True}) == typeless_id(
            {"src": "x", "dst": "y", "flag": "True"}
        )

    def test_nested_values_are_order_independent(self):
        assert typeless_id(
            {"src": "x", "dst": "y", "meta": {"a": 1, "b": [1, 2]}}
        ) == typeless_id({"src": "x", "dst": "y", "meta": {"b": [1, 2], "a": 1}})

    def test_stable_across_processes_with_different_hash_seeds(self):
        """Python's hash() is salted per process; the id must not be."""
        script = (
            "from graphlagoon.services.graph_operations import _get_edge_id;"
            "print(_get_edge_id({'src':'acc1','dst':'acc2','amount':100.0,"
            "'ts':'2026-01-01'}, '', 'src', 'dst', ''))"
        )
        expected = typeless_id(
            {"src": "acc1", "dst": "acc2", "amount": 100.0, "ts": "2026-01-01"}
        )
        for seed in ("1", "2"):
            out = subprocess.run(
                [sys.executable, "-W", "ignore", "-c", script],
                cwd=API_DIR,
                env={**os.environ, "PYTHONHASHSEED": seed},
                capture_output=True,
                text=True,
                check=True,
            )
            assert out.stdout.strip() == expected


class TestPathConsistency:
    """Subgraph/expand and transpiled Cypher must hash the same columns, or
    the same edge would get two ids and be duplicated on expansion merge."""

    def test_identity_columns_are_configured_edge_properties(self):
        ctx = make_context(
            edge_properties=[
                {"name": "amount"},
                SimpleNamespace(name="ts"),
                {"name": "src"},  # structural: never duplicated
                {"name": "amount"},  # duplicate entry
                {"name": ""},
            ]
        )
        assert edge_identity_columns(ctx, TYPELESS) == ["amount", "ts"]

    def test_no_identity_columns_with_edge_id_column(self):
        assert edge_identity_columns(make_context(), ColumnConfig()) == []

    def test_named_struct_carries_extra_columns_once(self):
        sql = build_edge_named_struct(TYPELESS, "e", ["amount", "src"])
        assert (
            sql == "NAMED_STRUCT('src', e.`src`, 'dst', e.`dst`, 'amount', e.`amount`)"
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("op", ["subgraph", "expand"])
    async def test_canned_queries_select_property_columns(self, monkeypatch, op):
        ds = SqlWarehouseDatasource(warehouse_client_getter=lambda: None)
        captured = {}

        async def fake_execute(context, query, **kwargs):
            captured["query"] = query
            return "graph"

        monkeypatch.setattr(ds, "_execute", fake_execute)
        if op == "subgraph":
            await ds.get_subgraph(make_context(), SubgraphRequest())
            assert "'amount', `amount`" in captured["query"]
            assert "'ts', `ts`" in captured["query"]
        else:
            await ds.expand(make_context(), ExpandRequest(node_id="acc1"))
            assert "'amount', e.`amount`" in captured["query"]
            assert "'ts', e.`ts`" in captured["query"]

    @pytest.mark.asyncio
    async def test_canned_queries_unchanged_with_edge_id_column(self, monkeypatch):
        ds = SqlWarehouseDatasource(warehouse_client_getter=lambda: None)
        captured = {}

        async def fake_execute(context, query, **kwargs):
            captured["query"] = query
            return "graph"

        monkeypatch.setattr(ds, "_execute", fake_execute)
        ctx = make_context(
            edge_structure={
                "edge_id_col": "edge_id",
                "src_col": "src",
                "dst_col": "dst",
                "relationship_type_col": "",
            }
        )
        await ds.get_subgraph(ctx, SubgraphRequest())
        assert "`amount`" not in captured["query"]

    def test_cypher_and_subgraph_struct_shapes_yield_same_id(self):
        """The transpiler emits struct keys alphabetically; the canned queries
        emit structural columns first. Same columns ⇒ same id."""
        cypher_item = {"amount": 7.0, "dst": "b", "src": "a", "ts": "t"}
        subgraph_item = {"src": "a", "dst": "b", "amount": 7.0, "ts": "t"}
        assert (
            edges_of([cypher_item])[0].edge_id == edges_of([subgraph_item])[0].edge_id
        )

    @pytest.mark.skipif(not HAS_TRANSPILER, reason="needs the real gsql2rsql")
    def test_transpiled_r_struct_has_exactly_the_identity_columns(self):
        import re

        from graphlagoon.services.cypher import transpile_cypher_to_sql

        ctx = make_context(node_table_name="cat.sch.nodes")
        sql = transpile_cypher_to_sql("MATCH (a)-[r]->(b) RETURN a, r, b", ctx)
        match = re.search(r"NAMED_STRUCT\(([^)]*)\) AS r\b", sql)
        assert match, sql
        keys = set(re.findall(r"'([^']+)',", match.group(1)))
        expected = {"src", "dst", *edge_identity_columns(ctx, TYPELESS)}
        assert keys == expected
