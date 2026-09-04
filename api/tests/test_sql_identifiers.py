"""Unit tests for the shared SQL identifier validation/quoting helpers.

These are the security boundary for every f-string SQL builder (finding A4
and its stored variant — see docs/dev/security-assessment.md).
"""

import pytest

from graphlagoon.services.sql_identifiers import (
    escape_identifier,
    qualified_from_dotted,
    qualified_name,
    quote_identifier,
    validate_identifier_part,
)


class TestValidateIdentifierPart:
    @pytest.mark.parametrize(
        "name", ["users", "Users_2", "_hidden", "T", "a1b2c3", "0start"]
    )
    def test_accepts_bare_identifiers(self, name):
        assert validate_identifier_part(name) == name

    @pytest.mark.parametrize(
        "name",
        [
            "",
            "with space",
            "semi;colon",
            "x; DROP TABLE users",
            "back`tick",
            "quo'te",
            'dou"ble',
            "dash-ed",
            "dot.ted",
            "star*",
            "paren(",
            "new\nline",
            "x WHERE 1=1 UNION SELECT * FROM secrets --",
        ],
    )
    def test_rejects_hostile_or_quoted_names(self, name):
        with pytest.raises(ValueError):
            validate_identifier_part(name)


class TestQuoting:
    def test_quote_wraps_in_backticks(self):
        assert quote_identifier("users") == "`users`"

    def test_quote_escapes_embedded_backticks(self):
        assert quote_identifier("a`b") == "`a``b`"

    def test_escape_doubles_without_wrapping(self):
        assert escape_identifier("a`b") == "a``b"
        assert escape_identifier("plain") == "plain"


class TestQualifiedName:
    def test_three_part(self):
        assert qualified_name("cat", "db", "tbl") == "`cat`.`db`.`tbl`"

    def test_single_part(self):
        assert qualified_name("db") == "`db`"

    def test_hostile_part_raises(self):
        with pytest.raises(ValueError):
            qualified_name("cat", "db", "t; DROP TABLE x")


class TestQualifiedFromDotted:
    def test_two_part(self):
        assert qualified_from_dotted("db.tbl") == "`db`.`tbl`"

    def test_three_part(self):
        assert qualified_from_dotted("cat.db.tbl") == "`cat`.`db`.`tbl`"

    @pytest.mark.parametrize(
        "name",
        [
            "single",
            "a.b.c.d",
            "db.t WHERE 1=1 UNION SELECT * FROM s",
            "db.t; DROP TABLE x",
            "db.`quoted`",
            "",
        ],
    )
    def test_rejects_non_table_shapes(self, name):
        with pytest.raises(ValueError):
            qualified_from_dotted(name)
