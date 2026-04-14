# Similarity System

Graph Lagoon Studio includes a similarity system that lets parent applications expose custom similarity endpoints. Users select a node type, a key property, and an endpoint — the system extracts keys from the graph, calls the endpoint, and injects the resulting scored edges into the visualization.

This is useful for embedding-based similarity, co-occurrence analysis, feature distance, or any computation that produces pairwise node relationships.

## How It Works

```
1. Discovery:  Frontend  -->  GET /api/similarity/endpoints
                          <--  [{ name, description, endpoint, params }]

2. Compute:    Frontend  -->  POST /my-api/similarity/cosine  (parent's endpoint)
                              { node_keys: [...], params: { threshold: 0.5 } }
                          <--  { edges: [{ source, target, score }] }
```

The backend only serves the catalog (step 1). The actual computation (step 2) goes directly to the parent app's endpoint on the same origin — no proxy, no middleware, no callable registration.

## Registering Endpoints

Pass `similarity_endpoints` to `create_mountable_app()`:

```python
from fastapi import FastAPI
from pydantic import BaseModel
from graphlagoon import (
    create_mountable_app,
    SimilarityEndpointSpec,
    SimilarityEndpointParam,
)

app = FastAPI()

# Define your similarity endpoint
class SimilarityRequest(BaseModel):
    node_keys: list[str]
    params: dict = {}

@app.post("/my-api/similarity/cosine")
async def cosine_similarity(request: SimilarityRequest):
    threshold = float(request.params.get("threshold", 0.5))
    top_k = int(request.params.get("top_k", 10))

    # Your computation here — embeddings, co-occurrence, etc.
    edges = compute_cosine_similarity(request.node_keys, threshold, top_k)

    return {
        "edges": [
            {"source": e.src, "target": e.dst, "score": e.score}
            for e in edges
        ]
    }

# Register it with Graph Lagoon
app.mount("/graphlagoon", create_mountable_app(
    mount_prefix="/graphlagoon",
    similarity_endpoints=[
        SimilarityEndpointSpec(
            name="cosine_embedding",
            description="Cosine similarity on embedding vectors",
            endpoint="/my-api/similarity/cosine",
            params=[
                SimilarityEndpointParam(
                    name="threshold",
                    type="float",
                    default=0.5,
                    description="Minimum score to include",
                ),
                SimilarityEndpointParam(
                    name="top_k",
                    type="int",
                    default=10,
                    description="Max neighbors per node",
                ),
            ],
        ),
    ],
))
```

### Endpoint Contract

Your endpoint receives a POST with:

```json
{
  "node_keys": ["key1", "key2", "key3"],
  "params": { "threshold": 0.5, "top_k": 10 }
}
```

And must return:

```json
{
  "edges": [
    { "source": "key1", "target": "key2", "score": 0.95 },
    { "source": "key2", "target": "key3", "score": 0.72 }
  ]
}
```

- `source` / `target`: must match the keys sent in `node_keys`
- `score`: float between 0 and 1
- Similarity is undirected — return **one edge per pair** (A->B only, not both A->B and B->A). The d3-force link force is undirected, so duplicating edges would double the attractive force

### Parameter Types

| Type | Frontend control |
|------|-----------------|
| `str` | Text input |
| `int` | Number input (step 1) |
| `float` | Number input (step 0.01) |
| `bool` | Checkbox |

Add `choices: ["a", "b", "c"]` to any param to render a dropdown instead.

## Frontend Usage

The similarity UI lives in the **Clusters panel > Similarity tab**:

1. **Select endpoint** from the dropdown (populated from the registry)
2. **Select node type** to filter which nodes provide keys
3. **Select key property** — the node property whose values become keys sent to the endpoint. Defaults to `node_id`. If the property contains a JSON string, check "Value is JSON string" and specify a dot-separated path (e.g. `embedding.id`)
4. **Preview keys** — click to inspect extracted keys before running
5. **Configure parameters** — dynamic form rendered from the endpoint's param schema
6. **Run** — calls the endpoint, injects similarity edges into the graph

### Display Modes

After computation, similarity edges (`__similarity__` type) can be shown in three modes:

| Mode | Behavior |
|------|----------|
| **Overlay** | Similarity edges shown alongside all other edges |
| **Exclusive** | Only similarity edges visible |
| **Hidden** | Similarity edges hidden, original graph restored |

### Layout by Edge Type

In the **Layout panel**, the "Layout by Edge Type" section lets you drive the force simulation using only a specific edge type. After running similarity, the layout automatically uses `__similarity__` edges with the "Fix then recompute" strategy:

| Strategy | How it works |
|----------|-------------|
| **Fix then recompute** | Run layout with only the selected edge type. Once stabilized, pin those nodes and re-run with all edges — remaining nodes settle around the fixed structure |
| **Full simulation, selected links only** | All nodes participate in charge/gravity, but only the selected edge type contributes link forces |
| **Selected only** | Only nodes connected by the selected edge type get link forces. Others drift to the periphery |

## Persistence

Similarity state is saved with explorations:
- Selected endpoint, node type, key property, and parameters
- The computed similarity edges themselves (no re-computation on reload)
- Display mode and layout settings

## Architecture Notes

- Similarity edges are injected directly into `graph.edges` with `relationship_type = '__similarity__'` and `edge_id = 'sim__{source}__{target}'`
- They flow through the standard pipeline: `filteredEdges` -> `enhancedEdges` -> `GraphLink`
- Display mode filtering happens in the graph store's `filteredEdges` computed
- Similarity edges render in orange (`#ff9500`) with opacity derived from score (0.3 at score=0, 1.0 at score=1)
- The similarity store auto-clears when graph data changes (new query executed)
