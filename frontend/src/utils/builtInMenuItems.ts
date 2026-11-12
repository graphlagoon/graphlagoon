/**
 * The right-click items the app adds on its own (not the context's configurable
 * actions, which have their own on/off switch, nor cluster programs, which have
 * "show in context menu"). Behaviors → Context Menu lists these so a person can
 * hide the ones they never use; the hidden ids live in the `hiddenMenuActions`
 * behavior. An id missing here can still be hidden through that behavior.
 */
export const BUILT_IN_MENU_ITEMS: readonly { id: string; label: string }[] = [
  { id: 'copy-id', label: 'Copy ID' },
  { id: 'expand-neighbors', label: 'Expand neighbors' },
  { id: 'ego-layout-focus', label: 'Ego layout from here' },
  { id: 'view-community-table', label: 'View community members' },
  { id: 'isolate-community', label: 'Show only this community' },
  { id: 'isolate-cluster', label: 'Show only this cluster' },
  { id: 'clear-isolation', label: 'Show all nodes' },
  { id: 'add-selection-to-case', label: 'Add selection to case' },
  { id: 'sketch-add-linked-node', label: 'Add a linked node…' },
  { id: 'sketch-connect', label: 'Connect to the selected node…' },
  { id: 'sketch-remove', label: 'Remove from your data' },
  { id: 'delete-from-graph', label: 'Delete from graph' },
];
