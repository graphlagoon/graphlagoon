# Graph Lagoon Studio

Interactive graph visualization and exploration tool for SQL-based graph data.

Graph Lagoon Studio lets you explore graph data stored in Spark SQL, Databricks, or any SQL warehouse. It provides 3D rendering, Cypher query support, BFS expansion, exploration saving, and can be embedded in existing FastAPI applications.

## Quick Start

### As a pip package

```bash
pip install graphlagoon
graphlagoon serve
# Open http://localhost:8000/graphlagoon/
```

### Embedding in an existing FastAPI app

```python
from fastapi import FastAPI
from graphlagoon import create_mountable_app

app = FastAPI(title="My Application")

# Mount Graph Lagoon Studio at /graphlagoon
sgraph_app = create_mountable_app(mount_prefix="/graphlagoon")
app.mount("/graphlagoon", sgraph_app)

# Access at: http://localhost:8000/graphlagoon/
```

### For development

```bash
git clone https://github.com/graphlagoon/graphlagoon.git
cd graphlagoon
make install
make dev
# Frontend: http://localhost:3000
# API: http://localhost:8000
```

## Architecture

```
                    ┌─────────────────────────┐
                    │   Frontend (Vue 3)      │
                    │   Port 3000 (dev)       │
                    └───────────┬─────────────┘
                                │ HTTP
                    ┌───────────▼─────────────┐
                    │   REST API (FastAPI)     │
                    │   Port 8000             │
                    └───────────┬─────────────┘
                                │ HTTP
                    ┌───────────▼─────────────┐
                    │   SQL Warehouse         │
                    │   PySpark / Databricks  │
                    └─────────────────────────┘
```

- **frontend/** — Vue 3 + TypeScript + Pinia, with 3d-force-graph (3D/2D projection)
- **api/** — FastAPI backend, serves the frontend as static files in production
- **warehouse/** — PySpark-based SQL warehouse for local development

## Integration Modes

### Sub-application (recommended)

Mount the full app (API + frontend) at any prefix:

```python
from graphlagoon import create_mountable_app

app.mount("/graphlagoon", create_mountable_app(mount_prefix="/graphlagoon"))
```

### API only

Include just the API routes without the frontend:

```python
from graphlagoon import create_api_router

app.include_router(create_api_router(), prefix="/graph-api")
```

### With Databricks

Connect directly to a Databricks SQL Warehouse:

```python
from graphlagoon import create_mountable_app

app.mount("/graphlagoon", create_mountable_app(
    databricks_catalog="my_catalog",
    databricks_schema="my_schema",
))
```

### With dynamic token refresh

```python
from graphlagoon import create_mountable_app

async def get_fresh_token() -> str:
    return await my_token_service.get_token()

app.mount("/graphlagoon", create_mountable_app(
    header_provider=get_fresh_token,
    databricks_catalog="my_catalog",
))
```

## Configuration

Configuration via environment variables:

```bash
# Warehouse connection
SQL_WAREHOUSE_URL=http://localhost:8001

# Database (optional, for persisting explorations/contexts)
GRAPH_LAGOON_DATABASE_ENABLED=true
GRAPH_LAGOON_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/sgraph

# Databricks mode (alternative to local warehouse)
GRAPH_LAGOON_DATABRICKS_MODE=false
GRAPH_LAGOON_DATABRICKS_HOST=adb-xxx.azuredatabricks.net
GRAPH_LAGOON_DATABRICKS_TOKEN=dapi-xxx
GRAPH_LAGOON_DATABRICKS_WAREHOUSE_ID=xxx
GRAPH_LAGOON_DATABRICKS_CATALOG=main

# Development
GRAPH_LAGOON_DEV_MODE=true
```

## Development

### Prerequisites

- Node.js 18+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Docker (for PostgreSQL, optional)

### Commands

```bash
make install          # Install all dependencies
make dev              # Run all services in background
make dev-stop         # Stop background services
make test             # Run unit tests (446 tests)
make test-e2e         # Run E2E tests (30 tests)
make test-all         # Run all tests
make build            # Build pip-installable wheel
make lint             # Run linters
make perf-report      # Collect frontend performance metrics
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

### Performance Profiling

The frontend includes built-in performance instrumentation (dev-only, zero-cost in production). It records timing data from Three.js rendering, force graph updates, and visual update passes into `window.__PERF_METRICS__`.

A Playwright script collects these metrics plus Three.js renderer stats and Chrome CDP metrics into a JSON report:

```bash
# 1. Start the dev server
make dev

# 2. Collect metrics (waits 5s for rendering to settle)
make perf-report

# 3. Read the report
cat frontend/perf-report.json
```

The report includes:
- **Custom timing entries** — `updateVisuals`, `forcegraphUpdate`, `clusterProgramExec` with per-phase breakdowns
- **Aggregated summary** — count, avg/min/max per operation label
- **Three.js renderer info** — draw calls, triangles, geometry/texture count
- **CDP browser metrics** — JS heap size, layout count, frame count
- **Chrome memory info** — heap usage and limits

To add instrumentation to new code:

```typescript
import { recordPerf } from '@/utils/perfMetrics'

const t0 = performance.now()
// ... work ...
recordPerf('myOperation', performance.now() - t0, { itemCount: 42 })
```

See [.claude/skills/skill_perf_profiling/SKILL.md](.claude/skills/skill_perf_profiling/SKILL.md) for the full profiling guide.

## License

[AGPL-3.0](LICENSE)
