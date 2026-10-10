# AI Agents (MCP)

::: tip TL;DR
Connect Claude Code, Claude Desktop or any MCP client to your
[investigations](./investigations.md). The agent is an analyst with your
identity: it reads the case, runs the same analyses as the screen, adds items
(notes, documents, tables, saved queries), runs queries, pins evidence, writes
the brief and annotates. Roles, tags, matches, typologies and hypothesis
statuses it writes arrive as **suggestions** you confirm or reject in place.

- **Use it when** you want an agent to do the legwork on a case (read the
  graph, follow the money, check typologies, draft the dossier) while you
  keep the decisions.
- **Not the tool for** letting an agent decide, export, share or delete:
  no tool does that, by design. Nor for sending customer data to an
  LLM without a policy: by default the agent sees CPF, CNPJ and accounts
  masked.
- **Needs** `GRAPH_LAGOON_AGENTS_ENABLED=true`, the `mcp` extra on the
  server (`pip install "graphlagoon[mcp]"`) and the `investigation.agent`
  [permission](./permissions.md) for whoever creates the token (see
  [Configuration](./configuration.md#ai-agents)).
:::

## Connect an agent

1. Open a case, click **Agents** in its header and create a token under
   *Connect an agent*: a name, the [scopes](#scopes) and a validity (at most
   `GRAPH_LAGOON_AGENT_TOKEN_MAX_DAYS`, default 90 days). The token (`glt_…`)
   is shown **once**, inside a ready-to-paste command; only its hash is
   stored. Revoke it under *Active tokens*.
2. Add the app to your client.

**Claude Code** (talks to the app's `/mcp` endpoint directly, Streamable
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

Then ask the agent something like *"list my investigations"* to check the
connection.

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

## What an agent does, proposes and never does

| | What | Where it shows |
|---|---|---|
| **Directly** | Read cases, the material and the graph; run traces, paths, typologies and entity resolution; create cases; add items (notes, documents, tables with a mapping, saved queries, analysis results) and versions; run saved queries; pin evidence; write the brief; annotate groups and hypotheses | The material list with the **agent** chip; the journal as "agent X on behalf of Y" |
| **Suggests** (a person confirms or rejects in place) | Roles, tags, `same_as` matches, typology badges, hypothesis statuses and case status changes — the kinds in the case's `settings.agent_suggest_kinds` | Dashed amber rows in the material list and the inspector; the queue's "suggested" counter |
| **Never** | Record the decision, export, share, delete, confirm its own suggestions, mint tokens | No tool exists; the routes answer 403 to an agent token even when its owner is a superuser |

The token acts with **your** access and never more: cases you cannot see,
restricted items and permissions apply the same way (`create_investigation`
needs your `investigation.create`, a CSV upload your `investigation.upload`).
Every read is audited (`agent.read`) and each token is limited to
`GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE` requests per minute (429 above it).

## Scopes

A token has no read/analyze/write scopes: it is your identity plus the short
human-only list above. Its scope is `user` (every case you read) or `case`
(only the `investigation_ids` it names), over REST and MCP alike.

| Group | Tools |
|---|---|
| Read | `list_investigations`, `get_investigation` (summary, roles, counts), `get_graph` (unified or one item), `search_entities`, `get_entity`, `lookup_enrichment`, `list_events`, `list_items`, `get_item` (versions and the text of one), `list_annotations`, `get_brief`, `search_case` |
| Analyse | `trace_money`, `find_paths`, `run_typologies`, `resolve_entities` (suggested `same_as`) |
| Write | `create_investigation`, `add_item` (or a new version with `item_id`), `run_query`, `pin_evidence`, `write_brief`, `annotate` (role, tag, group, same_as, hypothesis, hypothesis_status, typology) |

Over the REST API an agent token acts with its owner's access on the case
routes (`/api/investigations/*`), explorations, a context's graph queries and
`/config`; every other route (administration, contexts, tokens, sharing of
contexts or explorations) answers `AGENT_FORBIDDEN`.

The server also exposes two resources per case, `case://{id}/brief` (markdown)
and `case://{id}/items`.

## Personal data

By default agents see CPF, CNPJ and account numbers **masked**
(`***.456.789-**`, `**.345.678/****-**`, accounts down to their last two
digits); entity ids that contain them are masked too, and the server maps
them back when the agent refers to an entity or an edge. An administrator
can lift this with `GRAPH_LAGOON_AGENTS_ALLOW_UNMASKED_DATA`, and even then
only tokens created with `unmasked: true` see the real values: sending
customer data to an LLM provider is a personal-data transfer, so decide that
with your DPO. The same masking applies when an agent reads items,
snapshots, annotations, events or text over the REST API; item bytes
(`…/content`) answer 403 to an agent, which reads `…/text` instead.

Case data comes wrapped in `untrusted_data`: values from graphs and files may
contain text written to manipulate an agent, and the server tells the agent
never to follow it.

## Prompts

The server ships three ready-made scripts; in Claude Code they appear as
slash commands (`/mcp__graphlagoon__investigar_golpe_pix`, …) and take the case id.

| Prompt | What the agent does |
|---|---|
| `investigar_golpe_pix` | Reads the brief, material and graph, follows the money to the exits with `trace_money` (FIFO and proportional), keeps the run as a pinned table item, writes the brief and suggests victim, mule and exit roles |
| `revisar_lojista` | Runs `run_typologies` and `resolve_entities` for partners, terminals and accounts a merchant shares with others, notes them on the entities and suggests roles and a typology |
| `montar_dossie` | Reads the material, annotations and journal, pins the versions it relies on, suggests hypotheses and their statuses, and writes the brief for the person who decides |

## Reviewing the agent's work

- **In place:** suggestions show as dashed amber rows in the material list and
  in the inspector of the entity, with the agent's reason and **Confirm** /
  **Reject**; the queue and the case header count them.
- **Material:** items the agent added carry the **agent** chip and their
  versions name the author; pin the ones you rely on.
- **Dossier:** hypotheses and pinned evidence the agent produced, with the
  method stamp of each trace, ready for the
  [decision](./investigations.md#decision-freeze-and-retention).

## Limits

- No tool edits or deletes: an agent adds items, versions and annotations
  but never removes them.
- The rate limit is counted per server process.
- Tokens have no "last used" date; revoke the ones you no longer need.
- Text resources per item, `changes_since` and the org library of playbooks
  arrive with the AI-first phase.

