"""Tests for SQL validation service."""

from graphlagoon.services.sql_validation import (
    validate_sql_query,
    sanitize_string_literal,
)


class TestValidateSqlQuery:
    """Tests for validate_sql_query() deny list."""

    # --- Valid queries (should pass) ---

    def test_simple_select(self):
        is_valid, msg = validate_sql_query("SELECT * FROM catalog.schema.edges")
        assert is_valid, msg

    def test_select_with_where(self):
        is_valid, msg = validate_sql_query(
            "SELECT * FROM catalog.schema.edges WHERE relationship_type = 'KNOWS'"
        )
        assert is_valid, msg

    def test_select_with_join(self):
        sql = """
            SELECT e.*, n.node_type
            FROM catalog.schema.edges e
            JOIN catalog.schema.nodes n ON e.src = n.node_id
        """
        is_valid, msg = validate_sql_query(sql)
        assert is_valid, msg

    def test_select_with_cte(self):
        sql = """
            WITH filtered AS (
                SELECT * FROM catalog.schema.edges
                WHERE relationship_type = 'KNOWS'
            )
            SELECT * FROM filtered
        """
        is_valid, msg = validate_sql_query(sql)
        assert is_valid, msg

    def test_select_with_subquery(self):
        sql = """
            SELECT * FROM catalog.schema.edges
            WHERE src IN (
                SELECT node_id FROM catalog.schema.nodes
                WHERE node_type = 'Person'
            )
        """
        is_valid, msg = validate_sql_query(sql)
        assert is_valid, msg

    def test_select_with_named_struct(self):
        sql = """
            SELECT NAMED_STRUCT(
                'edge_id', edge_id, 'src', src
            ) AS r
            FROM catalog.schema.edges
            LIMIT 100
        """
        is_valid, msg = validate_sql_query(sql)
        assert is_valid, msg

    def test_select_with_limit(self):
        is_valid, msg = validate_sql_query(
            "SELECT * FROM catalog.schema.edges LIMIT 10"
        )
        assert is_valid, msg

    def test_select_with_order_by(self):
        is_valid, msg = validate_sql_query(
            "SELECT * FROM catalog.schema.edges ORDER BY src"
        )
        assert is_valid, msg

    def test_select_with_group_by(self):
        sql = """
            SELECT node_type, COUNT(*) as cnt
            FROM catalog.schema.nodes
            GROUP BY node_type
        """
        is_valid, msg = validate_sql_query(sql)
        assert is_valid, msg

    def test_select_constant(self):
        is_valid, msg = validate_sql_query("SELECT 1 + 1")
        assert is_valid, msg

    def test_select_union(self):
        sql = """
            SELECT * FROM catalog.schema.edges
            UNION ALL
            SELECT * FROM catalog.schema.edges
        """
        is_valid, msg = validate_sql_query(sql)
        assert is_valid, msg

    def test_recursive_cte(self):
        sql = """
            WITH RECURSIVE neighbors AS (
                SELECT node_id, 0 AS depth
                FROM catalog.schema.nodes
                WHERE node_id = 'start'
                UNION ALL
                SELECT e.dst AS node_id, n.depth + 1
                FROM neighbors n
                JOIN catalog.schema.edges e ON e.src = n.node_id
                WHERE n.depth < 2
            )
            SELECT * FROM neighbors
        """
        is_valid, msg = validate_sql_query(sql)
        assert is_valid, msg

    # --- Invalid queries: wrong statement type ---

    def test_reject_drop_table(self):
        is_valid, msg = validate_sql_query("DROP TABLE catalog.schema.edges")
        assert not is_valid
        assert "SELECT" in msg

    def test_reject_insert(self):
        is_valid, msg = validate_sql_query(
            "INSERT INTO catalog.schema.edges VALUES (1, 2, 3)"
        )
        assert not is_valid

    def test_reject_update(self):
        is_valid, msg = validate_sql_query("UPDATE catalog.schema.edges SET src = 'x'")
        assert not is_valid

    def test_reject_delete(self):
        is_valid, msg = validate_sql_query("DELETE FROM catalog.schema.edges")
        assert not is_valid

    def test_reject_create_table(self):
        is_valid, msg = validate_sql_query("CREATE TABLE catalog.schema.evil (id INT)")
        assert not is_valid

    def test_reject_alter_table(self):
        is_valid, msg = validate_sql_query(
            "ALTER TABLE catalog.schema.edges ADD COLUMN x INT"
        )
        assert not is_valid

    def test_reject_truncate(self):
        is_valid, msg = validate_sql_query("TRUNCATE TABLE catalog.schema.edges")
        assert not is_valid

    # --- Invalid queries: multi-statement injection ---

    def test_reject_multi_statement_semicolon(self):
        sql = "SELECT * FROM catalog.schema.edges; DROP TABLE catalog.schema.edges"
        is_valid, msg = validate_sql_query(sql)
        assert not is_valid
        assert "single" in msg.lower()

    def test_reject_select_then_insert(self):
        sql = "SELECT 1; INSERT INTO catalog.schema.edges VALUES (1, 2, 3)"
        is_valid, msg = validate_sql_query(sql)
        assert not is_valid

    # --- Invalid queries: edge cases ---

    def test_reject_empty_query(self):
        is_valid, msg = validate_sql_query("")
        assert not is_valid

    def test_reject_whitespace_only(self):
        is_valid, msg = validate_sql_query("   \n\t  ")
        assert not is_valid

    def test_reject_set_command(self):
        is_valid, msg = validate_sql_query("SET spark.sql.shuffle = 200")
        assert not is_valid


class TestSanitizeStringLiteral:
    """Tests for sanitize_string_literal()."""

    def test_normal_string(self):
        assert sanitize_string_literal("hello") == "hello"

    def test_single_quotes(self):
        assert sanitize_string_literal("it's") == "it''s"

    def test_null_bytes(self):
        assert sanitize_string_literal("hello\0world") == "helloworld"

    def test_backslashes(self):
        assert sanitize_string_literal("a\\b") == "a\\\\b"

    def test_injection_attempt(self):
        result = sanitize_string_literal("'; DROP TABLE x; --")
        # The single quote is doubled, so it can't break out
        assert result == "''; DROP TABLE x; --"

    def test_empty_string(self):
        assert sanitize_string_literal("") == ""

    def test_combined(self):
        result = sanitize_string_literal("a'b\\c\0d")
        assert result == "a''b\\\\cd"
