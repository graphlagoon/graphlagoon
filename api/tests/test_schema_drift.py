"""Tests for the pure schema-drift diff service (graphlagoon.services.schema_drift).

Every case here is I/O-free: live columns and discovered types are passed in
directly, no warehouse or database involved.
"""

import sys
from uuid import uuid4

# Stub gsql2rsql package tree so graphlagoon can be imported without the dep.
# IMPORTANT: only stub when the real package is genuinely unavailable — a
# `not in sys.modules` guard would stub gsql2rsql for the whole session and break
# test_transpile_options (this file is collected before it alphabetically).
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

from graphlagoon.db.memory_store import MemoryGraphContext  # noqa: E402
from graphlagoon.services.schema_drift import (  # noqa: E402
    compute_drift,
    counts_by_severity,
    diff_structure,
    diff_table,
    diff_types,
    merge_properties,
    overall_status,
    parse_qualified_table,
    structural_roles,
)


def make_context(**overrides) -> MemoryGraphContext:
    defaults = dict(
        id=uuid4(),
        title="t",
        edge_table_name="cat.db.edges",
        node_table_name="cat.db.nodes",
        owner_email="a@b.com",
        node_properties=[
            {"name": "name", "data_type": "string", "display_name": "Name"},
            {"name": "score", "data_type": "int"},
        ],
        edge_properties=[{"name": "weight", "data_type": "double"}],
        node_types=["Person", "Company"],
        relationship_types=["KNOWS"],
    )
    defaults.update(overrides)
    return MemoryGraphContext(**defaults)


def col(name, data_type):
    return {"name": name, "data_type": data_type, "nullable": True, "comment": None}


# --- parse_qualified_table ---------------------------------------------------


class TestParseQualifiedTable:
    def test_two_parts_defaults_to_spark_catalog(self):
        assert parse_qualified_table("db.table") == ("spark_catalog", "db", "table")

    def test_three_parts(self):
        assert parse_qualified_table("cat.db.table") == ("cat", "db", "table")

    def test_invalid_returns_none(self):
        assert parse_qualified_table("table") is None
        assert parse_qualified_table("a.b.c.d") is None
        assert parse_qualified_table("") is None


# --- structural_roles ---------------------------------------------------------


class TestStructuralRoles:
    def test_default_roles(self):
        context = make_context()
        roles = structural_roles(context)
        assert roles["node_id_col"] == ("node", "node_id")
        assert roles["src_col"] == ("edge", "src")
        assert roles["edge_id_col"] == ("edge", "edge_id")

    def test_empty_edge_id_col_is_skipped(self):
        context = make_context(
            edge_structure={
                "edge_id_col": "",
                "src_col": "src",
                "dst_col": "dst",
                "relationship_type_col": "relationship_type",
            }
        )
        roles = structural_roles(context)
        assert "edge_id_col" not in roles
        assert "src_col" in roles


# --- diff_table ----------------------------------------------------------------


class TestDiffTable:
    def test_clean_table_no_findings(self):
        stored = [{"name": "name", "data_type": "string"}]
        live = [col("name", "string")]
        findings = diff_table("node", "cat.db.nodes", stored, live, set())
        assert findings == []

    def test_missing_property_column_is_error(self):
        stored = [{"name": "email", "data_type": "string", "display_name": "E-mail"}]
        findings = diff_table("node", "cat.db.nodes", stored, [], set())
        assert len(findings) == 1
        f = findings[0]
        assert f.code == "PROPERTY_COLUMN_MISSING"
        assert f.severity == "error"
        assert f.name == "email"
        assert f.stored["display_name"] == "E-mail"
        assert f.auto_fixable is True

    def test_added_property_column_is_info(self):
        live = [col("new_col", "string")]
        findings = diff_table("node", "cat.db.nodes", [], live, set())
        assert len(findings) == 1
        f = findings[0]
        assert f.code == "PROPERTY_COLUMN_ADDED"
        assert f.severity == "info"
        assert f.name == "new_col"

    def test_type_changed_is_warning(self):
        stored = [{"name": "score", "data_type": "int"}]
        live = [col("score", "double")]
        findings = diff_table("node", "cat.db.nodes", stored, live, set())
        assert len(findings) == 1
        f = findings[0]
        assert f.code == "PROPERTY_TYPE_CHANGED"
        assert f.severity == "warning"
        assert f.stored["data_type"] == "int"
        assert f.live["data_type"] == "double"

    def test_type_case_insensitive_no_finding(self):
        stored = [{"name": "score", "data_type": "STRING"}]
        live = [col("score", "string")]
        findings = diff_table("node", "cat.db.nodes", stored, live, set())
        assert findings == []

    def test_structural_columns_are_excluded_both_directions(self):
        """A structural column must never surface as missing OR added property finding."""
        stored = [
            {"name": "node_id", "data_type": "string"}
        ]  # garbage: also structural
        live = [col("node_id", "string")]
        findings = diff_table("node", "cat.db.nodes", stored, live, {"node_id"})
        assert findings == []

    def test_column_both_structural_and_stored_property_produces_nothing(self):
        stored = [{"name": "node_id", "data_type": "string"}]
        findings = diff_table("node", "cat.db.nodes", stored, [], {"node_id"})
        assert findings == []


# --- diff_structure --------------------------------------------------------------


class TestDiffStructure:
    def test_missing_structural_column_is_error(self):
        context = make_context()
        live_node = [col("node_type", "string")]  # node_id missing
        live_edge = [
            col(c, "string") for c in ("src", "dst", "relationship_type", "edge_id")
        ]
        findings = diff_structure(context, live_node, live_edge, True, True)
        assert len(findings) == 1
        f = findings[0]
        assert f.code == "STRUCTURAL_COLUMN_MISSING"
        assert f.severity == "error"
        assert f.role == "node_id_col"
        assert f.side == "node"
        assert f.auto_fixable is False

    def test_unreachable_side_is_skipped_not_double_reported(self):
        context = make_context()
        live_edge = [
            col(c, "string") for c in ("src", "dst", "relationship_type", "edge_id")
        ]
        # Node unreachable (columns don't matter) but edge IS reachable and complete —
        # only the node side should be skipped, edge stays fully checked.
        findings = diff_structure(context, [], live_edge, False, True)
        assert findings == []

    def test_all_structural_columns_present_no_findings(self):
        context = make_context()
        live_node = [col(c, "string") for c in ("node_id", "node_type")]
        live_edge = [
            col(c, "string") for c in ("src", "dst", "relationship_type", "edge_id")
        ]
        findings = diff_structure(context, live_node, live_edge, True, True)
        assert findings == []


# --- diff_types -----------------------------------------------------------------


class TestDiffTypes:
    def test_none_means_not_checked(self):
        findings = diff_types(["Person"], ["KNOWS"], None, None)
        assert findings == []

    def test_removed_type_is_warning(self):
        findings = diff_types(["Person", "Company"], [], ["Person"], None)
        assert len(findings) == 1
        assert findings[0].code == "TYPE_VALUE_REMOVED"
        assert findings[0].severity == "warning"
        assert findings[0].name == "Company"

    def test_added_type_is_info(self):
        findings = diff_types(["Person"], [], ["Person", "Company"], None)
        assert len(findings) == 1
        assert findings[0].code == "TYPE_VALUE_ADDED"
        assert findings[0].severity == "info"
        assert findings[0].name == "Company"

    def test_relationship_types_diffed_independently(self):
        findings = diff_types([], ["KNOWS"], None, ["KNOWS", "WORKS_AT"])
        assert len(findings) == 1
        assert findings[0].side == "edge"
        assert findings[0].name == "WORKS_AT"


# --- merge_properties -------------------------------------------------------------


class TestMergeProperties:
    def test_survivor_keeps_display_name_and_description(self):
        stored = [
            {
                "name": "name",
                "data_type": "string",
                "display_name": "Name",
                "description": "d",
            }
        ]
        live = [col("name", "string")]
        result = merge_properties(stored, live, set())
        assert result == [
            {
                "name": "name",
                "data_type": "string",
                "display_name": "Name",
                "description": "d",
            }
        ]

    def test_survivor_takes_data_type_from_live(self):
        stored = [{"name": "score", "data_type": "int", "display_name": "Score"}]
        live = [col("score", "double")]
        result = merge_properties(stored, live, set())
        assert result[0]["data_type"] == "double"
        assert result[0]["display_name"] == "Score"

    def test_missing_column_is_dropped(self):
        stored = [{"name": "gone", "data_type": "string"}]
        result = merge_properties(stored, [], set())
        assert result == []

    def test_new_column_added_with_no_display_name(self):
        result = merge_properties([], [col("new_col", "string")], set())
        assert result == [
            {
                "name": "new_col",
                "data_type": "string",
                "display_name": None,
                "description": None,
            }
        ]

    def test_ordering_survivors_first_then_new_in_live_order(self):
        stored = [
            {"name": "b", "data_type": "string"},
            {"name": "a", "data_type": "string"},
        ]
        live = [col("c", "string"), col("a", "string"), col("b", "string")]
        result = merge_properties(stored, live, set())
        assert [r["name"] for r in result] == ["b", "a", "c"]

    def test_structural_columns_excluded_from_result(self):
        result = merge_properties(
            [], [col("node_id", "string"), col("name", "string")], {"node_id"}
        )
        assert [r["name"] for r in result] == ["name"]

    def test_stored_property_colliding_with_structural_name_silently_dropped(self):
        stored = [{"name": "node_id", "data_type": "string"}]
        result = merge_properties(stored, [col("node_id", "string")], {"node_id"})
        assert result == []


# --- overall_status / counts_by_severity ------------------------------------------


class TestOverallStatus:
    def test_no_findings_is_ok(self):
        assert overall_status([]) == "ok"

    def test_precedence_error_beats_warning_beats_info(self):
        from graphlagoon.services.schema_drift import Finding

        findings = [
            Finding(
                code="X",
                severity="info",
                side="node",
                kind="property",
                name="a",
                message="",
            ),
            Finding(
                code="Y",
                severity="warning",
                side="node",
                kind="property",
                name="b",
                message="",
            ),
        ]
        assert overall_status(findings) == "warning"
        findings.append(
            Finding(
                code="Z",
                severity="error",
                side="node",
                kind="table",
                name="c",
                message="",
            )
        )
        assert overall_status(findings) == "error"

    def test_counts_by_severity(self):
        from graphlagoon.services.schema_drift import Finding

        findings = [
            Finding(
                code="X",
                severity="error",
                side="node",
                kind="property",
                name="a",
                message="",
            ),
            Finding(
                code="Y",
                severity="error",
                side="node",
                kind="property",
                name="b",
                message="",
            ),
            Finding(
                code="Z",
                severity="info",
                side="node",
                kind="property",
                name="c",
                message="",
            ),
        ]
        assert counts_by_severity(findings) == {"error": 2, "warning": 0, "info": 1}


# --- compute_drift (orchestration) ------------------------------------------------


class TestComputeDrift:
    def test_clean_context_is_ok(self):
        context = make_context()
        live_node = [
            col("node_id", "string"),
            col("node_type", "string"),
            col("name", "string"),
            col("score", "int"),
        ]
        live_edge = [
            col(c, "string") for c in ("edge_id", "src", "dst", "relationship_type")
        ] + [col("weight", "double")]
        result = compute_drift(context, True, live_node, True, live_edge)
        assert result["status"] == "ok"
        assert result["findings"] == []
        assert {p["name"] for p in result["proposed_node_properties"]} == {
            "name",
            "score",
        }

    def test_unreachable_table_yields_single_finding_not_a_cascade(self):
        context = make_context()
        result = compute_drift(
            context,
            False,
            None,
            True,
            [
                col(c, "string")
                for c in ("edge_id", "src", "dst", "relationship_type", "weight")
            ],
        )
        table_not_found = [f for f in result["findings"] if f.code == "TABLE_NOT_FOUND"]
        property_missing = [
            f
            for f in result["findings"]
            if f.code == "PROPERTY_COLUMN_MISSING" and f.side == "node"
        ]
        structural_missing = [
            f
            for f in result["findings"]
            if f.code == "STRUCTURAL_COLUMN_MISSING" and f.side == "node"
        ]
        assert len(table_not_found) == 1
        assert property_missing == []
        assert structural_missing == []
        assert result["status"] == "error"

    def test_unreachable_table_echoes_stored_properties_in_proposed(self):
        context = make_context()
        result = compute_drift(
            context,
            False,
            None,
            True,
            [
                col(c, "string")
                for c in ("edge_id", "src", "dst", "relationship_type", "weight")
            ],
        )
        assert {p["name"] for p in result["proposed_node_properties"]} == {
            "name",
            "score",
        }

    def test_types_not_checked_by_default(self):
        context = make_context()
        live_node = [
            col("node_id", "string"),
            col("node_type", "string"),
            col("name", "string"),
            col("score", "int"),
        ]
        live_edge = [
            col(c, "string")
            for c in ("edge_id", "src", "dst", "relationship_type", "weight")
        ]
        result = compute_drift(context, True, live_node, True, live_edge)
        assert result["proposed_node_types"] is None
        assert result["proposed_relationship_types"] is None
        assert all(f.kind != "type" for f in result["findings"])

    def test_types_checked_surfaces_type_findings(self):
        context = make_context()
        live_node = [
            col("node_id", "string"),
            col("node_type", "string"),
            col("name", "string"),
            col("score", "int"),
        ]
        live_edge = [
            col(c, "string")
            for c in ("edge_id", "src", "dst", "relationship_type", "weight")
        ]
        result = compute_drift(
            context,
            True,
            live_node,
            True,
            live_edge,
            discovered_node_types=["Person", "Company", "Robot"],
            discovered_relationship_types=["KNOWS"],
        )
        added = [f for f in result["findings"] if f.code == "TYPE_VALUE_ADDED"]
        assert len(added) == 1
        assert added[0].name == "Robot"
        assert result["proposed_node_types"] == ["Person", "Company", "Robot"]
