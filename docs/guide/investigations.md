# Investigations

::: tip TL;DR
A **case** that gathers explorations from **different contexts** into one
workspace, merges the same person or account across them, and keeps a
tamper-evident journal of everything done on it.

- **Use it when** a fraud, AML or risk analysis spans more than one graph
  (Pix transfers in one context, customer records in another) and you need
  them on one canvas, with who-did-what recorded.
- **Not the tool for** a single exploration you just want to save or share
  (that's [Explorations & Sharing](./explorations.md)), or for loading files,
  following the money and writing the final report — those arrive in later
  releases.
:::

An investigation is a case file. It does not copy data out of the
warehouse: it points at explorations you already have, from any context you
can read, and shows them side by side and merged. Open **Investigations** in
the top navigation to see the queue of cases you own, are assigned to, or
that were shared with you.

![Investigation queue](/screenshots/investigations-queue.png)

The queue shows each case's typology, number of sources, status, assignee
and deadline (45 days from creation while awaiting selection, 45 days from
selection while in analysis). Filter by text or status; the counters on top
summarize the open work.

## Creating a case and adding explorations

1. **New investigation** (top right of the queue) asks for a title and,
   optionally, a typology, origin and assignee. The button only shows if you
   hold the `investigation.create` [permission](./permissions.md).
2. In the case, **+ Add** opens the picker: your explorations grouped by
   context. Tick one or more; the preview counts how many new contexts come
   in and which [identity keys](#identity-keys) they share.
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

## The workspace

![Investigation workspace](/screenshots/investigations-workspace.png)

- **Tabs.** *Unified view* shows every source together; each source also has
  its own tab, exactly as the exploration looks on its own. Selecting an
  entity in one tab keeps it selected in the others.
- **Rings = provenance.** In the unified view each node gets one colored
  ring per source it came from. A node with two rings was found in two
  contexts and merged. The legend on the canvas names each color.
- **Sources panel** (left) lists the sources with their context and node
  count, and how many entities were merged and by which key.
- **Inspector** (right) shows the selected node's *Data*, its *Notes* and its
  *Origin*: every source and original id behind it. When sources disagree on
  a property, the first value is kept and the others are listed with the
  source they came from.
- **Expanding** a merged node asks which context to expand from, since each
  context has different neighbors.

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

## Roles, notes and the journal

- **Role.** The inspector's *Role* selector marks an entity as **Victim**
  (blue fill), **Mule / suspect** (orange), **Exit (cash-out)** (navy) or
  **Discarded** (gray). The fill applies in every tab.
- **Notes.** The *Notes* tab of the inspector holds notes on the selected
  entity. Anyone who can edit the case adds them; only the author can delete
  one.
- **Journal.** The *Journal* button in the status bar lists every change to
  the case with author and time: creation, edits, shares, sources added or
  removed, roles and notes. Entries cannot be edited or deleted, and each one
  is chained to the previous by a hash, so a gap or a rewrite is detectable.
  Deleting a note keeps its text in the journal.

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
- Uploads, new versions and approvals go to the journal. Files live in the
  case storage (a Unity Catalog Volume on Databricks, see
  [Configuration](./configuration.md#investigation-storage)) and are only
  reached through the app, which checks access.

## Agents and proposals

The **Agents** button in the case header (with the number of pending
proposals) opens the agents page of the case. It needs agents turned on by
the administrator (see [Configuration](./configuration.md#ai-agents)).

- **Connect an agent.** Create a personal token: a name, what the agent may
  do (read, run analyses, write notes and draft artifacts, make proposals)
  and a validity. The token is shown **once**, inside the command to add the
  app to Claude Code; only its hash is stored. Revoke it under *Active
  tokens*. The agent acts with your access and never more.
- **Proposals.** An agent cannot change an entity's role, the case status
  or its typology directly: it proposes. Each proposal shows what it would
  change and the agent's rationale. **Accept** applies it exactly as if you
  had made the change yourself; **Reject** asks for a reason. Both go to the
  journal with who proposed and who decided. Only people decide.
- **Agent activity** lists what agents did on the case. In the journal,
  their entries read "agent X on behalf of Y".

## Access and sharing

- **Who sees a case:** its owner, its assignee, the people it was shared
  with, and superusers. Anyone else gets "not found", so a case's existence
  does not leak.
- **Who edits:** the owner, the assignee and people with a *write* share. A
  case with a recorded decision is read-only.
- **Sharing is nominal only.** A case is shared with named e-mails, never
  with `*` or `*@domain`: the tipping-off prohibition (Lei 9.613/98 art. 11,
  LC 105/01) requires need-to-know access.
- **Restricted sources.** If a case includes an exploration from a context
  you can't read, you see a locked placeholder with the context name and its
  owner (to ask for access), and none of its nodes.

## Admin area

Superusers get an **Investigations** tab in the admin area with every case
and its owner, assignee, status and sources, plus **Transfer** to hand a case
to a new owner (for example when someone leaves). Transfers, creations,
edits, shares and source changes are in the **Audit** tab; the case journal
records the transfer too.
