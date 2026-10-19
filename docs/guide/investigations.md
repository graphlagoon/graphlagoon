# Investigations

::: tip TL;DR
A **case** that gathers explorations and files from **different contexts**
into one workspace, merges the same person or account across them, follows
the money, records evidence and hypotheses, and ends in a human decision with
a tamper-evident journal and a reproducible hash.

- **Use it when** a fraud, AML or risk analysis spans more than one graph
  (Pix transfers in one context, customer records in another, a bank
  statement someone sent) and you need them on one canvas, with who-did-what
  recorded until the decision.
- **Not the tool for** a single exploration you just want to save or share
  (that's [Explorations & Sharing](./explorations.md)); filing the
  communication to COAF (the app exports a structured Siscoaf summary and a
  person files it in Siscoaf); tracing over the whole warehouse (traces,
  paths and badges run over the case graph, capped at
  `GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES` edges); or letting an AI
  decide (agents work the case and suggest; people confirm and decide, see
  [AI Agents (MCP)](./agents-mcp.md)).
- **Needs** database persistence (PostgreSQL) for cases to survive a
  restart, and a case storage folder or Volume for files and frozen copies
  (see [Settings](#settings)).
:::

An investigation is a case file. It does not copy data out of the
warehouse: it points at explorations you already have, from any context you
can read, adds files sent to you (bank statements, the Receita QSA, any
CSV), and shows them side by side and merged. Open **Investigations** in the
top navigation to see the queue of cases you own, are assigned to, or that
were shared with you.

![Investigation queue](/screenshots/investigations-queue.png)

The queue shows each case's typology, number of sources, status, assignee
and deadline. Filter by text, status, typology or assignee (*Open* hides
decided and archived cases), sort by any column, and click a counter on top
to use it as a filter. A case someone else owns is marked *shared with you*
or *read-only*.

**Status and deadlines** (Circ. 3.978): a case starts *Awaiting selection*
with 45 days from creation; moving it to *In analysis* records
`selected_at` and starts another 45 days. *Decided* is reached only by
[recording the decision](#decision-freeze-and-retention); *Archived* closes
a case without one. The server computes the deadline
(`deadline: {phase, due_at, days_left}` on every case, none once decided or
archived); under 7 days left it turns orange, in the queue and in the
case header. The selection phase counts from the alert date (`alert_at`)
when the case has one, and `deadline_days_override` replaces the 45 days
for a single case.

**Editing a case.** In the case header, click the title, description,
typology or assignee to edit it in place. The status select only offers the
allowed moves (*Awaiting selection* ↔ *In analysis* → *Archived*; an
archived case can go back to analysis); anything else is refused with 409.
**Decide** records the decision from the case screen; **Share** manages the
named people (read or write); the **…** menu reopens a decided case
(*Reopen*, people only: the decision and its hash stay in the journal as
`case.reopened`) and deletes the case after a confirmation.

## The flow at a glance

1. **[Create a case](#creating-a-case-and-adding-explorations)** and add
   explorations from any context, *live* or *frozen*.
2. **[Add files](#case-files)**: a SIMBA bank statement becomes a graph
   source; a QSA becomes an enrichment table of the case.
3. **[Read the unified view](#the-workspace)**: the same CPF, CNPJ, account
   or phone merges across sources by [identity keys](#identity-keys); the
   [match review](#match-review) suggests the ones a masked CPF kept apart.
4. **[Enrich](#enrichment-tables)** entities from side tables (KYC, devices)
   and promote shared values to nodes.
5. **[Follow the money](#follow-the-money)** forward or backward with a
   chosen allocation rule, and find **[paths](#paths)** between two entities.
6. **[Check typology badges](#typology-badges)** citing the CC 4.001 items.
7. **Mark [roles](#roles-notes-and-the-journal)** (victim, mule, exit),
   write notes, freeze **[evidence](#frozen-evidence)** and write
   **[hypotheses](#dossier)** citing it.
8. **[Read the dossier](#dossier)** and **[record the decision](#decision-freeze-and-retention)**:
   the case freezes and gets its frozen hash.
9. **[Export](#exports)** the Siscoaf summary, the JSON package, the CSV, the
   SIMBA layout or the printed laudo.

An [AI agent](#agents) can do the legwork of steps 1–7 with
your access; the decision and the exports stay with people.

## Who can do what

The app-wide [permissions](./permissions.md) gate five actions. Until an
administrator writes a rule, everyone holds them.

| Permission | Gates | Without it |
|---|---|---|
| `investigation.create` | Creating a case (**New investigation**) | You still work on cases assigned to or shared with you |
| `investigation.upload` | Uploading files to a case (**Upload**, and the agent's `add_item` for CSV) | You still read the material already in a case |
| `investigation.decide` | Recording the decision | You still analyse and write in the case |
| `investigation.share` | Sharing a case and assigning it (owner or superuser) | You still work on it |
| `investigation.agent` | Creating personal agent tokens (only when agents are enabled) | No agent can act for you |

On a given case:

| Who | Sees | Edits (items, annotations, brief) | Records the decision | Shares, deletes |
|---|---|---|---|---|
| Owner | Yes | Yes | Yes (once) | Yes; delete only after the [retention](#decision-freeze-and-retention) period |
| Assignee (an *editor* share automatically), *editor* share | Yes | Yes | Yes (once) | No |
| *Reader* share | Yes | No | No | No |
| Superuser | Every case | Only as owner, assignee or *editor* share | Same | Yes, also a retained case with a reason; transfers cases |
| AI agent | What its owner sees (masked) | What its owner edits; roles, tags, matches, typologies, hypothesis statuses and status changes arrive as **suggestions** a person confirms | Never | Never |
| Anyone else | "Not found": a case's existence does not leak | — | — | — |

- **Sharing is nominal only.** A case is shared with named e-mails, never
  with `*` or `*@domain`: the tipping-off prohibition (Lei 9.613/98 art. 11,
  LC 105/01) requires need-to-know access.
- **Restricted sources.** If a case includes an exploration from a context
  you can't read, you see a locked placeholder with the context name and its
  owner (to ask for access), and none of its nodes; traces, badges and
  exports leave it out too. A table uploaded to the case and mapped onto the
  canvas belongs to the case: everyone who reads the case sees it.
- A case with a recorded decision is **read-only** for everyone.

## Creating a case and adding explorations

1. **New investigation** (top right of the queue) asks for a title and,
   optionally, a typology, origin and assignee.
2. In the case, **Add** opens the picker on **My recent explorations**
   (yours, newest first, with their node count; search by title). An
   exploration saved without a graph is listed but cannot be added.
   Superusers can switch to **All contexts**. Tick one or more; the preview
   counts how many new contexts come in and which
   [identity keys](#identity-keys) they share. The × on a source in the left
   column removes it from the case.
3. Pick the mode:
   - **Live** follows the exploration: later saves show up in the case.
   - **Frozen** copies the exploration's saved graph now, with a SHA-256
     hash, so the case keeps exactly what you saw.

You can also start from the other side: **Add to investigation** on an
exploration in the Explorations list, or from the graph toolbar while an
exploration is open.

A source only shows a graph if its exploration has a **saved graph**
(snapshot). An exploration saved without one appears empty with a warning;
open it, save it, and reload the case.

## Case files

Everything in a case is an **item** of the material list (left column): a
graph (a live reference to a saved exploration, a frozen snapshot, a selection,
an analysis result), a saved query, a table (an uploaded CSV, a query result, an
enrichment table, metrics), a document (upload, markdown, link, the ★ brief at
the top) or a note. Every item has an author chip (person or agent), N
immutable versions with a sha256, and a **pin** that freezes one version as
evidence. Graph items carry an **on canvas** checkbox: unchecking one removes
its nodes without resetting the layout.

**Viewing and downloading.** Selecting an item shows its card in the
inspector, with **Visualizar** and **Baixar** for its latest version. Tables
(CSV, TAB-separated files such as SIMBA, query results) open as a table with
the first 200 rows; markdown, text and JSON open as text; images and PDFs
display inline; HTML renders in a sandboxed frame with scripts off. Anything
else, and files over 20 MB, can only be downloaded. The download keeps the
uploaded file name, and every read is audited (`investigation.item_read`).

**Upload** (needs `investigation.upload` and edit access) opens the file
assistant: pick the files of a layout (a SIMBA delivery is several
TAB-separated files), choose **Graph** (the table is mapped onto the canvas
through a mapping spec — a known layout such as SIMBA v3.1 or the Receita QSA
is detected, and the mapping is JSON you can edit), **Enrichment** (joined by
key to the case's nodes, in the inspector) or **Attachment** (kept with its
hash). No graph context is created: the mapping belongs to the item and the
graph is interpreted from the table on read, keeping its first
`GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES` edges. Agents read uploads as
text (`…/items/{id}/text`: md, txt, csv, json natively; PDF and DOCX when the
optional `pypdf` / `python-docx` are installed); the bytes never reach them.

**Saved queries** (`query` items) keep SQL or Cypher with `:name` parameters
declared like a query template's and the context to run against. **Run** (▶)
executes through the same path as the Query Console and stores the result as a
new version with its `run` metadata (statement id, duration, rows, parameters,
author); re-running adds a version, and any version can be pinned as evidence.

## The workspace

![Investigation workspace](/screenshots/investigations-workspace.png)

- **One canvas.** Every graph item checked *on canvas* in the material list
  shows together; uncheck one to take its nodes out without resetting the
  layout. *Follow the money* appears after a trace.
- **Rings = provenance.** In the unified view each node gets one colored
  ring per source it came from. A node with two rings was found in two
  contexts and merged. The legend on the canvas names each color.
- **Sources panel** (left) lists the sources with their context and node
  count, how many entities were merged and by which key, and the case files.
- **Inspector** (right) shows the selected node's *Data*, its *Enrichment*
  (see [Enrichment tables](#enrichment-tables)), its *Notes* and its
  *Origin*: every source and original id behind it. When sources disagree on
  a property, the first value is kept and the others are listed with the
  source they came from.
- **Expanding** a merged node asks which context to expand from, since each
  context has different neighbors.
- **Filter chips** over the canvas (source, role, tag, group, type, time
  window, 👁 masked) filter visually without resetting the layout; **visões**
  saves the chips, the layout and the closed groups as a `graph/view` item.
- The **analysis bar** (Seguir o dinheiro, Caminhos, Grupos, Tipologias,
  Vínculos, Enriquecer, Métricas) opens a parameter popover; every run is an
  item of the case with its provenance (tool, parameters), shown in the bottom
  strip's *Resultado* tab and pinnable as evidence. Re-running adds a version.
- **Grupos** without code: from the selection (name, color, optionally closed
  into one node) or by property, role, tag, community or component; groups are
  annotations, become chips and appear in the dossier. **Vínculos** links
  entities sharing attributes (phone, device, e-mail, address…) as a
  `graph/derived` layer of `compartilha_<attr>` edges.
- The header's **⚙** edits the case settings (deadlines, members, suggested
  agent writes, vocabularies, identity keys with the generic normalizers
  `device_id | ip | pix_key | card | terminal_id | address | regex`, edge
  semantics by relationship type, label templates); **Dossier** is
  `?mode=dossie` of the same screen.

Everything else the explorer does (labels, styles, filters,
[communities and metrics](./communities-metrics.md), the data table) works
in each tab as it does on a single graph.

### Identity keys

Merging across contexts is driven by **identity keys**, set per context in
the context form (**Identity Keys** section). A key says: nodes of type
`Titular` are the entity `Pessoa`, identified by the property `cpf`,
normalized as CPF/CNPJ. Two contexts that both map to `Pessoa` by CPF merge
their nodes when the normalized values match, so `123.456.789-01` and
`12345678901` become the same node.

| Normalizer | Does |
|---|---|
| `cpf_cnpj` | Digits only, left zeros restored. A masked value (`***.418.207-**`) is never used as a key. |
| `account` | Digits of each part (bank, branch, account) without left zeros. |
| `phone` | Digits only, without the `55` country code. |
| `email`, `lower` | Lowercase and trimmed. |
| `none` | The value as is. |

Nodes without a key never merge: they stay one per context.

### Match review

Entities that look like the same person (a masked CPF with the same middle
digits, a close name) become `same_as` **annotations** (the *Find matches*
button of the canvas, or an agent's `resolve_entities`). They arrive as
suggestions; confirming one in the inspector folds the two entities into one
on the canvas and in every server analysis.

## Enrichment tables

A context can attach side tables (KYC, login devices, chargebacks) in the
context form (**Enrichment Tables** section): the table, its key column, the
node types it applies to and which node value matches the key (the node id or
a property), whether a node has **one** row or **many**, and the columns that
may come out. Optionally, a table **promotes to nodes**: each distinct value
of a column becomes a node of a given type, linked to the nodes that share it
(for example `Dispositivo` by `device_id`, linking the accounts that used the
same device).

- Attaching or changing a table needs the `context.create` permission and a
  table in an allowed catalog.schema (`GRAPH_LAGOON_CATALOG_SCHEMAS`). Anyone
  who can read the context can look it up; a writer without the permission
  can only remove a table.
- In the workspace, the inspector's **Enrichment** tab looks a table up for
  every node of the graph it applies to. A *one row* table adds its columns
  to the nodes' properties; a *many rows* table shows the selected node's rows,
  and with promotion a *Shared by* count (how many nodes of the graph share
  the value). **Promote … to … nodes** adds those nodes and their links to
  the case graph and writes it to the journal.
- A lookup is always by key, returns only the listed columns, is capped
  (`GRAPH_LAGOON_ENRICHMENT_MAX_KEYS`, `GRAPH_LAGOON_ENRICHMENT_MAX_ROWS`)
  and is audited (`enrichment.read`).

## Amount and time

The context form's **Amount and Time** section names the edge properties that
hold each transaction's amount (in units or in cents, with a currency) and its
time (ISO date or datetime, `dd/mm/yyyy [hh:mm]`, or epoch seconds or
milliseconds). A file context gets them from its mapping (the SIMBA preset
sets `valor` and `data`). Each edge then shows its amount and time in the
hover tooltip, and in a case graph every edge keeps its own context's
semantics, so sources that name the amount differently still add up.

Two switches in the **Aesthetics** panel (Edges) use them, in any graph:

- **Sum parallel edges** draws one edge per source, target and type; its
  tooltip shows how many edges it stands for, the amount sum and the first and
  last time. Only the drawing changes: the data table, exports and analyses
  still see every edge.
- **Width by amount** makes each edge's width proportional to its amount (a
  summed edge, to its total). A weight metric chosen in the Metrics panel wins.

Follow the money, earliest-arrival paths and most badges need both.

## Follow the money

Right-click an edge or an account in the case workspace and pick **Follow the
money → forward** (where the money went) or **→ backward** (where it came
from). From an edge, that edge is the seed; from an account, its outgoing
edges (forward) or incoming edges (backward) with an amount and a time. The
**Follow the money** tab opens with:

- **Parameters** on the left: direction, max layers (default 3), max dwell Δ
  (default 24 h; money that sat longer in an account stops being traced), minimum
  amount (default 50), the time window (from the seed, 24 h), the allocation rule
  and the node types to stop at (cash-out, exchange, betting and external banks
  are checked by default). **Trace again** re-runs with the changes.
- **Allocation rule:** forward, FIFO (first in, first out), proportional (splits
  by the balance mix), LIBR (lowest intermediate balance) or total contamination
  (an upper bound). Backward offers LIFO, proportional and total contamination.
- **Layers** draws the traced subgraph in the canvas, one column per layer from
  the seed to the exits; **Sankey** draws the same flow with band width equal to
  the traced value. Chips above show the seed total, how much reached the exits
  and how much stayed in accounts.
- **Exits** on the right: each exit with the traced value under the chosen rule
  (and what the proportional rule would give), the retained balances
  (candidates for a precautionary block) and the method stamp listing every
  parameter of the run.
- **Swimlane timeline** below: one lane per account plus one for the exits, an
  arrow at the time of each traced transfer and a light band for how long the
  money sat in each account. Drag across it to pick a time window: the layers
  and the Sankey then show only the transfers inside it (the exits and the method
  stamp still describe the whole run). Click, or **clear**, to drop the window.

**Save as evidence** freezes the run (the whole result plus its method stamp) as
[frozen evidence](#frozen-evidence).

## Paths

Right-click a node and pick **Path to…**, then click the target node. The path is
selected (highlighted) in the canvas and named in the bar on top, which picks the
method:

- **Fewest hops (BFS)**;
- **Lightest (Dijkstra)**, weighting each edge 1 per hop or 1 / amount (big
  transfers first; edges without an amount are skipped);
- **k shortest (Yen)**, up to 10 paths, browsed with ‹ ›;
- **Earliest arrival**: only transfers that happen after the money reached the
  account, arriving as early as possible.

**follow direction** off walks edges both ways (earliest arrival always follows
direction). Ties are broken by node and edge id, so the same graph gives the same
path.

The trace and the paths also run on the server, over the unified graph of the
sources you can read: `POST /api/investigations/{id}/analysis/trace` and
`…/analysis/paths` (the agent tools `trace_money` and `find_paths`). They give
the same numbers as the screen, return the method stamp (with
`engine: "server"` and the restricted sources left out) and write `trace.run` /
`path.run` to the journal.

## Typology badges

**Typology badges** (bottom-left of the canvas) swaps the left column for the
patterns found in the unified graph, each citing its item of the BCB Circular
4.001/2020:

| Badge | Finds | CC 4.001 |
|---|---|---|
| Pass-through | inflows with ≥ 90% sent on within 24 h (FIFO) | IV-k, IV-ad |
| Many origins | ≥ 10 distinct payers within 7 days | I-h, IV-n |
| Many destinations | ≥ 10 distinct payees within 7 days | IV-o, IV-p |
| Structuring | ≥ 3 transfers below R$ 50,000 within 7 days summing ≥ the limit, or one ≥ 90% of it | I-d, I-e, I-k, I-m, IV-b |
| Cycle | money that comes back in time order in 2–6 hops (≥ 50%) | layering |
| Shared element | a partner, account, terminal, device or address linked (by an edge with no amount) to ≥ 3 unrelated entities of one type | III-f, III-i, III-k, III-l |
| Dormant reactivated | 180 days idle, then ≥ R$ 10,000 within 30 days | IV-e, IV-f |

Click a badge to highlight its entities; **Bipartite layout** puts the most common
node type on one axis and everything else on the other (a two-axis hive). Badges
only suggest: **Accept** writes `typology.accepted` to the journal, and the dossier
and the Siscoaf summary show the accepted badges with their norm item. The server
gives the same badges at `POST …/analysis/typologies` and to agents as
`run_typologies`.

## Roles, notes and the journal

- **Role.** The inspector's *Role* selector marks an entity with a role of the
  case's vocabulary (victim, mule, exit, discarded and any role already used in
  the case; presets will suggest more). Roles are `role` annotations; an
  agent's arrive as suggestions shown in the inspector with **Confirm** and
  **Reject** in place.
- **Notes.** The *Notes* tab of the inspector holds notes anchored on the
  selected entity (`note` items); the material list adds free notes and
  markdown documents.
- **Journal.** The *Journal* button in the status bar lists every change to
  the case with author and time: creation, edits, shares, items added, versions
  and pins, roles, tags, groups, matches, hypotheses, typologies, traces and
  paths, suggestions confirmed or rejected and the decision. Entries are
  append-only; the decision computes a `frozen_hash` over them and the pinned
  versions, verified on every export. An agent's entries read "agent X on
  behalf of Y".
- **Metrics as properties.** In the explorer, *Save as property* on a computed
  node metric (Metrics panel) writes its values into the node properties and
  saves them in the exploration's snapshot. Every case that references the
  exploration gets a journal entry naming the metric and the property.

## Frozen evidence

Evidence is a **pinned version** of an item: immutable, with its sha256,
author and time, and never unpinned.

- **📌** on a material row pins the current version; pinning a live exploration
  reference freezes its snapshot first.
- **Pin evidence** (canvas toolbar) freezes what the canvas shows as a
  `graph/snapshot` item and pins it;
- **Save as evidence** on the Follow the money tab keeps the trace result as a
  `table/result` item stamped with its method (every parameter of the run) and
  pins it.

API: `POST /api/investigations/{id}/items/{item}/pin` with `{version?, label?}`;
the dossier numbers pinned versions E1, E2, … Agents pin with `pin_evidence`.

## Dossier

**Dossier** in the workspace header opens the case as a document
(`?mode=dossie`, the same store; old `/dossier` links redirect):

- **Summary**: the description, typology, origin and how many entities hold
  each role, with indicators (sources and how many are restricted, evidence,
  hypotheses by status, notes, journal events, pending proposals) and the
  accepted typology badges;
- **Hypotheses**: each one (H1, H2, …) with its status (**open**,
  **supported** or **refuted**) and the evidence **for** and **against** it.
  Write a new one at the bottom; change the status or link and unlink evidence
  in the row. Hypotheses are never deleted: a wrong one is refuted. Every change
  goes to the journal;
- **Frozen evidence**: E1, E2, … in the order they were frozen, with the kind,
  the short hash, how it was made (the trace method stamp, or the tab and its
  size) and who froze it;
- **Journal**: the latest entries, or all of them;
- **Decision panel** on the right: records the decision and holds the exports.

API: hypotheses are `hypothesis` annotations (`POST /api/investigations/{id}/annotations`
with `{kind: "hypothesis", value: {text, status?, evidence_for?, evidence_against?}}`,
`PATCH …/annotations/{aid}`); a status change is a `hypothesis_status`
annotation on it (open, supported, refuted). Agents read it all with
`list_annotations` and suggest with `annotate`.

## Deadlines

The header and the queue show the case's **deadline** when its type has
phases: *seleção* while the case is open, then *análise*. Both count from the
case's `alert_at` (else `occurred_at`, else its creation). The days per phase
come from `GRAPH_LAGOON_INVESTIGATION_DEADLINE_DAYS` (JSON by case type;
default `{"pix_med": {"selection": 45, "analysis": 45}}`, Circ. 3.978) and a
case may override them in its settings (⚙ → prazos, `deadline_days`). A type
without an entry has no deadline. Under 7 days left the badge turns orange
(`#9a3412`); the bar shows how much of the phase is used. The API returns it as
`deadline: {phase, due_at, days_left, total_days}`, `null` once decided or
archived.

## Decision, freeze and retention

Pick the **outcome** (*Comunicar ao COAF via Siscoaf*, *Arquivar com
fundamentação*, *Medida cautelar* or *Apenas parecer*), the **actions** taken
with it (DICT, SPA, bloqueio cautelar) and write the **rationale**, pre-filled
with the supported hypotheses and the pinned evidence. The app records these
actions; it does not perform them (there is no DICT, SPA or Siscoaf
connection). **Registrar decisão** then, in one step:

1. writes `decision.recorded` to the journal, with the outcome, actions,
   rationale and reviewer;
2. computes the case's **frozen hash**: the sha256 of the canonical JSON
   (sorted keys) of the case and its decision, the **pinned versions** (item,
   version, sha256, label, who pinned) and the **journal up to the decision**;
3. sets `status: "decided"` and `frozen_at`.

From then on the case is **read-only**: every change answers
`409 INVESTIGATION_DECIDED`, except archiving it and sharing it (an auditor can
be given access). Those lines go to the journal after the decision and stay out
of the hash, so it can be recomputed and compared at any time: every export
does (see below).

The decision is a person's: owner, assignee or an editor share records it,
once. Agents cannot (LGPD art. 20; agents suggest, people decide). **Reabrir**
(decided → analysis, people only) clears the decision and the hash from the
case; both stay in the journal (`case.reopened`).

**Archiving.** `archived` is reached from `decided`, or from an open case with
an explicit reason: the status select asks for it and sends
`{status: "archived", archive_reason}`; without one the API answers
`422 ARCHIVE_REASON_REQUIRED`. The reason is journaled as
`case.archived_without_decision`. Agents cannot archive without a decision.

**Retention.** A decided case cannot be deleted for
`GRAPH_LAGOON_INVESTIGATION_RETENTION_YEARS` (default 10) after its
decision: `DELETE` answers `409 INVESTIGATION_RETAINED`, except for a
superuser who gives a reason (`DELETE /api/investigations/{id}?reason=…`),
which the audit log records. Deleting a case removes its rows and **every
blob** of the case from the storage (item versions and their text
extractions).

API: `POST /api/investigations/{id}/decision` with
`{outcome: "comunicar" | "arquivar" | "medida" | "parecer", actions: ["dict" | "spa" | "bloqueio_cautelar"], rationale, reviewer_email?}`;
returns the case with `status: "decided"`, `decision`, `frozen_hash` and
`frozen_at`. Recording is audited (`investigation.decide`).

## Exports

The dossier and the decision panel export the case. Each export is a download,
generated on request from what you can read, in any status, and recorded in
the audit log with its format and sha256. Exporting is a read: it adds nothing
to the journal, so the frozen hash stays reproducible. Every format
**recomputes the frozen hash** and reports
`integrity: {frozen_hash, verified}` (`verified: null` while undecided,
`false` when a pinned version or a journal line no longer matches).

| Button | Format | What it holds |
|---|---|---|
| **Resumo Siscoaf** | `siscoaf` (JSON) | The decision, the involved entities with their role, type, name, document and account, the transactions that touch them (count, total, first and last date), the confirmed CC 4.001 badges, a narrative (description + rationale), evidence (E1, E2, … with hashes), the tables flagged for the dossier, trace methods and `integrity`. To paste into Siscoaf: the app has no Siscoaf connection and sends nothing |
| **Pacote JSON** | `json` | The whole case record: case and decision, `integrity`, roles, hypotheses, annotations, every item with its versions, `evidence` (the pinned versions), `dossier` (the latest run of each table flagged *usar no dossiê*), trace methods and the journal |
| **CSV** | `csv` | The same record flattened, one row per item (`section, id, title, kind, sha256, detail, actor, at`; sections `case, decision, item, evidence, dossier, annotation, event`), through `utils/csv_safe`: a cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'` |
| **Layout SIMBA** | `simba` (zip) | The case's transactions as `…_EXTRATO.TXT`, `…_ORIGEM_DESTINO.TXT` and `…_TITULARES.TXT` (SIMBA v3.1: TAB, Latin-1, ddmmyyyy, cents) plus `MANIFEST.json` with the hashes, the verification and the trace methods. The *SIMBA v3.1* import preset reads it back |
| **Laudo PDF** | print | The dossier printed by the browser (*Salvar como PDF*): summary, hypotheses, evidence with method stamps and hashes, the full journal, the decision with the frozen hash, and the hashes of every item. Navigation and controls are left out |

How the SIMBA layout is written: each transaction (an edge with an amount) is
a lançamento of the end that has an account (`banco`, `agencia`, `conta`
properties, as an imported SIMBA gives), debit when money leaves it; the
other end is the counterpart, by its CPF/CNPJ and name, or agency 9999
(NAO-CORRENTISTA) when it has no document. Restricted sources are not
exported.

API: `GET /api/investigations/{id}/export?format=json|csv|simba|siscoaf`.
Agents cannot export (exports leave the app with unmasked data); they read
the case through the MCP tools.

## Case space

The case space, the match review page and the agents page of the first plan are
gone: artifacts are `document` items of the material list (an agent's arrive
with its author chip), matches are `same_as` annotations reviewed in the
inspector, and agent tokens live in the account menu (**Agents**).

## Agents

An agent is an analyst with the identity of the person who created its token:
it can do what that person can in a case (read, add items and versions, run
queries and analyses, group, annotate, write the brief) except decide, share,
delete, reopen, export and confirm suggestions. Its writes are attributed to it
(chip **agent** on items, annotations and journal lines; filter Pessoa / Agente
/ Tudo) and the kinds in the case's ⚙ **Agent** section
(`settings.agent_suggest_kinds`, by default roles, tags, matches, typologies,
hypothesis statuses and status changes) arrive **suggested**: the material list
and the inspector show them with **Confirm** and **Reject** in place, and the
queue counts them. Tokens are created on the **Agents** page of the account
menu (`/settings/agents`): scope "every case I read" or specific cases,
optional unmasked data when the org allows it, validity, last activity, and
the commands for Claude Code and for the stdio bridge; the case footer shows
how many of your agents reach it. Playbooks (admin area → **Library**) are the
agent's prompts and the **Vocabularies** tab holds the suggested roles, tags,
typologies and link attributes per case type, which the ⚙ offers with one
click. How to connect a client, the resources and the tools are in
[AI Agents (MCP)](./agents-mcp.md).

## Personal data

- **In the app** people see the data their contexts and files hold, as they
  are. A masked CPF in the source stays masked and never merges by
  identity key.
- **Agents** see CPF, CNPJ and account numbers **masked** by default
  (`***.456.789-**`, accounts down to the last two digits), including inside
  entity ids; see [Personal data](./agents-mcp.md#personal-data).
- **Exports** leave the app unmasked, which is why they need
  `investigation.export`, are human-only and are audited with their sha256.
- **Files and frozen copies** live in the case storage and are reached only
  through the app, which checks access on every read.

## Settings

All optional; the defaults suit a single analyst team. Details in
[Configuration](./configuration.md#investigation-storage).

| Variable | Default | Does |
|---|---|---|
| `GRAPH_LAGOON_INVESTIGATIONS_VOLUME_PATH` | `{DATABRICKS_VOLUME_PATH}/investigations`, else `{EXPLORATION_SNAPSHOTS_DIR}/investigations` | Where files, frozen sources, evidence and artifacts are stored |
| `GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES` | `209715200` (200 MB) | Largest file uploaded to a case |
| `GRAPH_LAGOON_ARTIFACT_MAX_BYTES` | `104857600` (100 MB) | Largest artifact version in the case space |
| `GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES` | `50000` | Edges kept from a file graph |
| `GRAPH_LAGOON_INVESTIGATION_RETENTION_YEARS` | `10` | Years a decided case cannot be deleted |
| `GRAPH_LAGOON_ENRICHMENT_MAX_KEYS` / `_MAX_ROWS` | `500` / `5000` | Keys per enrichment lookup / rows it returns |
| `GRAPH_LAGOON_AGENTS_ENABLED` | `false` | Agent tokens and the `/mcp` server ([AI agents](./configuration.md#ai-agents)) |
| `GRAPH_LAGOON_AGENT_TOKEN_MAX_DAYS` | `90` | Longest token validity |
| `GRAPH_LAGOON_AGENTS_ALLOW_UNMASKED_DATA` | `false` | Agents read CPF, CNPJ and accounts unmasked |
| `GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE` | `120` | Requests per minute per agent token |

## Limits and known gaps

This is an MVP. What it does not do yet, so you can plan around it:

- **Transfer** of a case to another owner is done by superusers in the
  admin area only.
- **Deadlines** exist only for presets with phases (Pix/MED: 45 + 45 days
  from the alert, or the case's `deadline_days`); there are no notifications
  and no special deadlines (the 24 h SPA notice).
- **Case graph size.** Everything renders in the browser; a file graph keeps
  only its first `GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES` edges.
  Tracing in the warehouse (SQL) is not available.
- **Promoted enrichment nodes** live in your session: pin evidence to keep
  them. Enrichment files have no promotion or *Shared by* count, and a
  lookup covers the first 500 keys of a graph.
- **Badges:** *Structuring* counts 7 calendar days instead of 5 business
  days; the incompatible POS pattern (CC 4.001 IV-v to IV-z) is missing,
  since acquirer POS data is not modeled.
- **Material** has no drag-and-drop, paste or multi-table operations yet
  (join, compare, promote); the "+ Add" popover with queries and files, saved
  views and groups from the selection arrive with the next phases.
- **Exports:** the laudo is the browser's *Save as PDF*, not a server PDF,
  and it has no digital signature; there is no Siscoaf, DICT or SPA
  connection; the whole case is exported, never a subset.
- **Uploads** go in one request (no chunked upload), so a proxy limit below
  `GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES` wins.
- **Agent rate limit** is counted per server process (N workers allow N× the
  limit).

## Admin area

Superusers get an **Investigations** tab in the admin area with every case
and its owner, assignee, status and item count, plus **Transfer** to hand a
case to a new owner (for example when someone leaves); the case journal
records the transfer too. Creations, edits, shares, items added or removed and
transfers are in the **Audit** tab, along with recorded decisions
(`investigation.decide`, with the outcome and the frozen hash), exports
(`investigation.export`, with the format and the sha256 of the file), item
content reads, enrichment lookups (`enrichment.read`) and every agent read
(`agent.read`). The **Library** and **Vocabularies** tabs edit the org's
playbooks and suggested vocabularies (audited as `library.*` and
`vocabulary.*`); the **Agent tokens** tab lists everyone's tokens with their
last activity. The five `investigation.*` permissions appear in the
permission matrix of [Groups & Permissions](./permissions.md).
