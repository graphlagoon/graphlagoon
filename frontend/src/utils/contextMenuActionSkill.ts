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

import { bulletList, propertyList, metricList, type SkillProperty, type SkillMetric } from './clusterProgramSkill'
import { sourceSchemaSection } from './stylePresetSkill'
import type { PortableSourceSchema } from '@/types/portable'
import type { TableProviderInfo } from '@/types/graph'
import { paramLines } from './providerParams'

export type { SkillProperty, SkillMetric }

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
   * Table providers registered on this server (for run-table-provider actions):
   * every one, with what it returns and its parameters.
   */
  tableProviders?: TableProviderInfo[]
  /** Session-computed node metrics (available as `{metric:<name>}`) */
  nodeMetrics?: SkillMetric[]
  /** Session-computed edge metrics */
  edgeMetrics?: SkillMetric[]
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
  /**
   * Actions (JSON text) exported from ANOTHER graph, to adapt to this one.
   * Switches the prompt from "interview me and write actions" to "rewrite
   * these for the types, properties and templates listed below".
   */
  importedJson?: string
  /** Schema of the graph the imported actions came from, when the export recorded it. */
  importedSource?: PortableSourceSchema
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

/** Every registered table provider: what it returns, for what, with which parameters. */
export function tableProviderList(providers: TableProviderInfo[]): string {
  if (providers.length === 0) {
    return '  (no table providers registered on this server: do not write `run-table-provider` actions)'
  }
  return providers
    .map((p) => {
      const what = p.description ? ` — ${p.description}` : ' — (no description)'
      return `  - name: \`${p.name}\` — "${p.label}"${what}\n    Has a table for: ${p.targets.join(', ')}. Parameters:\n${paramLines(p.params, '      ')}`
    })
    .join('\n')
}

/** A run-table-provider example with a real registered name ('' when there is none). */
function tableProviderExample(providers: TableProviderInfo[]): string {
  const p = providers[0]
  if (!p) return ''
  const target = p.targets[0] ?? 'node'
  const first = p.params?.find((x) => x.type === 'str' && !x.choices?.length)
  const bindings = first ? { [first.name]: target === 'node' ? '{node_id}' : '{edge_id}' } : {}
  const action = {
    kind: 'run-table-provider',
    label: p.label,
    icon: '▦',
    enabled: true,
    match: { target },
    provider: p.name,
    paramBindings: bindings,
    params: {},
  }
  return `${JSON.stringify(action, null, 2).replace(/^/gm, '  ')},\n`
}

/**
 * Build the context-menu-action skill prompt from the current graph's
 * metadata. The output is plain text (Markdown) meant to be copied into an
 * LLM chat; the LLM's final answer is JSON for the editor's Import box.
 */
export function buildContextMenuActionSkill(input: ContextMenuActionSkillInput): string {
  const { nodeTypes, edgeTypes, nodeProperties, edgeProperties, queryTemplates } = input
  const tableProviders = input.tableProviders ?? []
  const nodeMetrics = input.nodeMetrics ?? []
  const edgeMetrics = input.edgeMetrics ?? []
  const graphViewUrl = input.graphViewUrl || 'https://YOUR_APP_HOST/graph/YOUR_CONTEXT_ID'
  const explorationParam = `exploration=${input.explorationId || 'YOUR_EXPLORATION_ID'}`
  const adapting = !!input.importedJson?.trim()

  const task = adapting
    ? `# Task: adapt "context-menu actions" from another graph to this one`
    : `# Task: write "context-menu actions" for a graph visualization tool`

  const intro = adapting
    ? `You are helping me reuse **right-click menu actions** of Graph Lagoon Studio
that were exported from a **different graph**. Its type names, property names
and query-template ids do not match this graph. Your job is to produce the
same actions, **rewritten for the types, properties and templates listed
under "This graph's metadata"**. Your final answer will be a **JSON array**
that I paste into the tool's Actions editor ("Import JSON" box).`
    : `You are helping me configure **right-click menu actions** for Graph Lagoon
Studio. When I right-click a node or an edge of a 3D graph, a context menu
opens; each action you write becomes an entry in that menu. Your final answer
will be a **JSON array** that I paste into the tool's Actions editor
("Import JSON" box).

I don't know exactly what I want yet, so **start by asking me questions** (see
the "How to help me" section at the end) before writing any JSON.`

  const adaptSection = adapting
    ? `
## The actions to adapt

${sourceSchemaSection(input.importedSource)}

Here are the exported actions:

\`\`\`json
${input.importedJson!.trim()}
\`\`\`

Rules for adapting them:
- Rewrite \`match.nodeTypes\` / \`match.relationshipTypes\` to the **equivalent
  types in this graph**. Drop an action whose types have no equivalent here
  and tell me which ones you dropped.
- Rewrite every \`{prop:<name>}\` in \`urlTemplate\`, \`textTemplate\` and
  \`paramBindings\`, and every \`propertyConditions[].property\`, to the
  **equivalent property in this graph**. Built-ins (\`{node_id}\`, \`{src}\`...)
  stay as they are.
- \`run-query-template\` actions: the old \`templateId\`s are **not valid
  here**. Pick a template from this graph's list with the same purpose and
  re-bind its parameters; if none fits, turn the action into an \`open-url\`
  or \`copy-text\` when that makes sense, otherwise drop it and tell me.
- Keep labels, icons, \`openIn\` and URL hosts as they are unless a rename
  makes the label wrong. Never change a URL's scheme (\`https://\`,
  \`vscode://\`, …) — it picks which app the link opens.
- Do not wrap the answer in an export envelope — output the JSON array only.
`
    : ''

  const howToHelp = adapting
    ? `## How to help me

First, **show me the mapping you intend to use** (old type → new type, old
property → new property, old template → new template) as a short table and
ask me to confirm or correct anything ambiguous — one question at a time when
the choice is not obvious from the names. Only **then** output the final JSON
array (no prose around it) so I can paste it into the Import JSON box.`
    : `## How to help me

I don't know exactly which actions I want yet.
**Do NOT write JSON immediately.** First, **ask me questions, one topic at a
time**, referencing the actual types, properties and templates above:

- Which node types do I interact with most, and what would I want one click
  away for them? (an external system? a search? an internal template?)
- Do any properties hold ids/codes of external systems (ticket ids, DOIs,
  tax ids, SKUs) that map to a URL pattern? What is the exact URL pattern?
- Should links open in a new tab (keep the graph) or the current tab?
- Is there text I repeatedly copy out of the graph (ids, emails, composite
  strings)?
- Which saved query templates would be useful to trigger from a node or edge,
  and which property fills each parameter?${
    tableProviders.length
      ? `\n- Would any of the table providers listed above answer a question I ask about a\n  node or edge (read their descriptions)? Which property is the id they need?`
      : ''
  }
- Should an action apply to all types or only when a property is present /
  has a specific value?

Ask follow-ups until you're confident, **then** output ONLY the final JSON
array (no prose around it) so I can paste it into the Import JSON box.`

  return `${task}

${intro}
${adaptSection}

## What an action can do (the six kinds)

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
   By default the result replaces the graph. With \`"resultMode": "table"\`
   the rows open in a window instead and the graph stays: use it for
   one-to-many data about the clicked item, e.g. "the transactions of the
   accounts linked to this company in the last $days days" (the template joins
   the edge table to reach neighbors 1 or 2 hops away; filters are template
   parameters the user can edit in the window). Table actions also work on a
   case canvas and agents can run them.
4. \`show-same-value\` — nodes only: hide every node except those whose
   \`field\` (a node property, \`node_type\`, or \`metric:<name>\`) equals the
   clicked node's (\`"mode": "same"\`) or is set at all (\`"mode": "has"\`).
   Example: right-click an account shows only the accounts of the same
   \`branch_id\`. The layout stays; the status bar's ✕ shows everything again.
5. \`show-table\` — a table computed **in the browser from the graph on the
   canvas** (instant, no warehouse; on a case canvas it includes file and
   derived nodes). Prefer it over a table template when the answer is in what
   is loaded. Two sources:
   - \`{"type": "neighborhood", "hops": 1-5, "direction": "any"|"out"|"in",
     "edgeTypes": [walk over these], "nodeTypes": [list these],
     "list": "nodes"|"edges", "listEdgeTypes": [...], "columns": [props or
     "metric:<name>"]}\` — no code. \`list: "edges"\` lists the edges touching
     the listed nodes (e.g. the TRANSFER edges of the accounts 2 hops from a
     company). Hops and direction are editable in the window.
   - \`{"type": "program", "code": "...", "params": [{"id", "label",
     "default", "required", "type": "input"|"select", "options"}]}\` —
     JavaScript run in a sandboxed worker (no network, 10 s). In scope:
     \`item\` (clicked node/edge), \`params\`, \`nodes\`, \`edges\`,
     \`node(id)\`, \`neighbors(id, {direction, edgeTypes, nodeTypes})\`,
     \`hops(id, k, opts)\` (nodes with \`.hop\`), \`edgesOf(ids, {types,
     direction})\`, \`metric(ref, id)\`, \`selectedNodeIds\`. Return an array
     of objects or \`{columns, rows}\`. \`paramBindings\` fills params from
     the clicked item. Agents can run neighborhood tables, not programs.
6. \`run-table-provider\` — rows about the clicked item from **a table
   provider this server registered in code** (for example a call to an
   internal service or another database: data that is neither on the canvas
   nor reachable by a query template). It runs on the server and opens the
   same table window; it also works on a case canvas and agents can run it.
   \`provider\` is one of the names under "Table providers on this server"
   below — **use only those names, never invent one**, and read each
   description to decide when it fits. Each of its parameters gets its value
   from one of: \`paramBindings\` (name → template filled from the clicked
   item, e.g. \`{"account": "{node_id}"}\`; the provider receives only its
   parameters, so pass the item's id or properties this way), \`params\`
   (name → a value fixed by the action, which the person running it cannot
   change; it must respect the parameter's type, bounds and options), or
   neither (the declared default applies and the person may edit it in the
   window; a required one with no default is asked there).

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
    "kind": "run-query-template",
    "label": "Transactions of the linked accounts",
    "enabled": true,
    "match": { "target": "node", "nodeTypes": ["Company"] },
    "templateId": "<uuid from the template list below>",
    "templateName": "Company accounts transactions",
    "paramBindings": { "company": "{node_id}" },
    "resultMode": "table"
  },
  {
    "kind": "show-table",
    "label": "Transfers of the accounts within 2 hops",
    "enabled": true,
    "match": { "target": "node", "nodeTypes": ["Company"] },
    "source": {
      "type": "neighborhood", "hops": 2, "direction": "any",
      "nodeTypes": ["Account"], "list": "edges", "listEdgeTypes": ["TRANSFER"],
      "columns": ["amount", "date"]
    }
  },
  {
    "kind": "show-table",
    "label": "Big transfers nearby",
    "enabled": true,
    "match": { "target": "node" },
    "source": {
      "type": "program",
      "params": [{ "id": "min_amount", "label": "Min amount", "default": "1000" }],
      "code": "const ids = hops(item.node_id, 2).map(n => n.node_id);\\nreturn edgesOf(ids, { types: ['TRANSFER'] })\\n  .filter(e => Number(e.properties?.amount) >= Number(params.min_amount))\\n  .map(e => ({ src: e.src, dst: e.dst, amount: e.properties?.amount }));"
    }
  },
${tableProviderExample(tableProviders)}  {
    "kind": "show-same-value",
    "label": "Show only this branch",
    "enabled": true,
    "match": { "target": "node", "nodeTypes": ["Account"] },
    "field": "branch_id",
    "mode": "same"
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
  entry hides when the value is missing. \`property\` may also be a
  session-computed metric written as \`"metric:<name>"\` (e.g.
  \`{ "property": "metric:PageRank", "operator": "not-empty" }\`) — the action
  then stays hidden until that metric is computed in the session.
- \`urlTemplate\` MUST literally start with its scheme — never a placeholder:
  - \`https://\` (or \`http://\`) for a web page, opened per \`openIn\`;
  - any **app scheme** to open a desktop app on the clicking user's machine,
    e.g. \`vscode://file/<absolute-root>/{prop:path}:{prop:line}\` (VS Code),
    \`claude-cli://open?repo=<owner>/<repo>&q=<url-encoded prompt>\` (Claude
    Code in a terminal), \`vscode://anthropic.claude-code/open?prompt=...\`
    (Claude Code in VS Code), \`cursor://\`, \`obsidian://\`, \`slack://\`,
    \`mailto:\`. App links ignore \`openIn\` (the browser asks before
    launching the app). Only use a scheme I confirm my team's machines have.
  - \`javascript:\`, \`data:\`, \`file:\`, \`blob:\` and \`about:\` are rejected.
  Interpolated values are URL-encoded automatically; just write \`{prop:x}\`
  where the value goes. Literal text you write yourself (e.g. a prompt in
  \`q=\`) must already be URL-encoded (\`%20\` for spaces).
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
- \`{metric:<name>}\` — a session-computed metric of the clicked item (see
  "metrics" in the metadata below). Metrics only exist after the user computes
  them in the Metrics panel: a URL build aborts with a "missing" message when
  the metric is absent (values are URL-encoded like properties), and
  \`copy-text\` shows a \`[metric:<name>]\` placeholder. Pair a metric ref with
  a \`{ "property": "metric:<name>", "operator": "not-empty" }\` condition.
  Prefer a property when an equivalent column exists.
- Modifiers chain with \`|\` inside the braces: \`{prop:name|upper}\`,
  \`{prop:title|truncate:30:...}\`, \`{prop:code|split:_:0}\`,
  \`{prop:email|match:/@(.+)$/:1}\`. Prefer plain \`{prop:x}\` inside URLs
  (values are encoded before modifiers run).
- Conditionals: \`{if:prop:x>10|High|Low}\` or \`{if:metric:PageRank>0.5|hub|leaf}\`
  — useful in \`copy-text\`.

## This graph's metadata (use these real values)

**Node types (${nodeTypes.length}):**
${bulletList(nodeTypes, 'no nodes loaded yet')}

**Edge / relationship types (${edgeTypes.length}):**
${bulletList(edgeTypes, 'no edges loaded yet')}

**Node properties (available as \`{prop:<name>}\` on nodes):**
${propertyList(nodeProperties, 'none declared')}

**Edge properties (available as \`{prop:<name>}\` on edges):**
${propertyList(edgeProperties, 'none declared')}

**Node metrics (session-computed, available as \`{metric:<name>}\` on nodes):**
${metricList(nodeMetrics, 'none computed in this session')}

**Edge metrics (session-computed, available as \`{metric:<name>}\` on edges):**
${metricList(edgeMetrics, 'none computed in this session')}

**Query templates in this context (for \`run-query-template\`):**
${templateList(queryTemplates)}

**Table providers on this server (for \`run-table-provider\`; this is the complete list):**
${tableProviderList(tableProviders)}

${howToHelp}
`
}
