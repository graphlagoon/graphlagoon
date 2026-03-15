import os
import json
import uuid
import random
import string
import logging
from pathlib import Path
from typing import Optional, Any
from datetime import datetime, timedelta

from pyspark.sql import SparkSession, DataFrame
from pyspark.sql.types import (
    StructType, StructField, StringType, MapType,
    IntegerType, FloatType, BooleanType, DateType, TimestampType
)

from src.config import get_settings
from src.models.schemas import (
    RandomGraphRequest, RandomGraphResponse, ExtraColumnDefinition
)
from src.services.catalog import register_parquet_tables

logger = logging.getLogger(__name__)

settings = get_settings()


def get_table_path(table_name: str) -> str:
    """Get the full absolute path for a table's parquet directory."""
    data_dir = Path(settings.data_path)
    if not data_dir.is_absolute():
        # Resolve relative to the sql-warehouse root directory
        module_dir = Path(__file__).parent.parent.parent  # src/services/graph.py -> sql-warehouse/
        data_dir = (module_dir / settings.data_path).resolve()
    return str(data_dir / table_name)


def file_name_to_table_name(file_name: str) -> str:
    """Convert file name back to catalog.schema.table format.

    Example: edges_dev_catalog__graphs__test_graph -> dev_catalog.graphs.edges_test_graph
    """
    # Determine prefix (edges_ or nodes_)
    if file_name.startswith("edges_"):
        prefix = "edges_"
        table_prefix = "edges_"
    elif file_name.startswith("nodes_"):
        prefix = "nodes_"
        table_prefix = "nodes_"
    else:
        return file_name

    # Remove prefix and split by __
    name_part = file_name[len(prefix):]
    parts = name_part.split("__")

    if len(parts) == 3:
        # catalog__schema__table -> catalog.schema.edges_table
        catalog, schema, table = parts
        return f"{catalog}.{schema}.{table_prefix}{table}"
    else:
        # Fallback for non-standard names
        return file_name


def table_name_to_file_name(table_name: str) -> str:
    """Convert catalog.schema.table format to file name.

    Example: dev_catalog.graphs.edges_test_graph -> edges_dev_catalog__graphs__test_graph
    """
    parts = table_name.split(".")
    if len(parts) == 3:
        catalog, schema, table = parts
        # table is like edges_test_graph or nodes_test_graph
        if table.startswith("edges_"):
            table_suffix = table[len("edges_"):]
            return f"edges_{catalog}__{schema}__{table_suffix}"
        elif table.startswith("nodes_"):
            table_suffix = table[len("nodes_"):]
            return f"nodes_{catalog}__{schema}__{table_suffix}"
    # Fallback: return as-is (for legacy non-catalog tables)
    return table_name


def list_tables(spark: SparkSession) -> tuple[list[str], list[str]]:
    """List all edge and node tables."""
    data_dir = Path(settings.data_path)

    if not data_dir.exists():
        data_dir.mkdir(parents=True, exist_ok=True)
        return [], []

    edge_tables = []
    node_tables = []

    for table_dir in data_dir.iterdir():
        if table_dir.is_dir():
            name = table_dir.name
            if name.startswith("edges_"):
                edge_tables.append(file_name_to_table_name(name))
            elif name.startswith("nodes_"):
                node_tables.append(file_name_to_table_name(name))

    return sorted(edge_tables), sorted(node_tables)


def load_edge_table(spark: SparkSession, table_name: str) -> Optional[DataFrame]:
    """Load an edge table as DataFrame."""
    # Convert catalog.schema.table format to file name
    file_name = table_name_to_file_name(table_name)
    path = get_table_path(file_name)
    if not os.path.exists(path):
        return None
    return spark.read.parquet(path)


def load_node_table(spark: SparkSession, table_name: str) -> Optional[DataFrame]:
    """Load a node table as DataFrame."""
    # Convert catalog.schema.table format to file name
    file_name = table_name_to_file_name(table_name)
    path = get_table_path(file_name)
    if not os.path.exists(path):
        return None
    return spark.read.parquet(path)


def get_spark_type(data_type: str):
    """Convert string data type to Spark type."""
    type_map = {
        "string": StringType(),
        "int": IntegerType(),
        "float": FloatType(),
        "boolean": BooleanType(),
        "date": DateType(),
        "timestamp": TimestampType(),
    }
    return type_map.get(data_type, StringType())


_JSON_KEY_POOLS = {
    "business": ["name", "status", "region", "revenue", "active", "category", "priority"],
    "person": ["firstName", "lastName", "age", "email", "phone", "city", "country"],
    "product": ["sku", "price", "quantity", "inStock", "rating", "tags", "vendor"],
    "event": ["eventType", "timestamp", "source", "severity", "message", "code", "duration"],
}


def _random_json_leaf() -> Any:
    """Generate a random primitive value for a JSON leaf."""
    choice = random.randint(0, 4)
    if choice == 0:
        return random.randint(-1000, 1000)
    elif choice == 1:
        return round(random.uniform(-100.0, 100.0), 2)
    elif choice == 2:
        return random.choice([True, False])
    elif choice == 3:
        return None
    else:
        words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta",
                 "omega", "sigma", "lambda", "kappa", "micro", "nano", "tera"]
        return " ".join(random.choices(words, k=random.randint(1, 3)))


def _random_json_value(depth: int, max_depth: int, max_keys: int) -> Any:
    """Generate a random JSON value, potentially nested up to max_depth."""
    if depth >= max_depth:
        return _random_json_leaf()

    choice = random.randint(0, 6)
    if choice <= 3:
        # Leaf value (more likely than nesting to keep structures reasonable)
        return _random_json_leaf()
    elif choice == 4:
        # Nested object
        return _random_json_object(depth + 1, max_depth, max_keys)
    elif choice == 5:
        # Small nested array of primitives
        return [_random_json_leaf() for _ in range(random.randint(1, 4))]
    else:
        # Small nested array of objects
        n = random.randint(1, 3)
        return [_random_json_object(depth + 1, max_depth, max(2, max_keys - 1)) for _ in range(n)]


def _random_json_object(depth: int, max_depth: int, max_keys: int) -> dict:
    """Generate a random JSON object."""
    pool_name = random.choice(list(_JSON_KEY_POOLS.keys()))
    pool = _JSON_KEY_POOLS[pool_name]
    num_keys = random.randint(2, max(2, max_keys))
    keys = random.sample(pool, min(num_keys, len(pool)))
    return {k: _random_json_value(depth, max_depth, max_keys) for k in keys}


def generate_random_json_object(col_def: ExtraColumnDefinition) -> str:
    """Generate a JSON object string."""
    obj = _random_json_object(0, col_def.json_max_depth, col_def.json_max_keys)
    return json.dumps(obj)


def generate_random_json_array(col_def: ExtraColumnDefinition) -> str:
    """Generate a JSON array of uniform objects (sharing most keys)."""
    num_items = random.randint(col_def.json_array_min_items, col_def.json_array_max_items)
    # Pick a consistent set of keys for uniformity (frontend detects uniform arrays)
    pool_name = random.choice(list(_JSON_KEY_POOLS.keys()))
    pool = _JSON_KEY_POOLS[pool_name]
    num_keys = random.randint(3, min(len(pool), col_def.json_max_keys))
    base_keys = random.sample(pool, num_keys)

    items = []
    for _ in range(num_items):
        obj = {}
        for k in base_keys:
            obj[k] = _random_json_value(1, col_def.json_max_depth, col_def.json_max_keys)
        # Occasionally add 1 extra key for variety
        if random.random() < 0.3:
            extra_pool = [k for k in pool if k not in base_keys]
            if extra_pool:
                obj[random.choice(extra_pool)] = _random_json_leaf()
        items.append(obj)
    return json.dumps(items)


def generate_column_value(col_def: ExtraColumnDefinition, index: int) -> Any:
    """Generate a random value for a column based on its definition."""
    # Check for nullable
    if col_def.nullable and random.random() < col_def.null_probability:
        return None

    generator = col_def.generator

    if generator == "uuid":
        return str(uuid.uuid4())

    elif generator == "sequence":
        return index

    elif generator == "random_int":
        return random.randint(int(col_def.min_value), int(col_def.max_value))

    elif generator == "random_float":
        return random.uniform(col_def.min_value, col_def.max_value)

    elif generator == "random_choice":
        if col_def.choices:
            return random.choice(col_def.choices)
        return None

    elif generator == "random_string":
        return ''.join(random.choices(
            string.ascii_letters + string.digits,
            k=col_def.string_length
        ))

    elif generator == "random_date":
        # Random date in the last 5 years
        days_ago = random.randint(0, 365 * 5)
        base = datetime.now() - timedelta(days=days_ago)
        # TimestampType needs datetime, DateType needs date
        if col_def.data_type == "timestamp":
            return base.replace(
                hour=random.randint(0, 23),
                minute=random.randint(0, 59),
                second=random.randint(0, 59),
            )
        return base.date()

    elif generator == "random_timestamp":
        # Random datetime in the last 5 years
        seconds_ago = random.randint(0, 365 * 5 * 86400)
        return datetime.now() - timedelta(seconds=seconds_ago)

    elif generator == "random_bool":
        return random.choice([True, False])

    elif generator == "faker_name":
        # Simple fake names without faker library
        first_names = ["John", "Jane", "Bob", "Alice", "Charlie", "Diana", "Eve", "Frank", "Grace", "Henry"]
        last_names = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"]
        return f"{random.choice(first_names)} {random.choice(last_names)}"

    elif generator == "faker_email":
        domains = ["gmail.com", "yahoo.com", "outlook.com", "company.com", "example.org"]
        name = ''.join(random.choices(string.ascii_lowercase, k=8))
        return f"{name}@{random.choice(domains)}"

    elif generator == "faker_address":
        streets = ["Main St", "Oak Ave", "Pine Rd", "Maple Dr", "Cedar Ln", "Elm St", "Park Blvd", "Lake Ave"]
        cities = ["New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia", "San Antonio", "San Diego"]
        return f"{random.randint(1, 9999)} {random.choice(streets)}, {random.choice(cities)}"

    elif generator == "faker_company":
        prefixes = ["Tech", "Global", "Digital", "Smart", "Cloud", "Data", "Cyber", "Net", "Web", "AI"]
        suffixes = ["Corp", "Inc", "Ltd", "Systems", "Solutions", "Services", "Group", "Labs", "Works", "Hub"]
        return f"{random.choice(prefixes)} {random.choice(suffixes)}"

    elif generator == "constant":
        return col_def.constant_value

    elif generator == "random_json_object":
        return generate_random_json_object(col_def)

    elif generator == "random_json_array":
        return generate_random_json_array(col_def)

    else:
        return str(uuid.uuid4())[:col_def.string_length]


def generate_random_graph(
    spark: SparkSession,
    request: RandomGraphRequest
) -> RandomGraphResponse:
    """Generate a random graph using NetworkX models."""
    import networkx as nx

    # Create NetworkX graph based on model
    n = request.num_nodes
    model = request.model
    avg_degree = request.avg_degree

    if model == "erdos_renyi":
        p = min(1.0, avg_degree / max(1, n - 1))
        G = nx.erdos_renyi_graph(n, p)
    elif model == "barabasi_albert":
        m = max(1, round(avg_degree / 2))
        m = min(m, n - 1)
        G = nx.barabasi_albert_graph(n, m)
    elif model == "watts_strogatz":
        # k must be even for watts_strogatz_graph
        k = max(2, round(avg_degree))
        if k % 2 != 0:
            k += 1
        k = min(k, n - 1)
        if k % 2 != 0:
            k -= 1
        G = nx.watts_strogatz_graph(n, k, request.rewiring_prob)
    elif model == "complete":
        G = nx.complete_graph(n)
    elif model == "cycle":
        G = nx.cycle_graph(n)
    elif model == "star":
        G = nx.star_graph(n - 1)  # star_graph creates n+1 nodes
    elif model == "random_tree":
        G = nx.random_labeled_tree(n)
    else:
        # Default to barabasi_albert
        G = nx.barabasi_albert_graph(n, 3)

    # Connect disconnected components by adding random edges
    if request.ensure_connected and not nx.is_connected(G):
        components = list(nx.connected_components(G))
        for i in range(1, len(components)):
            u = random.choice(list(components[i - 1]))
            v = random.choice(list(components[i]))
            G.add_edge(u, v)

    # Table names in catalog.schema.table format
    full_prefix = f"{request.catalog}.{request.schema_name}"
    edge_table = f"{full_prefix}.edges_{request.table_name}"
    node_table = f"{full_prefix}.nodes_{request.table_name}"

    # For file storage, use sanitized name
    safe_name = f"{request.catalog}__{request.schema_name}__{request.table_name}"
    edge_table_path = f"edges_{safe_name}"
    node_table_path = f"nodes_{safe_name}"

    # Get column names from config
    cols = request.columns

    # Build node schema
    node_schema_fields = [
        StructField(cols.node_id_col, StringType(), False),
        StructField(cols.node_type_col, StringType(), False),
    ]
    if request.include_metadata:
        node_schema_fields.append(StructField("metadata", MapType(StringType(), StringType()), True))
    # Add extra node columns
    for col_def in request.extra_node_columns:
        node_schema_fields.append(StructField(col_def.name, get_spark_type(col_def.data_type), True))
    node_schema = StructType(node_schema_fields)

    # Generate node IDs and assign types
    node_id_map = {}  # NetworkX node index -> UUID
    nodes_data = []
    for i, nx_node in enumerate(G.nodes()):
        node_id = str(uuid.uuid4())
        node_id_map[nx_node] = node_id
        node_type = request.node_types[i % len(request.node_types)]

        # Build row tuple
        row = [node_id, node_type]
        if request.include_metadata:
            metadata = {"name": f"{node_type}_{i}", "index": str(i)}
            row.append(metadata)
        # Add extra column values
        for col_def in request.extra_node_columns:
            row.append(generate_column_value(col_def, i))
        nodes_data.append(tuple(row))

    nodes_df = spark.createDataFrame(nodes_data, node_schema)

    # Build edge schema
    edge_schema_fields = []
    if cols.edge_id_col:
        edge_schema_fields.append(
            StructField(cols.edge_id_col, StringType(), False)
        )
    edge_schema_fields.extend([
        StructField(cols.src_col, StringType(), False),
        StructField(cols.dst_col, StringType(), False),
        StructField(cols.relationship_type_col, StringType(), False),
    ])
    if request.include_metadata:
        edge_schema_fields.append(
            StructField("metadata", MapType(StringType(), StringType()), True)
        )
    # Add extra edge columns
    for col_def in request.extra_edge_columns:
        edge_schema_fields.append(
            StructField(col_def.name, get_spark_type(col_def.data_type), True)
        )
    edge_schema = StructType(edge_schema_fields)

    # Generate edges from NetworkX graph
    edges_data = []
    for i, (src_nx, dst_nx) in enumerate(G.edges()):
        src = node_id_map[src_nx]
        dst = node_id_map[dst_nx]
        relationship_type = request.edge_types[i % len(request.edge_types)]

        # Build row tuple
        row = []
        if cols.edge_id_col:
            row.append(str(uuid.uuid4()))
        row.extend([src, dst, relationship_type])
        if request.include_metadata:
            metadata = {"weight": str(random.random()), "index": str(i)}
            row.append(metadata)
        # Add extra column values
        for col_def in request.extra_edge_columns:
            row.append(generate_column_value(col_def, i))
        edges_data.append(tuple(row))

    # Add self-edges (loops where src == dst) based on requested ratio
    if request.self_edges_ratio > 0:
        num_regular_edges = len(edges_data)
        num_self_edges = max(1, round(num_regular_edges * request.self_edges_ratio))
        all_node_ids = list(node_id_map.values())
        edge_idx = num_regular_edges
        for _ in range(num_self_edges):
            node_id = random.choice(all_node_ids)
            relationship_type = request.edge_types[edge_idx % len(request.edge_types)]
            row = []
            if cols.edge_id_col:
                row.append(str(uuid.uuid4()))
            row.extend([node_id, node_id, relationship_type])
            if request.include_metadata:
                metadata = {"weight": str(random.random()), "index": str(edge_idx), "self_edge": "true"}
                row.append(metadata)
            for col_def in request.extra_edge_columns:
                row.append(generate_column_value(col_def, edge_idx))
            edges_data.append(tuple(row))
            edge_idx += 1

    # Add multi-edges (parallel edges between same pair) based on requested params
    if request.multi_edges_max_count > 0 and request.multi_edges_ratio > 0:
        base_edges = list(G.edges())
        edge_idx = len(edges_data)
        for i, (src_nx, dst_nx) in enumerate(base_edges):
            if random.random() > request.multi_edges_ratio:
                continue
            src = node_id_map[src_nx]
            dst = node_id_map[dst_nx]
            num_extra = random.randint(1, request.multi_edges_max_count)
            for _ in range(num_extra):
                relationship_type = request.edge_types[edge_idx % len(request.edge_types)]
                row = []
                if cols.edge_id_col:
                    row.append(str(uuid.uuid4()))
                row.extend([src, dst, relationship_type])
                if request.include_metadata:
                    metadata = {"weight": str(random.random()), "index": str(edge_idx), "multi_edge": "true"}
                    row.append(metadata)
                for col_def in request.extra_edge_columns:
                    row.append(generate_column_value(col_def, edge_idx))
                edges_data.append(tuple(row))
                edge_idx += 1

    edges_df = spark.createDataFrame(edges_data, edge_schema)

    # Save to Parquet (for backward compatibility and file-based access)
    node_path = get_table_path(node_table_path)
    edge_path = get_table_path(edge_table_path)

    nodes_df.write.mode("overwrite").parquet(node_path)
    edges_df.write.mode("overwrite").parquet(edge_path)

    # Register tables in Spark catalog for catalog.schema.table syntax
    # Create database (schema) if it doesn't exist
    try:
        spark.sql(f"CREATE DATABASE IF NOT EXISTS {request.schema_name}")

        # Register as managed tables using Delta format if available
        # Fall back to parquet external tables otherwise
        try:
            # Try Delta format first
            nodes_df.write.format("delta").mode("overwrite").saveAsTable(
                f"{request.schema_name}.nodes_{request.table_name}"
            )
            edges_df.write.format("delta").mode("overwrite").saveAsTable(
                f"{request.schema_name}.edges_{request.table_name}"
            )
        except Exception:
            # Fall back to parquet external tables
            spark.sql(f"""
                CREATE OR REPLACE TABLE {request.schema_name}.nodes_{request.table_name}
                USING parquet
                LOCATION '{node_path}'
            """)
            spark.sql(f"""
                CREATE OR REPLACE TABLE {request.schema_name}.edges_{request.table_name}
                USING parquet
                LOCATION '{edge_path}'
            """)
    except Exception as e:
        # If catalog registration fails, try auto-registration as fallback
        logger.warning(f"Could not register tables directly: {e}")
        logger.info("Attempting auto-registration from parquet files...")
        try:
            register_parquet_tables(spark)
        except Exception as reg_error:
            logger.warning(f"Auto-registration also failed: {reg_error}")

    return RandomGraphResponse(
        edge_table=edge_table,
        node_table=node_table,
        num_nodes=G.number_of_nodes(),
        num_edges=len(edges_data),
        model=model,
        status="created"
    )


