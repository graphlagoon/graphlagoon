# AI Agents (MCP)

::: tip TL;DR
Connect Claude Code, Claude Desktop or any MCP client to your
[investigations](./investigations.md). The agent reads the case, runs the
same analyses as the screen, writes notes, frozen evidence and draft
artifacts, and **proposes** roles, matches, hypotheses, typology and status;
you accept or reject on the case's **Agents** page.

- **Use it when** you want an agent to do the legwork on a case (read the
  graph, follow the money, check typologies, draft the dossier) while you
  keep the decisions.
- **Not the tool for** letting an agent decide, export, share, delete or
  approve: no tool does that, by design. Nor for sending customer data to an
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
| **Directly** | Read cases, graphs, files and the dossier; run matches, traces, paths and badges; create cases, add sources, upload files and build file graphs; write notes; freeze evidence; upload artifacts as **drafts** | The journal, as "agent X on behalf of Y" |
| **Proposes** | An entity role, a match decision, a new hypothesis or a hypothesis status, the typology, the case status | The case's Agents page, until a person accepts or rejects |
| **Never** | Record the decision, export, share, delete, approve an artifact, accept or reject a proposal or a match, mint tokens | No tool exists; the routes answer 403 to an agent token even when its owner is a superuser |

The token acts with **your** access and never more: cases you cannot see,
restricted sources and permissions apply the same way (`create_investigation`
needs your `investigation.create`, the file tools your
`investigation.upload`). Every read is audited (`agent.read`) and each token
is limited to `GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE` requests per minute
(429 above it).

## Scopes

A token carries one or more scopes; a tool outside them answers
`AGENT_FORBIDDEN`.

| Scope | Tools |
|---|---|
| `read` | `list_investigations`, `get_investigation` (summary, roles, sources; restricted ones as placeholders), `get_graph` (unified or one source), `search_entities`, `get_entity`, `lookup_enrichment` (a context's enrichment table for one entity), `list_events`, `list_notes`, `get_dossier` (indicators, hypotheses, evidence and the latest journal), `list_evidence`, `get_evidence`, `list_artifacts`, `get_artifact`, `list_files`, `get_file` (masked), `list_proposals`, `list_matches` |
| `analyze` | `suggest_matches` (stores suggestions, never merges), `trace_money` (follow the money, with the method stamp), `find_paths`, `run_typologies` (CC 4.001 badges, suggestions only); same results as the browser, journaled as `trace.run` / `path.run` |
| `write` | `create_investigation`, `add_source`, `add_note`, `pin_evidence` (a trace re-run on the server with its method stamp, the unified graph or a subset of it, or a table it provides), `upload_artifact` (always a **draft**, up to `GRAPH_LAGOON_ARTIFACT_MAX_BYTES`), `upload_file`, `create_file_graph` (a graph file into a source, with a preset or mapping), `set_file_mapping` (how an enrichment file joins nodes) |
| `propose` | `propose` with `kind`: `role` (`entity`, `role`), `status`, `typology`, `match` (`match_id`, `status`, `reason_text`), `hypothesis` (`text` and the evidence for and against) or `hypothesis_status` (`hypothesis_id`, `status`) |

The server also exposes two resources per case,
`investigation://{id}/summary` and `investigation://{id}/events` (the first
500 journal events).

## Personal data

By default agents see CPF, CNPJ and account numbers **masked**
(`***.456.789-**`, `**.345.678/****-**`, accounts down to their last two
digits); entity ids that contain them are masked too, and the server maps
them back when the agent refers to an entity or an edge. An administrator
can lift this with `GRAPH_LAGOON_AGENTS_ALLOW_UNMASKED_DATA`: sending
customer data to an LLM provider is a personal-data transfer, so decide that
with your DPO.

Case data comes wrapped in `untrusted_data`: values from graphs and files may
contain text written to manipulate an agent, and the server tells the agent
never to follow it.

## Prompts

The server ships three ready-made scripts; in Claude Code they appear as
slash commands (`/mcp__graphlagoon__investigar_golpe_pix`, …) and take the case id.

| Prompt | What the agent does |
|---|---|
| `investigar_golpe_pix` | Reads the case and graph, follows the money to the exits with `trace_money` (FIFO and proportional), notes each hop citing the method, freezes the trace as evidence, uploads a summary and proposes victim, mule and exit roles |
| `revisar_lojista` | Runs `run_typologies` for partners, terminals and accounts a merchant shares with others, notes them, uploads a review and proposes roles and a typology |
| `montar_dossie` | Reads the dossier (`get_dossier`), notes, artifacts and proposals, freezes the evidence it relies on, proposes hypotheses with the evidence for and against, and uploads a draft dossier (`dossie.md`) for the person who decides |

## Reviewing the agent's work

- **Agents page:** pending proposals with the agent's rationale. **Accept**
  applies the change exactly as if you made it; **Reject** asks for a reason.
  Both go to the journal with who proposed and who decided. *Agent activity*
  lists what agents did on the case.
- **Case space:** artifacts the agent uploaded show "agent · name, for you"
  and stay drafts until a person approves them.
- **Dossier:** hypotheses and evidence the agent produced, with the method
  stamp of each trace, ready for the [decision](./investigations.md#decision-freeze-and-retention).

## Limits

- No tool edits or deletes: an agent adds notes, sources and evidence but
  never removes them.
- The server's unified graph does not apply accepted matches yet, so
  `trace_money`, `find_paths` and `run_typologies` keep matched entities
  apart.
- The rate limit is counted per server process.
- Tokens have no "last used" date; revoke the ones you no longer need.
