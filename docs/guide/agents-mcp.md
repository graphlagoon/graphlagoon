# AI Agents (MCP)

::: tip TL;DR
Connect Claude Code, Claude Desktop or any MCP client to your
[investigations](./investigations.md). The agent is **an analyst with your
identity**: with a personal token it can do in a case what you can — open
cases for alerts, read the brief, the material (images included) and the
graph, import files, save and run queries, run the analyses (trace, paths,
entity resolution, links, communities), group and annotate entities, find
them in your other cases, pin evidence, plan tasks, write the brief, draft
reports from the org's templates and **propose** the decision. Every write
carries the **agent** chip; the kinds the case lists in
*agent_suggest_kinds* (roles, tags, matches, hypothesis statuses, status
changes and tasks by default) arrive as **suggestions** you confirm or reject.

- **Use it when** you want an agent to do the legwork on a case while you
  keep the decision.
- **Not the tool for** letting an agent decide, review, export, share,
  delete, reopen or confirm its own suggestions: no tool does that, by design.
- **Needs** `GRAPH_LAGOON_AGENTS_ENABLED=true`, the `mcp` extra on the
  server (`pip install "graphlagoon[mcp]"`) and the `investigation.agent`
  [permission](./permissions.md) for whoever creates the token (see
  [Configuration](./configuration.md#ai-agents)).
:::

Agents talk to Graph Lagoon through **MCP**, which describes its own tools;
systems that integrate without an AI (an alerting engine opening cases, a
nightly upload) use the **[REST API](./rest-api.md)** with the same kind of
token.

## Connect an agent

1. Open **Agents** in the account menu (`/settings/agents`) and create a
   token under *Connect an agent*: a name (tasks can be assigned to an agent
   by this name), which cases it reaches (**every case I can read** or **only
   these cases**) and a validity (at most
   `GRAPH_LAGOON_AGENT_TOKEN_MAX_DAYS`, default 90 days). The token (`glt_…`)
   is shown **once**, inside two ready-to-paste commands; only its hash is
   stored. The list shows each token's last activity; revoke it there.
2. Add the app to your client.

**Claude Code** talks to the app's `/mcp` endpoint directly (Streamable
HTTP):

```bash
claude mcp add --transport http graphlagoon http://localhost:8000/graphlagoon/mcp \
  --header "Authorization: Bearer glt_…"
```

The endpoint is `{app URL}/graphlagoon/mcp` (`/mcp` under the mount prefix of
`create_mountable_app`) and accepts agent tokens only.

**Claude Desktop, or any client that only runs local (stdio) servers**: use
the bridge that ships with the `graphlagoon` package. In
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "graphlagoon": {
      "command": "graphlagoon",
      "args": ["mcp-bridge", "--url", "http://localhost:8000"],
      "env": { "GRAPHLAGOON_AGENT_TOKEN": "glt_…" }
    }
  }
}
```

Then ask the agent something like *"list my cases"* to check the connection.

### On Databricks Apps: the local bridge

The Databricks Apps proxy wants a Databricks login, which most agents cannot
do. Run the bridge on your machine; it forwards every MCP message to the app:

```bash
pip install "graphlagoon[mcp]" databricks-sdk
databricks auth login --host https://<workspace>.cloud.databricks.com
claude mcp add graphlagoon -e GRAPHLAGOON_AGENT_TOKEN=glt_… -- \
  graphlagoon mcp-bridge --url https://<app>.databricksapps.com
```

- `--url` is the app URL; `/graphlagoon/mcp` is appended unless the URL
  already ends in `/mcp`.
- The token comes from `--token` or `GRAPHLAGOON_AGENT_TOKEN` (the env var
  keeps it out of your shell history).
- With `databricks-sdk` installed and a profile configured, the bridge sends
  your Databricks OAuth token (refreshed by the SDK) to get through the proxy
  and the agent token in `X-Graphlagoon-Agent-Token`. Without them it sends
  the agent token as `Authorization: Bearer`.

## Using Graph Lagoon from Claude Code

A Claude Code session connected with the command above can work a case from
the alert to the decision without the UI; the person only records the
decision. The built-in playbook **`claude_code_quickstart`** (a slash command
`/mcp__graphlagoon__claude_code_quickstart <case id>`, or `get_playbook`)
walks the agent through it:

1. **Know the org.** `get_case_type` lists the case types; with a slug it
   returns the vocabulary, the decision catalog (outcomes and actions), the
   fields and the stages. `get_playbook` lists the library: playbooks, report
   templates and saved file mappings.
2. **Open the case.** `create_case(case_type, fields, external_ref)` opens one
   for an alert; the same `external_ref` again returns the same case
   (`created: false`), so a retry never duplicates it. Or `get_case` an
   existing one, then `get_brief`, `list_items` and `read_item` (text of any
   version; PNG, JPEG, GIF and WebP also come back as **image content** the
   model can look at, up to `GRAPH_LAGOON_AGENT_IMAGE_MAX_BYTES`, 2 MB by
   default).
3. **Bring data in.** `import_file` takes a delimited or fixed-width text file
   inline (up to about 4 MB) with a file mapping onto the graph or as an
   enrichment table. Bigger files go to the REST route with the same token:

   ```bash
   curl -X POST -H "Authorization: Bearer glt_…" -H "Content-Type: text/csv" \
     --data-binary @statements.csv \
     "http://localhost:8000/graphlagoon/api/investigations/<case>/items?kind=table&subkind=csv&filename=statements.csv"
   ```

   then `update_item` (or the person's import wizard) gives it the mapping.
   `save_query` + `run_query` run SQL or Cypher against a context the person
   reads; `add_table` keeps a result the agent computed.
4. **Analyse.** `get_graph`, `search_entities`, `get_entity`,
   `run_analysis(kind=trace | paths | er | links | communities)`, and
   `find_entity_cases(uid)` — where the entity appeared in the person's other
   cases, with the roles, tags and decisions it got there.
5. **Record what it found.** `annotate` (roles and tags from the vocabulary,
   hypotheses, with the reason), `group`, `add_note`, `pin_evidence` for what
   each claim rests on, `add_task` for follow-ups (a person, or an agent by
   token name), `update_item(chart=…)` to show a table as a chart, and
   `add_item(kind="graph", subkind="view")` to save a view of the canvas (the
   format is in the tool description; a wrong shape is `INVALID_CONTENT`).
6. **Write it up.** `write_brief`, and `render_report(template)` with the case
   type's report template: a markdown draft that arrives *suggested*.
7. **Propose the decision.** `propose_decision(outcome, targets, tasks,
   rationale)` stores a draft; the person sees **Decision proposed** in the
   case header and the decision panel already filled in, then records it
   (the proposal is taken up and named in the decision), edits it first, or
   dismisses it. The agent never records, reviews or reopens a decision.
8. **Come back later.** `list_tasks` (by default: the open tasks assigned to
   this token's name, across cases), `update_task(state="done", note=…)` and
   `changes_since` tell the agent what is its own and what moved.

A case-scoped token does all of the above inside its cases only:
`find_entity_cases` and `list_tasks` never show other cases, and
`create_case` answers `CASE_SCOPED_TOKEN`. Over REST it reaches its cases,
`/api/org/…` and `/api/config`; explorations and context queries outside a
case answer 403.

## Tokens

A token is **your identity plus a short human-only list**; it has no
read/analyze/write scopes.

| Setting | Meaning |
|---|---|
| Scope **user** | every case you can read, and creating cases |
| Scope **case** | only the cases it names; 403 anywhere else, and it cannot create cases |
| Validity | up to `GRAPH_LAGOON_AGENT_TOKEN_MAX_DAYS`; expired and revoked tokens answer 401; a token whose owner lost `investigation.agent` answers 403 `AGENT_PERMISSION_REVOKED` |
| Last activity | bumped on use (at most once a minute); shown on the Agents page and in the admin area |

Over the REST API the same token acts with your access on the case routes
(`/api/investigations/*`), explorations, a context's graph queries, the org's
case types and library (`/api/org/*`, read-only) and `/config`; every other route (administration, contexts, token management,
sharing of contexts or explorations) answers `AGENT_FORBIDDEN`. Each token is
limited to `GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE` requests per minute
(429 above it) and every read tool call is audited (`agent.read`). Inside a
case the footer shows how many of your agents reach it, linking
to the Agents page; administrators list and revoke anyone's tokens in the
admin area.

## What the agent does directly, what arrives suggested, what it never does

The agent uses **the same service functions as the screen**, with
`author_kind=agent` and its token id on every item, annotation and journal
line.

| | What | How you see it |
|---|---|---|
| **Directly** | Read everything in the case it may read; open cases (idempotent by `external_ref`); edit title, description, tags, fields and stage; add notes, documents, tables, files with a mapping, saved queries, explorations, views and new versions; run queries; join, compare and promote tables; run the analyses; groups; hypotheses; pin evidence; write the brief; chart a table; move its own tasks; edit what agents wrote (an edit of a suggested kind is a suggestion again) | Items and annotations with the **agent** chip; journal lines "agent X for Y"; filter Person / Agent / All |
| **Suggested** (a person confirms or rejects) | The kinds in the case's ⚙ **Agent** section — by default `role`, `tag`, `hypothesis_status`, `same_as`, `status_change`, `task`; a case may add `group` and `note` or remove kinds. Reports drafted from a template. **Decision proposals** (always) | Dashed amber rows with **Confirm** / **Reject**; the queue's "suggested" counter; a proposal opens the decision panel filled in |
| **Never** | Record or review a decision, export, share, delete a case, reopen a closed case, confirm or reject suggestions, delete items or annotations, mint tokens; assign a case, change its type, its ⚙ settings (what arrives suggested included) or its SLA hours; edit a person's annotation, or the mapping or query of a person's item; move a hypothesis other than through `hypothesis_status` | No tool exists; the routes answer 403 to an agent token even when its owner is a superuser (`forbid_agents`, `AGENT_FORBIDDEN`, `ANNOTATION_NOT_YOURS`, `ITEM_NOT_YOURS`) |

The token acts with **your** access and never more: cases you cannot see,
restricted items and permissions apply the same way (an item from a graph
context you cannot read is listed with `accessible: false`; `read_item` returns
its metadata only, and tables joined or promoted from it keep the restriction) (`create_case` needs your
`investigation.create`, `import_file` your `investigation.upload`). A closed
case answers 409 to every change except tasks and drafted reports, for agent
and person alike.

## Sensitive data

There is no masking layer: the agent sees what you see. Decide what reaches an
LLM provider with the columns your contexts expose, the shares of each case
and case-scoped tokens (sending customer data to a provider is a
personal-data transfer: settle it with your DPO). Never put raw card numbers
in a case.

**Binaries.** The agent reads an item's text extraction (`read_item`,
`case://{id}/items/{item}`): markdown, csv and json as they are, PDF and DOCX
extracted server-side (a scanned PDF gives metadata, no OCR). PNG, JPEG, GIF
and WebP also come back from `read_item` as **image content** for multimodal
models, up to `GRAPH_LAGOON_AGENT_IMAGE_MAX_BYTES`. `…/content` answers 403 to
an agent token.

Case data comes wrapped in `untrusted_data`: values from graphs, files and
images may contain text written to manipulate an agent, and the server tells
the agent never to follow it.

## Resources

| Resource | Content |
|---|---|
| `case://{id}/brief` | the brief as markdown |
| `case://{id}/items` | the material (items with versions and pins) |
| `case://{id}/items/{item}` | the text of the item's latest version; never bytes |
| `case://{id}/graph?offset=&limit=` | the unified graph, nodes paged (default 500) with the edges among them |
| `case://{id}/changes?since=` | journal events, items created or with a new version, and annotations since an ISO timestamp |
| `org://playbooks/{slug}` | a playbook of the org library |
| `org://case-types/{slug}` | a case type in full: vocabulary, outcomes, actions, fields, stages, SLA hours, notice, playbook |

## Tools

Every tool is the twin of a human action and declares it in
`meta.human_equivalent` (a test keeps the list complete: a tool with no REST
twin, or a case route with neither a tool nor a reason, fails the build).

The **[MCP tool reference](./agents-mcp-tools.md)** lists every tool with its
description, its parameters and the route it mirrors, by group: cases, brief
and material, adding material, queries and tables, annotations and evidence,
tasks, graph and entities, analyses, reports and decisions, journal,
organization. It is generated from the server (`make docs-api`), so it is
exactly what an agent sees in `tools/list`.

## Playbooks

Prompts come from the **org library** (admin area → *Library*): markdown
playbooks where `{investigation_id}` is replaced by the case. In Claude Code
they appear as slash commands (`/mcp__graphlagoon__triage <case id>`), and any
doc of the library is reachable through the `playbook` prompt or
`org://playbooks/{slug}`. Three ship built in; editing one stores your version
and deleting that version restores the original. A case type can name the
playbook its cases start with.

| Playbook | What the agent does |
|---|---|
| `claude_code_quickstart` | the whole flow: know the org, open the case, import, analyse, annotate, tasks, report, propose the decision |
| `triage` | what the case is about, what is in it and what is missing; notes, suggested roles and tags, the brief |
| `assemble_brief` | material, annotations and `changes_since`; pins what each claim rests on; missing hypotheses; the brief for the person who decides |

Domain playbooks (a Pix scam, a merchant review, a credit group, a synthetic
identity ring) are the org's own docs, written in the admin area.

## Reviewing the agent's work

- **In place:** suggestions show as dashed amber rows in the material list and
  in the inspector of the entity, with the agent's reason and **Confirm** /
  **Reject**; the queue and the case footer count them.
- **Material:** items the agent added carry the **agent** chip and their
  versions name the author; pin the ones you rely on.
- **Journal:** filter by Person / Agent; `changes_since` gives the agent the
  same view the next time it connects.
- **Dossier:** hypotheses and pinned evidence the agent produced, with the
  method stamp of each analysis, and the agent's **decision proposal**,
  ready for the [decision](./investigations.md#decisions).

## Limits

- No tool deletes: an agent adds items, versions and annotations but never
  removes them (it can empty a group it created).
- `search_case` is a case-insensitive substring search over titles and the
  latest text of each item; there is no full-text ranking.
- `communities` is label propagation on the unified graph, not the browser's
  Louvain; use it to find clusters to group, not as a metric.
- The rate limit is counted per token in a store every worker shares (the
  `usage_logs` table with a database), so N workers do not allow N× the limit.
