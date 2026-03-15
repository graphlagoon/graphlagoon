# Graph Lagoon Studio

Graph exploration on Databricks. Zero ETL. Zero extra cost.

Explore fraud networks, supply chains, and entity relationships directly on your Delta tables — no dedicated graph database needed. Write Cypher queries that get transpiled to Databricks SQL, visualize results in an interactive 3D force-directed graph.

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
