# REST Connections

A REST connection turns any graph-serving HTTP API into a datasource: the user
types a query, Graph Lagoon sends it to your API exactly as your connection
spec describes, and the JSON answer renders as a graph. Unlike the SQL
warehouse and Amazon Neptune — one instance each, configured server-level — a
deployment can register **any number of named REST connections**, and each
graph context records which one it queries.

Use it when a team already serves a graph over HTTP — a fraud-scoring service,
a precomputed neighborhood cache, an internal knowledge graph — and you want it
explorable without ETL into tables.

## Registering connections

Connections are declared **in code** by the app that embeds Graph Lagoon, the
same way similarity endpoints are:

```python
from graphlagoon import (
    RestConnectionSpec,
    RestConnectionUI,
    RestRequest,
    create_mountable_app,
)

app.mount(
    "/graphlagoon",
    create_mountable_app(
        rest_connections=[
            RestConnectionSpec(
                name="fraud-api",                      # → context.datasource_name
                ui=RestConnectionUI(
                    label="Fraud Graph Service",
                    tagline="Operational · curated subgraph",
                    description="Precomputed fraud neighborhoods.",
                    caveat="Carries only the curated fraud subgraph.",
                    query_language="FraudQL",
                    example_query="accounts linked to case 42",
                ),
                base_url="https://fraud-graph.internal",
                headers={"X-Api-Key": os.environ["FRAUD_API_KEY"]},
            ),
        ],
    ),
)
```

Specs are validated at registration — a bad slug, a schemeless `base_url` or a
duplicate name fails app construction, not the first user's query.

`GET /api/config` then advertises the connection to the frontend as
`datasource_connections`: **only the `ui` block and the derived operation
flags**. `base_url`, headers and every callable stay in the process.

## The response contract

By default your API must answer `POST {base_url}/query` (body:
`{"query", "parameters", "limits"}`) with:

```json
{
  "nodes": [{ "id": "a", "label": "Person", "properties": { "name": "Alice" } }],
  "edges": [{ "id": "e1", "source": "a", "target": "b", "label": "KNOWS",
              "properties": {} }]
}
```

Required fields are strict — a node without `id`, or an edge without
`source`/`target`, is reported as `REST_INVALID_RESPONSE` naming the offending
index. Optional fields are forgiving: missing `label` → `""`, missing
`properties` → `{}`, numeric ids are string-coerced, a missing edge `id` is
synthesized. Edges naming a node the response didn't include get a placeholder
endpoint so the graph stays drawable.

An API with a different shape declares a mapper:

```python
RestConnectionSpec(
    ...,
    response_mapper=lambda payload: {
        "nodes": [{"id": v["key"], "label": v["type"]} for v in payload["vertices"]],
        "edges": [{"source": l["from"], "target": l["to"], "label": l["rel"]}
                  for l in payload["links"]],
    },
)
```

A different request shape declares a builder — the datasource still owns the
HTTP client, auth and error handling:

```python
request_builder=lambda query, parameters, limits: RestRequest(
    path="/v2/search", method="GET", params={"q": query},
)
```

## Authentication

Two slots, both server-side only:

- `headers` — static headers (API keys).
- `headers_provider` — a callable invoked per request and merged over the
  static ones; the slot for rotating bearer tokens.

**Trust model:** the query text is opaque to Graph Lagoon — there is no
read-only guard the way the SQL and openCypher paths have, because there is no
grammar to inspect. Connections are dev-declared; enforcing safety (read-only
endpoints, scoping, rate limits) is your API's responsibility.

## Canned operations are opt-in

Expand-from-node, the initial subgraph, fetch-by-id and type discovery cannot
be invented against an arbitrary API. Each lights up only when the spec
declares its builder — otherwise the UI hides the affordance and the API
answers `400 DATASOURCE_UNSUPPORTED_OPERATION`:

| Spec field | Enables | Response expected |
|---|---|---|
| `expand_builder(ExpandRequest)` | Alt+click / context-menu / side-panel expand | contract graph |
| `subgraph_builder(SubgraphRequest)` | `autoLoadOnOpen`, exploration fallback load | contract graph |
| `fetch_nodes_builder(list[str])` | node fetch by id | contract graph (`edges` ignored) |
| `discover_types_builder(SchemaDiscoveryRequest)` | Discover button in the context form | `{"node_types": [...], "relationship_types": [...]}` |

Capabilities are **derived from what you declare** — there is no override knob
to drift out of sync. A connection with none of them is query-only: the
context opens empty and the user runs a query.

## Errors, limits, cancellation

- Remote 4xx → `REST_REMOTE_ERROR` (with a body snippet); timeout →
  `REST_TIMEOUT`; non-JSON or contract-violating body →
  `REST_INVALID_RESPONSE`. Connect errors, 5xx and `response_mapper` crashes
  surface as execution failures with a traceback.
- `limits` (row/edge caps) are passed to your API in the request body — and
  enforced again on the mapped result, since the remote may ignore them.
- Cancellation is client-side only: the outgoing request is dropped, but your
  API may keep computing.
- A context whose connection was later removed from the config fails with
  `400 DATASOURCE_NOT_CONFIGURED` naming the connection, and the UI marks it
  unavailable.

## Trying it locally

`make dev-neptune` registers three demo connections. They are not mocks: the
dev host mounts a REST facade (`graphlagoon/rest_demo.py`) that executes
**real openCypher** against the local graph database (the emulator + seeded
Neo4j — the same graph the Amazon Neptune demo queries), so anything you type
is a real query and errors are real database errors. The three cover every
REST-connection feature:

- **Demo Graph API** (`demo-full`) — every operation wired, contract-shaped
  responses: query, expand, initial subgraph, node fetch, type discovery.
- **Demo Foreign API** (`demo-mapper`) — the same operations, but every
  response arrives in a foreign shape (`items`/`relations`) and is remapped
  by a `response_mapper` — on queries **and** on every canned operation.
- **Demo Minimal API** (`demo-minimal`) — query-only through a custom
  `request_builder` (GET with a query param): the degraded UI (no expand, no
  subgraph, no discovery) and the builder hook in one card.

The same data is also reachable as an Amazon Neptune context, which makes the
two datasource paths directly comparable. The facade also doubles as the
worked example of what an integrator would build in front of their own graph
store.

Under plain `make dev` (no graph database running) no REST cards appear — a
connection whose first query fails would be worse than none. The facade's
`base_url` points at the dev port; override with `GRAPH_LAGOON_SELF_PORT` if
you move it.
