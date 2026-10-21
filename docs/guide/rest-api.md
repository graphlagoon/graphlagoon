# REST API & Integrations

::: tip TL;DR
Two ways to drive Graph Lagoon from outside the browser, for two kinds of client:

- **AI agents** (Claude Code, Claude Desktop, any MCP client) use the **MCP server**: it describes its own
  tools, and that is what the agent reads. See [AI Agents (MCP)](./agents-mcp.md) and the
  [MCP tool reference](./agents-mcp-tools.md).
- **Systems** (an alerting engine that opens cases, a script that uploads statements every night, a ticketing
  integration) use the **REST API** described here, with an **agent token** as their identity. The full
  reference is the OpenAPI spec: [`openapi.json`](/openapi.json), and Swagger UI at `{prefix}/docs` when the
  server enables it.
:::

## Authentication

| Who calls | How | Notes |
|---|---|---|
| A person in the browser | The authenticating proxy (Databricks Apps, an SSO gateway) sets `X-Forwarded-Email` | Never sent by clients themselves outside dev mode. A host app can plug its own identity with `configure_auth` ([Python API](./python-api.md#authentication-configure-auth-and-userprovider)). |
| A system or a script | `Authorization: Bearer glt_…`, a personal **agent token** | Created on the Agents page of the account menu (needs `investigation.agent` and `GRAPH_LAGOON_AGENTS_ENABLED`). It acts with the access of the person who created it; a **case-scoped** token reaches only the cases it names (plus `/api/org/…` and `/api/config`; no explorations or context queries outside a case). Limited to `GRAPH_LAGOON_AGENT_RATE_LIMIT_PER_MINUTE` requests per minute (429 above). |

An agent token reaches the case routes (`/api/investigations…`), explorations, a context's graph queries, the
org's case types and library (`/api/org/…`, read-only) and `/api/config`; anything else answers
`403 AGENT_FORBIDDEN`. The routes that are a person's call — recording or
reviewing a decision, sharing, deleting, reopening, exporting, confirming suggestions — answer
`403 AGENT_FORBIDDEN` to a token too; the OpenAPI spec marks each of them **People only**. A system that must
record decisions acts as a person through the proxy, not with a token. A token also never assigns a case or
changes its type, settings or SLA hours (`403 AGENT_FORBIDDEN`), and edits only what agents wrote
(`ANNOTATION_NOT_YOURS`, `ITEM_NOT_YOURS`).

## The reference: OpenAPI and Swagger

- **Static**: [`openapi.json`](/openapi.json) on this site, generated from the code (`make docs-api`). Import it
  into Postman or Insomnia, or generate a client: operations have readable ids (`cases_create_investigation`,
  `decisions_record_decision`) and grouped tags (cases, case items, annotations & tasks, decisions, graph &
  analysis, org).
- **Live**: Swagger UI at `{prefix}/docs` (ReDoc at `{prefix}/redoc`, the spec at `{prefix}/openapi.json`) when
  `GRAPH_LAGOON_API_DOCS_ENABLED` is on — by default only in dev mode. It sits behind the same login as the API.
  **Authorize** takes an agent token (`agentToken`) or, in dev, an e-mail (`forwardedEmail`).

Where `/docs` lives depends on how Graph Lagoon runs:

| Deployment | Graph Lagoon's docs | The host app's own `/docs` |
|---|---|---|
| Standalone (`create_app`, `make dev`) | `/docs` (routes under `/graphlagoon/api/…`) | — |
| Mounted (`app.mount("/graphlagoon", create_mountable_app(...))`) | `/graphlagoon/docs`; Swagger fetches `/graphlagoon/openapi.json` | Does **not** list Graph Lagoon's routes: FastAPI never merges a mounted app into the host's spec |
| Routers included in the host (`app.include_router(create_api_router())`) | — | Lists them, under the host's docs settings |

## Conventions

- **Errors** come as `{"detail": {"error": {"code": "CASE_CLOSED", "message": "…", "details": {}}}}`. Validation
  errors (422) are FastAPI's list: `{"detail": [{"loc": ["body", "outcomes", 0, "id"], "msg": "…"}]}`.
- **The queue is paged**: `GET /api/investigations?limit=50&offset=0` returns `{items, total, limit, offset,
  counts}`; filters `status` (comma separated), `case_type`, `external_ref`, `q`, `deadline=urgent|overdue`,
  `suggested`, `field.<id>=gte:100000` (also `lte:`, `contains:`, `eq:`), `sort=-updated_at` or `field.<id>`.
- **Idempotent creation**: `POST /api/investigations` with an `external_ref` (the alert or ticket id) answers
  `201` with a new case, or `200` with the case already opened for that ref that the caller reads. Retries never
  duplicate a case.
- **Closed cases** answer `409 CASE_CLOSED` to every change except tasks and drafted reports, until a person
  reopens them.
- **Items are versioned**: content never changes in place; `POST …/items/{id}/versions` adds a version, and a
  pinned version is evidence.

## Flows

The examples use `API=http://localhost:8000/graphlagoon` (the dev server), a token in `$TOKEN`, a case id in
`$CASE` and the slug of a saved file mapping of the org library in `$MAPPING`.

### Open a case from an alert

```bash
curl -s -X POST "$API/api/investigations" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title": "Chargeback CB-4471-0912", "case_type": "chargeback_dispute",
       "external_ref": "CB-4471-0912", "alert_at": "2026-10-19T09:30:00",
       "fields": {"reason_code": "10.4", "amount": 1240.5, "network": "Visa"}}'
```

Sending it again returns the same case (`200`). `GET /api/org/case-types/{slug}` lists the type's fields, and a
missing required one is a `422`.

### Upload a large file and put it on the graph

```bash
# the bytes, streamed to the case storage with their sha256
ITEM=$(curl -s -X POST "$API/api/investigations/$CASE/items?kind=table&subkind=csv&filename=statements.csv" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" --data-binary @statements.csv | jq -r .id)
# the mapping that turns its rows into nodes and edges (an org mapping from the library, or your own)
curl -s -X PATCH "$API/api/investigations/$CASE/items/$ITEM" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"mapping\": $(curl -s "$API/api/org/library/$MAPPING" -H "Authorization: Bearer $TOKEN" | jq -r .body)}"
```

Uploads need the `investigation.upload` permission of the token's owner and stop at
`GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES`.

### Pick up the work assigned to you

```bash
curl -s "$API/api/investigations/tasks?mine=true&state=open" -H "Authorization: Bearer $TOKEN"
curl -s "$API/api/investigations/$CASE/events?after=$LAST_EVENT" -H "Authorization: Bearer $TOKEN"
```

With a token, `mine` means the tasks assigned to agents under the token's name (or to any agent).

### Record a decision (people only)

```bash
curl -s -X POST "$API/api/investigations/$CASE/decisions" \
  -H "X-Forwarded-Email: analyst@example.com" -H "Content-Type: application/json" \
  -d '{"outcome": "offboard", "targets": ["Merchant:M0009876"], "tasks": [{"action": "hold_settlements"}],
       "rationale": "Bust-out pattern (E1, E2).", "reviewer_email": "risk.lead@example.com"}'
```

An agent token gets `403 AGENT_FORBIDDEN` here; an agent proposes the decision instead (MCP
`propose_decision`) and a person records it with `proposal_id`.
