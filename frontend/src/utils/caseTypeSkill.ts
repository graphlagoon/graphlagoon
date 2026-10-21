/**
 * Case Type Skill Builder (06)
 *
 * A self-contained, copy-pasteable prompt ("skill") for any LLM to help an
 * administrator write a **case type**: what one kind of case means to the org
 * (vocabulary, decision catalog, fields, deadlines, notice, agent settings,
 * starter queries, report templates, trace defaults). The answer is a JSON
 * object pasted back into the editor's "Import JSON".
 *
 * Two modes: write a new type (interview first), or improve the type being
 * edited (`current`). The schema comes from `GET /api/org/authoring`, so the
 * prompt follows the server's validation. Mirrors `stylePresetSkill.ts`.
 * Pure function: no store access.
 */

import { bulletList } from './clusterProgramSkill'
import caseTypeExample from '@/assets/authoring/case-type-example.json'
import type { OrgAuthoring } from '@/types/admin'

export interface CaseTypeSkillInput {
  authoring: OrgAuthoring
  /** The org's types (slug — label), so the AI does not duplicate one. */
  existingTypes: { slug: string; label: string }[]
  /** Library slugs a type may reference. */
  playbooks: { slug: string; title: string }[]
  templates: { slug: string; title: string }[]
  /** The type being edited, as the editor would save it: switches to "improve" mode. */
  current?: Record<string, unknown> | null
}

// Validated against CaseTypeSpec by api/tests/test_type_data.py: a wrong example
// would teach the AI the wrong shape.
const EXAMPLE = caseTypeExample

function slugs(items: { slug: string; title?: string; label?: string }[], empty: string): string {
  return bulletList(items.map((i) => `\`${i.slug}\` — ${i.title ?? i.label ?? ''}`), empty)
}

export function buildCaseTypeSkill(input: CaseTypeSkillInput): string {
  const { authoring, existingTypes, playbooks, templates, current } = input
  const improving = !!current
  const task = improving
    ? '# Task: improve a "case type" of an investigation platform'
    : '# Task: write a "case type" for an investigation platform'

  const intro = improving
    ? `You are helping me improve a **case type** of Graph Lagoon, an investigation
platform where people and AI agents work cases (fraud, credit, AML, merchant
risk, internal incidents…) on a graph of the case's data, and people record
decisions. The current type is below. Your final answer will be the **whole
case type as one JSON object**, which I paste into the editor ("Import JSON").`
    : `You are helping me write a **case type** for Graph Lagoon, an investigation
platform where people and AI agents work cases (fraud, credit, AML, merchant
risk, internal incidents…) on a graph of the case's data, and people record
decisions. A case type is what one kind of case means to my organization. Your
final answer will be **one JSON object**, which I paste into the case type
editor ("Import JSON").

I don't know every detail yet, so **start by asking me questions** (see "How to
help me" at the end) before writing any JSON.`

  const currentSection = improving
    ? `
## The case type to improve

\`\`\`json
${JSON.stringify(current, null, 2)}
\`\`\`

Keep the ids of outcomes, actions and fields that already exist unless I ask
otherwise: cases already use them (decisions keep a copy of their label, but
filters and fields are matched by id).
`
    : ''

  const howToHelp = improving
    ? `## How to help me

Ask me what I want to change and why, one topic at a time. Point out what looks
wrong or missing (an outcome that never closes the case, a field nobody can
filter by, an action without a deadline that has a legal one, a vocabulary that
mixes roles and tags…). Then output ONLY the final JSON object (no prose
around it) so I can paste it into Import JSON.`
    : `## How to help me

**Do NOT write JSON immediately.** Ask me, one topic at a time:

1. What does my team investigate with this type, and who reads the case
   (analysts, a committee, a regulator)?
2. Which **decisions** can end it? Which of them **close** the case, and which
   need a **second person** to approve? Are there decisions taken along the way
   that do not close it (block an account, ask for documents)?
3. What has to happen after each decision (the **actions**, which become
   tasks), and in how many hours? Is any deadline legal or contractual?
4. Which **structured data** must the queue show and filter (an id, an amount,
   a reason code, a rating)? Which are required when the case is opened?
5. **Deadlines** (SLA hours to start and to finish), **stages** worth naming,
   the **retention** period, and a confidentiality **notice** if any.
6. The **roles** and **tags** analysts give entities, and the attributes that
   link entities (phone, device, account…).
7. Which queries every new case should start with (I may describe my tables).
8. What the AI agent may write without confirmation (\`agent_suggest_kinds\`).

Then output ONLY the final JSON object (no prose around it) so I can paste it
into Import JSON.`

  return `${task}

${intro}
${currentSection}
## What each part means

- \`label\`, \`description\`: how people name the type. Domain words (labels of
  roles, outcomes, fields) may be in the language my team uses; JSON keys and
  ids stay as below.
- \`vocabularies\`: the suggested \`roles\` and \`tags\` for entities, and the
  \`link_attributes\` that connect entities sharing a value. \`roles_multi\`:
  whether an entity may hold several confirmed roles (a company that is
  borrower **and** guarantor).
- \`outcomes\`: the decision catalog. Each has an \`id\`, a \`label\`, an optional
  \`description\`, \`closes_case\` (a closing decision freezes the case) and
  \`requires_review\` (four eyes: another person approves before it takes
  effect). At least one outcome must close the case. With no outcomes at all
  the decision is free text.
- \`actions\`: what a decision may set in motion; each chosen action becomes a
  **task** of the case, due \`due_hours\` after the decision.
- \`stages\`: free labels for where a case stands (no rules attached).
- \`fields\`: structured data of the case: \`type\` is one of text, number, money,
  date, enum (enum needs \`options\`); \`required\` is asked when the case is
  opened; \`in_queue\` makes it a column, a filter and a sort key of the queue.
- \`sla_hours\`: hours of the \`open\` phase and then of \`analysis\`, counted from
  the alert (else the occurrence, else the creation). Under 20% left = urgent.
- \`retention_years\`: how long a closed case cannot be deleted (else the org
  default).
- \`notice\`: shown where the case is shared and decided (a tipping-off or
  confidentiality warning).
- \`agent_suggest_kinds\`: what an AI agent writes as a **suggestion** a person
  confirms; \`null\` = the default (${authoring.suggest_kinds.default.map((k) => `\`${k}\``).join(', ')}).
  Possible values: ${authoring.suggest_kinds.all.map((k) => `\`${k}\``).join(', ')}.
  Agents never decide, whatever this says.
- \`playbook\`: the slug of an org library playbook the agent starts with, or
  \`null\`. \`report_templates\`: slugs of org library report templates offered
  first on this type's cases.
- \`starter_queries\`: SQL or Cypher copied into every new case as a query item,
  with \`:name\` parameters declared in \`parameters\` (\`id\`, \`label\`,
  optional \`default\`, \`required\`, \`type\` input | select with \`options\`).
- \`analysis_defaults.trace\`: what "follow the money" starts with (\`max_hops\`,
  \`max_dwell_hours\` with 0 = no limit, \`min_amount\`, \`allocation\`,
  \`stop_types\`).

What a new case **copies** from its type: vocabularies, agent_suggest_kinds,
sla_hours and starter_queries (the case may change them later). What it
**reads live**: label, outcomes, actions, notice, playbook, report templates,
trace defaults.

## Rules the server checks

- ids of outcomes, actions and fields: lowercase letters, digits and \`_\`,
  starting with a letter (\`report_to_authorities\`), unique within their list.
- At least one outcome with \`closes_case: true\` when there are outcomes.
- Every \`playbook\` / \`report_templates\` slug must exist in the library (below).
- No keys other than the schema's. Do not include a \`slug\`: I choose it in the
  editor.

## The JSON Schema (what the server validates)

\`\`\`json
${JSON.stringify(authoring.case_type_schema)}
\`\`\`

## An example (a merchant review at a card acquirer)

\`\`\`json
${JSON.stringify(EXAMPLE, null, 2)}
\`\`\`

## My organization

**Case types that already exist (do not duplicate them):**
${slugs(existingTypes, 'none yet')}

**Playbooks in the library (valid \`playbook\` values):**
${slugs(playbooks, 'none')}

**Report templates in the library (valid \`report_templates\` values):**
${slugs(templates, 'none yet — leave report_templates empty')}

${howToHelp}
`
}
