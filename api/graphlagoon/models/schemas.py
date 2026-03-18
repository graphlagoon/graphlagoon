from pydantic import BaseModel, Field
from typing import Optional, Any, Literal, TypeAlias
from uuid import UUID
from datetime import datetime


# NetworkX graph models
GraphModel = Literal[
    "erdos_renyi",
    "barabasi_albert",
    "watts_strogatz",
    "complete",
    "cycle",
    "star",
    "random_tree",
]

# Data types for extra columns
ColumnDataType = Literal["string", "int", "float", "boolean", "date", "timestamp"]

# Generator types for random data
GeneratorType = Literal[
    "uuid",
    "sequence",
    "random_int",
    "random_float",
    "random_choice",
    "random_string",
    "random_date",
    "random_bool",
    "faker_name",
    "faker_email",
    "faker_address",
    "faker_company",
    "constant",
    "random_json_object",
    "random_json_array",
]


class ExtraColumnDefinition(BaseModel):
    """Definition for an extra column to generate."""

    name: str
    data_type: ColumnDataType = "string"
    generator: GeneratorType = "random_string"
    choices: list[str] = Field(default_factory=list)
    min_value: float = 0
    max_value: float = 100
    string_length: int = 10
    constant_value: Optional[Any] = None
    nullable: bool = False
    null_probability: float = 0.1
    # JSON generator options
    json_max_depth: int = 2
    json_max_keys: int = 5
    json_array_min_items: int = 3
    json_array_max_items: int = 6


class ColumnConfig(BaseModel):
    """Configuration for column names in generated tables."""

    node_id_col: str = "node_id"
    node_type_col: str = "node_type"
    edge_id_col: str = "edge_id"
    src_col: str = "src"
    dst_col: str = "dst"
    relationship_type_col: str = "relationship_type"


# Graph data models (from sql-warehouse)
class Node(BaseModel):
    node_id: str
    node_type: str
    properties: Optional[dict] = None


class Edge(BaseModel):
    edge_id: str
    src: str
    dst: str
    relationship_type: str
    properties: Optional[dict] = None


class GraphResponse(BaseModel):
    nodes: list[Node]
    edges: list[Edge]
    truncated: bool = False
    total_count: Optional[int] = None


class DatasetsResponse(BaseModel):
    edge_tables: list[str]
    node_tables: list[str]


# Structural column configuration for edge and node tables
class EdgeStructure(BaseModel):
    """Structural column mapping for edge table."""

    edge_id_col: str = "edge_id"
    src_col: str = "src"
    dst_col: str = "dst"
    relationship_type_col: str = "relationship_type"


class NodeStructure(BaseModel):
    """Structural column mapping for node table."""

    node_id_col: str = "node_id"
    node_type_col: str = "node_type"


class PropertyColumn(BaseModel):
    """Definition of a property column (non-structural metadata)."""

    name: str  # column name in the table
    data_type: str  # string, int, float, boolean, date, timestamp
    display_name: Optional[str] = None  # friendly name for UI
    description: Optional[str] = None  # optional description


# Backwards compatibility aliases
EdgeColumnConfig = EdgeStructure
NodeColumnConfig = NodeStructure


# Graph Context models
class GraphContextCreate(BaseModel):
    title: str
    description: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    edge_table_name: str
    node_table_name: str
    edge_structure: EdgeStructure = Field(default_factory=EdgeStructure)
    node_structure: NodeStructure = Field(default_factory=NodeStructure)
    edge_properties: list[PropertyColumn] = Field(default_factory=list)
    node_properties: list[PropertyColumn] = Field(default_factory=list)
    node_types: list[str] = Field(default_factory=list)
    relationship_types: list[str] = Field(default_factory=list)


class GraphContextUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    edge_structure: Optional[EdgeStructure] = None
    node_structure: Optional[NodeStructure] = None
    edge_properties: Optional[list[PropertyColumn]] = None
    node_properties: Optional[list[PropertyColumn]] = None
    node_types: Optional[list[str]] = None
    relationship_types: Optional[list[str]] = None


class GraphContextResponse(BaseModel):
    id: UUID
    title: str
    description: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    edge_table_name: str
    node_table_name: str
    edge_structure: EdgeStructure = Field(default_factory=EdgeStructure)
    node_structure: NodeStructure = Field(default_factory=NodeStructure)
    edge_properties: list[PropertyColumn] = Field(default_factory=list)
    node_properties: list[PropertyColumn] = Field(default_factory=list)
    node_types: list[str] = Field(default_factory=list)
    relationship_types: list[str] = Field(default_factory=list)
    owner_email: str
    shared_with: list[str] = Field(default_factory=list)
    has_write_access: bool = False
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Exploration models
class NodeState(BaseModel):
    node_id: str


class EdgeState(BaseModel):
    edge_id: str


PropertyFilterOperator = Literal[
    "equals",
    "not_equals",
    "one_of",
    "contains",
    "less_than",
    "less_than_or_equal",
    "greater_than",
    "greater_than_or_equal",
    "between",
]


class PropertyFilter(BaseModel):
    id: str
    property: str
    operator: PropertyFilterOperator
    value: Optional[Any] = None  # str | number | null
    values: Optional[list[Any]] = None  # for 'one_of'
    minValue: Optional[float] = None  # for 'between'
    maxValue: Optional[float] = None  # for 'between'
    enabled: bool = True


class FilterState(BaseModel):
    node_types: list[str] = Field(default_factory=list)
    edge_types: list[str] = Field(default_factory=list)
    search_query: Optional[str] = None
    nodePropertyFilters: list[PropertyFilter] = Field(default_factory=list)
    edgePropertyFilters: list[PropertyFilter] = Field(default_factory=list)


class ViewportState(BaseModel):
    zoom: float = 1.0
    center_x: float = 0.0
    center_y: float = 0.0


# Text format models for label formatting
class TextFormatRule(BaseModel):
    id: str
    name: str
    target: Literal["node", "edge"]
    types: list[str] = Field(default_factory=list)
    template: str
    priority: int = 0
    enabled: bool = True
    scope: Literal["exploration", "context", "global"] = "exploration"


class TextFormatDefaults(BaseModel):
    nodeTemplate: str = "{node_id}"
    edgeTemplate: str = "{relationship_type}"


class TextFormatState(BaseModel):
    rules: list[TextFormatRule] = Field(default_factory=list)
    defaults: TextFormatDefaults = Field(default_factory=TextFormatDefaults)


VlpRenderingMode: TypeAlias = Literal["cte", "procedural"]
MaterializationStrategy: TypeAlias = Literal["temp_tables", "numbered_views"]


class ExplorationState(BaseModel):
    nodes: list[NodeState] = Field(default_factory=list)
    edges: list[EdgeState] = Field(default_factory=list)
    filters: FilterState = Field(default_factory=FilterState)
    viewport: ViewportState = Field(default_factory=ViewportState)
    layout_algorithm: str = "force-atlas-2"
    graph_query: Optional[str] = None
    cte_prefilter: Optional[str] = None  # CTE pre-filter for edge table
    vlp_rendering_mode: Optional[VlpRenderingMode] = None
    materialization_strategy: Optional[MaterializationStrategy] = None
    textFormat: Optional[TextFormatState] = None
    clusters: Optional[dict] = None  # ClusterState JSON from frontend


class ExplorationCreate(BaseModel):
    title: str
    state: ExplorationState


class ExplorationUpdate(BaseModel):
    title: Optional[str] = None
    state: Optional[ExplorationState] = None


class ExplorationResponse(BaseModel):
    id: UUID
    graph_context_id: UUID
    title: str
    owner_email: str
    shared_with: list[str] = Field(default_factory=list)
    has_write_access: bool = False
    state: ExplorationState
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Query Template models
class TemplateParameter(BaseModel):
    """A parameter for a query template."""

    id: str
    type: Literal["input", "select"] = "input"
    label: str
    description: Optional[str] = None
    placeholder: Optional[str] = None
    default: Optional[str] = None
    options: Optional[list[str]] = None  # only used when type == "select"
    required: bool = True


class TemplateOptions(BaseModel):
    """Execution options embedded in a query template."""

    procedural_bfs: bool = True
    cte_prefilter: Optional[str] = None
    large_results_mode: bool = True


class QueryTemplateCreate(BaseModel):
    name: str
    description: Optional[str] = None
    query_type: Literal["cypher", "sql"]
    query: str
    parameters: list[TemplateParameter] = Field(default_factory=list)
    options: TemplateOptions = Field(default_factory=TemplateOptions)


class QueryTemplateUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    query_type: Optional[Literal["cypher", "sql"]] = None
    query: Optional[str] = None
    parameters: Optional[list[TemplateParameter]] = None
    options: Optional[TemplateOptions] = None


class QueryTemplateResponse(BaseModel):
    id: UUID
    graph_context_id: UUID
    owner_email: str
    name: str
    description: Optional[str] = None
    query_type: str
    query: str
    parameters: list[TemplateParameter] = Field(default_factory=list)
    options: TemplateOptions = Field(default_factory=TemplateOptions)
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Share models
class ShareRequest(BaseModel):
    email: str
    permission: str = "read"


# Query models
class SubgraphRequest(BaseModel):
    edge_limit: int = 1000
    node_types: list[str] = Field(default_factory=list)
    edge_types: list[str] = Field(default_factory=list)


class ExpandRequest(BaseModel):
    node_id: str
    depth: int = Field(
        default=2,
        ge=1,
        le=2,
        description="Expansion depth (max 2)",
    )
    edge_types: list[str] = Field(default_factory=list)
    edge_limit: int = Field(
        default=100,
        ge=4,
        le=1000,
        description="Max edges to return",
    )
    directed: bool = Field(
        default=False,
        description="Use directed edges (-> vs -)",
    )


class GraphQueryRequest(BaseModel):
    """Request to execute a graph query (SQL).

    Note: The query should include its own LIMIT clause if needed.
    The backend respects whatever LIMIT is specified in the query.
    """

    query: str
    cte_prefilter: Optional[str] = None
    use_external_links: bool = True


class RandomGraphRequest(BaseModel):
    """Request to generate a random graph using NetworkX."""

    # Table naming: catalog.schema.table format
    catalog: str = "dev_catalog"
    schema_name: str = "graphs"
    table_name: str = "test_graph"

    # Graph model selection
    model: GraphModel = "barabasi_albert"

    # Model-specific parameters
    num_nodes: int = 1000
    avg_degree: float = 6.0
    rewiring_prob: float = 0.3  # For watts_strogatz only
    ensure_connected: bool = True
    self_edges_ratio: float = 0.0  # Ratio of self-edges to add (0.0-1.0)
    multi_edges_max_count: int = (
        0  # Max extra edges between same node pair (0 = disabled)
    )
    multi_edges_ratio: float = 0.3  # Fraction of existing edges to duplicate (0.0-1.0)
    bidirectional_edges_ratio: float = 0.0  # Fraction of edges to create reverse (B->A) (0.0-1.0)

    # Node and edge types
    node_types: list[str] = Field(
        default_factory=lambda: ["Person", "Company", "Product"]
    )
    edge_types: list[str] = Field(
        default_factory=lambda: ["KNOWS", "WORKS_AT", "BOUGHT"]
    )

    # Column configuration
    columns: ColumnConfig = Field(default_factory=ColumnConfig)

    # Extra columns for nodes and edges
    extra_node_columns: list[ExtraColumnDefinition] = Field(default_factory=list)
    extra_edge_columns: list[ExtraColumnDefinition] = Field(default_factory=list)


class RandomGraphResponse(BaseModel):
    edge_table: str
    node_table: str
    num_nodes: int
    num_edges: int
    model: str
    status: str = "created"


# Error models
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
    table_type: str
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


class TablePreviewResponse(BaseModel):
    """Response for table preview."""

    columns: list[str]
    rows: list[list[Optional[str]]]
    row_count: int


class SchemaDiscoveryRequest(BaseModel):
    """Request to discover schema (distinct types) from tables."""

    edge_table: str
    node_table: str
    columns: ColumnConfig = Field(default_factory=ColumnConfig)


class SchemaDiscoveryResponse(BaseModel):
    """Response with distinct node and relationship types from tables."""

    node_types: list[str]
    relationship_types: list[str]


class CypherQueryRequest(BaseModel):
    """Request to execute an OpenCypher query.

    Note: The query should include its own LIMIT clause if needed.
    The backend respects whatever LIMIT is specified in the Cypher query.
    """

    query: str
    cte_prefilter: Optional[str] = None
    vlp_rendering_mode: VlpRenderingMode = "cte"
    materialization_strategy: MaterializationStrategy = "numbered_views"
    use_external_links: bool = True


class CypherQueryResponse(BaseModel):
    """Response from an OpenCypher query execution."""

    nodes: list[Node]
    edges: list[Edge]
    truncated: bool = False
    total_count: Optional[int] = None
    transpiled_sql: str  # The SQL query generated from OpenCypher


class CypherTranspileRequest(BaseModel):
    """Request to transpile an OpenCypher query (without execution)."""

    query: str
    cte_prefilter: Optional[str] = None
    vlp_rendering_mode: VlpRenderingMode = "cte"
    materialization_strategy: MaterializationStrategy = "numbered_views"


class CypherTranspileResponse(BaseModel):
    """Response from OpenCypher transpilation (without execution)."""

    transpiled_sql: str


# --- Databricks SQL Statements API compatible models ---


class StatementParameter(BaseModel):
    """A parameter for a SQL statement (Databricks spec)."""

    name: str
    value: Optional[str] = None
    type: Optional[str] = None


class StatementExecutionRequest(BaseModel):
    """Request body for executing a SQL statement (Databricks spec)."""

    statement: str
    warehouse_id: str
    catalog: Optional[str] = None
    schema: Optional[str] = None
    disposition: Literal["INLINE", "EXTERNAL_LINKS"] = "INLINE"
    format: Literal["JSON_ARRAY", "ARROW_STREAM", "CSV"] = "JSON_ARRAY"
    wait_timeout: str = "10s"
    on_wait_timeout: Literal["CONTINUE", "CANCEL"] = "CONTINUE"
    row_limit: Optional[int] = None
    byte_limit: Optional[int] = None
    parameters: list[StatementParameter] = Field(default_factory=list)


class StatementColumnInfo(BaseModel):
    """Schema column information (Databricks spec)."""

    name: str
    position: int
    type_name: str
    type_text: str
    type_precision: Optional[int] = None
    type_scale: Optional[int] = None


class StatementResultSchema(BaseModel):
    """Schema of the result set (Databricks spec)."""

    column_count: int
    columns: list[StatementColumnInfo]


class StatementResultChunk(BaseModel):
    """Metadata for a result chunk (Databricks spec)."""

    chunk_index: int
    row_offset: int
    row_count: int
    byte_count: Optional[int] = None


class StatementResultManifest(BaseModel):
    """Manifest describing the result set (Databricks spec)."""

    format: str = "JSON_ARRAY"
    schema: StatementResultSchema
    total_row_count: int
    total_byte_count: Optional[int] = None
    total_chunk_count: int = 1
    truncated: bool = False
    chunks: Optional[list[StatementResultChunk]] = None


class StatementResultData(BaseModel):
    """Result data from statement execution (Databricks spec).

    For INLINE disposition: data_array contains the rows directly.
    For EXTERNAL_LINKS disposition: external_links contains presigned URLs
    to download the data chunks.
    """

    chunk_index: int = 0
    row_offset: int = 0
    row_count: int = 0
    byte_count: Optional[int] = None
    data_array: Optional[list[list[Optional[str]]]] = None
    external_links: Optional[list["ExternalLinkInfo"]] = None
    next_chunk_index: Optional[int] = None
    next_chunk_internal_link: Optional[str] = None


class StatementError(BaseModel):
    """Error details for failed statements (Databricks spec)."""

    error_code: Optional[str] = None
    message: Optional[str] = None


class StatementStatus(BaseModel):
    """Status of statement execution (Databricks spec)."""

    state: Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "CLOSED"]
    error: Optional[StatementError] = None


class ExternalLinkInfo(BaseModel):
    """External link info from Databricks EXTERNAL_LINKS disposition."""

    chunk_index: int
    row_offset: int
    row_count: int
    byte_count: Optional[int] = None
    external_link: str
    expiration: str
    next_chunk_index: Optional[int] = None
    next_chunk_internal_link: Optional[str] = None


# Resolve forward reference from StatementResultData.external_links
StatementResultData.model_rebuild()


class StatementResponse(BaseModel):
    """Response from statement execution (Databricks spec)."""

    statement_id: str
    status: StatementStatus
    manifest: Optional[StatementResultManifest] = None
    result: Optional[StatementResultData] = None
