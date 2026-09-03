/**
 * Style Preset Skill Builder
 *
 * Generates a self-contained, copy-pasteable prompt ("skill") that a user can
 * paste into an LLM (Gemini, ChatGPT, Claude, ...) to get help with a style
 * preset — the Style panel's contents (colors and icons per type, label
 * templates, layout, metric-driven sizing) saved as JSON.
 *
 * Two modes, one builder:
 *   - no `importedJson`: help me write a preset for THIS graph from scratch;
 *   - with `importedJson`: here is a preset exported from a DIFFERENT graph
 *     (with its schema in `importedSource` when the export carried it) —
 *     adapt it to this graph's types and property names.
 *
 * Mirrors `contextMenuActionSkill.ts` / `labelTemplateSkill.ts` in shape and
 * tone. Pure function — no store access — so it is easy to test.
 */

import { bulletList, propertyList, type SkillProperty } from './clusterProgramSkill'
import type { PortableSourceSchema } from '@/types/portable'

export type { SkillProperty }

export interface StylePresetSkillInput {
  /** Node types present in the current graph (e.g. ['Person', 'Company']) */
  nodeTypes: string[]
  /** Edge/relationship types present in the current graph */
  edgeTypes: string[]
  /** Node property columns from the current context */
  nodeProperties: SkillProperty[]
  /** Edge property columns from the current context */
  edgeProperties: SkillProperty[]
  /** Layout algorithms the tool accepts in `layout_algorithm`. */
  layoutAlgorithms: string[]
  /** A preset (JSON text) exported from another graph, to adapt. */
  importedJson?: string
  /** Schema of the graph the imported preset came from, when known. */
  importedSource?: PortableSourceSchema
  /**
   * Custom metrics defined on this context (writer view). Only the numeric
   * ones can drive `visual_mapping`; the others are listed so the LLM does
   * not invent them.
   */
  customMetrics?: { id: string; name: string; target: 'node' | 'edge'; valueType: 'number' | 'string' | 'boolean' }[]
}

/** Render the metric ids a preset may reference in `visual_mapping`. */
export function metricIdsSection(customMetrics: StylePresetSkillInput['customMetrics']): string {
  const numeric = (customMetrics ?? []).filter((m) => m.valueType === 'number')
  const lines = numeric.map(
    (m) => `- \`custom:${m.id}\` — "${m.name}" (${m.target === 'node' ? 'node size' : 'edge weight'})`,
  )
  const custom = lines.length > 0 ? `\n${lines.join('\n')}` : ' (none on this context)'
  return `- \`__builtin_degree\` — the built-in node degree (always available)
- custom numeric metrics of this context:${custom}
- \`null\` — no metric.
Algorithm runs (PageRank, betweenness…) get a new session-only id on every
run, so a preset cannot reference them reliably. Text/boolean custom metrics
cannot size anything.`
}

/** Render the origin schema block of an adapt prompt. */
export function sourceSchemaSection(source: PortableSourceSchema | undefined): string {
  if (!source) {
    return `The export did not record the schema of the graph it came from — infer the
old type and property names from the JSON itself.`
  }
  const title = source.context_title ? ` ("${source.context_title}")` : ''
  const templates =
    source.query_templates && source.query_templates.length > 0
      ? `\n\n**Query templates there (ids are NOT valid here):**\n${source.query_templates
          .map((t) => `  - id: \`${t.id}\` — "${t.name}" — parameters: ${t.parameters.join(', ') || 'none'}`)
          .join('\n')}`
      : ''
  return `The graph it came from${title} had:

**Node types:**
${bulletList(source.node_types, 'none recorded')}

**Edge / relationship types:**
${bulletList(source.relationship_types, 'none recorded')}

**Node properties:**
${bulletList(source.node_properties, 'none recorded')}

**Edge properties:**
${bulletList(source.edge_properties, 'none recorded')}${templates}`
}

/**
 * Build the style-preset skill prompt from the current graph's metadata. The
 * output is plain text (Markdown) meant to be copied into an LLM chat; the
 * LLM's final answer is a JSON object for the Presets modal's Import box.
 */
export function buildStylePresetSkill(input: StylePresetSkillInput): string {
  const { nodeTypes, edgeTypes, nodeProperties, edgeProperties, layoutAlgorithms } = input
  const adapting = !!input.importedJson?.trim()

  const task = adapting
    ? `# Task: adapt a "style preset" from another graph to this one`
    : `# Task: write a "style preset" for a graph visualization tool`

  const intro = adapting
    ? `You are helping me reuse a **style preset** of Graph Lagoon Studio — colors
and icons per node/edge type, label templates, layout and sizing — that was
exported from a **different graph**. Its type names and property names do not
match this graph. Your job is to produce the same look, **rewritten for the
types and properties listed under "This graph's metadata"**. Your final answer
will be a **JSON object** that I paste into the Presets modal ("Import JSON"
box).`
    : `You are helping me write a **style preset** for Graph Lagoon Studio — the
colors and icons per node/edge type, label templates, layout and sizing the
Style panel controls, saved as JSON. Your final answer will be a **JSON
object** that I paste into the Presets modal ("Import JSON" box).

I don't know exactly what I want yet, so **start by asking me questions** (see
the "How to help me" section at the end) before writing any JSON.`

  const adaptSection = adapting
    ? `
## The preset to adapt

${sourceSchemaSection(input.importedSource)}

Here is the exported preset:

\`\`\`json
${input.importedJson!.trim()}
\`\`\`

Rules for adapting it:
- Rename every key of \`nodeTypeColors\`, \`nodeTypeIcons\`, \`edgeTypeColors\`,
  \`edgeTypeIcons\` and \`nodePropertyIconConfigs\`, and every entry of a label
  rule's \`types\`, to the **equivalent type in this graph** (e.g. \`Person\` →
  \`Customer\`). Drop entries whose type has no equivalent here; you may add
  entries for this graph's types that had no counterpart, keeping the palette
  consistent.
- Rewrite every \`{prop:<name>}\` in label templates and every
  \`nodePropertyIconConfigs[type].property\` to the **equivalent property in this
  graph**. If none exists, pick a sensible fallback from the list (an id or
  name column) rather than leaving a property this graph does not have.
- Keep everything that does not name a type or property (aesthetics, layout,
  behaviors, force settings, visual_mapping) exactly as it is, unless I ask
  otherwise.
- Do not add keys the shape below does not list, and do not wrap the answer in
  an export envelope — output the settings object only.
`
    : ''

  const howToHelp = adapting
    ? `## How to help me

First, **show me the mapping you intend to use** (old type → new type, old
property → new property) as a short table and ask me to confirm or correct
anything ambiguous — one question at a time when the choice is not obvious
from the names. Only **then** output the final JSON object (no prose around
it) so I can paste it into the Import JSON box.`
    : `## How to help me

I don't know exactly which look I want yet.
**Do NOT write JSON immediately.** First, **ask me questions, one topic at a
time**, referencing the actual types and properties above:

- Which node types matter most, and should they stand out by color, icon or size?
- Is there a natural color scheme (by domain: people vs. companies, risk levels,
  status values)?
- What should a node's label say? An edge's label? Any type needing its own
  rule?
- Should layout be force, ego (around a focus), hive, hierarchical, circular or
  grid?
- Should node size follow a computed metric (degree, pagerank...)?
- Which properties should the detail panel show, and which should it hide?

Ask follow-ups until you're confident, **then** output ONLY the final JSON
object (no prose around it) so I can paste it into the Import JSON box.`

  return `${task}

${intro}
${adaptSection}
## The JSON shape (your final output)

A preset is a single JSON object. Every key is optional — a missing key means
"reset that part to the tool's default":

\`\`\`json
{
  "aesthetics": {
    "showArrows": true, "arrowSize": 1.0,
    "nodeOpacity": 1.0, "edgeOpacity": 0.6,
    "nodeSize": 8, "edgeWidth": 1,
    "enableMultiEdgeCurvature": true,
    "showNodeLabels3D": true, "showEdgeLabels3D": true,
    "nodeLabelSize3D": 10, "edgeLabelSize3D": 5,
    "nodeLabelPosition3D": "right",
    "hideEmptyValues": true
  },
  "nodeTypeColors": { "Person": "#4f8cff", "Company": "#ff9f43" },
  "edgeTypeColors": { "WORKS_AT": "#9aa0a6" },
  "nodeTypeIcons": { "Person": "user", "Company": "building" },
  "edgeTypeIcons": { "WORKS_AT": "briefcase" },
  "nodePropertyIconConfigs": {
    "Person": {
      "property": "status",
      "valueIcons": { "active": "check-circle", "blocked": "ban" },
      "fallbackIcon": "user"
    }
  },
  "textFormat": {
    "defaults": { "nodeTemplate": "{prop:name}", "edgeTemplate": "{relationship_type}" },
    "rules": [
      {
        "id": "rule-1", "name": "Company label", "target": "node",
        "types": ["Company"], "template": "{prop:name|upper} ({prop:country})",
        "priority": 10, "enabled": true, "scope": "context"
      }
    ]
  },
  "layout_algorithm": "force",
  "visual_mapping": {
    "nodeSize": { "metricId": "__builtin_degree", "minSize": 4, "maxSize": 20, "scale": "linear" },
    "edgeWeight": { "metricId": null, "minWeight": 1, "maxWeight": 4, "scale": "linear" },
    "enableRealTimeUpdates": true
  },
  "property_visibility": { "nodeProperties": ["name", "email"], "edgeProperties": null }
}
\`\`\`

Field rules:
- Type-keyed maps (\`nodeTypeColors\`, \`nodeTypeIcons\`, \`edgeTypeColors\`,
  \`edgeTypeIcons\`, \`nodePropertyIconConfigs\`) use the **exact type names**
  listed below as keys. Colors are hex strings. Icons are lucide icon names in
  kebab-case (\`user\`, \`building\`, \`shield-alert\`, \`git-branch\`...).
- \`textFormat\` templates use \`{prop:<column>}\` for a raw column, node
  built-ins \`{node_id}\`, \`{node_type}\`, edge built-ins \`{edge_id}\`,
  \`{relationship_type}\`, \`{src}\`, \`{dst}\`; modifiers chain with \`|\`
  (\`{prop:name|upper}\`, \`{prop:title|truncate:30:...}\`) and conditionals
  look like \`{if:prop:x>10|High|Low}\`. A rule's \`types\` empty means "all
  types". \`scope\` is always \`"context"\`.
- \`layout_algorithm\` must be one of: ${layoutAlgorithms.map((l) => `\`${l}\``).join(', ')}.
- \`visual_mapping.nodeSize.metricId\` / \`edgeWeight.metricId\` must be one of:
${metricIdsSection(input.customMetrics)}
  \`scale\` is \`"linear"\`, \`"log"\` or \`"sqrt"\`.
- \`property_visibility\`: \`null\` shows every property, \`[]\` hides all,
  otherwise an allowlist of column names.
- \`aesthetics.hideEmptyValues\`: \`true\` (the default) omits properties and
  metrics with no value from the details modal and the side panel. Set it to
  \`false\` only when the user wants to see every field, empty ones included.
- Keys you don't want to change may be omitted entirely.

## This graph's metadata (use these real values)

**Node types (${nodeTypes.length}):**
${bulletList(nodeTypes, 'no nodes loaded yet')}

**Edge / relationship types (${edgeTypes.length}):**
${bulletList(edgeTypes, 'no edges loaded yet')}

**Node properties (available as \`{prop:<name>}\` on nodes):**
${propertyList(nodeProperties, 'none declared')}

**Edge properties (available as \`{prop:<name>}\` on edges):**
${propertyList(edgeProperties, 'none declared')}

${howToHelp}
`
}
