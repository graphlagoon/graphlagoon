"""Enrichment files (BYOD-2): rows add properties to nodes or edges by key,
with the one merge rule of the case graph (first value wins, conflicts kept)."""

import json

import pytest
from pydantic import ValidationError

from graphlagoon.models.schemas import FileEnrichmentSpec
from graphlagoon.services import enrichment_files as ef

CSV = "doc;risk;segment;since\n123.456.789-01;high;retail;2019\n987.654.321-00;;corporate;00042\n".encode()


def spec(**over):
    return FileEnrichmentSpec.model_validate(
        {"name": "risk", "input": {"delimiter": ";"}, "key_column": "doc", "columns": ["risk", "segment", "since"], **over}
    ).model_dump()


def test_rows_are_keyed_normalized_and_typed():
    s = spec(normalize="digits")
    rows = ef.rows_by_key(*ef.table_of(CSV, "text/csv", s), s)
    assert rows["12345678901"] == [{"risk": "high", "segment": "retail", "since": 2019}]
    # Empty is missing; leading zeros keep a string.
    assert rows["98765432100"] == [{"risk": None, "segment": "corporate", "since": "00042"}]
    # key_digits cuts the normalized key.
    s = spec(normalize="digits", key_digits=3)
    assert set(ef.rows_by_key(*ef.table_of(CSV, "text/csv", s), s)) == {"123", "987"}


def test_json_tables_are_read_as_they_are():
    data = json.dumps({"columns": ["doc", "risk"], "rows": [["12345678901", 3]]}).encode()
    s = spec(columns=["risk"])
    assert ef.rows_by_key(*ef.table_of(data, "application/json", s), s) == {"12345678901": [{"risk": 3}]}


def test_spec_defaults_to_every_node_type_and_checks_edge_keys():
    s = spec()
    assert s["match_node_types"] == ["*"] and s["target"] == "nodes" and not s["overwrite"]
    with pytest.raises(ValidationError):
        spec(target="edges", key_column=None, edge_key={"by": "endpoints", "source_column": "a"})
    with pytest.raises(ValidationError):
        spec(key_column=None)
    ok = spec(target="edges", key_column=None, edge_key={"by": "endpoints", "source_column": "a", "target_column": "b"})
    assert ok["edge_key"]["by"] == "endpoints"


def unified():
    return {
        "nodes": [
            {"uid": "Person:12345678901", "type": "Person", "entity": "Person", "properties": {"risk": "low"},
             "sources": [{"source_id": "s1", "node_id": "p1"}]},
            {"uid": "a1@c", "type": "Account", "entity": None, "properties": {}, "sources": [{"source_id": "s1", "node_id": "a1"}]},
            {"uid": "a2@c", "type": "Account", "entity": None, "properties": {}, "sources": [{"source_id": "s1", "node_id": "a2"}]},
        ],
        "edges": [
            {"id": "s1:e1", "src": "a1@c", "dst": "a2@c", "type": "PIX", "properties": {"amount": 10}, "source_id": "s1"},
        ],
    }


def test_nodes_merged_by_identity_key_match_by_their_entity_value():
    g = unified()
    s = spec(normalize="digits")
    rows = ef.rows_by_key(*ef.table_of(CSV, "text/csv", s), s)
    assert ef.enrich_graph(g, s, rows, "file") == 1
    ana = g["nodes"][0]
    # The value already there wins; the file's is a conflict. New keys are filled.
    assert ana["properties"] == {"risk": "low", "segment": "retail", "since": 2019}
    assert ana["conflicts"] == {"risk": [{"value": "high", "source_id": "file"}]}
    # overwrite: the file wins.
    g = unified()
    s = spec(normalize="digits", overwrite=True)
    ef.enrich_graph(g, s, rows, "file")
    assert g["nodes"][0]["properties"]["risk"] == "high" and "conflicts" not in g["nodes"][0]


def test_node_types_and_property_sources_restrict_the_match():
    g = unified()
    g["nodes"][1]["properties"]["doc"] = "987.654.321-00"
    s = spec(normalize="digits", match_node_types=["Account"], match_source={"kind": "prop", "name": "doc"})
    rows = ef.rows_by_key(*ef.table_of(CSV, "text/csv", s), s)
    assert ef.enrich_graph(g, s, rows, "file") == 1
    assert g["nodes"][1]["properties"]["segment"] == "corporate" and "segment" not in g["nodes"][0]["properties"]


def test_edges_match_by_id_or_by_endpoints_in_either_direction():
    by_id = spec(target="edges", key_column="edge", columns=["channel"])
    rows = ef.rows_by_key(["edge", "channel"], [["e1", "app"]], by_id)
    g = unified()
    assert ef.enrich_graph(g, by_id, rows, "file") == 1 and g["edges"][0]["properties"]["channel"] == "app"

    ends = spec(target="edges", key_column=None, columns=["channel"],
                edge_key={"by": "endpoints", "source_column": "to", "target_column": "from", "type_column": "kind"})
    rows = ef.rows_by_key(["from", "to", "kind", "channel"], [["a1", "a2", "PIX", "web"]], ends)  # reversed columns
    g = unified()
    assert ef.enrich_graph(g, ends, rows, "file") == 1 and g["edges"][0]["properties"]["channel"] == "web"
    wrong_type = ef.rows_by_key(["from", "to", "kind", "channel"], [["a1", "a2", "TED", "web"]], ends)
    assert ef.enrich_graph(unified(), ends, wrong_type, "file") == 0


def test_snapshots_are_enriched_without_conflicts():
    snap = {
        "nodes": [{"id": "p1", "type": "Person", "properties": {"risk": "low"}}, {"id": "p2", "type": "Person", "properties": {}}],
        "edges": [{"id": "e1", "source": "p1", "target": "p2", "type": "KNOWS", "properties": {}}],
    }
    s = spec(key_column="id", columns=["risk"])
    rows = ef.rows_by_key(["id", "risk"], [["p1", "high"], ["p2", "mid"]], s)
    assert ef.enrich_snapshot(snap, s, rows, "o1") == 2
    assert [n["properties"]["risk"] for n in snap["nodes"]] == ["low", "mid"]
    assert all("conflicts" not in n for n in snap["nodes"])


# Shared with frontend/src/utils/__tests__/enrichment.parity.test.ts: both engines emit `expected`.
from pathlib import Path  # noqa: E402

from graphlagoon.services.case_graph import unify  # noqa: E402

PARITY = Path(__file__).resolve().parents[2] / "frontend/src/__tests__/fixtures/enrichment"
PARITY_FIXTURES = sorted(PARITY.glob("*.json")) if PARITY.is_dir() else []


@pytest.mark.skipif(not PARITY_FIXTURES, reason="frontend fixtures not checked out")
@pytest.mark.parametrize("path", PARITY_FIXTURES, ids=[p.stem for p in PARITY_FIXTURES])
def test_enrichment_matches_the_typescript_engine(path):
    fx = json.loads(path.read_text())
    parts = [(s["id"], s["context_id"], fx["contexts"][s["context_id"]].get("identity_keys"), s, None) for s in fx["sources"]]
    g = unify(parts)
    for f in fx["files"]:
        c = f["content"]
        data, ctype = (json.dumps(c).encode(), "application/json") if isinstance(c, dict) else (c.encode(), "text/csv")
        ef.enrich_graph(g, f["spec"], ef.rows_by_key(*ef.table_of(data, ctype, f["spec"]), f["spec"]), f["id"])
    pick = lambda o: {"properties": o["properties"], **({"conflicts": o["conflicts"]} if o.get("conflicts") else {})}  # noqa: E731
    assert {n["uid"]: pick(n) for n in g["nodes"]} == fx["expected"]["nodes"]
    assert {e["id"]: pick(e) for e in g["edges"]} == fx["expected"]["edges"]
