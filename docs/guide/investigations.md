# Investigations

::: tip TL;DR
A **case** gathers graphs, tables, queries, documents and notes from any
context into one workspace, merges the same entity across them, runs the
analyses (follow the money, paths, links, entity resolution), records
evidence, hypotheses and tasks, and ends in **decisions** recorded by people,
each with a reproducible hash. What a case *means* to your organization —
its types, fields, vocabulary, decision catalog, deadlines, reports — is
data an administrator writes, not code.

- **Use it when** an analysis (fraud, credit, AML, merchant risk, an internal
  incident, a vendor review…) spans more than one graph or file and you need
  them on one canvas, with who-did-what recorded until a decision.
- **Not the tool for** a single exploration you only want to save or share
  ([Explorations & Sharing](./explorations.md)); sending anything to a
  regulator or a bank (the app drafts reports from templates; a person files
  them); or letting an AI decide (agents work the case and *propose*; people
  record decisions, see [AI Agents (MCP)](./agents-mcp.md)).
- **Needs** database persistence (PostgreSQL) for cases to survive a
  restart, and a case storage folder or Volume for files and versions (see
  [Settings](#settings)).
:::

An investigation is a case file. It does not copy the warehouse: it points at
explorations you already have, from any context you can read, adds files sent
to you, saved queries and their runs, and shows them side by side and merged.
Open **Investigations** in the top navigation for the queue of the cases you
own, are assigned to, or that were shared with you.

![Investigation queue](/screenshots/investigations-queue.png)

## Concepts

| Concept | What it is |
|---|---|
| **Case type** | What a kind of case means to the org, defined in the admin area: vocabulary (roles, tags, link attributes), the **decision catalog** (outcomes and the actions they set in motion), the case **fields**, **stages**, **SLA hours**, retention, a confidentiality **notice**, the agent's playbook and suggest kinds, **starter queries**, **report templates** and trace defaults. The built-in **General** type has no rules. |
| **Item** | Everything in a case: a graph (a live exploration reference, a snapshot, a selection, a saved view, an analysis result), a table, a saved query, a document or a note. Every item has an author (person or agent) and immutable versions with a sha256. |
| **Evidence** | A **pinned** version of an item: immutable, numbered E1, E2… in the dossier. |
| **Annotation** | A role, tag, group, `same_as`, hypothesis, task or decision proposal on entities or items; a person's are confirmed, an agent's arrive *suggested*. |
| **Decision** | An outcome of the type's catalog (or a free one), on the whole case or on some entities, with its rationale, the evidence it rests on and the tasks it sets in motion. A case has as many as it needs; one that *closes the case* freezes it. |
| **Task** | A follow-up for a person or an agent, with a deadline; it survives the closing of the case. |
| **Journal** | Every change, append-only, with its author. Each decision hashes the journal up to itself. |

## The flow at a glance

1. **[Open a case](#the-queue-and-opening-a-case)** of a type (its required
   fields first) and add explorations, files and queries.
2. **[Read the unified view](#the-workspace)**: the same document, account,
   phone or device merges across sources by [identity keys](#identity-keys).
3. **[Enrich](#enrichment-tables)** entities from side tables, and run the
   **[analyses](#analyses)**: follow the money, paths, links, groups, entity
   resolution, the type's detectors.
4. **Mark [roles and tags](#roles-notes-tasks-and-the-journal)**, write notes,
   **[pin evidence](#evidence)**, write **[hypotheses](#dossier)** and plan
   **[tasks](#tasks)**.
5. **[Read the dossier](#dossier)**, draft a **[report](#reports)** from the
   type's template and **[record decisions](#decisions)** — four eyes when the
   outcome asks for it. A closing decision freezes the case.
6. **[Export](#exports)** the JSON package or the CSV, or print the dossier.

An [AI agent](#agents) can do the legwork of steps 1–5 with your access and
propose the decision; people record it.

## Who can do what

The app-wide [permissions](./permissions.md) gate five actions. Until an
administrator writes a rule, everyone holds them.

| Permission | Gates | Without it |
|---|---|---|
| `investigation.create` | Opening a case (**New investigation**, the agent's `create_case`) | You still work on cases assigned to or shared with you |
| `investigation.upload` | Uploading files to a case | You still read the material already there |
| `investigation.decide` | Recording and reviewing decisions | You still analyse, write and propose |
| `investigation.share` | Sharing a case and assigning it | You still work on it |
| `investigation.agent` | Creating personal agent tokens (when agents are enabled) | No agent can act for you |

On a given case:

| Who | Sees | Edits (items, annotations, brief, tasks) | Decides | Shares, deletes |
|---|---|---|---|---|
| Owner | Yes | Yes | Yes | Yes; deleting a closed case waits for its [retention](#retention-and-deleting) |
| Assignee (an *editor* share automatically), *editor* share | Yes | Yes | Yes | No |
| *Reader* share | Yes | No | No | No |
| Superuser | Every case | Only as owner, assignee or editor | Same | Yes, also a retained case with a reason; transfers cases |
| AI agent | What its owner sees (or only the cases of a case-scoped token) | What its owner edits; the type's suggest kinds arrive **suggested** | Never (it proposes) | Never |
| Anyone else | "Not found": a case's existence does not leak | — | — | — |

- **Sharing is nominal.** A case is shared with named e-mails, never with
  `*` or `*@domain`: a case is need-to-know. The case type's **notice** (for
  example, "do not tell the people under investigation") shows in the share
  dialog and the decision panel.
- **Restricted sources.** If a case includes an exploration or a query from
  a context you can't read, you see a locked placeholder with the context and
  its owner, and none of its nodes; you can't preview, download, pin, join or
  promote it, search doesn't look into its text, and analyses and exports
  leave it out too. A table joined or promoted from it keeps the restriction.
- **The case type is fixed once there is a decision** (even a withdrawn or
  rejected one): it holds the decision catalog, who needs a second person
  and the retention, so changing it answers `CASE_TYPE_LOCKED`.
- **An unreadable item** (a JSON that is not a graph, a mapping that no
  longer applies) shows its error on the canvas and is left out of the case
  graph (`broken_sources`); the rest of the case keeps working.
- **A closed case is read-only** for everyone until a person reopens it;
  tasks and drafted reports are the exceptions (see [Decisions](#decisions)).

## The queue and opening a case

The queue is paged on the server: filter by text (title, description or the
case's `#id`), status (*Open*, *In analysis*, *Closed*; *In progress* = the
first two), case type, assignee, cases owned by you or shared with you,
deadline (urgent or overdue) and suggestions to review; the counters on top
are filters too, and count the cases the other filters keep. **Assignee: me**
is whoever the case is on: its assignee or, unassigned, its owner. With one
**case type** chosen, its queue fields (for example *Amount at risk* or
*Reason code*) become columns, filters and sort keys. Each row shows the
type, status and stage, assignee, material, pending suggestions, the
deadline and the dates; most columns sort. Filters, sort and page are in the
address, so **Back** from a case returns to the same list and a filtered
queue can be shared as a link.

**My tasks** (next to *Cases*) lists the open tasks assigned to you across
every case you read, with their due time and a link to the case.

**New investigation** asks for a title, a type and the type's required
fields (the current-case chip in the top bar creates a General case in one
step, or opens this form). A case can also be opened by an alerting system or an agent through
the API with an `external_ref` (the alert id): the same ref again returns the
case already opened, so a retry never duplicates it.

A new case copies from its type the vocabulary, the agent's suggest kinds,
the SLA hours and the **starter queries** (as query items); from then on they
are the case's own. The label, the catalog, the notice, the playbook and the
report templates are read live from the type.

**Editing a case.** In the header, click the title, description, assignee or
a field to edit it in place; the type and its stage are selects. The status
moves between *Open* and *In analysis*; only a decision closes a case and only
**Reopen** (the **…** menu, people only) brings it back to analysis.
**Decide**, **Share**, **⚙** (settings) and **Dossier** are next to it. The
header only offers what you may do: **Decide** needs the *Decide* permission,
**Share** and the assignee need manage rights, the type no longer changes after
a decision (and asks before changing), and a case a decision closed is kept
for its retention period — only a superuser deletes it, with a reason that goes
to the audit log. A closed or read-only case says so under the header.

## Case files

Everything in a case is an **item** of the material list (left column). Graph
items carry an **on canvas** checkbox: unchecking one removes its nodes
without resetting the layout.

**Viewing and downloading.** Selecting an item shows its card in the
inspector, with **Preview** and **Download** for its latest version. Tables
open as a table with the first 200 rows — or as a **chart** (line or bars, an
x column and numeric series), which you can save as the item's view; markdown
renders (headings, lists, tables, links; **Raw** shows the source, and no HTML
of the document ever runs); text and JSON open as text; images and PDFs display
inline; HTML renders in a sandboxed frame with scripts off; a link document
opens its address. Every read is audited (`investigation.item_read`).

**Working with an item.** An attached exploration opens on its own page
(**Open exploration ↗** on its card, ↗ on its row, *Open in exploration* in a
node's Origin tab), with **← Case** to come back. **Edit** changes the title,
description and tags; ↑ ↓ move it among the items of its kind. **Edit text**
saves a note or markdown document as a new version, **Upload new version**
does the same for a file; **Versions** lists every version to preview,
download or pin with a label. Removing an item is undone from the toast or
from **Removed** at the end of the list, and a rejected suggestion can be
reopened; the short ids (G1, D2, E3…) never move. The material's search also
looks inside files, notes and documents, with a snippet of the match.

**Upload** (needs `investigation.upload` and edit access) opens the file
assistant: pick the files of a layout, choose **Graph** (the table is mapped
onto the canvas through a mapping spec), **Enrichment** (its columns become
properties of the nodes or edges already on the canvas, by key; see
[Bring your own data](./bring-your-own-data.md#enrich-nodes-or-edges-from-a-file))
or **Attachment** (kept with its hash). Files may be delimited
or **fixed-width** (`widths` instead of a delimiter). The org's **saved
mappings** are detected from the file names and headers, and a superuser can
**save the current mapping for the org**. No graph context is created: the
mapping belongs to the item and the graph is read from the table, keeping its
first `GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES` edges.

**Saved queries** keep SQL or Cypher with `:name` parameters and the context
to run against (a `:name` inside quotes is text, and in Cypher `(:Person)` and
`[:KNOWS]` are labels and types, not parameters). **Run** stores the result as a new version with its `run`
metadata (statement id, duration, rows, parameters, author); re-running adds a
version, and any version can be pinned.

## The workspace

![Investigation workspace](/screenshots/investigations-workspace.png)

- **One graph at a time.** A case opens on its first graph item; the legend
  over the canvas lists every graph of the case: click one (or click it in the
  material list) to clear the canvas and show only it, laid out on its own as
  in its exploration; Shift+click adds it to or removes it from what is shown,
  keeping their layout; **All graphs** unifies them all. On a
  unified canvas each node gets one colored ring per source it came from (two
  rings: found in two sources and merged). The material's *on canvas* box adds
  or removes one graph too. The choice is saved with the case (and in saved
  views); with a single graph, the canvas wears its exploration's style. A graph
  that shows nothing (an exploration never saved) says why with ⚠.
- **Inspector** (right) shows the selected entity: data, role and tags, the
  items that cite it, notes, enrichment and origin — and **Seen in N other
  cases** when the same entity appears in other cases you can read, with the
  roles, tags and decisions it got there.
- **Filter chips** over the canvas (source, role, tag, group, type, time
  window) filter visually; **views** saves the chips, the layout and the
  closed groups as a `graph/view` item.
- The **analysis bar** opens each analysis with its parameters; every run is
  an item with its provenance, shown in the bottom strip and pinnable.
- The bottom strip has the **Dated edges** timeline, the **Journal** (newest
  first, *Load older events* for the rest; filter person / agent / system,
  event kind, *since my last visit*, or search its text; a line about an item
  opens it, one about an entity shows it on the canvas), **Tasks**,
  **Suggestions** to confirm in bulk (asked first, sent at once), and the
  active analysis result.
- **⚙** edits the case settings: deadlines, the agent's suggest kinds,
  vocabularies, identity keys, edge semantics by relationship type and label
  templates. Only people change them (an agent token gets 403).

### Identity keys

Merging across sources is driven by **identity keys**, set per context in the
context form or per case in ⚙. A key says: nodes of type `Holder` are the
entity `Person`, identified by the property `national_id`, normalized as
`digits` (or `regex`, whose group 1 is the key: a pattern with nested
repetition such as `(a+)+` is refused, since it can take exponential time,
and ids over 256 characters are not matched). Two sources that map to `Person` merge their nodes when the
normalized values match, so `123.456.789-01` and `12345678901` become one
node, `Person:12345678901`. That id is the same in every case, which is how
**Seen in other cases** works.

| Normalizer | Does |
|---|---|
| `digits` | Digits only; a masked value (with `*`) is never a key |
| `account` | The digit groups without left zeros, joined by `-` (`0341-001234` → `341-1234`) |
| `phone` | Digits only |
| `email`, `lower` | Lowercase, trimmed |
| `device_id`, `ip`, `terminal_id` | Lowercase letters and digits; a canonical IPv4; uppercase without left zeros |
| `card` | First six and last four digits (`453212*9876`): never the full number |
| `address` | Lowercase, without accents and extra spaces |
| `regex` | The first group of a pattern |
| `none` | The value as is |

Nodes without a key never merge: they stay one per source. **Entity
resolution** (analysis bar) suggests `same_as` pairs for entities that share a
blocking attribute and have similar names; confirming one folds the two
entities into one on the canvas and in every server analysis.

## Enrichment tables

A context can attach side tables (KYC, devices, chargebacks) in the context
form. The inspector's **Enrichment** tab looks a table up for the selected
entity; a table can **promote** a column to nodes (each distinct value becomes
a node linked to the entities that share it). Lookups are by key, return only
the listed columns, are capped (`GRAPH_LAGOON_ENRICHMENT_MAX_KEYS`,
`GRAPH_LAGOON_ENRICHMENT_MAX_ROWS`) and are audited (`enrichment.read`).

A case can upload its own as an **Enrichment** file: the key column, how keys
are normalized, the node types it applies to (every type by default) or, for
edges, the edge id or the two endpoints. Its columns become **properties** of
the matching nodes or edges, on the canvas, in the server analyses and in what
agents read. A value already there wins and the file's is shown as a conflict,
unless the file says to replace it. The **Enrichment** tab lists every row the
file has for the selected entity. Details:
[Bring your own data](./bring-your-own-data.md#enrich-nodes-or-edges-from-a-file).

**Manual additions.** Right-click a node for **Add a linked node** or, with one
other node selected, **Connect to the selected node**; **+ Add → File → Draw a
node by hand** draws one alone. What you draw goes to one `graph/sketch` item
of the case, with you as author and a version per change
([Drawn by hand](./bring-your-own-data.md#drawn-by-hand)).

## Analyses

- **Follow the money** (right-click an edge or an account, or the analysis
  bar): forward or backward from a seed, with max layers, max dwell Δ, minimum
  amount, a time window, an allocation rule (FIFO, proportional, LIBR or total
  contamination forward; LIFO, proportional or total backward) and the node
  types to stop at (by default the types where value only ends). It shows the
  layers, a Sankey, the exits with the traced value, the retained balances, a
  swimlane timeline and the method stamp. A case type can set its own
  **defaults** (for example 4 layers and 48 h for a Pix scam).
- **Paths** between two entities: fewest hops, lightest (by 1 / amount),
  k shortest, or earliest arrival.
- **Links**: entities sharing attributes (phone, device, e-mail, address…)
  as a `graph/derived` layer of `shares_<attr>` edges.
- **Groups** from the selection or by property, role, tag, community or
  component.
- **Detectors**: the case type's starter queries, copied into the case; open
  one to run it and its result is a table of the case.
- **Metrics** from the explorer, saved as node properties.

Follow the money and paths need the **amount and time** of each edge: the
context form's *Amount and Time* section, a file mapping's `edge_semantics`, or
the case's ⚙ by relationship type. Trace, paths, entity resolution, links and
communities also run on the server over the unified graph
(`POST /api/investigations/{id}/analysis/trace|paths|er`), with the same
numbers as the screen and a journal entry.

## Roles, notes, tasks and the journal

- **Roles and tags** come from the case's vocabulary (the type's, editable in
  ⚙). A type may allow several roles per entity (a company that is borrower
  and guarantor).
- **Notes** are anchored on an entity or free; **documents** are markdown or
  links.
- **Journal**: every change with its author and time; an agent's entries read
  "agent X for Y".

### Tasks

A task is a follow-up with a title, a person or an agent (by its token name)
and a due time. A decision's **actions** become tasks automatically (the
action's `due_hours` sets the deadline); you add others in the **Tasks** tab
or the agent does with `add_task` (it arrives suggested). The tab filters
*mine*, *agents* and *overdue*; the dossier shows the open ones. Tasks stay
editable after the case is closed, so the follow-ups of a decision can be
done afterwards.

## Evidence

Evidence is a **pinned version** of an item: immutable, with its sha256,
author and time. **📌** on a material row pins the current version (a live
exploration is frozen first); **Pin evidence** on the canvas freezes what it
shows; **Save as evidence** on a trace keeps the result with its method stamp.
The dossier numbers pinned versions E1, E2, … by pin order.

## Dossier

**Dossier** in the header opens the case as a document (`?mode=dossier`):

- **Summary**: the description, the type, the brief, how many entities hold
  each role, groups and indicators;
- **Hypotheses** (H1, H2, …) with their status (open, supported, refuted) and
  the evidence for and against each; a wrong one is refuted, never deleted;
- **Evidence**: E1, E2, … with how each was made;
- **Notes and documents**: every note and document of the case, rendered
  (markdown, the reports drafted from templates), links clickable, files with
  their type, size, hash and download, and the entities a note is about;
- **Tables** flagged *Use in the dossier*, with their latest rows;
- **Tasks** still open, and the **Journal**;
- **Decisions** on the right: every decision so far, the panel to record one,
  the report templates and the exports.

## Reports

A **report template** is an org library doc (admin area → *Library*, kind
*report template*) in markdown with `{{placeholders}}`: `case.title`,
`case.number`, `case.type`, `case.status`, `fields.<id>`, `brief`,
`decisions`, `decision.outcome`, `decision.rationale`, `evidence`, `roles`,
`hypotheses`, `tasks`, `today`, `user` and more. **Draft report** in the
dossier (the case type's templates first) renders it over the case into a new
markdown document of the material: review it, pin it, print it. An agent's
draft arrives suggested. A placeholder the case has no value for stays in the
text, so the author sees what is missing. This is how regulator- or
org-specific reports (a suspicious activity narrative, a merchant offboarding
memo, a chargeback representment, a credit memo) are made without code.

## Decisions

The decision panel (header **Decide**, the inspector, or the dossier) records
one decision:

- **Outcome**: one of the type's outcomes, each saying whether it **closes
  the case** and whether it **needs four eyes**; a type without a catalog
  (General) asks for the outcome in words and a *Closes the case* box. The
  label is copied into the decision, so editing the catalog later never
  rewrites history.
- **About**: the entities it is about (the selection and the entities with a
  role), or the whole case — approve the limit of company A and deny B's,
  block account X and monitor Y.
- **Follow-up tasks**: the type's actions it sets in motion.
- **Rationale**, pre-filled with the supported hypotheses and the pinned
  evidence — the pre-fill alone is not enough: add your own words;
  **reviewer** (an editor of the case, never the author; the people on the
  case are suggested). A decision that closes the case asks before recording.

Recording appends the decision with the **hash** of the journal up to it
(sha256 of the canonical journal, which carries the pinned versions' hashes
and the tasks the decision created). Later lines never change it, so every
decision can be verified at any time.

- A decision that **does not close** the case leaves it open: a case can have
  several (contain while investigating, request documents, then decide).
- **Four eyes**: an outcome that needs review stays *waiting for review*
  until another person with write access (the named reviewer, when there is
  one) **approves** it — a closing outcome then closes the case — or
  **rejects** it. The author may **withdraw** their own pending decision,
  never approve it. Nothing else is decided while one waits.
- A **closed** case is read-only (`409 CASE_CLOSED`) except for its tasks and
  drafted reports. **Reopen** (people only) brings it back to analysis; the
  decisions stay, and the journal names the one that had closed it.
- An **agent proposes**: `propose_decision` stores a draft; the header shows
  *Decision proposed* and the panel opens filled in, to record, edit or
  dismiss. The decision names the proposal it took up.

API: `POST /api/investigations/{id}/decisions` with
`{outcome | outcome_label + closes_case, targets?, tasks?, rationale, evidence?, reviewer_email?, proposal_id?}`
and `POST …/decisions/{decision_id}/review` with `{approve, note?}`; both are
human-only and audited (`investigation.decide`,
`investigation.decision_review`).

### Retention and deleting

A case closed by a decision cannot be deleted for its type's
`retention_years` (else `GRAPH_LAGOON_INVESTIGATION_RETENTION_YEARS`, default
10) after the closing decision: `DELETE` answers `409 INVESTIGATION_RETAINED`,
except for a superuser who gives a reason (`?reason=…`), which the audit log
records. Deleting a case removes its rows and every blob of the case.

## Exports

Each export is a download, generated on request from what you can read, in
any status, and recorded in the audit log with its format and sha256.
Exporting adds nothing to the journal. Every format **recomputes each
decision's hash** and checks the bytes of the versions it rests on:
`integrity: {decisions: [{id, hash, verified}], verified}` (`verified: null`
without decisions).

| Button | Format | What it holds |
|---|---|---|
| **JSON package** | `json` | The whole record: the case, its decisions and `integrity`, roles, hypotheses, annotations, every item with its versions, the evidence, the tables flagged for the dossier, trace methods and the journal |
| **CSV** | `csv` | The same record flattened, one row per item and per decision, formula-safe |
| **Print report** | print | The dossier printed by the browser (*Save as PDF*), with the hashes |

Agents cannot export; they read the case through the MCP tools.

## Agents

An agent is an analyst with the identity of the person who created its token:
it reads, adds items and versions, runs queries and analyses, groups,
annotates, writes the brief, plans tasks, drafts reports and **proposes** the
decision; it never decides, reviews, shares, deletes, reopens or exports. Its
writes carry the **agent** chip, and the type's suggest kinds (by default
roles, tags, `same_as`, hypothesis statuses, status changes and tasks) arrive
**suggested** for a person to confirm. Tokens are created in the account menu
(**Agents**): every case you read, or only some cases. How to connect Claude
Code and the tools are in [AI Agents (MCP)](./agents-mcp.md).

**Sensitive data.** There is no masking layer: an agent sees what its owner
sees. Minimize what reaches agents with the columns your contexts expose, the
shares of each case and case-scoped tokens. Never upload raw card numbers
(PAN) to a case — expose tokenized or hashed values from the context; a raw
PAN in a file brings the case storage into PCI scope.

## Settings

All optional. Details in [Configuration](./configuration.md#investigation-storage).

| Variable | Default | Does |
|---|---|---|
| `GRAPH_LAGOON_INVESTIGATIONS_VOLUME_PATH` | `{DATABRICKS_VOLUME_PATH}/investigations`, else `{EXPLORATION_SNAPSHOTS_DIR}/investigations` | Where files and versions are stored |
| `GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES` | `209715200` (200 MB) | Largest file uploaded to a case |
| `GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES` | `50000` | Edges kept from a file graph |
| `GRAPH_LAGOON_INVESTIGATION_RETENTION_YEARS` | `10` | Years a closed case cannot be deleted, when its type sets none |
| `GRAPH_LAGOON_ENRICHMENT_MAX_KEYS` / `_MAX_ROWS` | `500` / `5000` | Keys per enrichment lookup / rows it returns |
| `GRAPH_LAGOON_AGENTS_ENABLED` | `false` | Agent tokens and the `/mcp` server |
| `GRAPH_LAGOON_AGENT_TOKEN_MAX_DAYS` | `90` | Longest token validity |
| `GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE` | `120` | Requests per minute per agent token |
| `GRAPH_LAGOON_AGENT_IMAGE_MAX_BYTES` | `2000000` | Images up to this size reach an agent as image content (0 = never) |

Case deadlines are not a setting any more: they are the **SLA hours** of each
case type (open, then analysis), counted from the alert date (else the
occurrence date, else creation), editable per case in ⚙. Under 20% of the
SLA left the case is *urgent*.

## Limits and known gaps

- **Business-day SLAs**, **multi-currency/FX**, **multiplicative ownership
  chains** (beneficial ownership over 25%) and **merging cases** are not
  modeled; use a starter query for the last two.
- **Bulk actions** on the queue (decide or close N cases at once) and
  **webhooks** for agents are not there yet; agents poll with
  `changes_since` and `list_tasks`.
- **Case graph size**: everything renders in the browser; a file graph keeps
  only its first `GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES` edges.
- **Seen in other cases** matches entities with an identity key; entities
  without one only match within the same context.
- The UI is in English; domain words (roles, outcomes, fields) are whatever
  your case types say.
- The printed report is the browser's *Save as PDF*, without a digital
  signature.
- **Uploads** go in one request, so a proxy limit below
  `GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES` wins.
- **Workspace layout**: the three columns have fixed widths and do not
  collapse; on a narrow screen use the dossier. Cases are not archived (a case
  is open, in analysis or closed), and removing a role, tag or group is final.
- **Expanded neighbors** and nodes promoted from enrichment tables last the
  session (the journal records them); save the exploration to keep them.
- *Since my last visit* is remembered per browser.

## Admin area

Superusers get, in the admin area:

- **Case types**: create and edit the org's types (vocabulary, outcomes and
  actions, fields, stages, SLA hours, retention, notice, agent settings,
  starter queries, report templates, trace defaults); a type in use cannot be
  deleted. Audited as `case_type.write|delete`.
- **Library**: playbooks, report templates and saved file mappings (audited as
  `library.*`).

Both editors explain themselves: a **?** on each section of a case type and on
the kinds of library doc, a reference under a library doc (the placeholders, or
the agent's tools, or the mapping operators; a click inserts one at the
cursor), **Start from the example**, and **Ask an AI**: a prompt to copy into
any AI assistant (Claude, ChatGPT, Gemini…) that explains the format, lists
exactly what this server accepts (the case type's JSON Schema, the
placeholders, the tools, the operators) and your org's types and library, and
asks the AI to interview you before it answers. Paste the answer back: a case
type through **Import JSON** (it fills the form; nothing is saved until you
save), a library doc into its body. **Copy JSON** takes a case type to another
environment. If the server rejects a save, the message names the field
(`outcomes.0.id: …`).
- **Investigations**: every case with its owner, assignee, status and item
  count, and **Transfer** to a new owner.
- **Audit**: creations, edits, shares, items, decisions
  (`investigation.decide` with the outcome and its hash) and reviews,
  exports with the sha256, item reads, enrichment lookups and agent reads.
- **Agent tokens**: everyone's tokens with their last activity.

The five `investigation.*` permissions appear in the permission matrix of
[Groups & Permissions](./permissions.md).
