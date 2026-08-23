/**
 * Label Template Skill Builder
 *
 * Generates a self-contained, copy-pasteable prompt ("skill") that a user can
 * paste into an LLM (Gemini, ChatGPT, Claude, ...) to get help writing label
 * templates for the Labels panel. The prompt embeds the current graph's
 * metadata (node/edge types and their properties) plus the full template
 * mini-language — placeholders, modifiers, date formats, conditionals — and
 * the rule shape the Labels panel expects.
 *
 * Mirrors `clusterProgramSkill.ts` in shape and tone so both "Ask AI" helpers
 * behave the same way. Pure function — no store access — so it is easy to test.
 */

import { bulletList, propertyList, type SkillProperty } from './clusterProgramSkill'

export type { SkillProperty }

export interface LabelTemplateSkillInput {
  /** Node types present in the current graph (e.g. ['Person', 'Company']) */
  nodeTypes: string[]
  /** Edge/relationship types present in the current graph */
  edgeTypes: string[]
  /** Node property columns from the current context */
  nodeProperties: SkillProperty[]
  /** Edge property columns from the current context */
  edgeProperties: SkillProperty[]
}

/**
 * Build the label-template skill prompt from the current graph's metadata.
 * The output is plain text (Markdown) meant to be copied into an LLM chat.
 */
export function buildLabelTemplateSkill(input: LabelTemplateSkillInput): string {
  const { nodeTypes, edgeTypes, nodeProperties, edgeProperties } = input

  return `# Task: write "label templates" for a graph visualization tool

You are helping me write **label templates** for Graph Lagoon Studio. A label
template is a short string with \`{...}\` placeholders that decides the text drawn
on each node and each edge of a 3D graph. I will type your templates into the
tool's Labels panel.

I don't know exactly what I want yet, so **start by asking me questions** (see the
"How to help me" section at the end) before writing any template.

## Where a template goes

There are two places a template can live:

1. **Default templates** — one for nodes, one for edges. Used for anything not
   covered by a rule. Defaults are \`{node_id}\` for nodes and
   \`{relationship_type}\` for edges.
2. **Rules** — a rule overrides the default for specific types. A rule has:

\`\`\`js
{
  name: string,               // human-readable, e.g. "Person labels"
  target: 'node' | 'edge',    // what it applies to
  types: string[],            // which node/edge types (EMPTY = all types of that target)
  template: string,           // the template string
  priority: number,           // 0-100, higher wins
  enabled: boolean,
}
\`\`\`

Rule selection: among enabled rules with the same \`target\` whose \`types\` list is
empty or contains the item's type, the highest \`priority\` wins; on a tie, a rule
with explicit \`types\` beats one with an empty \`types\` list. If no rule matches,
the default template is used.

## Template syntax

### Placeholders

Nodes:
- \`{node_id}\` — node identifier (the context's configured ID column)
- \`{node_type}\` — node type / label

Edges:
- \`{edge_id}\` — edge identifier
- \`{relationship_type}\` — edge relationship type
- \`{src}\` — source node id
- \`{dst}\` — destination node id

Any raw table column, on nodes or edges:
- \`{prop:<column>}\` — e.g. \`{prop:name}\`, \`{prop:email}\`

Important: \`prop:\` reads the **raw table column first**. So if the table has its
own column literally named \`node_id\` while the configured ID column is something
else (e.g. \`id_hash\`), then \`{node_id}\` shows the configured id and
\`{prop:node_id}\` shows the literal column. When a \`prop:\` column does not exist,
it falls back to the built-in of the same name; if nothing resolves, the label
shows \`[<column>]\` as a visible placeholder (so a typo in a column name is easy to
spot). Missing values never raise an error.

Anything outside \`{...}\` is literal text: \`[{node_type}] {prop:name}\` works.

Line break:
- \`{br}\` — splits the label into multiple lines, e.g. \`{prop:name}{br}{prop:score|number}\`
  renders the name with the score on a second line under it. Use at most 2-3
  lines; every line still counts toward the label's screen footprint, so
  multi-line labels get hidden more often by the overlap filter.

### Modifiers (pipe syntax)

Append \`|modifier\` inside the braces. Arguments are colon-separated.

- \`{prop:name|upper}\` → JOHN DOE
- \`{prop:name|lower}\` → john doe
- \`{prop:name|capitalize}\` → John doe
- \`{prop:bio|truncate:15:...}\` → Software engin...  (truncate:<length>:<suffix>)
- \`{prop:count|number}\` → 1,234,567 (locale number)
- \`{prop:price|currency:USD}\` → $1,234.56   (also \`currency:BRL\` → R$ 1.234,56)
- \`{prop:rate|percent}\` → 85.5%  (0.855 → 85.5%)

Only ONE modifier per placeholder — they do not chain.

### Dates

\`{date:prop:<column>|<format>}\` — the format defaults to \`YYYY-MM-DD\`.
Pattern tokens: \`YYYY\`, \`YY\`, \`MM\`, \`M\`, \`DD\`, \`D\`, \`HH\`, \`H\`, \`mm\`, \`m\`, \`ss\`, \`s\`.

- \`{date:prop:created|DD/MM/YYYY}\` → 25/01/2024
- \`{date:prop:created|DD/MM HH:mm}\` → 25/01 14:30
- \`{date:prop:updated|MM/YYYY}\` → 01/2024

Values may be ISO strings or unix timestamps (seconds or milliseconds).

### Conditionals

\`{if:<condition>|<trueValue>|<falseValue>}\` — the false branch may be omitted
(renders empty). Conditions always read a property with the \`prop:\` prefix.

Comparison operators are written **inline, with no spaces or separators**, right
after the property name: \`==\`, \`!=\`, \`>\`, \`<\`, \`>=\`, \`<=\`, \`contains\`,
\`startsWith\`, \`endsWith\`.

- \`{if:prop:active==true|Active|Inactive}\`
- \`{if:prop:score>80|High|Low}\`
- \`{if:prop:role==admin|Admin|User}\`
- \`{if:prop:namecontainsjohn|Match|No match}\` — parsed as property \`name\`,
  operator \`contains\`, value \`john\`. Note there is NO space and NO pipe between
  the property, the operator and the value.

Date operators use the pipe form:
- \`{if:prop:created|daysAgo:<7|Recent|Old}\` (also \`>\`, \`<=\`, \`>=\`)
- \`{if:prop:created|dateAfter:2024-01-01|New|Legacy}\`
- \`{if:prop:created|dateBefore:2023-12-31|Archive|Current}\`
- \`{if:prop:created|dateBetween:2024-01-01:2024-12-31|In range|Out}\`

Branch values may themselves contain placeholders:
\`{if:prop:verified==true|{prop:name}|anonymous}\`.

### Constraints

- Braces must be balanced; every \`{\` needs its \`}\`.
- Unknown modifiers are ignored (the raw value is rendered).
- Labels are drawn in a **3D canvas** — keep them SHORT. Roughly 20-30 characters
  reads well; use \`truncate\` for anything that can be long (names, descriptions,
  URLs). Prefer \`{br}\` over stacking many fields into one long line, and keep it
  to 2-3 lines.
- The label font only covers **basic ASCII** (letters, digits, common
  punctuation). Accented letters are drawn without the accent (e.g. "Jose" for
  "José"); any other character — emoji, the single-char ellipsis, arrows — is
  drawn as \`?\`. Use ASCII in literal text: \`...\` (three dots) as a truncate
  suffix, a word like \`NEW\` instead of an emoji badge.

## This graph's metadata (use these real values)

**Node types (${nodeTypes.length}):**
${bulletList(nodeTypes, 'no nodes loaded yet')}

**Edge / relationship types (${edgeTypes.length}):**
${bulletList(edgeTypes, 'no edges loaded yet')}

**Node properties (available as \`{prop:<name>}\` on nodes):**
${propertyList(nodeProperties, 'none declared')}

**Edge properties (available as \`{prop:<name>}\` on edges):**
${propertyList(edgeProperties, 'none declared')}

## Worked example

Default node template:

\`\`\`
{prop:name|truncate:24:...}
\`\`\`

Rule "Company labels" — target \`node\`, types \`[Company]\`, priority \`20\`
(two lines: name on top, revenue under it):

\`\`\`
{prop:name|truncate:18:...}{br}{prop:revenue|currency:USD}
\`\`\`

Rule "Recent transactions" — target \`edge\`, types \`[PAID]\`, priority \`30\`:

\`\`\`
{prop:amount|currency:USD} {if:prop:created|daysAgo:<7|NEW|}
\`\`\`

## How to help me

I don't know exactly what I want my labels to say yet.
**Do NOT write templates immediately.** First, **ask me questions, one topic at a
time**, to figure out what each label should show. Use the node types, edge types
and properties listed above to make your questions concrete (reference the actual
types/properties, not generic ones).

Good questions to ask me include:
- Which node types need their own label, and which can share a default?
- For each type, which property is the *primary* text (a name, a title, an id)?
- Should the type be shown as a prefix/suffix, or is it obvious from color/shape?
- How long can a label be before it clutters the canvas? Should long values be
  truncated, and at what length?
- Should any label show a second piece of information on its own line (with
  \`{br}\`), like a name with a metric under it?
- Should numbers be formatted (thousands separator, currency + which currency,
  percentage)? Which properties are numeric?
- Are there date properties worth showing, and in what format?
- Any status/flag property that should become a short badge or emoji via a
  conditional?
- Do edges need labels at all, or only some relationship types?

Ask follow-ups until you have enough to build them. When you're confident you
understand, **then** write the templates.

## When you write the templates

Give me, in this exact form so I can type it into the panel:

1. **Default node template:** \`<template>\`
2. **Default edge template:** \`<template>\`
3. **Rules** — for each: name, target (node/edge), types, template, priority.

Then briefly explain, in one or two sentences, what each template renders for a
typical item. Only use placeholders/properties that exist in the metadata above.

Start by asking me your first question.
`
}
