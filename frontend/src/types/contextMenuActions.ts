/**
 * User-configurable context-menu actions.
 *
 * Stored per graph context in the `context_menu_actions` JSON column
 * (opaque to the backend — the frontend owns this shape). Each config
 * becomes a right-click menu entry whose visibility is filtered by the
 * clicked item's type and properties, and whose behavior is dispatched
 * on `kind`.
 */

export type MenuActionTarget = 'node' | 'edge' | 'both';

export type PropertyConditionOperator =
  | 'exists'
  | 'not-empty'
  | 'equals'
  | 'not-equals'
  | 'contains';

export interface PropertyCondition {
  /** Property name (raw table column) or built-in (node_id, node_type, edge_id, relationship_type, src, dst). */
  property: string;
  operator: PropertyConditionOperator;
  /** Comparison value — required for equals / not-equals / contains. */
  value?: string;
}

export interface MenuActionMatch {
  target: MenuActionTarget;
  /** Node types the action applies to. Empty/undefined = all node types. */
  nodeTypes?: string[];
  /** Relationship types the action applies to. Empty/undefined = all edge types. */
  relationshipTypes?: string[];
  /** All conditions must hold (AND). An unloaded/missing property fails its condition. */
  propertyConditions?: PropertyCondition[];
}

interface MenuActionBase {
  id: string;
  label: string;
  /** Emoji or short string rendered as the menu icon. */
  icon?: string;
  enabled: boolean;
  match: MenuActionMatch;
}

export interface OpenUrlActionConfig extends MenuActionBase {
  kind: 'open-url';
  /**
   * labelFormatter template producing the URL. Must literally start with its
   * scheme — http(s):// for a web page, or an app scheme (vscode://,
   * claude-cli://, …) — so a property value can never control the scheme.
   * In-browser schemes (javascript:, data:, file:, …) are rejected.
   */
  urlTemplate: string;
  /** Web links only — app links are always handed to the OS. */
  openIn: 'new-tab' | 'same-tab';
}

export interface CopyTextActionConfig extends MenuActionBase {
  kind: 'copy-text';
  /** labelFormatter template producing the copied text. */
  textTemplate: string;
}

export interface RunQueryTemplateActionConfig extends MenuActionBase {
  kind: 'run-query-template';
  /**
   * Query template UUID (stable across renames — template *names* are not
   * unique, which is why the `?template=` URL feature needs an ambiguity
   * error path this reference avoids).
   */
  templateId: string;
  /** Display/fallback only — never used for lookup. */
  templateName?: string;
  /**
   * paramId -> labelFormatter template resolved against the clicked item,
   * e.g. { gene: '{prop:gene_id}' }. Parameters without a binding fall back
   * to their declared default; if a required parameter still has no value
   * the execute modal opens pre-filled instead of running directly.
   */
  paramBindings: Record<string, string>;
  /**
   * `graph` (default, also when absent): the result replaces the graph.
   * `table`: the server runs the template for the clicked item and the rows
   * open in a modal; the graph stays. Table actions also run on a case canvas
   * and are tools for agents (MCP `list_entity_actions` / `run_entity_action`).
   */
  resultMode?: 'graph' | 'table';
}

export interface ShowSameValueActionConfig extends MenuActionBase {
  kind: 'show-same-value';
  /**
   * What to compare: a node property, `node_type`, or `metric:<ref>`. Read
   * with the label renderer's lookup (resolveItemValue), so a value shows the
   * same way in a label and in this filter.
   */
  field: string;
  /**
   * `same`: show only the nodes whose field equals the clicked node's.
   * `has`: show only the nodes where the field is set (not empty).
   */
  mode: 'same' | 'has';
}

/** A parameter of a canvas table: an editable input of the table modal. */
export interface CanvasTableParam {
  id: string;
  label: string;
  type?: 'input' | 'select';
  options?: string[];
  default?: string;
  required?: boolean;
  description?: string;
}

/**
 * Canvas neighbors, no code: walk `hops` steps from the clicked item over the
 * loaded graph and list the nodes reached, or the edges of those nodes.
 */
export interface NeighborhoodTableSource {
  type: 'neighborhood';
  /** Steps to walk (1..MAX_NEIGHBORHOOD_HOPS). Editable in the modal. */
  hops: number;
  /** Which way an edge may be walked. Editable in the modal. */
  direction: 'any' | 'out' | 'in';
  /** Edge types the walk may use. Empty = all. */
  edgeTypes?: string[];
  /** Node types listed (or whose edges are listed). The walk passes through every type. Empty = all. */
  nodeTypes?: string[];
  /** `nodes`: the nodes reached (not the clicked one). `edges`: the edges touching the listed nodes, the clicked one included. */
  list: 'nodes' | 'edges';
  /** Edge types listed when `list` is `edges`. Empty = all. */
  listEdgeTypes?: string[];
  /** Property names or `metric:<ref>`. Empty = every property found. */
  columns?: string[];
}

/**
 * A JavaScript program over the loaded graph, run in a sandboxed worker
 * (no network, no storage, hard timeout). It returns an array of objects or
 * `{ columns, rows }`. See utils/canvasTable.ts for its scope.
 */
export interface ProgramTableSource {
  type: 'program';
  code: string;
  params?: CanvasTableParam[];
}

export type CanvasTableSource = NeighborhoodTableSource | ProgramTableSource;

/**
 * Rows computed in the browser from the graph on the canvas: instant, works on
 * every node of a case canvas (files and derived ones included), and shows
 * what is loaded, not everything in the warehouse (that is a run-query-template
 * action with `resultMode: 'table'`).
 */
export interface ShowTableActionConfig extends MenuActionBase {
  kind: 'show-table';
  source: CanvasTableSource;
  /** paramId -> labelFormatter template resolved against the clicked item (program parameters). */
  paramBindings?: Record<string, string>;
}

/**
 * Rows about the clicked item from a table source of the context: a table provider the
 * deployment registered in Python (it may call an internal service or another database),
 * declared in the context's list of enrichments and data sources. Runs on the server like
 * a warehouse table: same window, same case canvas and agent tools.
 */
export interface RunTableProviderActionConfig extends MenuActionBase {
  kind: 'run-table-provider';
  /** The name of a table source of this context (an `enrichment_tables` entry with `table_provider`). */
  source: string;
  /** An action written before sources existed names the provider: the context's first source using it runs. */
  provider?: string;
  /** param name -> template resolved against the clicked item, e.g. { account: '{node_id}' }. Open parameters only. */
  paramBindings?: Record<string, string>;
  /** param name -> a value fixed by the action: whoever runs it cannot change it. Open parameters only. */
  params?: Record<string, string | number | boolean>;
}

export type ContextMenuActionConfig =
  | OpenUrlActionConfig
  | CopyTextActionConfig
  | RunQueryTemplateActionConfig
  | ShowSameValueActionConfig
  | ShowTableActionConfig
  | RunTableProviderActionConfig;

export const CONTEXT_MENU_ACTION_KINDS = [
  'open-url',
  'copy-text',
  'run-query-template',
  'show-same-value',
  'show-table',
  'run-table-provider',
] as const;

export const MAX_NEIGHBORHOOD_HOPS = 5;
/** Program code stored inline in the action. */
export const MAX_PROGRAM_CODE_LENGTH = 20_000;

/** Skip configs whose kind this build doesn't know (forward compatibility). */
export function isKnownActionKind(kind: string): boolean {
  return (CONTEXT_MENU_ACTION_KINDS as readonly string[]).includes(kind);
}

/** An action whose rows the server returns: a query template shown as a table, or a registered table provider. */
export function isTableAction(config: ContextMenuActionConfig): boolean {
  return config.kind === 'run-table-provider' || (config.kind === 'run-query-template' && config.resultMode === 'table');
}

/** Any action whose result is a table: from the warehouse or from the canvas. */
export function opensTable(config: ContextMenuActionConfig): boolean {
  return isTableAction(config) || config.kind === 'show-table';
}
