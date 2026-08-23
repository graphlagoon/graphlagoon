from pydantic import BaseModel, ConfigDict, Field, model_validator
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

# Which backend a graph context is queried through.
#
# "sql_warehouse" is a graph stored as an edge table + a node table, queried by
# transpiling Cypher to Spark SQL. "neptune" is Amazon Neptune's openCypher
# endpoint — a native graph database, so it defines no tables at all. "rest" is
# a dev-registered named connection to an external graph-serving API: the only
# type with multiple instances, selected by datasource_name.
DatasourceType = Literal["sql_warehouse", "neptune", "rest"]

# Contexts created before datasources were pluggable are all warehouse contexts,
# so this default is what keeps every existing context working untouched.
DEFAULT_DATASOURCE_TYPE: DatasourceType = "sql_warehouse"

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


class QueryMetadata(BaseModel):
    """Timing metadata for query execution stages (all values in milliseconds)."""

    edge_query_ms: Optional[float] = None
    edge_processing_ms: Optional[float] = None
    node_query_ms: Optional[float] = None
    node_processing_ms: Optional[float] = None
    transpilation_ms: Optional[float] = None
    total_ms: Optional[float] = None
    # Chunk-download breakdown (EXTERNAL_LINKS path only; None for INLINE).
    # chunk_download_ms is a subset of edge_query_ms + node_query_ms — it isolates
    # how much of the query time was spent downloading result chunks from storage.
    chunk_download_ms: Optional[float] = None
    chunk_count: Optional[int] = None
    # Result sizes, for correlating timings with graph scale.
    node_count: Optional[int] = None
    edge_count: Optional[int] = None


class GraphResponse(BaseModel):
    nodes: list[Node]
    edges: list[Edge]
    truncated: bool = False
    total_count: Optional[int] = None
    metadata: Optional[QueryMetadata] = None
    properties_deferred: bool = Field(
        default=False,
        description=(
            "True when nodes were returned without their properties "
            "(nodes_mode='types'). Tells the client to schedule background "
            "enrichment via /nodes/batch; false keeps the historical contract."
        ),
    )


# ---------------------------------------------------------------------------
# Precomputed graphs — named, per-context graphs resolved by a provider
# ---------------------------------------------------------------------------


class PrecomputedGraphData(BaseModel):
    """The graph a precomputed entry replays.

    Deliberately the *API* node/edge shape rather than the snapshot shape, so a
    precomputed graph feeds the frontend store without a field-by-field remap.
    It is GraphResponse minus `metadata`, which is query timing and meaningless
    once replayed.

    No node positions: a precomputed graph is data, and layout runs fresh on
    load. Positions with their surrounding visual state are what explorations
    and their snapshots are for.
    """

    nodes: list[Node]
    edges: list[Edge]
    truncated: bool = False
    total_count: Optional[int] = None
    properties_deferred: bool = Field(
        default=False,
        description=(
            "Always false for a precomputed graph — writes are refused while "
            "node properties are still being enriched, so an entry is never "
            "half-filled."
        ),
    )


class PrecomputedGraphSource(BaseModel):
    """Where a precomputed graph came from.

    Both fields are optional, and a `source` omitted entirely is valid: a graph
    assembled by a batch job from Delta tables, or built by hand, never had a
    query to record. `kind="manual"` is how such an entry says so, which is not
    the same as a query-derived entry whose query was lost.

    `datasource_type`/`datasource_name` used to live here and were removed: an
    entry is already scoped to a context, the context knows its own datasource,
    and nothing ever read the copies back. Worse, repointing a context at another
    datasource would have left them silently lying.
    """

    kind: Literal["cypher", "sql", "subgraph", "manual"] = "manual"
    query: Optional[str] = None


class PrecomputedGraphWriteRequest(BaseModel):
    """Body of PUT /api/graph-contexts/{id}/precomputed-graphs/{name}."""

    graph: PrecomputedGraphData
    source: PrecomputedGraphSource = Field(default_factory=PrecomputedGraphSource)


class PrecomputedGraphPayload(BaseModel):
    """The envelope that is stored, or that a provider returns.

    `provider` and `params` record *who* produced this graph and *with what*,
    which is the difference between the old cache — where a name was the whole
    identity — and a resolved resource that may have been computed on demand
    from URL arguments.
    """

    payload_version: int = 1
    name: str
    context_id: str
    provider: str = ""
    params: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    created_by: str
    node_count: int = 0
    edge_count: int = 0
    properties_complete: bool = True
    source: PrecomputedGraphSource = Field(default_factory=PrecomputedGraphSource)
    graph: PrecomputedGraphData


class PrecomputedGraphEntry(BaseModel):
    """What a write reports back about the entry it just stored.

    There is no listing endpoint to return these in bulk — entries are addressed
    by name, and enumerating them is the one operation that does not survive
    scale. Richer metadata lives inside the payload itself.
    """

    name: str
    size_bytes: int
    modified_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Style presets — named style + label + layout settings, applied by URL
# ---------------------------------------------------------------------------


class StylePresetSettings(BaseModel):
    """The presentation subset of an exploration's state.

    Every field here already exists in `ExplorationState` and is produced and
    consumed by the same frontend code, so a preset and an exploration can never
    describe the same thing two different ways.

    Deliberately excluded: nodes, edges, filters, viewport, the query and its
    transpile options, clusters, communities and behaviors. A preset says how a
    graph *looks*, never which data it shows — otherwise applying one would
    silently hide nodes and the graph would look like it came back incomplete.

    The server does not interpret any of it. Shapes are owned by the frontend
    (`buildStylePreset`/`applyStylePreset` in stores/graph.ts) and validated
    there; typing them here would mean two definitions drifting apart.
    """

    model_config = ConfigDict(extra="allow")

    # Style
    aesthetics: Optional[dict[str, Any]] = None
    nodeTypeColors: Optional[dict[str, str]] = None
    edgeTypeColors: Optional[dict[str, str]] = None
    nodeTypeIcons: Optional[dict[str, str]] = None
    edgeTypeIcons: Optional[dict[str, str]] = None
    nodePropertyIconConfigs: Optional[dict[str, Any]] = None
    # Labels
    textFormat: Optional[dict[str, Any]] = None
    # Layout
    layout_algorithm: Optional[str] = None
    layout_mode_config: Optional[dict[str, Any]] = None
    force3d_settings: Optional[dict[str, Any]] = None


class StylePresetWriteRequest(BaseModel):
    """Body of PUT /api/graph-contexts/{id}/style-presets/{name}."""

    settings: StylePresetSettings
    description: Optional[str] = Field(default=None, max_length=280)


class StylePreset(BaseModel):
    """What gets written to the volume, and what a read returns."""

    preset_version: int = 1
    name: str
    context_id: str
    created_at: datetime
    created_by: str
    updated_at: Optional[datetime] = None
    description: Optional[str] = None
    settings: StylePresetSettings


class StylePresetEntry(BaseModel):
    """One row of the preset listing.

    Only what a directory listing reports — no `created_by`, because ownership
    lives inside each file and reading every one of them to build a list would
    be a request per preset. Delete checks ownership server-side instead.
    """

    name: str
    size_bytes: int
    modified_at: Optional[datetime] = None


class StylePresetListResponse(BaseModel):
    presets: list[StylePresetEntry]


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
    datasource_type: DatasourceType = DEFAULT_DATASOURCE_TYPE
    # Which named connection a "rest" context uses. Meaningless (and forced to
    # None) for the single-instance types.
    datasource_name: Optional[str] = None
    edge_table_name: Optional[str] = None
    node_table_name: Optional[str] = None
    edge_structure: EdgeStructure = Field(default_factory=EdgeStructure)
    node_structure: NodeStructure = Field(default_factory=NodeStructure)
    edge_properties: list[PropertyColumn] = Field(default_factory=list)
    node_properties: list[PropertyColumn] = Field(default_factory=list)
    node_types: list[str] = Field(default_factory=list)
    relationship_types: list[str] = Field(default_factory=list)
    default_behaviors: dict = Field(
        default_factory=dict,
        description="Default graph behavior settings applied when this context is "
        "opened (e.g. {'viewMode': '3d'}). Passed through opaquely; the frontend "
        "validates keys against its own schema. A saved exploration overrides these.",
    )
    cluster_programs: list[dict] = Field(
        default_factory=list,
        description="Context-level cluster programs shared by all explorations of "
        "this context. Passed through opaquely; the frontend owns the shape.",
    )

    @model_validator(mode="after")
    def _validate_datasource_fields(self) -> "GraphContextCreate":
        """Enforce the shape each datasource type actually needs.

        A warehouse context is meaningless without its two tables. A Neptune
        context is the opposite: tables and column properties describe nothing,
        so they are normalized away rather than rejected — a client that sends
        leftovers from the warehouse form still gets a valid context instead of
        a validation error it cannot act on.
        """
        if self.datasource_type == "sql_warehouse":
            if not self.edge_table_name or not self.node_table_name:
                raise ValueError(
                    "edge_table_name and node_table_name are required for "
                    "sql_warehouse contexts"
                )
        else:
            self.edge_table_name = None
            self.node_table_name = None
            self.edge_properties = []
            self.node_properties = []

        if self.datasource_type == "rest":
            # Whether the name is REGISTERED is the router's job (it needs the
            # registry); that it exists at all is shape validation.
            if not self.datasource_name or not self.datasource_name.strip():
                raise ValueError(
                    "datasource_name is required for rest contexts — it names "
                    "the registered REST connection to query"
                )
        else:
            self.datasource_name = None
        return self


class GraphContextUpdate(BaseModel):
    # datasource_type is deliberately absent: changing a context's backend
    # would silently invalidate every exploration, template and cluster program
    # saved against it. Create a new context instead.
    title: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    edge_structure: Optional[EdgeStructure] = None
    node_structure: Optional[NodeStructure] = None
    edge_properties: Optional[list[PropertyColumn]] = None
    node_properties: Optional[list[PropertyColumn]] = None
    node_types: Optional[list[str]] = None
    relationship_types: Optional[list[str]] = None
    default_behaviors: Optional[dict] = None
    cluster_programs: Optional[list[dict]] = None


class GraphContextResponse(BaseModel):
    id: UUID
    title: str
    description: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    datasource_type: DatasourceType = DEFAULT_DATASOURCE_TYPE
    # Which named connection a "rest" context uses; null for the other types.
    datasource_name: Optional[str] = None
    # Null for native graph databases, which define no tables.
    edge_table_name: Optional[str] = None
    node_table_name: Optional[str] = None
    edge_structure: EdgeStructure = Field(default_factory=EdgeStructure)
    node_structure: NodeStructure = Field(default_factory=NodeStructure)
    edge_properties: list[PropertyColumn] = Field(default_factory=list)
    node_properties: list[PropertyColumn] = Field(default_factory=list)
    node_types: list[str] = Field(default_factory=list)
    relationship_types: list[str] = Field(default_factory=list)
    default_behaviors: dict = Field(default_factory=dict)
    cluster_programs: list[dict] = Field(default_factory=list)
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


class ProceduralBFSOptions(BaseModel):
    """Fine-grained toggles for gsql2rsql's procedural BFS renderer.

    Field names and defaults mirror ``gsql2rsql.ProceduralBFSOptimizations``.
    Flags only take effect when ``vlp_rendering_mode == "procedural"``. Note
    ``undirected_doubled_adjacency`` and ``undirected_union_all`` are mutually
    exclusive — enabling both raises ``ValueError`` in the transpiler.
    """

    visited_not_exists: bool = True  # default; both strategies
    loop_control_into: bool = True  # default; numbered_views only
    undirected_doubled_adjacency: bool = True  # default; both strategies
    deferred_edge_payload: bool = True  # default; temp_tables only
    barrier_precompute: bool = True  # default; temp_tables only
    # temp_tables only; only effective when barrier_precompute is also ON.
    # App default is ON (diverges from gsql2rsql's own False default).
    barrier_on_adjacency: bool = True
    # temp_tables only; only effective when BOTH undirected_doubled_adjacency
    # and barrier_precompute are ON. App default is ON (diverges from
    # gsql2rsql's own False default).
    prune_barrier_adjacency: bool = True
    undirected_union_all: bool = False  # default; both strategies


class SnapshotNode(BaseModel):
    id: str
    type: str
    properties: dict = Field(default_factory=dict)
    x: Optional[float] = None
    y: Optional[float] = None


class SnapshotEdge(BaseModel):
    id: str
    source: str
    target: str
    type: str
    properties: dict = Field(default_factory=dict)


class GraphSnapshot(BaseModel):
    """Full graph state snapshot (nodes + edges with positions and properties)."""

    nodes: list[SnapshotNode]
    edges: list[SnapshotEdge]
    snapshot_version: int = 1


class ExplorationState(BaseModel):
    nodes: list[NodeState] = Field(default_factory=list)
    edges: list[EdgeState] = Field(default_factory=list)
    has_snapshot: bool = False
    filters: FilterState = Field(default_factory=FilterState)
    viewport: ViewportState = Field(default_factory=ViewportState)
    layout_algorithm: str = "force-atlas-2"
    layout_mode_config: Optional[dict] = (
        None  # Per-layout-mode params (ego/hive/hierarchical)
    )
    graph_query: Optional[str] = None
    cte_prefilter: Optional[str] = None  # CTE pre-filter for edge table
    vlp_rendering_mode: Optional[VlpRenderingMode] = None
    materialization_strategy: Optional[MaterializationStrategy] = None
    procedural_optimizations: Optional[ProceduralBFSOptions] = None
    textFormat: Optional[TextFormatState] = None
    clusters: Optional[dict] = None  # ClusterState JSON from frontend
    nodeTypeIcons: Optional[dict[str, str]] = None
    nodePropertyIconConfigs: Optional[dict] = (
        None  # node type → PropertyIconConfig from frontend
    )
    nodeTypeColors: Optional[dict[str, str]] = None
    edgeTypeColors: Optional[dict[str, str]] = None
    edgeTypeIcons: Optional[dict[str, str]] = None
    behaviors: Optional[dict] = None
    aesthetics: Optional[dict] = None
    force3d_settings: Optional[dict] = None  # d3-force-3d simulation params
    community: Optional[dict] = None
    similarity: Optional[dict] = None


class ExplorationCreate(BaseModel):
    title: str
    state: ExplorationState
    snapshot: Optional[GraphSnapshot] = None


class ExplorationUpdate(BaseModel):
    title: Optional[str] = None
    state: Optional[ExplorationState] = None
    snapshot: Optional[GraphSnapshot] = None


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
    # Whether a ?template= link may auto-execute this template. Default True so
    # templates saved before the field existed stay linkable; the default is
    # filled at rehydration (TemplateOptions(**raw_options)), never migrated.
    allow_url_execution: bool = True


class QueryTemplateCreate(BaseModel):
    name: str
    description: Optional[str] = None
    query_type: Literal["cypher", "sql"]
    query: str
    parameters: list[TemplateParameter] = Field(default_factory=list)
    options: TemplateOptions = Field(default_factory=TemplateOptions)
    visibility: Literal["shared", "private"] = "shared"


class QueryTemplateUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    query_type: Optional[Literal["cypher", "sql"]] = None
    query: Optional[str] = None
    parameters: Optional[list[TemplateParameter]] = None
    options: Optional[TemplateOptions] = None
    visibility: Optional[Literal["shared", "private"]] = None


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
    visibility: Literal["shared", "private"] = "shared"
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Share models
class ShareRequest(BaseModel):
    email: str
    permission: str = "read"

    @model_validator(mode="after")
    def _public_share_is_read_only(self) -> "ShareRequest":
        # Public shares ("*") are always read-only; coerce instead of
        # rejecting so re-sharing an existing public share can't flip it
        # to write.
        if self.email == "*":
            self.permission = "read"
        return self


# Query models
class SubgraphRequest(BaseModel):
    edge_limit: int = 1000
    node_types: list[str] = Field(default_factory=list)
    edge_types: list[str] = Field(default_factory=list)
    nodes_mode: Literal["full", "types"] = Field(
        default="full",
        description=(
            "'full' returns nodes with all configured properties (default, "
            "unchanged behaviour). 'types' returns only node_id and node_type "
            "— everything needed to render — leaving properties null so the "
            "client can paint the graph immediately and fetch properties in "
            "the background via /nodes/batch."
        ),
    )


class NodeBatchRequest(BaseModel):
    """Fetch properties for a known set of node ids (progressive load)."""

    node_ids: list[str] = Field(
        ...,
        min_length=1,
        max_length=5000,
        description="Node ids to fetch. Capped so one batch stays a bounded "
        "query; the client chunks larger sets.",
    )
    columns: Optional[list[str]] = Field(
        default=None,
        description=(
            "Optional subset of property columns to fetch. Every name is "
            "validated against the context's configured node_properties, so "
            "this can only ever NARROW the projection — never widen it or "
            "reach columns the context does not expose. Unknown names are "
            "ignored. Omit to fetch everything the context exposes; that is "
            "expensive on wide tables (a 100-column table costs ~36 MB for "
            "19k nodes), which is what this field exists to avoid."
        ),
    )


class NodeBatchResponse(BaseModel):
    nodes: list[Node]
    metadata: Optional[QueryMetadata] = None


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
    bidirectional_edges_ratio: float = (
        0.0  # Fraction of edges to create reverse (B->A) (0.0-1.0)
    )

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
    """Request to discover the types a datasource exposes.

    A SQL warehouse needs the two tables and their structural columns to run
    ``SELECT DISTINCT``; a native graph database reads its own label catalog and
    ignores all three, which is why they are optional.
    """

    datasource_type: DatasourceType = DEFAULT_DATASOURCE_TYPE
    # Which named connection a "rest" discovery targets — this endpoint is the
    # one context-free dispatch, so the instance selector travels in the body.
    datasource_name: Optional[str] = None
    edge_table: Optional[str] = None
    node_table: Optional[str] = None
    columns: ColumnConfig = Field(default_factory=ColumnConfig)

    @model_validator(mode="after")
    def _require_tables_for_sql(self) -> "SchemaDiscoveryRequest":
        if self.datasource_type == "sql_warehouse" and not (
            self.edge_table and self.node_table
        ):
            raise ValueError(
                "edge_table and node_table are required for sql_warehouse discovery"
            )
        if self.datasource_type == "rest" and not self.datasource_name:
            raise ValueError("datasource_name is required for rest discovery")
        return self


class SchemaDiscoveryResponse(BaseModel):
    """Response with distinct node and relationship types from tables."""

    node_types: list[str]
    relationship_types: list[str]


# Schema drift models — see graphlagoon.services.schema_drift for the diff logic.
class SchemaDriftFinding(BaseModel):
    """One detected difference between a context's stored snapshot and the live table."""

    code: str
    severity: Literal["error", "warning", "info"]
    side: Literal["node", "edge"]
    kind: Literal["table", "structure", "property", "type"]
    name: str
    message: str
    role: Optional[str] = None
    stored: Optional[dict] = None
    live: Optional[dict] = None
    auto_fixable: bool = False


class SchemaDriftTable(BaseModel):
    """Live state of one side's table, as seen by the drift check."""

    table_name: str
    reachable: bool
    columns: list[ColumnInfo] = Field(default_factory=list)


class SchemaDriftProposal(BaseModel):
    """The resync payload — echo this back through PUT to apply it.

    ``node_types``/``relationship_types`` are ``None`` unless the check was run
    with ``check_types=true``; ``None`` already means "leave unchanged" on
    ``GraphContextUpdate``, so this can be forwarded verbatim.
    """

    node_properties: list[PropertyColumn] = Field(default_factory=list)
    edge_properties: list[PropertyColumn] = Field(default_factory=list)
    node_types: Optional[list[str]] = None
    relationship_types: Optional[list[str]] = None


class SchemaDriftResponse(BaseModel):
    """Full drift report for a context. A read-only diff — never an HTTP failure
    on its own; an unreachable table surfaces as a `TABLE_NOT_FOUND` finding."""

    context_id: UUID
    checked_at: datetime
    status: Literal["ok", "error", "warning", "info"]
    types_checked: bool
    counts: dict[str, int]
    node_table: SchemaDriftTable
    edge_table: SchemaDriftTable
    findings: list[SchemaDriftFinding]
    proposed: SchemaDriftProposal


class CypherQueryRequest(BaseModel):
    """Request to execute an OpenCypher query.

    Note: The query should include its own LIMIT clause if needed.
    The backend respects whatever LIMIT is specified in the Cypher query.
    """

    query: str
    cte_prefilter: Optional[str] = None
    vlp_rendering_mode: VlpRenderingMode = "procedural"
    materialization_strategy: MaterializationStrategy = "numbered_views"
    procedural_optimizations: Optional[ProceduralBFSOptions] = None
    use_external_links: bool = True


class CypherQueryResponse(BaseModel):
    """Response from an OpenCypher query execution."""

    nodes: list[Node]
    edges: list[Edge]
    truncated: bool = False
    total_count: Optional[int] = None
    # The SQL generated from the OpenCypher. Null for backends that speak
    # Cypher natively and therefore transpile nothing.
    transpiled_sql: Optional[str] = None
    metadata: Optional[QueryMetadata] = None


class CypherTranspileRequest(BaseModel):
    """Request to transpile an OpenCypher query (without execution)."""

    query: str
    cte_prefilter: Optional[str] = None
    vlp_rendering_mode: VlpRenderingMode = "procedural"
    materialization_strategy: MaterializationStrategy = "numbered_views"
    procedural_optimizations: Optional[ProceduralBFSOptions] = None


class CypherTranspileResponse(BaseModel):
    """Response from OpenCypher transpilation (without execution)."""

    transpiled_sql: str


class TableQueryRequest(BaseModel):
    """Request to run a generic query and return raw tabular rows.

    Unlike CypherQueryRequest, the query is NOT required to return edges
    (RETURN r). Any projection is allowed; the result is returned as
    columns + rows for display in a table.
    """

    query: str
    mode: Literal["cypher", "sql"] = "cypher"
    cte_prefilter: Optional[str] = None
    row_limit: int = Field(default=1000, ge=1, le=100000)
    # Transpile options (cypher mode only). Default to legacy "cte" so plain
    # SQL / simple cypher table queries are unaffected.
    vlp_rendering_mode: VlpRenderingMode = "procedural"
    materialization_strategy: MaterializationStrategy = "numbered_views"
    procedural_optimizations: Optional[ProceduralBFSOptions] = None


class TableQueryResponse(BaseModel):
    """Response from a generic tabular query.

    ``status`` distinguishes the two outcomes of the cancellable submit flow:
    - ``"succeeded"``: query finished within the submit wait window; ``columns``
      and ``rows`` hold the result (the historical fast-path shape).
    - ``"running"``: query is still executing; ``columns``/``rows`` are empty and
      ``statement_id`` identifies it for polling (``GET .../query/table/{id}``)
      and cancellation (``POST .../query/table/{id}/cancel``).
    """

    status: Literal["succeeded", "running"] = "succeeded"
    statement_id: Optional[str] = None
    columns: list[str] = Field(default_factory=list)
    rows: list[list[Optional[str]]] = Field(default_factory=list)
    row_count: int = 0
    truncated: bool = False
    # Result-set shape from the warehouse manifest (known once SUCCEEDED). For
    # the INLINE table path this is a single chunk; surfaced so the client can
    # log/report how the result was chunked.
    total_chunk_count: Optional[int] = None
    total_row_count: Optional[int] = None
    transpiled_sql: Optional[str] = None  # populated in cypher mode
    metadata: Optional[QueryMetadata] = None


class TableQueryStatusResponse(BaseModel):
    """Poll response for an in-flight table query.

    Mirrors :class:`TableQueryResponse` but for the ``GET`` status endpoint:
    ``status="running"`` while executing, ``status="succeeded"`` with data once
    complete. A FAILED/timed-out statement surfaces as an HTTP 400 instead; a
    CANCELED one as ``status="canceled"``.
    """

    status: Literal["running", "succeeded", "canceled"]
    statement_id: str
    columns: list[str] = Field(default_factory=list)
    rows: list[list[Optional[str]]] = Field(default_factory=list)
    row_count: int = 0
    truncated: bool = False
    # Result-set shape from the warehouse manifest (known once SUCCEEDED).
    total_chunk_count: Optional[int] = None
    total_row_count: Optional[int] = None


class GraphJobProgress(BaseModel):
    """Chunk-download progress for an in-flight graph query job."""

    phase: str  # "edges" | "nodes"
    chunks_done: int
    chunks_total: int


class GraphJobSubmitResponse(BaseModel):
    """Response to submitting a cancellable graph/cypher query job."""

    status: Literal["running", "succeeded"] = "running"
    job_id: str
    transpiled_sql: Optional[str] = None  # populated for cypher jobs


class GraphJobStatusResponse(BaseModel):
    """Poll response for an in-flight graph query job.

    ``running`` carries chunk-download ``progress``; ``succeeded`` carries the
    ``result`` graph (and ``transpiled_sql`` for cypher). A failed job surfaces
    as HTTP 400; a cancelled one as ``status="canceled"``.
    """

    status: Literal["running", "succeeded", "canceled"]
    job_id: str
    progress: Optional[GraphJobProgress] = None
    result: Optional[GraphResponse] = None
    transpiled_sql: Optional[str] = None
    partial: Optional[GraphResponse] = Field(
        default=None,
        description=(
            "A renderable intermediate result — edges plus nodes carrying only "
            "their structural columns — published while the job is still "
            "fetching properties. Lets the client draw the graph before the "
            "job completes."
        ),
    )
    partial_seq: int = Field(
        default=0,
        description=(
            "Increments on each published partial. The client polls far more "
            "often than partials are produced, so it applies a partial only "
            "when this advances."
        ),
    )


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
    # Client-side telemetry (not part of the Databricks spec). Populated by
    # execute_statement_external to expose how long chunk downloading took and
    # how many chunks were fetched, so callers can attribute query time.
    client_download_ms: Optional[float] = None
    client_chunk_count: Optional[int] = None
