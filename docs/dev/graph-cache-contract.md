# Graph cache — data contract for batch producers

Reference for writing graph cache entries from **outside** the application —
a Spark/Databricks job that turns Delta tables into a graph the visualizer can
open without touching the warehouse.

The contract itself is owned by two files, and they are the tie-breaker if this
document ever drifts from them:

| What | Where |
|---|---|
| Schemas (source of truth) | [`api/graphlagoon/models/schemas.py`](../../api/graphlagoon/models/schemas.py) |
| Storage key, size limit, codec | [`api/graphlagoon/services/graph_cache.py`](../../api/graphlagoon/services/graph_cache.py) |
| Compression | [`api/graphlagoon/services/graph_codec.py`](../../api/graphlagoon/services/graph_codec.py) |
| Mirrored TS types | [`frontend/src/types/graph.ts`](../../frontend/src/types/graph.ts) |

---

## 1. What a cache entry is (and is not)

A cache entry is **a set of nodes and edges stored under a name**, so that
`/graph/{context_id}?graph={name}` renders it without running a query.

It is deliberately *not* a saved view. Three things are excluded, each for a
reason a batch producer needs to understand:

- **No node positions.** Layout runs fresh on every load. A batch job must not
  try to precompute coordinates — there is nowhere to put them, and the loader
  sets `freshLayoutRequested = true` regardless.
- **No styling, filters, clusters or communities.** Those are *style presets*
  and *explorations*. A cache says **which data**; a preset says **how it
  looks**. Loading a cache deliberately leaves the current style untouched, so
  one published style can be applied over many generated graphs.
- **No query timing metadata.** Meaningless once replayed.

If your job needs to ship a *look* alongside the data, publish a style preset
separately and hand users a URL carrying both.

---

## 2. The payload

This is the complete JSON object that must end up in the file — nothing more is
read, nothing less is accepted.

```jsonc
{
  "cache_version": 1,
  "name": "fraud-ring-2026-08",
  "context_id": "3f2b...uuid",
  "created_at": "2026-08-21T03:14:00Z",
  "created_by": "batch-job@company.com",
  "node_count": 12043,
  "edge_count": 48120,
  "properties_complete": true,
  "source": { "kind": "manual" },
  "graph": {
    "nodes": [
      { "node_id": "acct:1", "node_type": "Account",
        "properties": { "balance": 1200, "opened": "2024-01-05" } }
    ],
    "edges": [
      { "edge_id": "t:99", "src": "acct:1", "dst": "acct:2",
        "relationship_type": "TRANSFER",
        "properties": { "amount": 500 } }
    ],
    "truncated": false,
    "total_count": null,
    "properties_deferred": false
  }
}
```

### The graph — the only part that is truly load-bearing

| Field | Required | Notes |
|---|---|---|
| `nodes[].node_id` | **yes** | String. Edge endpoints are matched against it — must be globally unique within the entry. |
| `nodes[].node_type` | **yes** | Drives colour, icon and type filters. Keep the vocabulary small and stable. |
| `nodes[].properties` | no | `null` or an object. See the `properties_deferred` invariant below. |
| `edges[].edge_id` | **yes** | Unique within the entry. |
| `edges[].src` / `dst` | **yes** | Must match a `node_id` **present in the same entry** — see §5. |
| `edges[].relationship_type` | **yes** | Drives edge colour and type filters. |
| `edges[].properties` | no | `null` or an object. |
| `truncated` | no | `false` unless the job knowingly capped the result. Shows a "partial graph" hint in the UI. |
| `total_count` | no | Only meaningful alongside `truncated: true`. |
| `properties_deferred` | no | **Must be `false`.** See below. |

### The envelope

| Field | Who sets it | Why it exists |
|---|---|---|
| `cache_version` | producer (`1`) | The only thing separating "evolve the format" from "break every entry ever written". Two bytes. |
| `name` | producer | Must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` and equal the filename stem. |
| `context_id` | producer | Must equal the directory it is written into. |
| `created_at` | producer | ISO-8601, UTC. |
| `created_by` | producer | Attribution. Use a stable job identity, not a person. When a published cache is wrong, "who produced this?" is the first question. |
| `node_count` / `edge_count` | producer | Lets the UI describe an entry without decompressing megabytes of graph. Keep them honest — nothing recomputes them. |
| `properties_complete` | producer | `= not properties_deferred`. |
| `source` | producer | See §3. |

> **When writing through the API instead, you send only `{graph, source}`** —
> the server derives every other envelope field. Direct volume writes get no
> such help, which is exactly the trade discussed in §6.

---

## 3. `source` — and why a Delta-derived graph is a first-class case

```jsonc
"source": { "kind": "manual" }     // ← a batch-built graph, complete and valid
```

`source` describes **provenance**, not data. Both of its fields are optional
and the object itself may be omitted entirely — a write of just `{"graph": …}`
is valid and stores `{"kind": "manual", "query": null}`.

| Field | Values | For a Delta batch job |
|---|---|---|
| `kind` | `cypher` \| `sql` \| `subgraph` \| `manual` | Use **`manual`**. |
| `query` | string or `null` | `null`, or the driving SQL if you want it visible. |

`kind: "manual"` is not a fallback — it is the vocabulary for *"this graph was
assembled, not queried"*. Keeping it distinct matters: without it, a consumer
cannot tell a graph that never had a query from one whose query was lost.

If the job runs a single readable SQL statement worth showing, putting it in
`query` populates the visualizer's query panel on load, so users can see how
the graph was built. If the pipeline is many joins across many tables, leave it
`null` — a misleading half-query is worse than none.

### Removed: `datasource_type` and `datasource_name`

Earlier entries carried these. They were cut, and a batch job should not emit
them:

- A cache is already scoped to a `context_id`, and the context knows its own
  datasource — they were pure denormalization.
- Nothing ever read them back (verified across the frontend and API).
- They could *lie*: repointing a context at another datasource left stale
  copies behind, with no mechanism to notice.

**Entries already on disk that still contain them keep working** — Pydantic
ignores unknown keys, and a test pins that behaviour so a future
`extra="forbid"` cannot silently make every pre-existing cache unreadable.

---

## 4. The one hard invariant: `properties_deferred: false`

The API **refuses** a write with `properties_deferred: true` (HTTP 400,
`CACHE_INCOMPLETE`), and a direct writer must uphold the same rule by hand.

The reason is specific to how the app loads graphs interactively: contexts
without configured `node_properties` return nodes with `properties: null` and
fill them in afterwards via `/nodes/batch`. Caching mid-flight would freeze
those nulls forever, and the entry would replay as a graph that *looks* empty —
nodes present, every attribute blank, no error anywhere.

**For a batch job this is easy and non-negotiable: materialize all properties
before writing.** A job has no enrichment phase, so simply emit complete nodes
and set `properties_deferred: false` / `properties_complete: true`.

---

## 5. Referential integrity is the producer's job

Nothing validates that `edges[].src` and `dst` resolve to a node in the same
entry. Dangling endpoints do not raise — they produce a graph that silently
renders fewer edges than the job intended, which is the hardest class of bug to
notice downstream.

Two ways this bites a Delta pipeline in particular:

- **Filtering nodes after building edges.** Any node-level `WHERE` applied
  after the edge join orphans edges. Filter first, or semi-join edges against
  the final node set.
- **Node-cap truncation.** If you cap nodes to keep the entry under the size
  limit, the edge set must be re-filtered against the surviving ids, and
  `truncated` set to `true`.

Recommended final step before serialization:

```python
node_ids = {n["node_id"] for n in nodes}
edges = [e for e in edges if e["src"] in node_ids and e["dst"] in node_ids]
```

Also worth asserting: `node_id` uniqueness (duplicates silently overwrite) and
`edge_id` uniqueness.

---

## 6. Writing directly to the volume

### Location

```
{cache_root}/cache/{context_id}/{name}.jsonz
```

`cache_root` is `GRAPH_LAGOON_GRAPH_CACHE_VOLUME_PATH`, falling back to
`{GRAPH_LAGOON_DATABRICKS_VOLUME_PATH}/graph-cache`, falling back to
`GRAPH_LAGOON_GRAPH_CACHE_DIR` (`./tmp/graph-cache`) for local runs. Note the
literal `cache/` segment **inside** the root — it exists so a root shared with
other artifacts stays legible.

### Encoding

`gzip(orjson.dumps(payload))`, level 6. The `.jsonz` extension names
"compressed JSON" without naming the algorithm; `decompress` dispatches on
magic bytes, so a future codec swap needs no file migration.

gzip is not an arbitrary choice and **should not be swapped for zstd**: the
read endpoint returns the stored bytes *untouched* under `Content-Encoding:
gzip`, so the server never decompresses a large graph. An entry written in
another codec is rejected at read time with `CACHE_UNREADABLE`.

### Size

Compressed entries must stay under `GRAPH_LAGOON_GRAPH_CACHE_MAX_BYTES`
(default **200 MB**). Check after compressing — graphs compress well, so a
pre-compression estimate will mislead. Over the limit, reduce the graph and set
`truncated: true`; do not split one logical graph across names, since nothing
recombines them.

### Atomicity

A volume write is **not atomic**, and a reader can catch a half-written object.
The API's local store writes to a temp file then `os.replace`s it; a batch job
writing to the same volume should do the same — write `{name}.jsonz.tmp`, then
rename. Without it, someone loading the graph mid-write gets a
`CACHE_UNREADABLE` 502 rather than a stale-but-valid entry.

### Minimal producer

```python
import gzip, orjson
from datetime import datetime, timezone

def build_payload(context_id, name, nodes, edges, created_by, truncated=False):
    node_ids = {n["node_id"] for n in nodes}
    edges = [e for e in edges if e["src"] in node_ids and e["dst"] in node_ids]

    return {
        "cache_version": 1,
        "name": name,
        "context_id": str(context_id),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": created_by,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "properties_complete": True,
        "source": {"kind": "manual"},
        "graph": {
            "nodes": nodes,
            "edges": edges,
            "truncated": truncated,
            "properties_deferred": False,
        },
    }

def write_entry(root, payload, max_bytes=200 * 1024 * 1024):
    data = gzip.compress(orjson.dumps(payload), compresslevel=6)
    if len(data) > max_bytes:
        raise ValueError(f"{len(data)} bytes compressed, above the {max_bytes} limit")

    target = f"{root}/cache/{payload['context_id']}/{payload['name']}.jsonz"
    tmp = f"{target}.tmp"
    write_bytes(tmp, data)      # your volume client
    rename(tmp, target)         # atomic within a filesystem
```

### Validating without deploying

The schemas are importable, so a job can typecheck its own output:

```python
from graphlagoon.models.schemas import GraphCachePayload
GraphCachePayload.model_validate(payload)   # raises on a malformed entry
```

This is the cheapest possible guard and catches most producer bugs — but note
it will **not** catch dangling edge endpoints or dishonest counts, which is why
§5 exists.

---

## 7. Direct volume write vs. the API

| | Direct volume | `PUT …/graph-cache/{name}` |
|---|---|---|
| Envelope fields | **producer's job** | server derives them |
| Validation | none (add `model_validate` yourself) | full, plus `CACHE_INCOMPLETE` |
| Auth | volume credentials | superuser only |
| Size ceiling | 200 MB compressed | same, plus an HTTP body limit |
| Atomicity | **your responsibility** | handled |
| Right for | large batch output | interactive saves, modest sizes |

For a Delta-backed batch job producing large graphs, **direct volume writes are
the right call** — no HTTP body ceiling, no superuser token in the job, no
multi-hundred-megabyte upload. The cost is that the four guarantees the server
would give you (envelope derivation, schema validation, the
`properties_deferred` refusal, atomic replace) become the job's responsibility.
Each has a one-line mitigation above; implement all four.

---

## 8. Naming entries

`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` — no slashes, 64 chars max.

**There is no listing endpoint, by design.** Enumeration is O(entries) and is
the one operation that stops working at scale, so nothing discovers entries;
every consumer must already know the name it wants. For a recurring job this
makes naming a real interface decision:

- A **stable name** (`fraud-ring-daily`) means one durable URL that always shows
  the latest run. Overwrites are in-place, and readers mid-write need the atomic
  rename from §6.
- A **dated name** (`fraud-ring-2026-08-21`) keeps history and makes runs
  comparable, but every consumer must construct the name, and old entries
  accumulate with nothing to enumerate or expire them. If you go this way, have
  the job delete entries past a retention window using names it computes itself.

A common compromise: write both — a dated entry for history plus a stable alias
rewritten each run for the "current" URL.

---

## 9. Lifecycle

Deleting a graph context purges every cache entry under its `context_id`
prefix, so a job never needs to clean up after a removed context. Nothing else
expires entries: an unnamed, unreferenced entry lives until something deletes
it.
