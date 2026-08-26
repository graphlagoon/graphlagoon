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
   * labelFormatter template producing the URL. Must literally start with
   * http:// or https:// so a property value can never control the scheme.
   */
  urlTemplate: string;
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
}

export type ContextMenuActionConfig =
  | OpenUrlActionConfig
  | CopyTextActionConfig
  | RunQueryTemplateActionConfig;

export const CONTEXT_MENU_ACTION_KINDS = [
  'open-url',
  'copy-text',
  'run-query-template',
] as const;

/** Skip configs whose kind this build doesn't know (forward compatibility). */
export function isKnownActionKind(kind: string): boolean {
  return (CONTEXT_MENU_ACTION_KINDS as readonly string[]).includes(kind);
}
