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
}

export interface GraphResponse {
  nodes: Node[];
  edges: Edge[];
  truncated: boolean;
  total_count?: number;
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

export interface GraphContext {
  id: string;
  title: string;
  description?: string;
  tags: string[];
  edge_table_name: string;
  node_table_name: string;
  edge_structure: EdgeStructure;
  node_structure: NodeStructure;
  edge_properties: PropertyColumn[];
  node_properties: PropertyColumn[];
  node_types: string[];
  relationship_types: string[];
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

export type LayoutAlgorithm = "force-atlas-2" | "circular" | "grid";
export type Layout3DEngine = "d3-force";

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
  textFormat?: TextFormatState;        // Label formatting rules (optional for backwards compat)
  clusters?: any;                      // ClusterState from cluster store (optional for backwards compat)
  nodeTypeIcons?: Record<string, string>;  // Node type → icon name mapping (optional for backwards compat)
  nodeTypeColors?: Record<string, string>; // Node type → color hex (optional for backwards compat)
  edgeTypeColors?: Record<string, string>; // Edge type → color hex (optional for backwards compat)
  behaviors?: Record<string, unknown>;     // Behavior settings (optional for backwards compat)
  aesthetics?: Record<string, unknown>;    // Aesthetic settings (optional for backwards compat)
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
}

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
}

export interface UpdateQueryTemplateRequest {
  name?: string;
  description?: string;
  query_type?: 'cypher' | 'sql';
  query?: string;
  parameters?: TemplateParameter[];
  options?: TemplateOptions;
}

export interface SubgraphRequest {
  edge_limit?: number;
  node_types?: string[];
  edge_types?: string[];
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
  edge_table_name: string;
  node_table_name: string;
  edge_structure?: EdgeStructure;
  node_structure?: NodeStructure;
  edge_properties?: PropertyColumn[];
  node_properties?: PropertyColumn[];
  node_types?: string[];
  relationship_types?: string[];
}

export interface ShareRequest {
  email: string;
  permission: "read" | "write";
}

export interface CreateExplorationRequest {
  title: string;
  state: ExplorationState;
}

export type VlpRenderingMode = 'cte' | 'procedural';
export type MaterializationStrategy = 'temp_tables' | 'numbered_views';

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
}

export interface CypherTranspileResponse {
  transpiled_sql: string;
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
  edge_table: string;
  node_table: string;
  columns?: ColumnConfig;
}

export interface SchemaDiscoveryResponse {
  node_types: string[];
  relationship_types: string[];
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
