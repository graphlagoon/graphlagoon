# Questions and Decisions Made

This document records the decisions made during the productization of Graph Lagoon Studio.

---

## Phase 1: Databricks Connection ✅

### Decisions Made

1. **Databricks Authentication via Bearer Token**
   - Decision: Use standard Databricks API `Authorization: Bearer {token}` header
   - Alternative discarded: OAuth2 flow (more complex, not necessary for programmatic usage)

2. **Configuration validation via properties**
   - Decision: Use `@property` in Settings that raises ValueError if config is incomplete
   - Reason: Fail-fast - clear error at startup instead of runtime failure

3. **Dev-only methods in Databricks mode**
   - Decision: `create_random_graph()` and `clear_all_tables()` raise `NotImplementedError`
   - Alternative: Return HTTP 501 error - but preferred Python exception for clarity

4. **Default catalog in Databricks**
   - Decision: Use `databricks_catalog` from settings as default when not specified
   - Reason: Databricks requires explicit catalog; local Spark does not

### Modified Files
- `src/config.py` - Settings with Databricks properties
- `src/services/warehouse.py` - WarehouseClient with dual support
- `.env.example` - Databricks environment variables

---

## Phase 2: Factory Functions and Optional Database ✅

### Decisions Made

1. **Completely optional database**
   - Decision: Routes that require DB return 503 Service Unavailable with a clear message
   - Alternative discarded: In-memory storage (unnecessary complexity)
   - Implementation: `is_database_available()` checks if DB is configured

2. **Factory function vs Global App**
   - Decision: Keep both - `create_app()` for standalone, `create_api_router()` for embedding
   - Reason: Maximum flexibility without breaking changes

3. **Dependency injection for auth**
   - Decision: Auth middleware checks if database is available before creating user
   - Default: Keep current X-User-Email header
   - Reason: Allows operation without database

4. **Settings as parameter vs global**
   - Decision: Factory accepts optional Settings, uses get_settings() as fallback
   - Reason: Allows multiple instances with different configs (tests, multi-tenant)

### Modified Files
- `src/app.py` - Factory functions `create_app()`, `create_api_router()`, `create_frontend_router()`
- `src/db/database.py` - Optional database with `is_database_available()`
- `src/middleware/auth.py` - Auth middleware with optional database support
- `src/__init__.py` - Public package exports

---

## Phase 3: Frontend Build ✅

### Decisions Made

1. **Where to place compiled assets**
   - Decision: `src/static/` inside the Python package
   - Alternative discarded: Separate folder outside the package (would complicate pip install)

2. **Vite Manifest**
   - Decision: Use `manifest: true` in vite.config.ts
   - Reason: Allows Jinja to know the hashed filenames

3. **API URL in frontend**
   - Decision: Inject via `window.__GRAPH_LAGOON_API_URL__` in the template
   - Alternative discarded: Build-time env var (doesn't work with dynamic embedding)

4. **Build output path**
   - Decision: Vite builds directly to `../graphlagoon-rest-api/src/static/`
   - Command: `make build-frontend`

### Modified Files
- `graphlagoon-frontend/vite.config.ts` - Output to Python package + manifest
- `graphlagoon-frontend/src/services/api.ts` - Support for `window.__GRAPH_LAGOON_API_URL__`

---

## Phase 4: Jinja Template ✅

### Decisions Made

1. **Catch-all route for SPA**
   - Decision: Route `/{path:path}` serves the template for any non-API path
   - Note: Frontend router is included last to avoid overriding API routes

2. **Static assets**
   - Decision: Mount StaticFiles at `/static/`
   - Template references assets via direct path

3. **Config injected in template**
   - Decision: Pass a `config` object with `dev_mode`, `database_enabled`, `databricks_mode`
   - Usage: `window.__GRAPH_LAGOON_CONFIG__ = {{ config | tojson }}`

4. **Fallback when frontend is not compiled**
   - Decision: Template shows instructions on how to build
   - Reason: Better DX for developers

### Created Files
- `src/templates/index.html` - Jinja template for SPA
- `src/static/` - Directory for compiled assets

---

## Phase 5: Python Package ✅

### Decisions Made

1. **Package name**
   - Decision: `graphlagoon` (pip install graphlagoon)
   - Import: `from src import create_app, create_api_router`

2. **Optional dependencies**
   - Decision: `gsql2rsql` as required dependency (cypher support)
   - Decision: `asyncpg` and `alembic` as optional extra `[postgres]`

3. **Including static files in the package**
   - Decision: Use `force-include` in hatchling to include static and templates
   - Include: `src/static`, `src/templates`

4. **Build scripts**
   - Decision: Makefile with `build-frontend` and `build` targets
   - Command: `make build` generates wheel with frontend included

5. **CLI entry point**
   - Decision: `graphlagoon` command via `src.cli:main`
   - Usage: `graphlagoon --port 8000 --host 0.0.0.0`

### Modified Files
- `pyproject.toml` - Package configuration with extras and force-include
- `Makefile` - Build targets
- `src/cli.py` - CLI entry point

---

## Trade-offs Accepted

1. **Complexity vs Flexibility**
   - Accepted: More code to support multiple modes (dev/databricks/embedded)
   - Benefit: Single package serves all use cases

2. **Frontend bundle size**
   - Accepted: ~2MB of JS/CSS included in pip install
   - Alternative rejected: CDN (requires internet, doesn't work air-gapped)

3. **No SSR**
   - Accepted: Frontend is pure SPA, no SSR
   - Reason: SSR complexity doesn't justify the benefit for this application

4. **Optional database but no fallback**
   - Accepted: No DB = no persistence for contexts/explorations
   - Reason: In-memory storage would be confusing (data lost on restart)

---

## Pending Items and Risks

1. **Integration tests with real Databricks**
   - Status: Not yet tested
   - Risk: There may be subtle API differences

2. **CORS in embedded mode**
   - Status: CORS currently allows all origins
   - Risk: May need more restrictive config in production

3. **Authentication in production**
   - Status: X-User-Email is insecure
   - Recommendation: Users should provide their own auth_dependency

---

## How to Use

### Standalone Mode (Local Dev)
```bash
# Install dependencies
make install

# Build frontend
make build-frontend

# Run API with frontend
cd graphlagoon-rest-api
uv run uvicorn src.app:app --reload
```

### Standalone Mode (Databricks)
```bash
# Set environment variables
export DATABRICKS_MODE=true
export DATABRICKS_HOST=adb-xxx.azuredatabricks.net
export DATABRICKS_TOKEN=dapi-xxx
export DATABRICKS_WAREHOUSE_ID=xxx
export DATABASE_ENABLED=false

# Run
uv run uvicorn src.app:app
```

### Embedded Mode (in existing app)
```python
from fastapi import FastAPI
from src import create_api_router

app = FastAPI()
app.include_router(create_api_router(), prefix="/graphlagoon")
```
