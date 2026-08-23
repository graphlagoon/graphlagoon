"""Tests for services/graph_codec.py."""

import gzip

import orjson
import pytest

from graphlagoon.services.graph_codec import (
    EXTENSION,
    GZIP_MAGIC,
    ZSTD_MAGIC,
    compress,
    decompress,
    sniff_encoding,
)


def _graph_payload(node_count: int = 3) -> dict:
    return {
        "payload_version": 1,
        "graph": {
            "nodes": [
                {
                    "node_id": f"n{i}",
                    "node_type": "Account",
                    "properties": {"score": i, "label": f"node {i}", "flag": None},
                }
                for i in range(node_count)
            ],
            "edges": [
                {
                    "edge_id": f"e{i}",
                    "src": f"n{i}",
                    "dst": f"n{i + 1}",
                    "relationship_type": "SENT",
                    "properties": {},
                }
                for i in range(node_count - 1)
            ],
            "truncated": False,
            "total_count": None,
            "properties_deferred": False,
        },
    }


class TestRoundTrip:
    def test_round_trip_preserves_payload(self):
        payload = _graph_payload()
        assert decompress(compress(payload)) == payload

    def test_output_is_gzip(self):
        assert compress(_graph_payload()).startswith(GZIP_MAGIC)

    def test_compresses_repetitive_graphs_well(self):
        payload = _graph_payload(500)
        raw = len(orjson.dumps(payload))
        packed = len(compress(payload))
        assert packed < raw / 3, f"expected >3x compression, got {raw / packed:.1f}x"

    def test_reads_a_payload_written_by_plain_gzip_json(self):
        """Anything that writes gzip'd JSON — including an external job dropping a
        file on the volume — must be readable without going through compress()."""
        payload = _graph_payload()
        blob = gzip.compress(orjson.dumps(payload))
        assert decompress(blob) == payload

    def test_extension_does_not_name_the_algorithm(self):
        assert EXTENSION == ".jsonz"
        assert "gz" not in EXTENSION


class TestSniffEncoding:
    def test_detects_gzip(self):
        assert sniff_encoding(compress({"a": 1})) == "gzip"

    def test_detects_zstd(self):
        assert sniff_encoding(ZSTD_MAGIC + b"payload") == "zstd"

    def test_unknown_is_none(self):
        assert sniff_encoding(b'{"plain": "json"}') is None

    def test_empty_is_none(self):
        assert sniff_encoding(b"") is None


class TestErrors:
    def test_uncompressed_json_is_rejected_clearly(self):
        with pytest.raises(ValueError, match="Unrecognized payload encoding"):
            decompress(b'{"plain": "json"}')

    def test_empty_input_is_rejected_clearly(self):
        with pytest.raises(ValueError, match="Unrecognized payload encoding"):
            decompress(b"")

    def test_zstd_payload_names_the_missing_support(self):
        with pytest.raises(ValueError, match="no zstd support"):
            decompress(ZSTD_MAGIC + b"whatever")

    def test_truncated_gzip_raises(self):
        blob = compress(_graph_payload())
        with pytest.raises(Exception):
            decompress(blob[: len(blob) // 2])


class TestSerialization:
    def test_non_string_dict_keys_are_rejected(self):
        """Warehouse property dicts are str-keyed; anything else should fail loudly
        at write time rather than silently round-tripping into a different shape."""
        with pytest.raises(TypeError):
            compress({"properties": {1: "one"}})

    def test_nested_nulls_and_unicode_survive(self):
        payload = {"properties": {"name": "Ana Lúcia", "missing": None, "n": 1.5}}
        assert decompress(compress(payload)) == payload
