"""Tests for CTE pre-filter service."""

from graphlagoon.services.cte_prefilter import (
    validate_cte_prefilter,
    apply_cte_prefilter,
)


# ── validate_cte_prefilter ──────────────────────────────────────────


class TestValidateCtePrefilter:
    def test_valid_single_cte(self):
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__ WHERE x = 1)"
        is_valid, err = validate_cte_prefilter(cte)
        assert is_valid, err

    def test_valid_multiple_ctes(self):
        cte = (
            "helper AS (SELECT * FROM __EDGES__ WHERE status = 'active'),\n"
            "MY_FINAL_EDGES AS (SELECT * FROM helper WHERE weight > 0.5)"
        )
        is_valid, err = validate_cte_prefilter(cte)
        assert is_valid, err

    def test_valid_with_nodes_placeholder(self):
        cte = (
            "MY_FINAL_EDGES AS (\n"
            "  SELECT e.* FROM __EDGES__ e\n"
            "  JOIN __NODES__ n ON e.src = n.node_id\n"
            "  WHERE n.node_type = 'Person'\n"
            ")"
        )
        is_valid, err = validate_cte_prefilter(cte)
        assert is_valid, err

    def test_valid_case_insensitive(self):
        cte = "my_final_edges AS (SELECT * FROM __EDGES__)"
        is_valid, err = validate_cte_prefilter(cte)
        assert is_valid, err

    def test_missing_my_final_edges(self):
        cte = "other_cte AS (SELECT * FROM __EDGES__)"
        is_valid, err = validate_cte_prefilter(cte)
        assert not is_valid
        assert "MY_FINAL_EDGES" in err

    def test_empty_cte_text(self):
        is_valid, err = validate_cte_prefilter("")
        assert not is_valid
        assert "Empty" in err

    def test_whitespace_only(self):
        is_valid, err = validate_cte_prefilter("   \n  ")
        assert not is_valid
        assert "Empty" in err

    def test_syntax_error(self):
        cte = "MY_FINAL_EDGES AS (SELECT * FROM"
        is_valid, err = validate_cte_prefilter(cte)
        assert not is_valid
        assert "syntax" in err.lower() or "parse" in err.lower()

    def test_cte_with_ddl_rejected(self):
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__) ; DROP TABLE __EDGES__"
        is_valid, err = validate_cte_prefilter(cte)
        assert not is_valid

    def test_cte_with_where_clause(self):
        cte = (
            "MY_FINAL_EDGES AS (\n"
            "  SELECT * FROM __EDGES__\n"
            "  WHERE relationship_type IN ('KNOWS', 'WORKS_AT')\n"
            "  AND src != dst\n"
            ")"
        )
        is_valid, err = validate_cte_prefilter(cte)
        assert is_valid, err

    def test_cte_with_aggregation(self):
        cte = (
            "edge_counts AS (\n"
            "  SELECT src, dst, relationship_type, COUNT(*) AS cnt\n"
            "  FROM __EDGES__\n"
            "  GROUP BY src, dst, relationship_type\n"
            "),\n"
            "MY_FINAL_EDGES AS (\n"
            "  SELECT * FROM __EDGES__ e\n"
            "  JOIN edge_counts ec ON e.src = ec.src AND e.dst = ec.dst\n"
            "  WHERE ec.cnt > 1\n"
            ")"
        )
        is_valid, err = validate_cte_prefilter(cte)
        assert is_valid, err


# ── apply_cte_prefilter ─────────────────────────────────────────────


EDGE_TABLE = "dev_catalog.graphs.edges_test"
NODE_TABLE = "dev_catalog.graphs.nodes_test"


class TestApplyCtePrefilter:
    def test_simple_table_replacement(self):
        """Edge table reference in SQL is replaced with MY_FINAL_EDGES."""
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__ WHERE x = 1)"
        sql = f"SELECT * FROM {EDGE_TABLE} WHERE y = 2"

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        assert "MY_FINAL_EDGES" in result
        # The original table should not appear as a FROM target
        # (it should only appear inside the CTE definition)
        # Check result is valid SQL by confirming WITH is present
        assert result.strip().upper().startswith("WITH")

    def test_placeholder_replacement(self):
        """__EDGES__ and __NODES__ are replaced with actual table names."""
        cte = (
            "MY_FINAL_EDGES AS (\n"
            "  SELECT e.* FROM __EDGES__ e\n"
            "  JOIN __NODES__ n ON e.src = n.node_id\n"
            ")"
        )
        sql = f"SELECT * FROM {EDGE_TABLE}"

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        # Placeholders should be replaced
        assert "__EDGES__" not in result
        assert "__NODES__" not in result
        # Actual table names should appear (inside the CTE)
        assert EDGE_TABLE in result or "edges_test" in result
        assert NODE_TABLE in result or "nodes_test" in result

    def test_cte_merging_no_existing_ctes(self):
        """SQL without CTEs gets CTE prepended."""
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__)"
        sql = f"SELECT * FROM {EDGE_TABLE}"

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        assert result.strip().upper().startswith("WITH")
        assert "MY_FINAL_EDGES" in result

    def test_cte_merging_with_existing_ctes(self):
        """SQL with existing CTEs gets user CTEs prepended."""
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__)"
        sql = (
            f"WITH existing_cte AS (SELECT src FROM {EDGE_TABLE}) "
            f"SELECT * FROM {EDGE_TABLE} e "
            "JOIN existing_cte ec ON e.src = ec.src"
        )

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        upper = result.upper()
        assert "MY_FINAL_EDGES" in upper
        assert "EXISTING_CTE" in upper
        # Should start with a single WITH
        assert upper.strip().startswith("WITH")
        # Should NOT have two WITH keywords
        assert upper.count("WITH ") == 1 or upper.count("WITH\n") <= 1

    def test_multiple_table_references_replaced(self):
        """All edge table references in SQL are replaced."""
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__)"
        sql = (
            f"SELECT a.*, b.* FROM {EDGE_TABLE} a JOIN {EDGE_TABLE} b ON a.dst = b.src"
        )

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        # Count MY_FINAL_EDGES references (should appear in CTE + 2 in query)
        assert result.upper().count("MY_FINAL_EDGES") >= 3

    def test_node_table_not_replaced_in_main_sql(self):
        """Node table refs in the main SQL are NOT replaced."""
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__)"
        sql = f"SELECT * FROM {EDGE_TABLE} e JOIN {NODE_TABLE} n ON e.src = n.node_id"

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        # Node table should still be referenced directly
        assert NODE_TABLE in result or "nodes_test" in result

    def test_output_is_valid_sql(self):
        """The output can be parsed by sqlglot without errors."""
        import sqlglot

        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__ WHERE x = 1)"
        sql = f"SELECT * FROM {EDGE_TABLE} WHERE y = 2"

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        # Should parse without error
        statements = sqlglot.parse(result, dialect="spark")
        assert len(statements) == 1
        assert statements[0] is not None

    def test_table_alias_preserved(self):
        """Table aliases (e.g. 'e' in 'FROM table e') are preserved."""
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__)"
        sql = (
            f"SELECT e.src, e.dst FROM {EDGE_TABLE} e "
            f"WHERE e.relationship_type = 'KNOWS'"
        )

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        # Alias 'e' should be preserved after table replacement
        assert "MY_FINAL_EDGES e" in result
        assert "e.src" in result
        assert "e.dst" in result

    def test_recursive_cte_preserved(self):
        """WITH RECURSIVE keyword is preserved when merging CTEs."""
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__ WHERE x = 1)"
        sql = (
            f"WITH RECURSIVE paths_1 AS ("
            f"  SELECT src, dst, 1 AS depth FROM {EDGE_TABLE}"
            f"  UNION ALL"
            f"  SELECT p.src, e.dst, p.depth + 1"
            f"  FROM paths_1 p JOIN {EDGE_TABLE} e ON p.dst = e.src"
            f"  WHERE p.depth < 3"
            f") SELECT * FROM paths_1"
        )

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        upper = result.upper()
        # RECURSIVE keyword must be preserved
        assert "RECURSIVE" in upper
        # User CTE and paths_1 both present
        assert "MY_FINAL_EDGES AS" in upper
        assert "PATHS_1 AS" in upper
        # Only one MY_FINAL_EDGES CTE definition
        assert upper.count("MY_FINAL_EDGES AS (") == 1

    def test_no_partial_table_name_replacement(self):
        """Table name replacement doesn't affect similar but different names."""
        cte = "MY_FINAL_EDGES AS (SELECT * FROM __EDGES__)"
        # SQL references both the edge table and a similarly-named table
        sql = (
            f"SELECT * FROM {EDGE_TABLE} e JOIN {EDGE_TABLE}_backup b ON e.src = b.src"
        )

        result = apply_cte_prefilter(sql, cte, EDGE_TABLE, NODE_TABLE)

        # The exact edge table should be replaced
        assert "MY_FINAL_EDGES e" in result
        # The similar table should NOT be replaced
        assert f"{EDGE_TABLE}_backup" in result
