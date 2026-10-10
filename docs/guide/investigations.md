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
  decide (agents only propose, see [AI Agents (MCP)](./agents-mcp.md)).
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

An [AI agent](#agents-and-proposals) can do the legwork of steps 1–7 with
your access; the decision and the exports stay with people.

## Who can do what

The app-wide [permissions](./permissions.md) gate four actions. Until an
administrator writes a rule, everyone holds them.

| Permission | Gates | Without it |
|---|---|---|
| `investigation.create` | Creating a case (**New investigation**) | You still work on cases assigned to or shared with you |
| `investigation.upload` | Uploading files to a case (**Add file…**, and the agent's file tools) | You still read the files already in a case |
| `investigation.export` | The export buttons and the laudo | You still read the case in the app |
| `investigation.agent` | Creating personal agent tokens (only when agents are enabled) | No agent can act for you |

On a given case:

| Who | Sees | Edits (sources, files, roles, notes, evidence, hypotheses, artifacts) | Records the decision | Shares, deletes |
|---|---|---|---|---|
| Owner | Yes | Yes | Yes (once) | Yes; delete only after the [retention](#decision-freeze-and-retention) period |
| Assignee, *write* share | Yes | Yes | Yes (once) | No |
| *Read* share | Yes | No | No | No |
| Superuser | Every case | Only as owner, assignee or *write* share | Same | Yes, also a retained case with a reason; transfers cases |
| AI agent | What its owner sees | What its owner edits, within its [scopes](./agents-mcp.md#scopes) | Never | Never |
| Anyone else | "Not found": a case's existence does not leak | — | — | — |

- **Sharing is nominal only.** A case is shared with named e-mails, never
  with `*` or `*@domain`: the tipping-off prohibition (Lei 9.613/98 art. 11,
  LC 105/01) requires need-to-know access.
- **Restricted sources.** If a case includes an exploration from a context
  you can't read, you see a locked placeholder with the context name and its
  owner (to ask for access), and none of its nodes; traces, badges and
  exports leave it out too. A graph generated from a case file is readable
  by everyone who reads the case.
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

The **Files** section of the left column lists the files uploaded to the case
(bank statements in the SIMBA layout, the Receita QSA, any CSV) with their
role, size and sha256.

**Add file…** opens the file assistant (needs `investigation.upload` and edit
access to the case). Its five steps:

1. **Files**: pick every file of the layout at once (a SIMBA delivery is
   five TAB-separated files).
2. **Role**: **Graph** (becomes a source of the case), **Enrichment**
   (joined to the case's nodes by key) or **Attachment** (kept as is).
3. **Map columns**: a known layout (SIMBA v3.1, Receita QSA) is detected
   from the file names and headers. The table shows what each column
   becomes and how it is converted (cents, `ddmmaaaa` dates, `C`/`D` as
   the direction of the money). The mapping itself is JSON you can edit;
   it is checked as you type and saved, by name, with the file. The
   quality panel shows the share of transactions without an identified
   counterpart, the “Desconhecido” nodes (one per unidentified
   transaction, never grouped), discarded rows with the reason, and a
   preview of the first edges.
4. **Identity**: node types whose id is normalized as a CPF/CNPJ,
   account, phone or e-mail merge with the other sources of the case.
5. **Review**: **Add to case** uploads the files and, for the graph
   role, the server builds the graph and adds it as a source that opens
   in its own tab.

- An **Enrichment** file (for example the Receita QSA) is configured in step 3:
  the key column, the columns to show, the node types it enriches, the node
  property holding the key (or the node id) and, optionally, how many leading
  digits to compare (8 turns a merchant's CNPJ into the QSA's CNPJ básico). Its
  rows then show in the inspector's **Enrichment** tab of matching nodes. The
  join runs in your browser and only inside this case: the file never becomes
  part of a context.
- A file graph lives in a **file context**: it can be opened and expanded but
  not queried (no Query Console, no SQL, no Cypher). Only its first
  `GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES` edges are kept; the journal
  records how many were dropped.
- The server computes the sha256 while receiving the file and stores it by
  that hash; uploading the same bytes again reuses the stored copy. Files
  above `GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES` are refused (413).
- Uploads and every read of a file's content go to the audit log; uploads
  also go to the journal.

## The workspace

![Investigation workspace](/screenshots/investigations-workspace.png)

- **Tabs.** *Unified view* shows every source together; each source also has
  its own tab, exactly as the exploration looks on its own. Selecting an
  entity in one tab keeps it selected in the others. *Follow the money*
  appears after a trace; *Case space* holds the [artifacts](#case-space).
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
- The header links to the **Dossier**, **Matches** (open suggestions) and
  **Agents** (pending proposals) pages of the case.

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

The **Matches** page finds entities that may be the same person even though
no identity key joined them: the 6 central CPF digits are equal and **at
least one side has a masked CPF** (a full CPF already merges by identity
key). The score adds a name similarity (Jaro-Winkler, after removing accents
and DE/DA/DO/DOS/DAS/E), the CPF digits and the same 5-digit CEP; from 0.85
up it becomes a suggestion.

- The queue is ordered by how many new connections accepting would bring,
  then by score. Each suggestion shows both entities side by side with the
  compared values highlighted, the reasons and the effect of accepting.
- **Nothing merges by itself**, least of all with a masked CPF. *Same entity*,
  *Not the same* and *Defer* each need a reason, which goes to the journal.
  An accepted match joins the two entities in the unified view; accepted and
  rejected are final, a deferred one stays in the queue.
- Agents run the same search (`suggest_matches`) and **propose** a decision;
  a person accepts it on the Agents page.

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

- **Role.** The inspector's *Role* selector marks an entity as **Victim**
  (blue fill), **Mule / suspect** (orange), **Exit (cash-out)** (navy) or
  **Discarded** (gray). The fill applies in every tab.
- **Notes.** The *Notes* tab of the inspector holds notes on the selected
  entity. Anyone who can edit the case adds them; only the author can delete
  one.
- **Journal.** The *Journal* button in the status bar lists every change to
  the case with author and time: creation, edits, shares, sources and files
  added or removed, roles, notes, enrichment promotions, traces and paths,
  accepted badges, evidence, hypotheses, matches, proposals and the
  decision. Entries cannot be edited or deleted, and each one is chained to
  the previous by a hash, so a gap or a rewrite is detectable. Deleting a
  note keeps its text in the journal; an agent's entries read "agent X on
  behalf of Y".
- **Metrics as properties.** In the explorer, *Save as property* on a computed
  node metric (Metrics panel) writes its values into the node properties and
  saves them in the exploration's snapshot. Every case that has the exploration
  as a source gets a journal entry naming the metric and the property.

## Frozen evidence

An evidence is a frozen, immutable copy of something the case relies on:

- **Pin evidence** (canvas toolbar of the workspace) freezes what the current tab
  shows: its nodes, edges, the roles on them and the selected node;
- **Save as evidence** on the Follow the money tab freezes the trace result with
  its method stamp (every parameter of the run).

Each evidence stores a gzipped snapshot in the case storage together with its
title, parameters, author and time, and the **sha256** of that file. There is no
edit or delete: the copy is written once, the hash is checked on every read and
the journal records `evidence.created` with the hash. API:
`POST /api/investigations/{id}/evidence` with `{title, kind, params, snapshot}`
(`kind` is `graph_state`, `trace`, `table` or `file`), `GET …/evidence` and
`GET …/evidence/{eid}` (with the snapshot). Agents pin evidence directly with
`pin_evidence`.

## Dossier

**Dossier** in the workspace header opens the case as a document:

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

API: `POST /api/investigations/{id}/hypotheses` with
`{text, status?, evidence_for?, evidence_against?, note?}` and
`PATCH …/hypotheses/{hid}` (the evidence lists are replaced); both return the
case, whose `state.hypotheses` holds them. Agents read it all with
`get_dossier` and propose hypotheses (`hypothesis`, `hypothesis_status`).

## Decision, freeze and retention

Pick the **outcome** (*Communicate to COAF via Siscoaf* or *Archive with a
rationale*), the **actions** taken with it (flag the accounts in DICT,
notify the SPA, request a precautionary block) and write the **rationale**,
citing the evidence. The app records these actions; it does not perform them
(there is no DICT, SPA or Siscoaf connection). **Record decision** then, in
one step:

1. freezes every **live** source (the same frozen copy with sha256 that
   adding a source as *frozen* makes), so the case no longer follows the
   explorations it points at;
2. writes `decision.recorded` to the journal, with the outcome, actions,
   rationale and the hash of each source it froze;
3. computes the case's **frozen hash**: the sha256 of the canonical record of
   the case (title, description, typology, origin and the decision; state with
   roles and hypotheses; sources with their hashes; files and evidence with
   their hashes; journal up to the decision). The dossier shows it next to the
   decision.

From then on the case is **read-only**: every change (edit, roles, notes,
evidence, hypotheses, sources, files, proposals, matches, artifacts, another
decision) answers `409 INVESTIGATION_DECIDED`. Sharing still works, so an
auditor can be given access; that line goes to the journal after the
decision and stays out of the hash, so the hash can be recomputed and
compared at any time (the JSON export does it, see below).

The decision is a person's: owner, assignee or a *write* share records it,
once. Agents cannot (LGPD art. 20; agents propose, people decide).

**Retention.** A decided case cannot be deleted for
`GRAPH_LAGOON_INVESTIGATION_RETENTION_YEARS` (default 10) after its
decision: `DELETE` answers `409 INVESTIGATION_RETAINED`, except for a
superuser who gives a reason (`DELETE /api/investigations/{id}?reason=…`),
which the audit log records.

API: `POST /api/investigations/{id}/decision` with
`{outcome: "comunicar" | "arquivar", actions: ["dict" | "spa" | "bloqueio_cautelar"], rationale}`;
returns the case with `status: "decidido"`, `decision`, `frozen_hash` and
`frozen_at`. Recording is audited (`investigation.decide`).

## Exports

The decision panel also exports the case, for people with the
`investigation.export` permission (the buttons are hidden without it). Each
export is a download, generated on request from what you can read, in any
status, and recorded in the audit log with its format and sha256. Exporting
is a read: it adds nothing to the journal, so the frozen hash stays
reproducible.

| Button | Format | What it holds |
|---|---|---|
| **Siscoaf summary** | `siscoaf` (JSON) | The decision, the involved entities with their role, type, name, document and account, the transactions that touch them (count, total, first and last date), the accepted CC 4.001 badges, a narrative (description + rationale), evidence (E1, E2, … with hashes), trace methods, file hashes and the frozen hash. To paste into Siscoaf: the app has no Siscoaf connection and sends nothing |
| **Package JSON** | `json` | The whole case record: case and decision, the frozen hash and whether it still verifies (`frozen_hash_valid`), roles, hypotheses, sources (redacted as on screen), files, evidence and trace methods with their hashes, notes and the journal |
| **CSV** | `csv` | The same record flattened, one row per item (`section, id, title, kind, sha256, detail, actor, at`), safe against spreadsheet formulas: a cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'` |
| **SIMBA layout** | `simba` (zip) | The case's transactions as `…_EXTRATO.TXT`, `…_ORIGEM_DESTINO.TXT` and `…_TITULARES.TXT` (SIMBA v3.1: TAB, Latin-1, ddmmyyyy, cents) plus `MANIFEST.json` with the hashes and trace methods. The *SIMBA v3.1* import preset reads it back |
| **Laudo PDF** | print | The dossier printed by the browser (*Save as PDF*): summary, hypotheses, evidence with method stamps and hashes, the full journal, the decision with the frozen hash, and the hashes of every source and file. Navigation and controls are left out |

How the SIMBA layout is written: each transaction (an edge with an amount) is
a lançamento of the end that has an account (`banco`, `agencia`, `conta`
properties, as an imported SIMBA gives), debit when money leaves it; the
other end is the counterpart, by its CPF/CNPJ and name, or agency 9999
(NAO-CORRENTISTA) when it has no document. Restricted sources are not
exported.

API: `GET /api/investigations/{id}/export?format=json|csv|simba|siscoaf`.
Agents cannot export (exports leave the app with unmasked data); they read
the case with `get_dossier`.

## Case space

The **Case space** tab keeps the case's artifacts: slides, documents,
reports, images and data (`md`, `txt`, `pdf`, `png`, `jpg`, `pptx`, `docx`,
`xlsx`, `csv`, `json`, `html`, `svg`).

- **Upload artifact** adds a file; **New version** adds a version of the
  selected one (same file type). A version never replaces the previous one:
  each is stored separately with its sha256, author and note, and the list
  on the right shows them all.
- **Preview:** `md` and `txt` show as plain text, images and PDFs in place.
  `html` and `svg` are **download only**: they are never opened in the
  browser, since they can carry scripts. The other types are download only.
- **Approve.** Every version starts as a *draft*. Only a person with edit
  access approves it; an AI agent can upload drafts but never approve.
- Uploads, new versions and approvals go to the journal.

## Agents and proposals

The **Agents** button in the case header (with the number of pending
proposals) opens the agents page of the case. It needs agents turned on by
the administrator (`GRAPH_LAGOON_AGENTS_ENABLED`) and, to create a token, the
`investigation.agent` permission.

- **Connect an agent.** Create a personal token: a name, what the agent may
  do (read, run analyses, write, propose) and a validity. The token is shown
  **once**, inside the command to add the app to Claude Code; only its hash
  is stored. Revoke it under *Active tokens*. The agent acts with your access
  and never more.
- **Proposals.** Each proposal shows what it would change and the agent's
  rationale. **Accept** applies it exactly as if you had made the change
  yourself; **Reject** asks for a reason. Both go to the journal with who
  proposed and who decided.
- **Agent activity** lists what agents did on the case.

| An agent… | What |
|---|---|
| **does directly** (journaled as "agent X on behalf of Y") | read the case, graph, files and dossier; run matches, traces, paths and badges; create cases, add sources, upload files and build file graphs; write notes; freeze evidence; upload artifacts as **drafts** |
| **proposes** (a person accepts or rejects) | an entity role, a match decision, a hypothesis or its status, the typology, the case status |
| **never does** (no tool; the routes answer 403 to agent tokens) | record the decision, export, share, delete, approve an artifact, accept or reject a proposal or a match, mint tokens |

How to connect Claude Code or Claude Desktop, the scopes and the ready-made
prompts are in [AI Agents (MCP)](./agents-mcp.md).

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
- **Deadlines** count calendar days from the alert (or creation) and from
  `selected_at`; there are no notifications and no special deadlines (the
  24 h SPA notice).
- **Case graph size.** Everything renders in the browser; a file graph keeps
  only its first `GRAPH_LAGOON_INVESTIGATION_MAX_WORKING_EDGES` edges.
  Tracing in the warehouse (SQL) is not available.
- **Promoted enrichment nodes** live in your session: pin evidence to keep
  them. Enrichment files have no promotion or *Shared by* count, and a
  lookup covers the first 500 keys of a graph.
- **Accepted matches** join entities in the browser's unified view only; the
  server's unified graph (server trace, paths, badges and agent tools) still
  keeps them apart.
- **Badges:** *Structuring* counts 7 calendar days instead of 5 business
  days; the incompatible POS pattern (CC 4.001 IV-v to IV-z) is missing,
  since acquirer POS data is not modeled.
- **Evidence** from an enrichment row or a file has no button (the API takes
  `kind: table` or `file`); evidence has no thumbnail.
- **Exports:** the laudo is the browser's *Save as PDF*, not a server PDF,
  and it has no digital signature; there is no Siscoaf, DICT or SPA
  connection; the whole case is exported, never a subset; case files have
  no download button.
- **Uploads** go in one request (no chunked upload), so a proxy limit below
  `GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES` wins.
- **Agent rate limit** is counted per server process (N workers allow N× the
  limit).

## Admin area

Superusers get an **Investigations** tab in the admin area with every case
and its owner, assignee, status and sources, plus **Transfer** to hand a case
to a new owner (for example when someone leaves); the case journal records
the transfer too. Creations, edits, shares, source changes and transfers are
in the **Audit** tab, along with recorded decisions (`investigation.decide`,
with the outcome and the frozen hash), exports (`investigation.export`, with
the format and the sha256 of the file), file reads, enrichment lookups
(`enrichment.read`) and every agent read (`agent.read`). The four
`investigation.*` permissions appear in the permission matrix of
[Groups & Permissions](./permissions.md).
