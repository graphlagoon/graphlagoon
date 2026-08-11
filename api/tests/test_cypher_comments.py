"""Tests that Cypher comments don't break the validation gate.

``validate_cypher_query`` keys off the leading MATCH keyword, so before
comments were stripped a query starting with ``// note`` was rejected with
"Query must start with MATCH" — the frontend disabled the Run button and the
user had no way forward.

Uses the same stub-poisoning guard as test_cypher_schema_provider.py: importing
graphlagoon.services.cypher pulls in gsql2rsql, and a MagicMock stub left behind
by an earlier-collected module would make these assertions meaningless.
"""

from unittest.mock import MagicMock

import pytest

gsql2rsql = pytest.importorskip("gsql2rsql")
if isinstance(gsql2rsql, MagicMock):
    pytest.skip(
        "gsql2rsql stubbed by an earlier test module; real package unavailable",
        allow_module_level=True,
    )

from graphlagoon.services.cypher import validate_cypher_query  # noqa: E402


class TestValidateCypherQueryWithComments:
    def test_leading_line_comment_accepted(self):
        is_valid, err = validate_cypher_query(
            "// find the neighbours\nMATCH (s)-[r]->(d) RETURN r"
        )
        assert is_valid, err

    def test_trailing_line_comment_accepted(self):
        is_valid, err = validate_cypher_query(
            "MATCH (s)-[r]->(d) RETURN r // only direct edges"
        )
        assert is_valid, err

    def test_block_comment_before_match_accepted(self):
        is_valid, err = validate_cypher_query(
            "/* header */ MATCH (s)-[r]->(d) RETURN r"
        )
        assert is_valid, err

    def test_multiple_leading_comments_accepted(self):
        is_valid, err = validate_cypher_query(
            "// first\n// second\nMATCH (s)-[r]->(d) RETURN DISTINCT r"
        )
        assert is_valid, err

    def test_commented_out_return_does_not_satisfy_gate(self):
        """A RETURN r hidden in a comment must not pass the gate."""
        is_valid, _ = validate_cypher_query(
            "MATCH (s)-[r]->(d) // RETURN r"
        )
        assert not is_valid

    def test_commented_out_match_still_rejected(self):
        is_valid, err = validate_cypher_query(
            "// MATCH (s)-[r]->(d) RETURN r"
        )
        assert not is_valid
        assert "MATCH" in err

    def test_uncommented_query_still_valid(self):
        is_valid, err = validate_cypher_query("MATCH (s)-[r]->(d) RETURN r")
        assert is_valid, err

    def test_non_match_query_still_rejected(self):
        is_valid, err = validate_cypher_query("CREATE (n:Person) RETURN n")
        assert not is_valid
        assert "MATCH" in err
