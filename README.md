# Graph Lagoon Studio

Graph exploration on Databricks. Zero ETL. Zero extra cost.

Explore fraud networks, supply chains, and entity relationships directly on your Delta tables — no dedicated graph database needed. Write Cypher queries that get transpiled to Databricks SQL via [gsql2rsql](https://github.com/graphlagoon/gsql2rsql), and visualize results in an interactive 3D force-directed graph.

## gsql2rsql — Query your Delta Tables as a Graph

Graph Lagoon Studio is powered by [gsql2rsql](https://github.com/graphlagoon/gsql2rsql) (open-source, MIT), a Cypher-to-SQL transpiler. Write intuitive OpenCypher queries, get Databricks SQL automatically — no separate graph database needed.

| Challenge | Solution |
|-----------|----------|
| Graph queries require complex recursive SQL | Write a few lines of Cypher instead |
| Maintaining a separate graph database | Query Delta Lake directly |
| LLM-generated SQL is hard to audit | Human-readable Cypher + deterministic transpilation |
| Scaling to billions of triples is costly in graph DBs | Delta Lake handles it natively with Spark scalability |

## Databricks Integration

```python
from fastapi import FastAPI
from graphlagoon import create_mountable_app, Settings

app = FastAPI()

settings = Settings(
    databricks_mode=True,
    databricks_host="adb-xxx.azuredatabricks.net",
    databricks_token="dapi-xxx",
    databricks_warehouse_id="your-warehouse-id",
    databricks_catalog="main",
)

app.mount("/graphlagoon", create_mountable_app(
    settings=settings,
    mount_prefix="/graphlagoon",
))
```

For dynamic token refresh (OAuth), database persistence, and other integration modes, see the [full documentation](https://graphlagoon.github.io/graphlagoon/guide/integration).

## Similarity System

Register your own similarity endpoints and explore pairwise relationships directly in the graph. The parent app owns the computation — Graph Lagoon handles discovery, visualization, and layout.

```python
from graphlagoon import create_mountable_app, SimilarityEndpointSpec, SimilarityEndpointParam

@app.post("/my-api/similarity/cosine")
async def cosine_similarity(request):
    # Your computation: embeddings, co-occurrence, etc.
    return {"edges": [{"source": "a", "target": "b", "score": 0.95}]}

app.mount("/graphlagoon", create_mountable_app(
    similarity_endpoints=[
        SimilarityEndpointSpec(
            name="cosine_embedding",
            description="Cosine similarity on embedding vectors",
            endpoint="/my-api/similarity/cosine",
            params=[
                SimilarityEndpointParam(name="threshold", type="float", default=0.5),
            ],
        ),
    ],
))
```

Similarity edges are injected into the graph with display modes (overlay, exclusive, hidden) and a layout-by-edge-type feature that can drive the force simulation using only similarity edges. See the [similarity guide](https://graphlagoon.github.io/graphlagoon/guide/similarity) for details.

## Local Development

**Prerequisites:** Node.js 18+, Python 3.11+, [uv](https://docs.astral.sh/uv/)

```bash
git clone https://github.com/graphlagoon/graphlagoon.git
cd graphlagoon
git submodule update --init --recursive
make install
make dev
# Frontend: http://localhost:3000
# API:      http://localhost:8000
```

```bash
make dev-stop         # Stop services
make test             # Unit tests
make test-e2e         # E2E tests
make lint             # Linters
make build            # Build pip-installable wheel
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

## Documentation

Full docs at [graphlagoon.github.io/graphlagoon](https://graphlagoon.github.io/graphlagoon/)

## License

[AGPL-3.0](LICENSE)
