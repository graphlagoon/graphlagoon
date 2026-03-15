"""OpenCypher to SQL transpiler service using gsql2rsql."""

import re
from typing import Optional

from gsql2rsql.parser.opencypher_parser import OpenCypherParser
from gsql2rsql.planner.logical_plan import LogicalPlan
from gsql2rsql.planner.pass_manager import optimize_plan
from gsql2rsql.renderer.sql_renderer import SQLRenderer
from gsql2rsql.common.schema import NodeSchema, EdgeSchema, EntityProperty
from gsql2rsql.renderer.schema_provider import (
    SimpleSQLSchemaProvider,
    SQLTableDescriptor,
)

from graphlagoon.db.models import GraphContext as GraphContextModel


def spark_type_to_python_type(spark_type: str) -> type:
    """Convert Spark SQL type to Python type for gsql2rsql."""
    spark_type_lower = spark_type.lower()

    if spark_type_lower in ("string", "varchar", "char", "text"):
        return str
    elif spark_type_lower in (
        "int",
        "integer",
        "bigint",
        "smallint",
        "tinyint",
        "long",
    ):
        return int
    elif spark_type_lower in ("float", "double", "decimal", "numeric", "real"):
        return float
    elif spark_type_lower in ("boolean", "bool"):
        return bool
    else:
        return str


def build_schema_provider(context: GraphContextModel) -> SimpleSQLSchemaProvider:
    """
    Build a SimpleSQLSchemaProvider from a GraphContext.

    Creates NodeSchema for each node_type and EdgeSchema for each
    (source_type, edge_type, sink_type) combination.
    """
    schema = SimpleSQLSchemaProvider()

    # Extract structure info
    node_struct = context.node_structure or {}
    edge_struct = context.edge_structure or {}

    node_id_col = node_struct.get("node_id_col", "node_id")
    node_type_col = node_struct.get("node_type_col", "node_type")

    src_col = edge_struct.get("src_col", "src")
    dst_col = edge_struct.get("dst_col", "dst")
    relationship_type_col = edge_struct.get(
        "relationship_type_col", "relationship_type"
    )

    # Convert property columns to dict {name: type}
    extra_node_attrs: dict[str, type] = {}
    for prop in context.node_properties or []:
        prop_name = (
            prop.get("name") if isinstance(prop, dict) else getattr(prop, "name", None)
        )
        prop_type = (
            prop.get("data_type", "string")
            if isinstance(prop, dict)
            else getattr(prop, "data_type", "string")
        )
        if prop_name:
            extra_node_attrs[prop_name] = spark_type_to_python_type(
                prop_type or "string"
            )

    extra_edge_attrs: dict[str, type] = {}
    for prop in context.edge_properties or []:
        prop_name = (
            prop.get("name") if isinstance(prop, dict) else getattr(prop, "name", None)
        )
        prop_type = (
            prop.get("data_type", "string")
            if isinstance(prop, dict)
            else getattr(prop, "data_type", "string")
        )
        if prop_name:
            extra_edge_attrs[prop_name] = spark_type_to_python_type(
                prop_type or "string"
            )

    # Get types
    node_types = context.node_types or ["Node"]
    edge_types = context.relationship_types or ["RELATED_TO"]

    # Create NodeSchema for each node_type
    for node_type in node_types:
        node_schema = NodeSchema(
            name=node_type,
            properties=[
                EntityProperty(property_name=prop_name, data_type=data_type)
                for prop_name, data_type in extra_node_attrs.items()
            ]
            + [
                EntityProperty(property_name=node_type_col, data_type=str),
                EntityProperty(property_name=node_id_col, data_type=str),
            ],
            node_id_property=EntityProperty(property_name=node_id_col, data_type=str),
        )
        schema.add_node(
            node_schema,
            SQLTableDescriptor(
                table_name=context.node_table_name,
                node_id_columns=[node_id_col],
                filter=f"{node_type_col} = '{node_type}'",
            ),
        )

    # Create EdgeSchema for each (source_type, edge_type, sink_type) combination
    # Without edge_combinations discovery, we create all possible combinations
    for edge_type in edge_types:
        for source_type in node_types:
            for sink_type in node_types:
                edge_id = f"{source_type}@{edge_type}@{sink_type}"

                edge_schema = EdgeSchema(
                    name=edge_type,
                    source_node_id=source_type,
                    sink_node_id=sink_type,
                    source_id_property=EntityProperty(
                        property_name=src_col, data_type=str
                    ),
                    sink_id_property=EntityProperty(
                        property_name=dst_col, data_type=str
                    ),
                    properties=[
                        EntityProperty(property_name=prop_name, data_type=data_type)
                        for prop_name, data_type in extra_edge_attrs.items()
                    ]
                    + [
                        EntityProperty(
                            property_name=relationship_type_col, data_type=str
                        ),
                        EntityProperty(property_name=src_col, data_type=str),
                        EntityProperty(property_name=dst_col, data_type=str),
                        EntityProperty(property_name="edge_id", data_type=str),
                    ],
                )
                schema.add_edge(
                    edge_schema,
                    SQLTableDescriptor(
                        entity_id=edge_id,
                        table_name=context.edge_table_name,
                        filter=f"{relationship_type_col} = '{edge_type}'",
                        node_id_columns=[src_col, dst_col],
                    ),
                )
    return schema


def transpile_cypher_to_sql(
    cypher_query: str,
    context: GraphContextModel,
    vlp_rendering_mode: str = "cte",
    materialization_strategy: str = "numbered_views",
) -> str:
    """
    Transpile an OpenCypher query to Spark SQL.

    Args:
        cypher_query: The OpenCypher query string
        context: The GraphContext with schema information
        vlp_rendering_mode: "cte" (WITH RECURSIVE) or "procedural" (BFS)
        materialization_strategy: "temp_tables" or "numbered_views"

    Returns:
        The transpiled SQL query string

    Raises:
        ValueError: If the query cannot be parsed or transpiled
    """
    # Build schema provider from context
    schema = build_schema_provider(context)

    # Parse the OpenCypher query
    parser = OpenCypherParser()
    ast = parser.parse(cypher_query)

    plan = LogicalPlan.process_query_tree(ast, schema)

    optimize_plan(plan, enabled=True, pushdown_enabled=True)

    plan.resolve(original_query=cypher_query)

    # Render to SQL
    renderer = SQLRenderer(
        db_schema_provider=schema,
        vlp_rendering_mode=vlp_rendering_mode,
        materialization_strategy=materialization_strategy,
    )

    sql = renderer.render_plan(plan)

    return sql


# Regex to find relationship alias in patterns like [r], [r:TYPE], [:TYPE]
RELATIONSHIP_ALIAS_PATTERN = re.compile(r"\[(\w+)(?::\w+)?\]")


def extract_relationship_alias(query: str) -> Optional[str]:
    """
    Extract the relationship alias from a Cypher query.

    Examples:
        "MATCH (s)-[r]->(d)" -> "r"
        "MATCH (s:Product)-[rel:KNOWS]->(d)" -> "rel"
        "MATCH (s)-[:TYPE]->(d)" -> None (no alias)

    Returns:
        The relationship alias or None if not found.
    """
    match = RELATIONSHIP_ALIAS_PATTERN.search(query)
    if match:
        return match.group(1)
    return None


def validate_cypher_query(query: str) -> tuple[bool, str]:
    """
    Validate that a Cypher query has the required structure.

    The query must:
    1. Start with MATCH (case insensitive)
    2. Have RETURN r (with optional DISTINCT, e.g., RETURN r, RETURN DISTINCT r)

    Returns:
        (is_valid, error_message)
    """
    query_stripped = query.strip()
    query_upper = query_stripped.upper()

    # Check if starts with MATCH
    if not query_upper.startswith("MATCH"):
        return False, "Query must start with MATCH"

    # Check for RETURN r (with optional DISTINCT)
    if not re.search(r"\bRETURN\s+(?:DISTINCT\s+)?r\b", query_stripped, re.IGNORECASE):
        return False, "Query must have RETURN r (or RETURN DISTINCT r)"

    return True, ""
