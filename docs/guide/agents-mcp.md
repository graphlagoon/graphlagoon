# AI Agents (MCP)

::: tip TL;DR
Connect Claude Code, Claude Desktop or any MCP client to your
[investigations](./investigations.md). The agent is **an analyst with your
identity**: with a personal token it can do in a case what you can — read the
brief, the material and the graph, search, add notes, documents, tables and
files, save and run queries, create explorations, run the analyses (trace,
paths, typologies, entity resolution, links, communities), group entities,
annotate, pin evidence and write the brief. Every write carries the **agent**
chip; the kinds the case lists in *agent_suggest_kinds* (roles, tags, matches,
typologies, hypothesis statuses, status changes by default) arrive as
**suggestions** you confirm or reject in place.

- **Use it when** you want an agent to do the legwork on a case while you
  keep the decision: follow the money, check typologies, join the tables you
  received, draft the dossier from a playbook.
- **Not the tool for** letting an agent decide, export, share, delete,
  reopen or confirm its own suggestions: no tool does that, by design. Nor
  for sending customer data to an LLM without a policy: by default the
  agent sees CPF, CNPJ and accounts masked.
- **Needs** `GRAPH_LAGOON_AGENTS_ENABLED=true`, the `mcp` extra on the
  server (`pip install "graphlagoon[mcp]"`) and the `investigation.agent`
  [permission](./permissions.md) for whoever creates the token (see
  [Configuration](./configuration.md#ai-agents)).
:::

## Connect an agent

1. Open **Agents** in the account menu (`/settings/agents`) and create a
   token under *Connect an agent*: a name, which cases it reaches (**every
   case I can read** or **only these cases**), *unmasked data* when the
   administrator allows it, and a validity (at most
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

## Tokens

A token is **your identity plus a short human-only list**; it has no
read/analyze/write scopes.

| Setting | Meaning |
|---|---|
| Scope **user** | every case you can read, and creating cases |
| Scope **case** | only the cases it names; 403 anywhere else, and it cannot create cases |
| **Unmasked** | honoured only when the administrator sets `GRAPH_LAGOON_AGENTS_ALLOW_UNMASKED_DATA`; otherwise the flag changes nothing |
| Validity | up to `GRAPH_LAGOON_AGENT_TOKEN_MAX_DAYS`; expired and revoked tokens answer 401 |
| Last activity | bumped on use (at most once a minute); shown on the Agents page and in the admin area |

Over the REST API the same token acts with your access on the case routes
(`/api/investigations/*`), explorations, a context's graph queries and
`/config`; every other route (administration, contexts, token management,
sharing of contexts or explorations) answers `AGENT_FORBIDDEN`. Each token is
limited to `GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE` requests per minute
(429 above it) and every read tool call is audited (`agent.read`). Inside a
case the footer shows **N agentes ativos** (your tokens that reach it) linking
to the Agents page; administrators list and revoke anyone's tokens in the
admin area.

## What the agent does directly, what arrives suggested, what it never does

There is no matrix of proposals: the agent uses **the same service functions
as the screen**, with `author_kind=agent` and its token id on every item,
annotation and journal line.

| | What | How you see it |
|---|---|---|
| **Directly** | Read everything in the case; create cases; edit title, description and tags; add notes, documents (markdown or link), tables, files with a mapping, saved queries, explorations and new versions; run queries; join, compare and promote tables; run the analyses; create and edit groups; add hypotheses; pin evidence; write the brief | Items and annotations with the **agent** chip; journal lines "agent X on behalf of Y"; filter Pessoa / Agente / Tudo |
| **Suggested** (a person confirms or rejects in place) | The kinds in the case's ⚙ **Agent** section — by default `role`, `tag`, `hypothesis_status`, `same_as`, `status_change`, `typology`; a case may add `group` and `note` or remove kinds | Dashed amber rows in the material list and the inspector with **Confirm** / **Reject**; the queue's "suggested" counter |
| **Never** | Record the decision, export, share, delete a case, reopen a decided case, confirm or reject suggestions, delete items or annotations, mint tokens | No tool exists; the routes answer 403 to an agent token even when its owner is a superuser (`forbid_agents`) |

The token acts with **your** access and never more: cases you cannot see,
restricted items and permissions apply the same way (`create_case` needs your
`investigation.create`, `import_file` your `investigation.upload`). After the
decision every mutation answers 409, for agent and person alike.

## Personal data

By default agents see CPF, CNPJ and account numbers **masked**
(`***.456.789-**`, `**.345.678/****-**`, accounts down to their last two
digits); entity ids that contain them are masked too, and the server maps
them back when the agent refers to an entity, an edge or an anchor. Text is
masked **before** it is paged, so a slice never shows half a document. An
administrator can lift this with `GRAPH_LAGOON_AGENTS_ALLOW_UNMASKED_DATA`,
and even then only tokens created with *unmasked* see the real values:
sending customer data to an LLM provider is a personal-data transfer, so
decide that with your DPO. The same masking applies when an agent reads
items, snapshots, annotations, events or text over the REST API.

**Binary never reaches the agent.** It reads an item's text extraction
(`read_item`, `case://{id}/items/{item}`): markdown, csv and json as they
are, PDF and DOCX extracted server-side (a scanned PDF gives metadata and a
warning, no OCR); `…/content` answers 403 to an agent token.

Case data comes wrapped in `untrusted_data`: values from graphs and files may
contain text written to manipulate an agent, and the server tells the agent
never to follow it.

## Resources

| Resource | Content |
|---|---|
| `case://{id}/brief` | the brief as markdown |
| `case://{id}/items` | the material (items with versions and pins) |
| `case://{id}/items/{item}` | the text of the item's latest version, masked; never bytes |
| `case://{id}/graph?offset=&limit=` | the unified graph, nodes paged (default 500) with the edges among them |
| `case://{id}/changes?since=` | journal events, items created or with a new version, and annotations since an ISO timestamp |
| `org://playbooks/{slug}` | a playbook of the org library |
| `org://vocabularies/{kind}` | the org's suggested values for `role`, `tag`, `typology` or `link_attribute` |

## Tools

Every tool is the twin of a human action and declares it in
`meta.human_equivalent` (a test keeps the list complete: a tool with no REST
twin, or a case route with neither a tool nor a reason, fails the build).

| Group | Tools |
|---|---|
| Cases | `list_cases`, `get_case` (summary, roles, counts), `create_case`, `update_case` (title, description, tags, status) |
| Brief and material | `get_brief`, `write_brief`, `list_items`, `read_item(offset, limit)`, `update_item`, `search_case` |
| Adding | `add_note` (free or anchored), `add_document` (text or url), `add_table` (columns and rows), `save_query` (sql or cypher with `:param`s), `import_file` (delimited text with a graph or enrichment mapping), `create_exploration`, `add_item` (anything else, or a new version) |
| Queries and tables | `run_query` (each run is a version), `join_tables`, `compare_tables`, `promote_tables` |
| Annotations | `annotate` (role, tag, same_as, hypothesis, hypothesis_status, typology), `group` (create, add, remove), `list_annotations`, `pin_evidence` |
| Graph | `get_graph` (paged, unified or one item), `search_entities`, `get_entity`, `lookup_enrichment` |
| Analyses | `run_analysis` with kind `trace`, `paths`, `typologies`, `er` (suggested `same_as`), `links` (shared attributes → `compartilha_*` edges), `communities` (label propagation); `save=true` keeps the result as an item with its method stamp |
| Journal | `list_events`, `changes_since` |
| Org | `get_playbook`, `list_vocabulary` (values for the case's preset) |

## Playbooks

Prompts come from the **org library** (admin area → *Library*): markdown
playbooks where `{investigation_id}` is replaced by the case. In Claude Code
they appear as slash commands (`/mcp__graphlagoon__investigar_golpe_pix …`)
and any doc of the library is reachable through the `playbook` prompt or the
`org://playbooks/{slug}` resource. Six ship built in; editing one stores your
version and deleting that version restores the original.

| Playbook | What the agent does |
|---|---|
| `investigar_golpe_pix` | brief, graph, victim and contested transfer; trace FIFO and proportional, saved and pinned; mules and shared people; brief and suggested roles |
| `revisar_lojista` | merchant, terminals, settlement account and partners; typologies (`hub_atributo`), links and entity resolution; notes, a group of the ring, roles and a typology seal |
| `montar_dossie` | material, annotations and `changes_since`; pins what each claim rests on; missing hypotheses and statuses; the brief for the person who decides |
| `analise_credito_grupo` | companies, partners and guarantors; links by address, phone and e-mail, communities, groups; join and promote the shareholdings; roles and exposure per company |
| `fuga_garantia` | debtor, asset and acquirers; earliest paths after the contract, trace from the proceeds, a saved query on the registry; roles, evidence and the chain of transfers |
| `fraude_sintetica` | people, e-mails, phones, devices, IPs, cards and terminals; links, entity resolution and typologies; groups sharing devices, notes, roles |

The **vocabularies** tab of the admin area holds the suggested roles, tags,
typologies (CC 4.001) and link attributes per case type; the case's ⚙ offers
them with one click and `list_vocabulary` gives them to the agent, so roles
stay consistent across cases without being imposed.

## Reviewing the agent's work

- **In place:** suggestions show as dashed amber rows in the material list and
  in the inspector of the entity, with the agent's reason and **Confirm** /
  **Reject**; the queue and the case footer count them.
- **Material:** items the agent added carry the **agent** chip and their
  versions name the author; pin the ones you rely on.
- **Journal:** filter by Pessoa / Agente; `changes_since` gives the agent the
  same view the next time it connects.
- **Dossier:** hypotheses and pinned evidence the agent produced, with the
  method stamp of each analysis, ready for the
  [decision](./investigations.md#decision-freeze-and-retention).

## Limits

- No tool deletes: an agent adds items, versions and annotations but never
  removes them (it can empty a group it created).
- `search_case` is a case-insensitive substring search over titles and the
  latest text of each item; there is no full-text ranking.
- `communities` is label propagation on the unified graph, not the browser's
  Louvain; use it to find clusters to group, not as a metric.
- The rate limit is counted per server process.
