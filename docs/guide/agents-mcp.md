# AI Agents (MCP)

::: tip TL;DR
Connect Claude Code, Claude Desktop or any MCP client to your investigations.
The agent reads the case, writes notes and draft artifacts and **proposes**
roles, status and typology; you accept or reject on the case's **Agents** page.

- **Use it when** you want an agent to do the legwork on a case (read the
  graph, follow the trail, write the summary) while you keep the decisions.
- **Not the tool for** letting an agent decide, share, delete or approve: no
  tool does that, by design.
- **Needs** `GRAPH_LAGOON_AGENTS_ENABLED=true` and the `mcp` extra on the
  server (see [Configuration](./configuration.md#ai-agents)).
:::

## Connect an agent

1. Open a case, click **Agents** in its header and create a token under
   *Connect an agent*: a name, the scopes and a validity. The token (`glt_…`)
   is shown **once**, inside a ready-to-paste command.
2. Add the app to your client.

**Claude Code** (talks to the app's `/mcp` endpoint directly):

```bash
claude mcp add --transport http graphlagoon http://localhost:8000/graphlagoon/mcp \
  --header "Authorization: Bearer glt_…"
```

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

## On Databricks Apps: the local bridge

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

## Scopes

| Scope | The agent can |
|---|---|
| `read` | read cases, the unified graph, entities, the journal, notes, artifacts, case files (`list_files`, `get_file`, masked) and proposals; look up an entity in its context's enrichment tables (`lookup_enrichment`) |
| `analyze` | run server analyses (arrives with follow-the-money and typologies) |
| `write` | create cases, add sources, write notes, upload artifacts as **drafts**, upload case files (`upload_file`, up to the artifact size), turn a graph file into a source with a preset or mapping (`create_file_graph`) and set how an enrichment file joins nodes (`set_file_mapping`); the file tools need your `investigation.upload` permission |
| `propose` | propose an entity role, the case status or a typology |

The token acts with **your** access and never more: cases you cannot see,
restricted sources and permissions apply the same way. Tokens expire (at most
`GRAPH_LAGOON_AGENT_TOKEN_MAX_DAYS`) and can be revoked on the Agents page or
by an administrator.

## What agents never do

There is no tool to **decide** a case, **share** it, **delete** anything,
**approve** an artifact or **accept/reject** a proposal. The matching routes
answer 403 to an agent token even when its owner is a superuser. Everything an
agent does goes to the journal as "agent X on behalf of Y" and every read is
audited (`agent.read`).

## Personal data

By default agents see CPF, CNPJ and account numbers **masked**
(`***.456.789-**`, accounts down to their last two digits); entity ids that
contain them are masked too, and the server maps them back when the agent
refers to an entity. An administrator can lift this with
`GRAPH_LAGOON_AGENTS_ALLOW_UNMASKED_DATA` — sending customer data to an LLM
provider is a personal-data transfer, so decide that with your DPO.

Case data comes wrapped in `untrusted_data`: values from graphs and files may
contain text written to manipulate an agent, and the server tells the agent
never to follow it.

## Prompts

The server ships three ready-made scripts; in Claude Code they appear as
slash commands (`/mcp__graphlagoon__investigar_golpe_pix`, …) and take the case id.

| Prompt | What the agent does |
|---|---|
| `investigar_golpe_pix` | Reads the case and graph, follows the money hop by hop to the exits, notes each hop, uploads a summary and proposes victim, mule and exit roles |
| `revisar_lojista` | Looks for partners, terminals and accounts a merchant shares with others, notes them, uploads a review and proposes roles and a typology |
| `montar_dossie` | Reads the journal, notes, artifacts and proposals and uploads a draft dossier (`dossie.md`) for the person who decides |

## Reviewing the agent's work

- **Agents page:** pending proposals with the agent's rationale. **Accept**
  applies the change exactly as if you made it; **Reject** asks for a reason.
- **Case space:** artifacts the agent uploaded show "agent · name, for you"
  and stay drafts until a person approves them.

See [Investigations](./investigations.md#agents-and-proposals) for both pages.
