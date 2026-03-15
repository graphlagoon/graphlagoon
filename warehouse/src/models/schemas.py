from pydantic import BaseModel, Field
from typing import Optional, Any, Literal


# NetworkX graph models
GraphModel = Literal[
    "erdos_renyi",      # Random graph G(n, p)
    "barabasi_albert",  # Scale-free preferential attachment
    "watts_strogatz",   # Small-world graph
    "complete",         # Complete graph K_n
    "cycle",            # Cycle graph
    "star",             # Star graph
    "random_tree",      # Random tree
]

# Data types for extra columns
ColumnDataType = Literal["string", "int", "float", "boolean", "date", "timestamp"]

# Generator types for random data
GeneratorType = Literal[
    "uuid",           # Random UUID
    "sequence",       # Sequential integers (0, 1, 2, ...)
    "random_int",     # Random integer in range
    "random_float",   # Random float in range
    "random_choice",  # Random choice from list
    "random_string",  # Random string of given length
    "random_date",    # Random date in range
    "random_timestamp",  # Random datetime (timestamp) in range
    "random_bool",    # Random boolean
    "faker_name",     # Fake name (requires faker)
    "faker_email",    # Fake email
    "faker_address",  # Fake address
    "faker_company",  # Fake company name
    "constant",       # Constant value
    "random_json_object",  # Random JSON object (key-value with nested values)
    "random_json_array",   # Random JSON array of objects
]


class ExtraColumnDefinition(BaseModel):
    """Definition for an extra column to generate."""
    name: str
    data_type: ColumnDataType = "string"
    generator: GeneratorType = "random_string"
    # Generator-specific options
    choices: list[str] = Field(default_factory=list)  # For random_choice
    min_value: float = 0  # For random_int, random_float
    max_value: float = 100  # For random_int, random_float
    string_length: int = 10  # For random_string
    constant_value: Optional[Any] = None  # For constant
    nullable: bool = False  # Chance to be null
    null_probability: float = 0.1  # Probability of null if nullable
    # JSON generator options
    json_max_depth: int = 2  # Max nesting depth for JSON values
    json_max_keys: int = 5  # Max keys per JSON object
    json_array_min_items: int = 3  # Min items in JSON array
    json_array_max_items: int = 6  # Max items in JSON array


class ColumnConfig(BaseModel):
    """Configuration for column names in generated tables."""
    # Node table columns
    node_id_col: str = "node_id"
    node_type_col: str = "node_type"
    # Edge table columns
    edge_id_col: Optional[str] = "edge_id"  # If None, generates {src}@{rel_type}@{dst}
    src_col: str = "src"
    dst_col: str = "dst"
    relationship_type_col: str = "relationship_type"


class DatasetsResponse(BaseModel):
    edge_tables: list[str]
    node_tables: list[str]


class RandomGraphRequest(BaseModel):
    """Request to generate a random graph using NetworkX."""
    # Table naming: catalog.schema.table format
    catalog: str = "dev_catalog"
    schema_name: str = "graphs"  # 'schema' is reserved
    table_name: str = "test_graph"

    # Graph model selection
    model: GraphModel = "barabasi_albert"

    # Model-specific parameters
    num_nodes: int = 1000
    # Average degree (controls connectivity for erdos_renyi, barabasi_albert, watts_strogatz)
    avg_degree: float = 6.0
    # For watts_strogatz: rewiring probability (does not affect avg degree)
    rewiring_prob: float = 0.3
    # Connect disconnected components with random edges
    ensure_connected: bool = True
    # Ratio of self-edges to add (0.0-1.0, e.g. 0.3 = 30% of total edges become self-edges)
    self_edges_ratio: float = 0.0
    # Max extra edges between same node pair (0 = disabled)
    multi_edges_max_count: int = 0
    # Fraction of existing edges to duplicate as multi-edges (0.0-1.0)
    multi_edges_ratio: float = 0.3

    # Node and edge types
    node_types: list[str] = Field(default_factory=lambda: ["Person", "Company", "Product"])
    edge_types: list[str] = Field(default_factory=lambda: ["KNOWS", "WORKS_AT", "BOUGHT"])

    # Column configuration
    columns: ColumnConfig = Field(default_factory=ColumnConfig)

    # Extra columns for nodes (beyond node_id, node_type, metadata)
    extra_node_columns: list[ExtraColumnDefinition] = Field(default_factory=list)

    # Extra columns for edges (beyond edge_id, src, dst, relationship_type, metadata)
    extra_edge_columns: list[ExtraColumnDefinition] = Field(default_factory=list)

    # Whether to include the metadata column (MapType)
    include_metadata: bool = True


class RandomGraphResponse(BaseModel):
    edge_table: str  # Full path: catalog.schema.edges_table
    node_table: str  # Full path: catalog.schema.nodes_table
    num_nodes: int
    num_edges: int
    model: str
    status: str = "created"


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    error: ErrorDetail


# Catalog schemas
class CatalogInfo(BaseModel):
    """Information about a catalog."""
    name: str


class DatabaseInfo(BaseModel):
    """Information about a database/schema."""
    name: str
    catalog: str
    description: Optional[str] = None
    location: Optional[str] = None


class TableInfo(BaseModel):
    """Information about a table."""
    name: str
    database: str
    catalog: str
    table_type: str  # MANAGED, EXTERNAL, VIEW
    is_temporary: bool = False


class ColumnInfo(BaseModel):
    """Information about a table column."""
    name: str
    data_type: str
    nullable: bool = True
    comment: Optional[str] = None


class TableSchema(BaseModel):
    """Full schema of a table."""
    table_name: str
    database: str
    catalog: str
    columns: list[ColumnInfo]


class CatalogListResponse(BaseModel):
    """Response for listing catalogs."""
    catalogs: list[CatalogInfo]


class DatabaseListResponse(BaseModel):
    """Response for listing databases."""
    databases: list[DatabaseInfo]


class TableListResponse(BaseModel):
    """Response for listing tables."""
    tables: list[TableInfo]
