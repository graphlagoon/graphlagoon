/**
 * Portable (export/import) envelopes for style presets and context-menu actions.
 *
 * Both live per-context on the server; the envelope is how one travels to a
 * different context — or a different Graph Lagoon instance. Besides the
 * payload it carries the *schema of the graph it came from* (`source`), so
 * that the Ask-AI "adapt" prompt can tell an LLM what the old names were
 * when it renames types and properties for the current graph.
 *
 * The import parsers also accept the bare payload (a settings object, a full
 * server `StylePreset`, or an array of actions): an LLM's answer usually comes
 * without the envelope.
 */
import type { StylePresetSettings } from './graph';
import type { ContextMenuActionConfig } from './contextMenuActions';
import type { CustomMetricDefinition } from './customMetrics';

export const PORTABLE_EXPORT_VERSION = 1;

export interface PortableQueryTemplateRef {
  id: string;
  name: string;
  parameters: string[];
}

export interface PortableSourceSchema {
  context_title?: string;
  node_types: string[];
  relationship_types: string[];
  node_properties: string[];
  edge_properties: string[];
  /** Only meaningful for actions (`run-query-template` references ids). */
  query_templates?: PortableQueryTemplateRef[];
}

export interface PortableStylePreset {
  graphlagoon_export: 'style-preset';
  export_version: number;
  name?: string;
  description?: string | null;
  source: PortableSourceSchema;
  settings: StylePresetSettings;
}

export interface PortableContextMenuActions {
  graphlagoon_export: 'context-menu-actions';
  export_version: number;
  source: PortableSourceSchema;
  actions: ContextMenuActionConfig[];
}

export interface PortableCustomMetrics {
  graphlagoon_export: 'custom-metrics';
  export_version: number;
  source: PortableSourceSchema;
  metrics: CustomMetricDefinition[];
}
