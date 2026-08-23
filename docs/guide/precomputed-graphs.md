# Precomputed Graphs

A **precomputed graph** is a named graph resource resolved on the server:

```
/graph/{context_id}?precomputed=fraude-bfs&seed=99872&hops=3
                    └─────┬────┘ └────────┬────────┘
                        name          provider arguments
```

Where the graph comes from is your decision, not the library's. It can be a
file published by a nightly job, a recursive query against Lakebase computed
from the link's own parameters, a Delta table read through the SQL warehouse, or
an internal service. You express that decision as a **provider**: a Python
function registered when you build the app.

Everyone with read access to the context can open such a link. Nobody needs to
run a query, and nothing needs to be listed — a link *is* the interface.

## The chain

Providers are registered in order, and each may decline:

```python
from graphlagoon import create_mountable_app, volume_provider

app = create_mountable_app(
    precomputed_graph_providers=[volume_provider(), lakebase_bfs],
)
```

For each request the server walks the list. A provider whose `matches`
predicate says no is skipped; one whose `resolve` returns `None` declines and
the next is tried. The first to answer wins; if all decline, the answer is 404.

Two details are worth knowing up front:

- **Omitting the argument** registers the built-in volume provider alone, which
  is the behaviour of a deployment that has never heard of providers.
- **Passing `[]`** registers nothing, and every read answers 404. That is how a
  deployment says "we serve no precomputed graphs" — distinct from disabling the
  feature with `GRAPH_LAGOON_PRECOMPUTED_GRAPHS_ENABLED=false`.

## Writing a provider

```python
from graphlagoon import (
    PrecomputedGraphProvider, PrecomputedGraphResult, PrecomputedGraphData,
    ParamSpec, Node, Edge,
)

provider = PrecomputedGraphProvider(
    name="lakebase-bfs",              # lowercase slug
    resolve=my_async_function,        # async; return a result or None
    params=[...],                     # declared URL arguments
    matches=None,                     # which requests are mine (None = all)
    save=None, delete=None,           # absent ⇒ PUT/DELETE answer 405
)
```

`save` and `delete` being absent is not an oversight — it is how a provider says
it cannot be written to, and the UI hides its publish panel accordingly. Most
providers are read-only: a graph computed from a query has nowhere to write
back to.

### Declared parameters

Every URL argument a provider accepts must be declared. Anything undeclared is
a `400` *before* `resolve` runs.

```python
ParamSpec("seed",      "str", required=True, max_length=64)
ParamSpec("hops",      "int", default=2, min=1, max=4)
ParamSpec("edge_type", "str", default="transfer",
          choices=["transfer", "device", "shared_card"])
```

Types are `str`, `int`, `float`, `bool`. Numbers must be plain decimals —
`1e5`, `0x10`, `+1` and `NaN` are all rejected, so a value never parses one way
in Python and another in JavaScript. A repeated parameter is rejected rather
than resolved to the last one: a value decided by luck is precisely what this
layer exists to prevent.

### Parameters in a chain

Providers in one chain may declare completely different arguments — that is what
makes a volume taking none sit in front of a query taking several. Each provider
receives **only the arguments it declared**, coerced against its own specs, and
the three ways that can go wrong are deliberately not the same failure:

| Situation | Result | Why |
|---|---|---|
| A key **no** provider in the chain declares | `400 UNKNOWN_PARAM` | A typo. The check is against the union across the chain, so `?seed=` is fine when *some* provider declares it — but `?sed=` is declared by nobody and still fails. |
| A value outside a provider's `choices` / `min` / `max` | `400 INVALID_PARAM` | Hard, even when a provider behind it would have answered. Falling through would serve a graph that silently ignored the argument you asked for. |
| A **required** argument that provider did not get | that provider stands down | Not an error — the same standing-down as `matches` returning `False`. It is what lets `?precomputed=x` with no arguments reach a volume while a BFS provider requiring `seed` steps aside. |

If *every* provider stands down for a missing required argument, the answer is
`400 MISSING_PARAM` naming it, not a bare `404` — otherwise you would go hunting
for a name that was perfectly fine.

::: tip Matchers run before coercion
A provider is what *declares* the arguments, so `matches` necessarily runs
first — inside it, `request.params` is empty and `request.raw_params` holds the
untouched query string. Route on `context_id`, `name`, or the raw strings.
:::

### What the framework guarantees

Before `resolve` is awaited:

- `params` holds **only declared names**, coerced to their declared types and
  inside their declared bounds.
- `name` passed the artifact-name rule — never a `/`, a quote, or whitespace.
- `context_id` is a real UUID and **the caller has read access to that context**.
- An exception from `resolve` becomes a `502`, with the provider named in the
  server log and a generic message in the response.

### What you owe

- **A coerced `str` is still attacker-controlled text.** `type="str"` guarantees
  the type, never the content. Bind it; never interpolate it into SQL.
- **A value in identifier position needs `choices`.** Table, column, partition,
  sort key — an allowlist is the only safe way, and it is why `choices` exists.
- **`min`/`max` is the only cost control there is.** Declare it on anything that
  becomes a LIMIT, an offset, a window or a hop count, or a link can ask the
  warehouse for everything.
- **Authorization narrower than the context is yours.** Re-check `user_email`
  inside `resolve` when the data is narrower than the context it sits in.
- **Result size and timeouts are yours.** The 200 MB ceiling applies to volume
  writes, not to a payload you build in memory, and `resolve` is awaited with no
  framework timeout.

---

## Example 1 — Volume: publish a file, read it by name

The default, and what the in-app publish panel writes to.

```python
from graphlagoon import create_mountable_app, volume_provider

app = create_mountable_app(precomputed_graph_providers=[volume_provider()])
```

Files live at `{root}/precomputed/{context_id}/{name}.jsonz`, gzipped JSON in
the shape the [payload contract](../dev/precomputed-graphs-contract.md)
describes. The read path returns those bytes **untouched** under
`Content-Encoding: gzip`, so nothing decompresses a large graph server-side just
to serialize it again.

Open with `/graph/{ctx}?precomputed=fraude-2024`.

A store fed only by a batch job should be read-only, so the app never offers a
publish button it would refuse:

```python
volume_provider(writable=False)
```

## Example 2 — Lakebase: a BFS computed from the URL

Nothing is materialised ahead of time; the graph is computed from the link's own
parameters. `seed` is **bound**, never interpolated. `hops` carries `min`/`max`
because it is the exponent of the cost. `edge_type` uses `choices` because it
lands in identifier position.

```python
from sqlalchemy import text
from graphlagoon import (
    PrecomputedGraphProvider, PrecomputedGraphResult, PrecomputedGraphData,
    ParamSpec, Node, Edge,
)

BFS = """
WITH RECURSIVE reach(src, dst, depth) AS (
    SELECT src, dst, 1 FROM edges WHERE src = :seed AND rel = :edge_type
  UNION ALL
    SELECT e.src, e.dst, r.depth + 1
    FROM edges e JOIN reach r ON e.src = r.dst
    WHERE r.depth < :hops AND e.rel = :edge_type
)
SELECT DISTINCT src, dst, depth FROM reach LIMIT :max_edges
"""

async def bfs_from_lakebase(request):
    async with session_maker() as db:
        rows = (await db.execute(text(BFS), {
            "seed":      request.params["seed"],
            "hops":      request.params["hops"],
            "edge_type": request.params["edge_type"],
            "max_edges": request.params["max_edges"],
        })).mappings().all()

    if not rows:
        return None          # declines; the chain continues

    ids = {r["src"] for r in rows} | {r["dst"] for r in rows}
    graph = PrecomputedGraphData(
        nodes=[Node(node_id=i, node_type="account") for i in ids],
        edges=[
            Edge(
                edge_id=f"{r['src']}->{r['dst']}",
                src=r["src"],
                dst=r["dst"],
                relationship_type=request.params["edge_type"],
            )
            for r in rows
        ],
        properties_deferred=False,      # hard invariant
    )
    return PrecomputedGraphResult.from_graph(
        graph,
        name=request.name,
        context_id=request.context_id,
        provider="lakebase-bfs",
        created_by=request.user_email,
        params=request.params,
    )

lakebase_bfs = PrecomputedGraphProvider(
    name="lakebase-bfs",
    params=[
        ParamSpec("seed",      "str", required=True, max_length=64),
        ParamSpec("hops",      "int", default=2, min=1, max=4),
        ParamSpec("edge_type", "str", default="transfer",
                  choices=["transfer", "device", "shared_card"]),
        ParamSpec("max_edges", "int", default=5_000, min=1, max=50_000),
    ],
    resolve=bfs_from_lakebase,
    # no save/delete ⇒ PUT and DELETE answer 405, and the panel hides publishing
)
```

Open with
`/graph/{ctx}?precomputed=vizinhanca&seed=99872&hops=3&edge_type=device`.
Changing `seed` in the address bar re-resolves the graph — arguments are part of
what the link identifies, not decoration on it.

## Example 3 — Lakebase in one context, a volume in another

`matches` is the router. It keeps the routing decision declarative instead of an
`if` buried inside `resolve`.

```python
from dataclasses import replace
from uuid import UUID

FRAUDE = UUID("...")   # operational context, live graph
RISCO  = UUID("...")   # analytical context, published nightly

create_mountable_app(precomputed_graph_providers=[
    replace(lakebase_bfs, matches=lambda r: r.context_id == FRAUDE),
    volume_provider(
        name="volume-risco",
        matches=lambda r: r.context_id == RISCO,
        writable=False,
    ),
])
```

The predicate sees `context_id`, `name` and `params`, so routing by name works
the same way:

```python
replace(lakebase_bfs, matches=lambda r: r.name.startswith("bfs-"))
```

If no provider matches, the answer is 404 — the deployment has said nothing
serves that context.

## Example 4 — Layers: a volume with a Lakebase fallback

Composition falls out of `resolve → None`. The nightly job materialises the
frequent cases; everything else is computed on demand, behind the same URL shape.

```python
create_mountable_app(precomputed_graph_providers=[
    volume_provider(writable=False),   # the nightly file, if there is one
    lakebase_bfs,                      # otherwise, compute it now
])
```

The two providers declare different arguments and that is fine — the volume gets
`{}`, `lakebase_bfs` gets `{seed, hops, ...}`. A link with no arguments reaches
the volume while `lakebase_bfs` stands down for its missing required `seed`; a
link carrying `?seed=` reaches whichever answers first. See
[Parameters in a chain](#parameters-in-a-chain).

Note what does **not** cascade: a `PUT` goes to the first provider that
*matches*, and if that one cannot be written to the answer is 405 — the chain
never falls through to a writable provider further down. Writing somewhere other
than where you read from is the worst surprise this feature could produce.

## Example 5 — A Delta table through the SQL warehouse

Reuses the warehouse client the app already holds; no new SDK.

```python
async def delta_snapshot(request):
    rows = await warehouse.execute(
        "SELECT src, dst, rel FROM cat.esq.published_graph "
        "WHERE snapshot_date = ? AND segment = ?",
        parameters=[request.params["snapshot_date"], request.params["segment"]],
    )
    if not rows:
        return None
    return PrecomputedGraphResult.from_graph(
        build_graph(rows),
        name=request.name,
        context_id=request.context_id,
        provider="delta-snapshot",
        params=request.params,
    )

delta = PrecomputedGraphProvider(
    name="delta-snapshot",
    params=[
        ParamSpec("snapshot_date", "str", required=True, max_length=10),
        ParamSpec("segment", "str", default="retail",
                  choices=["retail", "wholesale", "corporate"]),  # goes in WHERE
    ],
    resolve=delta_snapshot,
)
```

## Example 6 — A batch job writing straight to the volume

Still the right approach for large graphs: no HTTP body ceiling, no superuser
token in the job, no multi-hundred-megabyte upload. The job builds the payload
itself and writes `{name}.jsonz.tmp`, then renames.

See the [payload contract](../dev/precomputed-graphs-contract.md) for the
complete envelope, the atomicity requirement, and a runnable reference producer.

---

## Publishing from the app

A superuser can publish the graph on screen under a name, from the
**Precomputed** panel in the toolbar — but only where the resolving provider
declares `save`. The panel asks the server what the context supports rather than
assuming, so a Lakebase-backed context shows a short explanation instead of a
button that would fail.

Publishing is refused while node properties are still being enriched: the entry
would store the nulls and replay as a graph with every attribute blank.

## What it is not

| | Says | Scope |
|---|---|---|
| **Precomputed graph** | which data | shared by everyone with context access |
| **Style preset** | how it looks | shared, applied over any graph |
| **Exploration** | one person's working state | positions, clusters, communities |

Loading a precomputed graph deliberately leaves the current style alone, so one
published style composes with many graphs:

```
/graph/{ctx}?precomputed=fraude-2024&style=investigacao
```

## There is no listing

By design. Enumeration is O(entries) and is the one operation that stops working
as a store grows — a context with a million entries would mean a multi-second
call returning a hundred megabytes, and paging only moves the cost around.
Every real use of a link already knows the name it wants.

The collection URL (`GET /api/graph-contexts/{id}/precomputed-graphs`) answers
with **capabilities** — what this context can do — never with an inventory.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GRAPH_LAGOON_PRECOMPUTED_GRAPHS_ENABLED` | `true` | Feature toggle. Off ⇒ every endpoint answers 404, before any authorization check. |
| `GRAPH_LAGOON_PRECOMPUTED_GRAPHS_DIR` | `./tmp/precomputed-graphs` | Local directory for the built-in volume provider. |
| `GRAPH_LAGOON_PRECOMPUTED_GRAPHS_VOLUME_PATH` | — | Unity Catalog Volume path. Falls back to `{DATABRICKS_VOLUME_PATH}/precomputed-graphs`. |
| `GRAPH_LAGOON_PRECOMPUTED_GRAPHS_MAX_BYTES` | `209715200` (200 MB) | Ceiling for a compressed entry written through the volume provider. |

These apply to the built-in volume provider. A provider you write reads its own
configuration.

::: warning Multi-replica deployments
Without a volume path, the volume provider is a directory local to one process.
Behind more than one replica the same link lands on different replicas and a
graph appears and disappears at random. Set a volume path in any deployment with
more than one replica; the server warns at startup when it detects this.
:::
