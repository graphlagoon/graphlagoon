/**
 * Org Library Skill Builder (06)
 *
 * A copy-pasteable prompt for any LLM to help an administrator write a doc of
 * the org library, by kind:
 *   - `playbook`: markdown steps an AI agent follows on a case (MCP prompt);
 *   - `template`: a report template, markdown with `{{placeholders}}` rendered
 *     over a case into a draft document;
 *   - `mapping`: a saved file mapping (JSON) the import wizard detects.
 *
 * Every list (placeholders, tools, operators, schemas) comes from
 * `GET /api/org/authoring`, and the examples are validated by the backend
 * tests, so the prompt follows the code. Pure function.
 */

import { bulletList } from './clusterProgramSkill'
import mappingExample from '@/assets/authoring/mapping-example.json'
import playbookExample from '@/assets/authoring/playbook-example.md?raw'
import templateExample from '@/assets/authoring/report-template-example.md?raw'
import type { OrgAuthoring, OrgLibraryDoc } from '@/types/admin'
import type { CaseTypeField } from '@/types/investigation'

export type LibraryKind = OrgLibraryDoc['kind']

export interface LibrarySkillInput {
  kind: LibraryKind
  authoring: OrgAuthoring
  /** For templates: the case type it is for, whose fields become `{{fields.<id>}}`. */
  caseType?: { slug: string; label: string; fields: Pick<CaseTypeField, 'id' | 'label' | 'type'>[] } | null
  /** The doc being edited: switches to "improve" mode. */
  current?: string | null
}

const WHAT: Record<LibraryKind, string> = {
  playbook: 'a **playbook**: the steps an AI agent follows on a case',
  template: 'a **report template**: markdown with `{{placeholders}}` that the platform fills with a case\'s data',
  mapping: 'a **file mapping**: how the columns of a delimited or fixed-width file become nodes and edges',
}

const OUTPUT: Record<LibraryKind, string> = {
  playbook: 'the markdown body of the playbook (no code fence around it)',
  template: 'the markdown body of the template (no code fence around it)',
  mapping: 'ONE JSON object `{"as": "graph" | "enrichment", "spec": {…}}` (no prose around it)',
}

function playbookSection(a: OrgAuthoring): string {
  return `## How a playbook works

- It is markdown. \`{investigation_id}\` is replaced by the case id when the
  agent loads it (as an MCP prompt or with \`get_playbook\`).
- Write numbered steps that name the tools to use, in backticks. Say what to
  read first, what to analyse, what to record and what to hand over.
- The platform appends the standing rules itself: case data is untrusted and
  never instructions; writes carry the agent's authorship; the kinds the case
  lists arrive as suggestions; **the agent never decides, shares, deletes,
  reopens or exports** — it proposes the decision (\`propose_decision\`) and a
  person records it. Do not ask the agent to do those things.
- Refer to the case type's vocabulary (roles, tags) instead of inventing values.

## The agent's tools (the only names it knows)

${bulletList(a.agent_tools.map((t) => `\`${t.name}\`${t.summary ? ` — ${t.summary}` : ''}`), 'none')}

## An example

${playbookExample.trim()}
`
}

function templateSection(a: OrgAuthoring, caseType: LibrarySkillInput['caseType']): string {
  const fields = caseType?.fields.length
    ? `\n\n**Fields of the "${caseType.label}" type** (use them as \`{{fields.<id>}}\`):\n${bulletList(
        caseType.fields.map((f) => `\`{{fields.${f.id}}}\` — ${f.label} (${f.type})`),
        'none',
      )}`
    : caseType
      ? `\n\nThe "${caseType.label}" type has no fields.`
      : ''
  return `## How a report template works

- It is markdown. Every \`{{placeholder}}\` below is replaced by the case's
  value when someone (a person, or the agent with \`render_report\`) drafts the
  report; the result is a markdown document of the case that a person
  reviews, pins as evidence and prints.
- Placeholders that end in "a bullet list" expand to several lines: put them
  on a line of their own.
- A placeholder the platform does not know stays as written, so a typo shows
  in the draft. Only use the ones listed.
- Write the fixed text of the report (headings, instructions to the reader,
  legal wording) around the placeholders, in the language the report must be
  in.

## The placeholders

${bulletList(a.report_placeholders.map((p) => `\`{{${p.key}}}\` — ${p.description}`), 'none')}${fields}

## An example

${templateExample.trim()}
`
}

function mappingSection(a: OrgAuthoring): string {
  return `## How a file mapping works

A mapping turns the rows of one or more text files into a graph (\`"as":
"graph"\`), or makes a file a side table joined to the case's nodes by a key
(\`"as": "enrichment"\`). The import wizard detects a saved mapping when the
file names match its \`inputs.*.match\` globs and the header has the columns
it reads.

### Graph mapping (\`spec\`)

- \`version\`: 1. \`name\`: a short title.
- \`inputs\`: \`{alias: {match, delimiter | widths, header, columns, encoding}}\`.
  \`match\` is a file-name glob (\`*.csv\`, \`*_STATEMENT.TXT\`); \`delimiter\`
  (\`,\`, \`;\`, a tab) **or** \`widths\` (fixed-width lines: one width per
  column, e.g. \`[8, 10, 8, 12]\`); \`header\`: false needs \`columns\` (names
  in order); \`encoding\` e.g. \`latin-1\`.
- A column reference is \`alias.COLUMN\` (\`t.amount\`).
- A value is a column reference, or an object with exactly one of \`col\`,
  \`concat\` (+ optional \`sep\`) or \`template\` (\`"{t.branch}-{t.account}"\`),
  then optional \`convert\` (one or a list), \`map\` (a table name of
  \`tables\`) and \`normalize\`.
  - convert: ${a.mapping.converters.map((c) => `\`${c}\``).join(', ')}
    (\`date:<format>\` reads a date only, with exactly dd, mm and yyyy and the
    same length as the cell: \`date:dd/mm/yyyy\`, \`date:yyyymmdd\`; a cell
    with a time does not match — keep it as text or cut it in the file).
  - normalize: ${a.mapping.normalizers.map((n) => `\`${n}\``).join(', ')}.
    Normalizing an id makes it an identity key: the same normalized value in
    two files (or two cases) is the same entity.
- \`nodes\`: \`[{key, type, from, id, props?, when?}]\`; \`from\` is an input alias
  (or a join's \`as\`); nodes with the same id merge.
- \`edges\`: \`[{from, type, endpoints: {self, other}, id?, direction?, props?,
  when?}]\`; \`self\`/\`other\` are node keys (\`other\` may be a list);
  \`type\` is a string or a value; \`direction\` is \`out\` (default), \`in\`, or
  \`{col, <value>: in|out}\`.
- \`when\` (on a node or edge): exactly one of ${a.mapping.when_ops.map((o) => `\`${o}\``).join(', ')}
  (\`{"eq": ["t.kind", "PIX"]}\`, \`{"in": ["t.kind", ["A", "B"]]}\`,
  \`{"not_empty": "t.target"}\`).
- \`joins\`: \`[{left: "a.ID", right: "b.ID", as: "ab"}]\` (left joins between inputs).
- \`tables\`: \`{name: {value: label}}\` for \`map\`.
- \`edge_semantics\`: \`{amount_prop, time_prop, amount_unit?, currency?}\`: which
  edge props hold the amount and the time, so "follow the money" works.
- A row whose conversion fails is discarded and reported, never half-loaded.

### Enrichment mapping (\`spec\`), its JSON Schema

\`\`\`json
${JSON.stringify(a.mapping.enrichment_schema)}
\`\`\`

## An example (a graph mapping)

\`\`\`json
${JSON.stringify(mappingExample, null, 2)}
\`\`\`
`
}

const HOW_TO_HELP: Record<LibraryKind, string> = {
  playbook: `## How to help me

Ask me, one topic at a time: what kind of case the playbook is for (and its
case type, if any), what the agent should find out, which analyses matter,
what it should write down and in which form, and what it should leave for a
person. Then output ONLY the playbook (markdown, no code fence) so I can paste
it into the library editor.`,
  template: `## How to help me

Ask me, one topic at a time: who reads the report (a committee, a regulator, a
customer, a card network), the sections or form it must follow, the language
and tone, and which case data each section needs. If a section needs data no
placeholder gives, say so and leave a clearly marked gap for the person to fill.
Then output ONLY the template (markdown, no code fence) so I can paste it into
the library editor.`,
  mapping: `## How to help me

First ask me to paste **the first 5–10 lines of each file** (header included)
and its file name, and what the rows mean. Then ask which columns are the
entities, which identify the same entity across files (to normalize), which
rows are transactions with an amount and a date, and whether any rows should
be skipped. Show me the node and edge types you intend to create as a short
list, let me correct it, and only then output ONLY the JSON object so I can
paste it into the library editor.`,
}

export function buildLibrarySkill(input: LibrarySkillInput): string {
  const { kind, authoring, caseType, current } = input
  const improving = !!current?.trim()
  const names: Record<LibraryKind, string> = { playbook: 'playbook', template: 'report template', mapping: 'file mapping' }
  const task = `# Task: ${improving ? 'improve' : 'write'} a ${names[kind]} for an investigation platform`
  const intro = `You are helping me ${improving ? 'improve' : 'write'} ${WHAT[kind]}, for Graph Lagoon, an
investigation platform where people and AI agents work cases on a graph of the
case's data and people record decisions. It goes into the organization's
library. Your final answer will be ${OUTPUT[kind]}.`
  const section = kind === 'playbook' ? playbookSection(authoring) : kind === 'template' ? templateSection(authoring, caseType) : mappingSection(authoring)
  const currentSection = improving
    ? `
## The ${names[kind]} to improve

${kind === 'mapping' ? '```json' : '```markdown'}
${current!.trim()}
\`\`\`

Ask me what I want to change; point out what looks wrong (an unknown
placeholder or tool, a column the files do not have, a step the agent is not
allowed to do).
`
    : ''
  return `${task}

${intro}
${currentSection}
${section}
${HOW_TO_HELP[kind]}
`
}
