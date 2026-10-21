"""Unit tests for the shared SQL identifier validation/quoting helpers.

These are the security boundary for every f-string SQL builder (finding A4
and its stored variant — see docs/dev/security-assessment.md).
"""

import pytest

from graphlagoon.services.sql_identifiers import (
    dotted_name,
    escape_identifier,
    qualified_from_dotted,
    qualified_name,
    quote_identifier,
    split_qualified,
    validate_identifier_part,
)


class TestValidateIdentifierPart:
    @pytest.mark.parametrize(
        "name", ["users", "Users_2", "_hidden", "T", "a1b2c3", "0start"]
    )
    def test_accepts_bare_identifiers(self, name):
        assert validate_identifier_part(name) == name

    # Unity Catalog names may hold hyphens; the result is always backtick-quoted.
    @pytest.mark.parametrize(
        "name, bare",
        [("dash-ed", "dash-ed"), ("`dash-ed`", "dash-ed"), ("`catalogo`", "catalogo")],
    )
    def test_accepts_catalog_names_and_strips_backticks(self, name, bare):
        assert validate_identifier_part(name) == bare

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
            "dot.ted",
            "`",
            "``",
            "`a`b`",
            "`x` DROP",
            "`x`; DROP TABLE users --`",
            "back\\slash",
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
            "db.`t; DROP`",
            "my-cat.db.t",
            "``.db.t",
            "",
        ],
    )
    def test_rejects_non_table_shapes(self, name):
        with pytest.raises(ValueError):
            qualified_from_dotted(name)


class TestBacktickedNames:
    """Databricks users write `catalogo`.schema.tabela, or need backticks for
    a catalog like `my-cat`."""

    def test_quoted_catalog(self):
        assert qualified_from_dotted("`catalogo`.schema.tabela") == (
            "`catalogo`.`schema`.`tabela`"
        )

    def test_every_part_quoted(self):
        assert qualified_from_dotted("`my-cat`.`db`.`t`") == "`my-cat`.`db`.`t`"

    def test_split_strips_backticks(self):
        assert split_qualified("`my-cat`.db.t") == ["my-cat", "db", "t"]

    def test_unquoted_hyphen_asks_for_backticks(self):
        with pytest.raises(ValueError, match="backticks"):
            split_qualified("my-cat.db.t")

    def test_dotted_name_quotes_only_what_needs_it(self):
        assert dotted_name("my-cat", "db", "t") == "`my-cat`.db.t"
        assert dotted_name("main", "db", "t") == "main.db.t"
        assert split_qualified(dotted_name("my-cat", "db", "t")) == ["my-cat", "db", "t"]
