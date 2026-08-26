/**
 * Context-Menu Action Skill Builder
 *
 * Generates a self-contained, copy-pasteable prompt ("skill") that a user can
 * paste into an LLM (Gemini, ChatGPT, Claude, ...) to get help writing
 * configurable right-click menu actions. The prompt embeds the current
 * graph's metadata (node/edge types, properties, query templates) plus the
 * exact JSON shape the Actions editor imports, so the LLM's answer can be
 * pasted straight into the editor's "Import JSON" box.
 *
 * Mirrors `clusterProgramSkill.ts` / `labelTemplateSkill.ts` in shape and
 * tone. Pure function — no store access — so it is easy to test.
 */

import { bulletList, propertyList, type SkillProperty } from './clusterProgramSkill'

export type { SkillProperty }

export interface SkillTemplateParameter {
  id: string
  label: string
  required: boolean
}

export interface SkillQueryTemplate {
  id: string
  name: string
  description?: string
  parameters: SkillTemplateParameter[]
}

export interface ContextMenuActionSkillInput {
  /** Node types present in the current graph (e.g. ['Person', 'Company']) */
  nodeTypes: string[]
  /** Edge/relationship types present in the current graph */
  edgeTypes: string[]
  /** Node property columns from the current context */
  nodeProperties: SkillProperty[]
  /** Edge property columns from the current context */
  edgeProperties: SkillProperty[]
  /** Query templates available in this context (for run-query-template actions) */
  queryTemplates: SkillQueryTemplate[]
  /**
   * Absolute URL of the current graph view (e.g. https://host/graph/<ctx-id>),
   * used in the deep-link example (`?layout=ego&...`). Optional — falls back
   * to a placeholder the LLM is told to keep as-is.
   */
  graphViewUrl?: string
  /**
   * Id of the exploration currently open, if any. A deep link must LOAD a
   * graph before layout params mean anything (a bare graph URL opens empty),
   * so the ego example anchors on `?exploration=<id>` — the real one when
   * available, a placeholder otherwise.
   */
  explorationId?: string
}

function templateList(templates: SkillQueryTemplate[]): string {
  if (templates.length === 0) return '  (no query templates in this context)'
  return templates
    .map((t) => {
      const params =
        t.parameters.length === 0
          ? 'no parameters'
          : t.parameters
              .map((p) => `${p.id}${p.required ? ' (required)' : ''}`)
              .join(', ')
      const desc = t.description ? ` — ${t.description}` : ''
      return `  - id: \`${t.id}\` — "${t.name}"${desc} — parameters: ${params}`
    })
    .join('\n')
}

/**
 * Build the context-menu-action skill prompt from the current graph's
 * metadata. The output is plain text (Markdown) meant to be copied into an
 * LLM chat; the LLM's final answer is JSON for the editor's Import box.
 */
export function buildContextMenuActionSkill(input: ContextMenuActionSkillInput): string {
  const { nodeTypes, edgeTypes, nodeProperties, edgeProperties, queryTemplates } = input
  const graphViewUrl = input.graphViewUrl || 'https://YOUR_APP_HOST/graph/YOUR_CONTEXT_ID'
  const explorationParam = `exploration=${input.explorationId || 'YOUR_EXPLORATION_ID'}`

  return `# Task: write "context-menu actions" for a graph visualization tool

You are helping me configure **right-click menu actions** for Graph Lagoon
Studio. When I right-click a node or an edge of a 3D graph, a context menu
opens; each action you write becomes an entry in that menu. Your final answer
will be a **JSON array** that I paste into the tool's Actions editor
("Import JSON" box).

I don't know exactly what I want yet, so **start by asking me questions** (see
the "How to help me" section at the end) before writing any JSON.

## What an action can do (the three kinds)

1. \`open-url\` — build a URL from the clicked item's properties and open it in
   a new tab or the current tab. Example: open a PubMed search for a gene node.
   The URL can also **deep-link back into this tool itself** — the graph view
   accepts layout parameters like \`?layout=ego&layout.ego.focusNodeId=<id>\`,
   so an action can e.g. re-open the graph with an ego layout centred on the
   clicked node (see the last example below). Important: layout params only
   style whatever the link LOADS — a bare graph URL opens empty, so an in-tool
   deep link must also carry one of \`?exploration=<id>\` (a saved
   exploration), \`?precomputed=<name>&<args>\` (a precomputed graph — an arg
   like a seed can itself be \`{node_id}\`), or \`?template=<name>&
   template.<param>=...\` (auto-run a query template).
2. \`copy-text\` — copy templated text built from the clicked item to the
   clipboard. Example: copy \`{prop:name} <{prop:email}>\`.
3. \`run-query-template\` — run one of this context's saved query templates,
   with the clicked item's properties bound to the template's parameters.
   Example: right-click a Person node runs a "neighbors of $person" template.

## The JSON shape (your final output)

Output a JSON array of action objects:

\`\`\`json
[
  {
    "kind": "open-url",
    "label": "Search on PubMed",
    "icon": "🔎",
    "enabled": true,
    "match": {
      "target": "node",
      "nodeTypes": ["Gene"],
      "propertyConditions": [
        { "property": "symbol", "operator": "not-empty" }
      ]
    },
    "urlTemplate": "https://pubmed.ncbi.nlm.nih.gov/?term={prop:symbol}",
    "openIn": "new-tab"
  },
  {
    "kind": "copy-text",
    "label": "Copy contact",
    "enabled": true,
    "match": { "target": "node", "nodeTypes": ["Person"] },
    "textTemplate": "{prop:name} <{prop:email}>"
  },
  {
    "kind": "run-query-template",
    "label": "Expand transactions",
    "enabled": true,
    "match": { "target": "node", "nodeTypes": ["Account"] },
    "templateId": "<uuid from the template list below>",
    "templateName": "Account transactions",
    "paramBindings": { "account": "{prop:account_id}" }
  },
  {
    "kind": "open-url",
    "label": "Ego layout from here",
    "icon": "🎯",
    "enabled": true,
    "match": { "target": "node" },
    "urlTemplate": "${graphViewUrl}?${explorationParam}&layout=ego&layout.ego.focusNodeId={node_id}",
    "openIn": "same-tab"
  }
]
\`\`\`

The last example deep-links into this tool: it loads the saved exploration and
draws it with the **ego layout centred on the clicked node** (\`{node_id}\`
fills the \`layout.ego.focusNodeId\` URL parameter). The \`exploration=\` part
is what loads the graph — without it (or a \`precomputed=\`/\`template=\`
equivalent) the link opens an empty view. Use \`"openIn": "same-tab"\` for
in-tool navigation like this, and keep the URL prefix exactly as given above.

Field rules:
- \`label\`: short menu text (2-4 words). \`icon\`: optional, a single emoji.
- \`match.target\`: \`"node"\`, \`"edge"\` or \`"both"\`.
- \`match.nodeTypes\` / \`match.relationshipTypes\`: which types the action
  applies to. **Omit or use \`[]\` to mean "all types"**. Use \`nodeTypes\` for
  node targets and \`relationshipTypes\` for edge targets.
- \`match.propertyConditions\`: optional AND-ed conditions. Each is
  \`{ "property": <name>, "operator": <op>, "value": <string, when needed> }\`
  with operators \`exists\`, \`not-empty\`, \`equals\`, \`not-equals\`,
  \`contains\`. An action that interpolates \`{prop:x}\` into a URL should
  usually also require \`{ "property": "x", "operator": "not-empty" }\` so the
  entry hides when the value is missing.
- \`urlTemplate\` MUST literally start with \`http://\` or \`https://\` — the
  tool rejects anything else. Interpolated values are URL-encoded
  automatically; just write \`{prop:x}\` where the value goes.
- \`paramBindings\` maps a template's parameter id to a template string built
  from the clicked item (usually just \`{prop:<column>}\`). Required
  parameters left unbound make the tool open its parameter form pre-filled
  instead of running directly — that's fine when the user should confirm.
- Do not invent \`templateId\`s — only use ids from the list below. If no
  template fits, don't produce a \`run-query-template\` action.

## Template placeholders (used in urlTemplate, textTemplate and bindings)

- \`{prop:<column>}\` — any raw table column of the clicked node/edge, e.g.
  \`{prop:name}\`. A missing value makes the action refuse to run (and with a
  \`not-empty\` condition, hide instead).
- Node built-ins: \`{node_id}\`, \`{node_type}\`.
- Edge built-ins: \`{edge_id}\`, \`{relationship_type}\`, \`{src}\`, \`{dst}\`.
- Modifiers chain with \`|\` inside the braces: \`{prop:name|upper}\`,
  \`{prop:title|truncate:30:...}\`, \`{prop:code|split:_:0}\`,
  \`{prop:email|match:/@(.+)$/:1}\`. Prefer plain \`{prop:x}\` inside URLs
  (values are encoded before modifiers run).
- Conditionals: \`{if:prop:x>10|High|Low}\` — useful in \`copy-text\`.

## This graph's metadata (use these real values)

**Node types (${nodeTypes.length}):**
${bulletList(nodeTypes, 'no nodes loaded yet')}

**Edge / relationship types (${edgeTypes.length}):**
${bulletList(edgeTypes, 'no edges loaded yet')}

**Node properties (available as \`{prop:<name>}\` on nodes):**
${propertyList(nodeProperties, 'none declared')}

**Edge properties (available as \`{prop:<name>}\` on edges):**
${propertyList(edgeProperties, 'none declared')}

**Query templates in this context (for \`run-query-template\`):**
${templateList(queryTemplates)}

## How to help me

I don't know exactly which actions I want yet.
**Do NOT write JSON immediately.** First, **ask me questions, one topic at a
time**, referencing the actual types, properties and templates above:

- Which node types do I interact with most, and what would I want one click
  away for them? (an external system? a search? an internal template?)
- Do any properties hold ids/codes of external systems (ticket ids, DOIs,
  CNPJs, SKUs) that map to a URL pattern? What is the exact URL pattern?
- Should links open in a new tab (keep the graph) or the current tab?
- Is there text I repeatedly copy out of the graph (ids, emails, composite
  strings)?
- Which saved query templates would be useful to trigger from a node or edge,
  and which property fills each parameter?
- Should an action apply to all types or only when a property is present /
  has a specific value?

Ask follow-ups until you're confident, **then** output ONLY the final JSON
array (no prose around it) so I can paste it into the Import JSON box.
`
}
