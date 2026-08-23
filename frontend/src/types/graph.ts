import type { ClusterProgram } from './cluster';

export interface Node {
  node_id: string;
  node_type: string;
  properties?: Record<string, unknown>;
  x?: number;
  y?: number;
  selected?: boolean;
}

export interface Edge {
  edge_id: string;
  src: string;
  dst: string;
  relationship_type: string;
  properties?: Record<string, unknown>;
  selected?: boolean;
}

export interface QueryMetadata {
  edge_query_ms?: number;
  edge_processing_ms?: number;
  node_query_ms?: number;
  node_processing_ms?: number;
  transpilation_ms?: number;
  total_ms?: number;
  // Chunk-download breakdown (EXTERNAL_LINKS path only)
  chunk_download_ms?: number;
  chunk_count?: number;
  // Result sizes, for correlating timings with graph scale
  node_count?: number;
  edge_count?: number;
}

export interface GraphResponse {
  nodes: Node[];
  edges: Edge[];
  truncated: boolean;
  total_count?: number;
  metadata?: QueryMetadata;
  /**
   * Set when nodes came back without properties (nodes_mode: 'types'), so the
   * graph can render immediately. The store schedules background enrichment
   * via getNodesBatch when this is true.
   */
  properties_deferred?: boolean;
}

export interface NodeBatchResponse {
  nodes: Node[];
  metadata?: QueryMetadata;
}

export interface EdgeStructure {
  edge_id_col: string;
  src_col: string;
  dst_col: string;
  relationship_type_col: string;
}

export interface NodeStructure {
  node_id_col: string;
  node_type_col: string;
}

export interface PropertyColumn {
  name: string;
  data_type: string;
  display_name?: string;
  description?: string;
}

// Backwards compatibility aliases
export type EdgeColumnConfig = EdgeStructure;
export type NodeColumnConfig = NodeStructure;

/**
 * Which backend a context is queried through.
 *
 * `sql_warehouse` is a graph stored as an edge table + a node table, queried by
 * transpiling Cypher to Spark SQL. `neptune` is Amazon Neptune's openCypher
 * endpoint — a native graph database, so it defines no tables at all.
 */
export type DatasourceType = "sql_warehouse" | "neptune" | "rest";

/**
 * A named REST connection as the server advertises it in
 * `config.datasource_connections` — UI copy plus per-connection operation
 * flags. Transport and auth never leave the server.
 */
export interface DatasourceConnectionConfig {
  type: "rest";
  name: string;
  label: string;
  kind: string;
  tagline: string;
  description: string;
  caveat: string;
  query_language: string;
  query_placeholder: string;
  example_query: string;
  capabilities: {
    expand: boolean;
    subgraph: boolean;
    fetch_nodes: boolean;
    schema_discovery: boolean;
  };
}

export interface GraphContext {
  id: string;
  title: string;
  description?: string;
  tags: string[];
  /** Absent on contexts created before datasources were pluggable — treat as `sql_warehouse`. */
  datasource_type?: DatasourceType;
  /** Which named connection a `rest` context uses; null for the other types. */
  datasource_name?: string | null;
  /** Null for native graph databases, which define no tables. */
  edge_table_name: string | null;
  node_table_name: string | null;
  edge_structure: EdgeStructure;
  node_structure: NodeStructure;
  edge_properties: PropertyColumn[];
  node_properties: PropertyColumn[];
  node_types: string[];
  relationship_types: string[];
  /** Behavior settings applied when this context is opened. A saved exploration overrides them. */
  default_behaviors?: Record<string, unknown>;
  /** Context-level cluster programs, shared by all explorations. Built-in defaults are never stored here. */
  cluster_programs?: ClusterProgram[];
  owner_email: string;
  shared_with: string[];
  has_write_access: boolean;
  created_at: string;
  updated_at: string;
}

export interface NodeState {
  node_id: string;
}

export interface EdgeState {
  edge_id: string;
}

// Graph snapshot — full node/edge data saved alongside an exploration
export interface SnapshotNode {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  x?: number;
  y?: number;
}

export interface SnapshotEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface GraphSnapshot {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  snapshot_version?: number;
}

// Precomputed graphs — named graph resources resolved server-side by a provider.
//
// Where one comes from is the deploying developer's decision: a file in a
// volume, a query against Lakebase parameterised by the URL, a Delta table.
// The frontend does not care which — it asks for a name plus arguments and
// gets this shape back.
//
// Distinct from a snapshot: a snapshot belongs to one exploration and one user
// and carries UI state (positions, communities, clusters); a precomputed graph
// is named, visible to everyone with context access, and carries nothing but
// data. That is why it reuses the API's Node/Edge shape instead of the
// snapshot's — it feeds the store with no field remapping.

export interface PrecomputedGraphData {
  nodes: Node[];
  edges: Edge[];
  truncated: boolean;
  total_count?: number | null;
  properties_deferred?: boolean;
}

/** Where a precomputed graph came from.
 *
 *  Both fields are optional, and a graph that never came from a query — one a
 *  batch job assembled from Delta tables, say — says so with `kind: 'manual'`.
 *  `datasource_type`/`datasource_name` were removed: an entry is already
 *  scoped to a context that knows its own datasource, and nothing read them. */
export interface PrecomputedGraphSource {
  kind: 'cypher' | 'sql' | 'subgraph' | 'manual';
  query?: string | null;
}

export interface PrecomputedGraphPayload {
  payload_version: number;
  name: string;
  context_id: string;
  /** Which provider resolved this graph. */
  provider: string;
  /** The URL arguments it was resolved with — empty for a plain stored file. */
  params: Record<string, string | number | boolean | null>;
  created_at: string;
  created_by: string;
  node_count: number;
  edge_count: number;
  properties_complete: boolean;
  source: PrecomputedGraphSource;
  graph: PrecomputedGraphData;
}

/** What a write reports back. There is no listing endpoint to return these in
 *  bulk — entries are addressed by name. */
export interface PrecomputedGraphEntry {
  name: string;
  size_bytes: number;
  modified_at?: string | null;
}

/** One provider, as advertised by the capabilities endpoint. */
export interface PrecomputedGraphProviderInfo {
  name: string;
  label: string;
  description: string;
  caveat: string;
  capabilities: { write: boolean; delete: boolean };
  params: Array<{
    name: string;
    type: string;
    required: boolean;
    default: unknown;
    description: string;
    choices: string[] | null;
    min: number | null;
    max: number | null;
  }>;
}

/** What this context can do — deliberately not a listing of entries.
 *
 *  `can_write` already folds in superuser status, so the panel gates on one
 *  flag rather than re-deriving the rule the server owns. */
export interface PrecomputedGraphCapabilities {
  enabled: boolean;
  can_write: boolean;
  can_delete: boolean;
  providers: PrecomputedGraphProviderInfo[];
}

/** Mirrors ARTIFACT_NAME_RE in api/graphlagoon/services/named_store.py, which
 *  owns the rule for precomputed graphs and style presets alike. */
export const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// Style presets — named style + label + layout settings, applied by URL.
//
// Every field here also exists in ExplorationState, and both are produced by
// `buildStylePreset()` and consumed by `applyStylePreset()` in stores/graph.ts.
// Keeping one definition is the point: a preset and an exploration must never
// describe the same setting two different ways.
//
// Deliberately absent: nodes, edges, filters, viewport, query, clusters,
// communities and behaviors. A preset says how a graph looks, not what it shows.

export interface StylePresetSettings {
  // Style
  aesthetics?: Record<string, unknown>;
  nodeTypeColors?: Record<string, string>;
  edgeTypeColors?: Record<string, string>;
  nodeTypeIcons?: Record<string, string>;
  edgeTypeIcons?: Record<string, string>;
  nodePropertyIconConfigs?: Record<string, PropertyIconConfig>;
  // Labels
  textFormat?: TextFormatState;
  // Layout
  layout_algorithm?: LayoutAlgorithm;
  layout_mode_config?: LayoutModeConfig;
  force3d_settings?: Record<string, unknown>;
}

export interface StylePreset {
  preset_version: number;
  name: string;
  context_id: string;
  created_at: string;
  created_by: string;
  updated_at?: string | null;
  description?: string | null;
  settings: StylePresetSettings;
}

/** One row of the preset picker. No owner: the listing reports only what a
 *  directory listing knows, and delete checks ownership server-side. */
export interface StylePresetEntry {
  name: string;
  size_bytes: number;
  modified_at?: string | null;
}

// Property filter types
export type PropertyFilterOperator =
  | 'equals'           // Exact match (string or number)
  | 'not_equals'       // Not equal
  | 'one_of'           // Value is one of array
  | 'contains'         // String contains (case-insensitive)
  | 'less_than'        // Numeric comparison
  | 'less_than_or_equal'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'between';         // Range (inclusive)

export interface PropertyFilter {
  id: string;                         // Unique identifier for this filter
  property: string;                   // Property name (from metadata) or 'metric:metricId'
  operator: PropertyFilterOperator;
  value: string | number | null;      // For single value operators
  values?: (string | number)[];       // For 'one_of' operator
  minValue?: number;                  // For 'between' operator
  maxValue?: number;                  // For 'between' operator
  enabled: boolean;                   // Allow toggling without removing
}

export interface FilterState {
  node_types: string[];
  edge_types: string[];
  search_query?: string;
  nodePropertyFilters: PropertyFilter[];
  edgePropertyFilters: PropertyFilter[];
}

export interface ViewportState {
  zoom: number;
  center_x: number;
  center_y: number;
}

export type LayoutAlgorithm = "force" | "ego" | "hive" | "hierarchical" | "circular" | "grid";

/** BFS direction for the ego layout: follow outgoing edges, incoming edges, or both */
export type EgoDirection = "both" | "out" | "in";

/**
 * Angular ordering strategy for ego rings.
 * - 'id': sorted-id order (purely structural baseline)
 * - 'barycenter': radial-Sugiyama crossing reduction (Bachmaier, IEEE TVCG 2007)
 * - 'node-type' | 'community' | 'property': contiguous angular sectors by attribute
 */
export type RingOrdering = "id" | "barycenter" | "node-type" | "community" | "property";

/**
 * Heuristic behind the "fewest crossings" ordering. All deterministic; they
 * trade cost for strength.
 * - 'barycenter': sibling sweeps by mean neighbour angle — cheap, weak on stars
 * - 'median': same sweeps, circular median (Eades & Wormald 3-approximation)
 * - 'sifting': circular sifting (Baur & Brandes 2004) — far stronger, costlier
 */
export type CrossingHeuristic = "barycenter" | "median" | "sifting";

/** Radial scale for hive plot axis positioning */
export type HiveScale = "rank" | "linear" | "log";

export interface EgoLayoutConfig {
  /** Node the rings radiate from. Layout is inert while null. */
  focusNodeId: string | null;
  direction: EgoDirection;
  /** Restrict BFS traversal to these relationship types (null = all). Other edges stay drawn. */
  edgeTypes: string[] | null;
  /** Hide nodes farther than this many hops (null = no cutoff) */
  maxHops: number | null;
  ringSpacing: number;
  /**
   * How nodes are ordered angularly within each ring. Strategies are mutually
   * exclusive — the ring's angle carries one meaning at a time, so two runs of
   * the layout stay comparable (the point of a deterministic radial layout).
   */
  ringOrdering: RingOrdering;
  /** Property name used by ringOrdering 'property' (null = none selected yet) */
  ringOrderingKey: string | null;
  /** Which heuristic ringOrdering 'barycenter' runs */
  crossingHeuristic: CrossingHeuristic;
  /** Sweeps for the barycenter/median heuristics (sifting ignores this) */
  crossingSweeps: number;
  /**
   * Draw edges between nodes on the SAME ring as arcs hugging that ring instead
   * of straight chords across the interior. Every edge stays individually
   * traceable — this is arc routing, not bundling.
   */
  arcIntraRingEdges: boolean;
}

export interface HiveLayoutConfig {
  /** 'node_type' or 'prop:<name>' of a categorical node property */
  axisKey: string;
  /** Categories beyond this count are bucketed into an "Others" axis */
  maxAxes: number;
  /** 'degree' or 'prop:<name>' of a numeric node property */
  positionKey: string;
  scale: HiveScale;
  innerRadius: number;
  outerRadius: number;
}

export interface HierarchicalLayoutConfig {
  /** 'td' = levels grow downward, 'lr' = levels grow rightward */
  direction: "td" | "lr";
  /** Edge traversal for the hierarchy: 'out' = src→dst flows down (money flow) */
  traversal: EgoDirection;
  /** Restrict hierarchy edges to these relationship types (null = all) */
  edgeTypes: string[] | null;
  levelSpacing: number;
  nodeSpacing: number;
}

export interface LayoutModeConfig {
  ego: EgoLayoutConfig;
  hive: HiveLayoutConfig;
  hierarchical: HierarchicalLayoutConfig;
}

/** Per-node-type configuration for property-based icon mapping */
export interface PropertyIconConfig {
  property: string;                    // Property name to use for icon lookup
  valueIcons: Record<string, string>;  // Property value → icon name
  fallbackIcon?: string;               // Icon for null/unspecified property values
}

export interface ExplorationState {
  nodes: NodeState[];
  edges: EdgeState[];
  filters: FilterState;
  viewport: ViewportState;
  layout_algorithm: LayoutAlgorithm;
  graph_query?: string;
  cte_prefilter?: string;              // CTE pre-filter for edge table
  vlp_rendering_mode?: VlpRenderingMode;         // Cypher transpilation mode (optional for backwards compat)
  materialization_strategy?: MaterializationStrategy; // Materialization strategy (optional for backwards compat)
  procedural_optimizations?: ProceduralBFSOptions; // Procedural BFS flags (optional for backwards compat)
  cte_fallback_enabled?: boolean;      // Retry failed procedural queries in CTE mode (optional for backwards compat, defaults to true)
  cte_fallback_silent?: boolean;       // Skip the fallback warning toasts (optional for backwards compat, defaults to true)
  textFormat?: TextFormatState;        // Label formatting rules (optional for backwards compat)
  clusters?: any;                      // ClusterState from cluster store (optional for backwards compat)
  nodeTypeIcons?: Record<string, string>;  // Node type → icon name mapping (optional for backwards compat)
  nodePropertyIconConfigs?: Record<string, PropertyIconConfig>; // Node type → property icon config (optional for backwards compat)
  nodeTypeColors?: Record<string, string>; // Node type → color hex (optional for backwards compat)
  edgeTypeColors?: Record<string, string>; // Edge type → color hex (optional for backwards compat)
  edgeTypeIcons?: Record<string, string>;  // Edge type → icon name mapping (optional for backwards compat)
  layout_mode_config?: LayoutModeConfig;   // Per-layout-mode parameters (optional for backwards compat)
  behaviors?: Record<string, unknown>;     // Behavior settings (optional for backwards compat)
  aesthetics?: Record<string, unknown>;    // Aesthetic settings (optional for backwards compat)
  force3d_settings?: Record<string, unknown>; // 3D force simulation params (optional for backwards compat)
  community?: Record<string, unknown>;     // Community detection state (optional for backwards compat)
  similarity?: Record<string, unknown>;    // Similarity system state (optional for backwards compat)
  has_snapshot?: boolean;                  // Whether a file-based graph snapshot exists
}

export interface Exploration {
  id: string;
  graph_context_id: string;
  title: string;
  owner_email: string;
  shared_with: string[];
  has_write_access: boolean;
  state: ExplorationState;
  created_at: string;
  updated_at: string;
}

export interface DatasetsResponse {
  edge_tables: string[];
  node_tables: string[];
}

// Query Template types
export interface TemplateParameter {
  id: string;
  type: 'input' | 'select';
  label: string;
  description?: string;
  placeholder?: string;
  default?: string;
  options?: string[];   // only used when type === 'select'
  required: boolean;
}

export interface TemplateOptions {
  procedural_bfs: boolean;
  cte_prefilter?: string;
  large_results_mode: boolean;
  /** Whether a ?template= link may auto-execute this template. Absent ⇒ true. */
  allow_url_execution?: boolean;
}

// 'shared': visible to everyone with context access, mutable by context writers.
// 'private': visible and mutable only by its creator.
export type TemplateVisibility = 'shared' | 'private';

export interface QueryTemplate {
  id: string;
  graph_context_id: string;
  owner_email: string;
  name: string;
  description?: string;
  query_type: 'cypher' | 'sql';
  query: string;
  parameters: TemplateParameter[];
  options: TemplateOptions;
  visibility: TemplateVisibility;
  created_at: string;
  updated_at: string;
}

export interface CreateQueryTemplateRequest {
  name: string;
  description?: string;
  query_type: 'cypher' | 'sql';
  query: string;
  parameters: TemplateParameter[];
  options?: TemplateOptions;
  visibility?: TemplateVisibility;
}

export interface UpdateQueryTemplateRequest {
  name?: string;
  description?: string;
  query_type?: 'cypher' | 'sql';
  query?: string;
  parameters?: TemplateParameter[];
  options?: TemplateOptions;
  visibility?: TemplateVisibility;
}

export interface SubgraphRequest {
  edge_limit?: number;
  node_types?: string[];
  edge_types?: string[];
  /**
   * 'full' (default) returns nodes with their properties. 'types' returns only
   * node_id/node_type — enough to render — so the canvas can paint before the
   * properties are fetched in background batches.
   */
  nodes_mode?: 'full' | 'types';
}

export interface ExpandRequest {
  node_id: string;
  depth?: number;  // 1-2, default 2
  edge_types?: string[];
  edge_limit?: number;  // 4-1000, default 100
  directed?: boolean;  // default false (undirected)
}

// NetworkX graph models
export type GraphModel =
  | "erdos_renyi"
  | "barabasi_albert"
  | "watts_strogatz"
  | "complete"
  | "cycle"
  | "star"
  | "random_tree";

// Data types for extra columns
export type ColumnDataType = "string" | "int" | "float" | "boolean" | "date" | "timestamp";

// Generator types for random data
export type GeneratorType =
  | "uuid"
  | "sequence"
  | "random_int"
  | "random_float"
  | "random_choice"
  | "random_string"
  | "random_date"
  | "random_bool"
  | "faker_name"
  | "faker_email"
  | "faker_address"
  | "faker_company"
  | "constant"
  | "random_json_object"
  | "random_json_array";

export interface ExtraColumnDefinition {
  name: string;
  data_type: ColumnDataType;
  generator: GeneratorType;
  choices?: string[];
  min_value?: number;
  max_value?: number;
  string_length?: number;
  constant_value?: unknown;
  nullable?: boolean;
  null_probability?: number;
  json_max_depth?: number;
  json_max_keys?: number;
  json_array_min_items?: number;
  json_array_max_items?: number;
}

export interface ColumnConfig {
  node_id_col: string;
  node_type_col: string;
  edge_id_col: string;
  src_col: string;
  dst_col: string;
  relationship_type_col: string;
}

export interface RandomGraphRequest {
  // Table naming: catalog.schema.table format
  catalog: string;
  schema_name: string;
  table_name: string;

  // Graph model selection
  model: GraphModel;

  // Model-specific parameters
  num_nodes: number;
  avg_degree?: number;          // For erdos_renyi, barabasi_albert, watts_strogatz
  rewiring_prob?: number;       // For watts_strogatz only
  ensure_connected?: boolean;   // Connect disconnected components
  self_edges_ratio?: number;    // Ratio of self-edges to add (0.0-1.0, e.g. 0.3 = 30% of edges)
  multi_edges_max_count?: number;  // Max extra edges between same pair of nodes (0 = disabled)
  multi_edges_ratio?: number;      // Fraction of existing edges to duplicate (0.0-1.0)
  bidirectional_edges_ratio?: number;  // Fraction of edges to create reverse (B->A) (0.0-1.0)

  // Node and edge types
  node_types: string[];
  edge_types: string[];

  // Column configuration
  columns?: ColumnConfig;

  // Extra columns for nodes and edges
  extra_node_columns?: ExtraColumnDefinition[];
  extra_edge_columns?: ExtraColumnDefinition[];
}

export interface RandomGraphResponse {
  edge_table: string;
  node_table: string;
  num_nodes: number;
  num_edges: number;
  model: string;
  status: string;
}

export interface CreateGraphContextRequest {
  title: string;
  description?: string;
  tags?: string[];
  /** Omitted means `sql_warehouse`, keeping older callers valid. */
  datasource_type?: DatasourceType;
  /** Required for `rest`: the registered connection to query. */
  datasource_name?: string;
  /** Required for `sql_warehouse`; omitted for native graph databases. */
  edge_table_name?: string;
  node_table_name?: string;
  edge_structure?: EdgeStructure;
  node_structure?: NodeStructure;
  edge_properties?: PropertyColumn[];
  node_properties?: PropertyColumn[];
  node_types?: string[];
  relationship_types?: string[];
  default_behaviors?: Record<string, unknown>;
  cluster_programs?: ClusterProgram[];
}

export interface ShareRequest {
  email: string;
  permission: "read" | "write";
}

export interface CreateExplorationRequest {
  title: string;
  state: ExplorationState;
  snapshot?: GraphSnapshot;
}

export type VlpRenderingMode = 'cte' | 'procedural';
export type MaterializationStrategy = 'temp_tables' | 'numbered_views';

/**
 * Fine-grained toggles for the procedural BFS renderer in gsql2rsql. Field
 * names and defaults mirror the backend `ProceduralBFSOptions` /
 * `gsql2rsql.ProceduralBFSOptimizations`. Flags only take effect when
 * `vlp_rendering_mode === 'procedural'`. Note `undirected_doubled_adjacency`
 * and `undirected_union_all` are mutually exclusive (both ON → transpiler error).
 */
export interface ProceduralBFSOptions {
  visited_not_exists: boolean;            // both strategies
  loop_control_into: boolean;             // numbered_views only
  undirected_doubled_adjacency: boolean;  // both strategies
  deferred_edge_payload: boolean;         // temp_tables only
  barrier_precompute: boolean;            // temp_tables only
  barrier_on_adjacency: boolean;          // temp_tables only; needs barrier_precompute
  prune_barrier_adjacency: boolean;       // temp_tables only; needs doubled_adjacency + barrier_precompute
  undirected_union_all: boolean;          // both strategies
}

/**
 * App defaults for the procedural BFS flags. These mirror gsql2rsql's dataclass
 * defaults EXCEPT `barrier_on_adjacency` and `prune_barrier_adjacency`, which
 * the app enables by default (gsql2rsql's own default is `false` for both).
 */
export const DEFAULT_PROCEDURAL_BFS_OPTIONS: ProceduralBFSOptions = {
  visited_not_exists: true,
  loop_control_into: true,
  undirected_doubled_adjacency: true,
  deferred_edge_payload: true,
  barrier_precompute: true,
  barrier_on_adjacency: true,
  prune_barrier_adjacency: true,
  undirected_union_all: false,
};

export interface GraphQueryRequest {
  query: string;
  cte_prefilter?: string;
  use_external_links?: boolean;
}

export interface CypherQueryRequest {
  query: string;
  cte_prefilter?: string;
  vlp_rendering_mode?: VlpRenderingMode;
  materialization_strategy?: MaterializationStrategy;
  procedural_optimizations?: ProceduralBFSOptions;
  use_external_links?: boolean;
}

export interface CypherQueryResponse {
  nodes: Node[];
  edges: Edge[];
  truncated: boolean;
  total_count?: number;
  transpiled_sql: string;
  metadata?: QueryMetadata;
}

export interface CypherTranspileRequest {
  query: string;
  cte_prefilter?: string;
  vlp_rendering_mode?: VlpRenderingMode;
  materialization_strategy?: MaterializationStrategy;
  procedural_optimizations?: ProceduralBFSOptions;
}

export interface CypherTranspileResponse {
  transpiled_sql: string;
}

export type TableQueryMode = 'cypher' | 'sql';

export interface TableQueryRequest {
  query: string;
  mode?: TableQueryMode;
  cte_prefilter?: string;
  row_limit?: number;
  vlp_rendering_mode?: VlpRenderingMode;
  materialization_strategy?: MaterializationStrategy;
  procedural_optimizations?: ProceduralBFSOptions;
}

export interface TableQueryResponse {
  // 'succeeded' → columns/rows hold the result; 'running' → still executing,
  // poll with statement_id (defaults omitted by older backends → treat as
  // 'succeeded').
  status?: 'succeeded' | 'running';
  statement_id?: string;
  columns: string[];
  rows: (string | null)[][];
  row_count: number;
  truncated: boolean;
  total_chunk_count?: number;
  total_row_count?: number;
  transpiled_sql?: string;
  metadata?: QueryMetadata;
}

export interface TableQueryStatusResponse {
  status: 'running' | 'succeeded' | 'canceled';
  statement_id: string;
  columns: string[];
  rows: (string | null)[][];
  row_count: number;
  truncated: boolean;
  total_chunk_count?: number;
  total_row_count?: number;
}

export interface GraphJobProgress {
  phase: string; // "edges" | "nodes"
  chunks_done: number;
  chunks_total: number;
}

export interface GraphJobSubmitResponse {
  status: 'running' | 'succeeded';
  job_id: string;
  transpiled_sql?: string;
}

export interface GraphJobStatusResponse {
  status: 'running' | 'succeeded' | 'canceled';
  job_id: string;
  progress?: GraphJobProgress | null;
  result?: GraphResponse | null;
  transpiled_sql?: string;
  /**
   * A renderable intermediate result — edges plus nodes carrying only their
   * structural columns — published while the job is still fetching properties,
   * so the graph can be drawn roughly twice as early.
   */
  partial?: GraphResponse | null;
  /** Increments per published partial; the poller applies each one once. */
  partial_seq?: number;
}

// Catalog types
export interface CatalogInfo {
  name: string;
}

export interface DatabaseInfo {
  name: string;
  catalog: string;
  description?: string;
  location?: string;
}

export interface TableInfo {
  name: string;
  database: string;
  catalog: string;
  table_type: string;
  is_temporary: boolean;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  comment?: string;
}

export interface TableSchema {
  table_name: string;
  database: string;
  catalog: string;
  columns: ColumnInfo[];
}

export interface CatalogListResponse {
  catalogs: CatalogInfo[];
}

export interface DatabaseListResponse {
  databases: DatabaseInfo[];
}

export interface TableListResponse {
  tables: TableInfo[];
}

export interface TablePreviewResponse {
  columns: string[];
  rows: (string | null)[][];
  row_count: number;
}

export interface SchemaDiscoveryRequest {
  /** Omitted means `sql_warehouse`. */
  datasource_type?: DatasourceType;
  /** Required for `rest`: the connection whose types to discover. */
  datasource_name?: string;
  /** Required for `sql_warehouse`; a native graph database reads its own label catalog. */
  edge_table?: string;
  node_table?: string;
  columns?: ColumnConfig;
}

export interface SchemaDiscoveryResponse {
  node_types: string[];
  relationship_types: string[];
}

// Schema drift — see api/graphlagoon/services/schema_drift.py for the source of truth.
export type SchemaDriftSeverity = 'ok' | 'error' | 'warning' | 'info';

export interface SchemaDriftFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  side: 'node' | 'edge';
  kind: 'table' | 'structure' | 'property' | 'type';
  name: string;
  message: string;
  role?: string | null;
  stored?: Record<string, unknown> | null;
  live?: Record<string, unknown> | null;
  auto_fixable: boolean;
}

export interface SchemaDriftTable {
  table_name: string;
  reachable: boolean;
  columns: ColumnInfo[];
}

export interface SchemaDriftProposal {
  node_properties: PropertyColumn[];
  edge_properties: PropertyColumn[];
  node_types: string[] | null;
  relationship_types: string[] | null;
}

export interface SchemaDriftResponse {
  context_id: string;
  checked_at: string;
  status: SchemaDriftSeverity;
  types_checked: boolean;
  counts: { error: number; warning: number; info: number };
  node_table: SchemaDriftTable;
  edge_table: SchemaDriftTable;
  findings: SchemaDriftFinding[];
  proposed: SchemaDriftProposal;
}

// ============================================================================
// Text Format Rules - Label formatting for nodes and edges
// ============================================================================

/** Modifiers that can be applied to property values in templates */
export type TextFormatModifier =
  | 'upper'           // Convert to uppercase
  | 'lower'           // Convert to lowercase
  | 'capitalize'      // Capitalize first letter
  | 'truncate'        // Truncate with ellipsis: truncate:20:...
  | 'number'          // Format as number with locale
  | 'currency'        // Format as currency: currency:BRL or currency:USD
  | 'percent';        // Format as percentage

/** Operators for conditional expressions */
export type TextFormatConditionOperator =
  | '=='              // Equals
  | '!='              // Not equals
  | '>'               // Greater than
  | '<'               // Less than
  | '>='              // Greater or equal
  | '<='              // Less or equal
  | 'contains'        // String contains
  | 'startsWith'      // String starts with
  | 'endsWith'        // String ends with
  | 'daysAgo'         // Date is within N days: daysAgo:<7
  | 'dateAfter'       // Date is after: dateAfter:2024-01-01
  | 'dateBefore'      // Date is before: dateBefore:2024-12-31
  | 'dateBetween';    // Date is between: dateBetween:2024-01-01:2024-12-31

/** Scope where the rule applies */
export type TextFormatScope = 'global' | 'context' | 'exploration';

/** A text format rule defines how labels should be displayed */
export interface TextFormatRule {
  id: string;                          // Unique identifier
  name: string;                        // Human-readable name
  target: 'node' | 'edge';             // What this rule applies to
  types: string[];                     // Specific types (empty = all types)
  template: string;                    // Template string with placeholders
  priority: number;                    // Higher priority rules take precedence
  enabled: boolean;                    // Allow toggling without removing
  scope: TextFormatScope;              // Where this rule is stored/applies
}

/** Default format rule (used when no matching rule is found) */
export interface TextFormatDefaults {
  nodeTemplate: string;                // Default template for nodes
  edgeTemplate: string;                // Default template for edges
}

/** State for text format rules in exploration */
export interface TextFormatState {
  rules: TextFormatRule[];
  defaults: TextFormatDefaults;
}
