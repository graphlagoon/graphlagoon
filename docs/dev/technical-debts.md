# Technical Debts

## Overview

This document tracks technical debts, areas for improvement, and architectural concerns in the graphlagoon-studio project. Technical debt represents code or design decisions that prioritize short-term delivery over long-term maintainability.

## Classification

- **🔴 Critical:** Affects stability, security, or performance significantly
- **🟡 High:** Should be addressed soon to prevent future issues
- **🟢 Medium:** Nice to have, improves maintainability
- **⚪ Low:** Minor improvements, can be deferred

---

## Frontend Technical Debts

### 1. 🟡 Large Store File (graph.ts - 1127 lines)

**Location:** [graphlagoon-frontend/src/stores/graph.ts](graphlagoon-frontend/src/stores/graph.ts)

**Issue:**
The main graph store has grown to 1127 lines, making it difficult to navigate and maintain. It handles too many responsibilities:
- Graph data management
- Filters (multiple types)
- Layout algorithms
- Aesthetics
- Text formatting
- Explorations
- Behaviors
- API calls

**Impact:**
- Hard to understand and modify
- Increased risk of bugs when making changes
- Difficult to test individual features
- Merge conflicts more likely

**Recommendation:**
Split into smaller, focused stores:
```
stores/
├── graph/
│   ├── data.ts        # nodes, edges, current context
│   ├── filters.ts     # all filter types
│   ├── layout.ts      # Force Atlas 2, Helios settings
│   ├── aesthetics.ts  # colors, sizes, opacity
│   ├── text.ts        # text formatting rules
│   ├── behaviors.ts   # UI behavior settings
│   └── index.ts       # Combines all substores
```

**Effort:** Medium (2-3 days)

### 2. 🟡 Dual Persistence Mode Complexity

**Location:** [graphlagoon-frontend/src/services/api.ts](graphlagoon-frontend/src/services/api.ts)

**Issue:**
The dual persistence mode (localStorage vs API) creates complexity throughout the frontend:
- Every API call checks `persistenceMode`
- `context_info` must be passed conditionally
- Error handling differs between modes
- Testing requires covering both paths

**Impact:**
- More complex code
- Higher chance of bugs
- Harder to maintain
- Duplicate logic

**Recommendation:**
Use the **Adapter Pattern** to abstract persistence:
```typescript
interface PersistenceAdapter {
  loadContext(id: string): Promise<GraphContext>
  executeQuery(contextId: string, query: string): Promise<GraphResponse>
  // ...
}

class LocalStorageAdapter implements PersistenceAdapter { }
class ApiAdapter implements PersistenceAdapter { }

// Single interface, no mode checks
const persistence: PersistenceAdapter = createAdapter(mode)
```

**Effort:** Medium (3-4 days)

### 3. 🟢 Missing TypeScript Strict Mode

**Location:** Frontend tsconfig

**Issue:**
TypeScript strict mode is not enabled, allowing:
- Implicit `any` types
- Null/undefined issues
- Type coercion bugs

**Impact:**
- Runtime errors that could be caught at compile time
- Less type safety
- Harder to refactor

**Recommendation:**
Enable strict mode incrementally:
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true
  }
}
```

**Effort:** High (5-7 days to fix all errors)

### 4. 🟡 No Unit Tests

**Location:** Frontend codebase

**Issue:**
No unit tests for critical business logic:
- Graph filtering algorithms
- Label formatting
- Metrics calculations
- API service layer

**Impact:**
- Regressions not caught early
- Fear of refactoring
- Hard to verify bug fixes

**Recommendation:**
Add Vitest + Testing Library:
- Test stores with Pinia Testing
- Test components with Vue Testing Library
- Test utils and composables in isolation

**Priority Areas:**
1. Graph filtering logic
2. Label formatter
3. API service
4. Metrics calculations

**Effort:** High (ongoing, start with critical paths)

### 5. 🟢 Hardcoded Values and Magic Numbers

**Location:** Multiple components

**Examples:**
- Camera idle timeout: 300ms (GraphCanvas3D.vue)
- Curvature step: 0.15 (GraphCanvas.vue, GraphCanvas3D.vue)
- Color defaults scattered across files

**Recommendation:**
Create configuration constants:
```typescript
// constants/visualization.ts
export const CAMERA_IDLE_TIMEOUT_MS = 300
export const EDGE_CURVATURE_STEP = 0.15
export const MAX_EDGE_CURVATURE = 0.6
export const DEFAULT_NODE_SIZE = 5
```

**Effort:** Low (1-2 days)

### 6. 🔴 Memory Leaks Risk with Web Workers

**Location:** [graphlagoon-frontend/src/stores/metrics.ts](graphlagoon-frontend/src/stores/metrics.ts)

**Issue:**
Web Workers may not be properly terminated when:
- Component unmounts
- User navigates away
- Context changes

**Impact:**
- Memory leaks in long-running sessions
- Performance degradation
- Browser tab crashes

**Recommendation:**
Implement proper cleanup:
```typescript
onUnmounted(() => {
  if (metricsWorker) {
    metricsWorker.terminate()
    metricsWorker = null
  }
})
```

Use worker pool with lifecycle management.

**Effort:** Low (1 day)

**Resolved (2026-08-26):** `GraphVisualizationView` now calls
`resetMetricsCalculator()` (which terminates the metrics worker pool) plus
`communityStore.clearCommunities()` (which terminates a mid-run community
worker) both in `onUnmounted` and in the context-change watcher. The pool
re-initializes lazily on the next computation, so re-entering the view costs
nothing. Contract pinned by
`frontend/src/services/__tests__/metricsCalculator.test.ts`.

### 7. 🟡 Error Handling Inconsistency

**Location:** Frontend stores and components

**Issue:**
Error handling varies across the codebase:
- Some errors shown in modals
- Some in toasts
- Some only logged to console
- Inconsistent error message format

**Recommendation:**
Standardize error handling:
```typescript
// utils/errorHandler.ts
export function handleApiError(error: unknown, context: string) {
  const details = extractErrorDetails(error)

  // Always log
  console.error(`[${context}]`, details)

  // Show user-friendly message
  if (details.isUserError) {
    useToast().warning(details.message)
  } else {
    useToast().error(details.message)
  }

  // Store for debugging
  errorStore.addError({ context, details, timestamp: Date.now() })
}
```

**Effort:** Medium (2-3 days)

**Resolved (2026-08-26):** Shared extractor created at
`frontend/src/utils/errorMessage.ts` (`extractErrorDetails` /
`getErrorMessage`, tested), replacing 4 near-identical copies (graph store,
query console store, StylePresetModal, PrecomputedGraphPanel) plus the
hand-rolled unwraps in `saveExploration` and GraphContextFormModal. All
`alert()` calls removed (cluster program run paths now use toasts).
Silent user-initiated failures now toast: load-exploration (Toolbar),
metric compute (MetricsPanel), delete/share/unshare in ContextsView and
ExplorationsView, template delete, and the never-rendered persistence
error refs in `cluster.ts`/`contextMenuActions.ts`. Deliberately NOT done
(follow-ups, not blockers): axios response interceptor, unifying the
modal-vs-toast double report on query failures, `window.confirm` sites,
worker error-channel field naming.

### 8. 🟢 3D Force Graph Type Safety

**Location:** [graphlagoon-frontend/src/components/GraphCanvas3D.vue](graphlagoon-frontend/src/components/GraphCanvas3D.vue:22)

**Issue:**
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let graph3d: any = null;
```

Using `any` type for the main graph instance loses all type safety.

**Recommendation:**
Create proper type definitions:
```typescript
import type ForceGraph3D from '3d-force-graph'

type Graph3DInstance = ReturnType<typeof ForceGraph3D>
let graph3d: Graph3DInstance | null = null
```

**Effort:** Low (1 day)

---

## Backend Technical Debts

### 9. 🔴 Missing Database Connection Pooling Configuration

**Location:** [graphlagoon-rest-api/graphlagoon/db/database.py](graphlagoon-rest-api/graphlagoon/db/database.py)

**Issue:**
Database engine created without explicit pool configuration:
```python
engine = create_async_engine(database_url, echo=False, pool_pre_ping=True)
```

Missing:
- Pool size limits
- Overflow handling
- Connection timeout
- Pool recycle time

**Impact:**
- Connection exhaustion under load
- Poor performance with many concurrent users
- Potential database connection leaks

**Recommendation:**
```python
engine = create_async_engine(
    database_url,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,              # Max connections in pool
    max_overflow=20,           # Additional connections under load
    pool_timeout=30,           # Wait time for connection
    pool_recycle=3600,         # Recycle connections every hour
)
```

**Effort:** Low (1 day)

**Resolved (2026-08-26):** The standard PostgreSQL engine now receives
`pool_size` / `max_overflow` / `pool_timeout` / `pool_recycle` from `Settings`
(new `GRAPH_LAGOON_DATABASE_POOL_*` env vars, defaults 10/20/30s/3600s —
documented in `docs/guide/configuration.md`). The Lakebase engine already had
its own tuned pool (recycle tied to token lifetime) and is unchanged. Pinned by
`api/tests/test_database_pool.py`.

### 10. 🟡 Lazy Database Initialization Without Health Checks

**Location:** [graphlagoon-rest-api/graphlagoon/db/database.py](graphlagoon-rest-api/graphlagoon/db/database.py)

**Issue:**
Database is initialized lazily but there's no health check on startup. The application starts successfully even if the database is unavailable, and errors only occur on first request.

**Impact:**
- Silent failures during deployment
- Delayed error discovery
- Poor developer experience

**Recommendation:**
Add startup health check:
```python
@app.on_event("startup")
async def check_database_health():
    if settings.database_enabled:
        await init_database(settings.database_url)
        # Verify connection
        async with get_db() as db:
            await db.execute("SELECT 1")
        logger.info("Database connection verified")
```

**Effort:** Low (1 day)

### 11. 🟡 SQL Injection Risk in Node Query Construction

**Location:** [graphlagoon-rest-api/graphlagoon/services/graph_operations.py:282-287](graphlagoon-rest-api/graphlagoon/services/graph_operations.py:282-287)

**Issue:**
```python
node_ids_str = ", ".join([f"'{n}'" for n in node_ids])
node_query = f"""
    SELECT *
    FROM {node_table}
    WHERE `{node_id_col}` IN ({node_ids_str})
"""
```

While `node_ids` comes from the previous query result (relatively safe), using string formatting for SQL is a bad practice that could become vulnerable if the data source changes.

**Impact:**
- Potential SQL injection vulnerability
- Bad practice that could propagate

**Recommendation:**
Use parameterized queries or proper escaping:
```python
# Validate and escape node IDs
from sqlalchemy import text

safe_node_ids = [escape_sql_value(nid) for nid in node_ids]
node_ids_str = ", ".join([f":{i}" for i in range(len(node_ids))])

node_query = text(f"""
    SELECT *
    FROM {node_table}
    WHERE `{node_id_col}` IN ({node_ids_str})
""")
params = {str(i): nid for i, nid in enumerate(node_ids)}
```

**Note:** This requires the warehouse client to support parameterized queries.

**Effort:** Medium (2-3 days, depends on warehouse client capabilities)

### 12. 🟡 Missing Request Validation Middleware

**Location:** Backend routers

**Issue:**
No global request size limits or rate limiting. Large payloads could cause:
- Memory exhaustion
- Slow response times
- DoS attacks

**Recommendation:**
Add middleware:
```python
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from slowapi import Limiter

limiter = Limiter(key_func=get_remote_address)

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["*.example.com", "localhost"]
)

# Rate limiting on expensive endpoints
@limiter.limit("10/minute")
@router.post("/query")
async def execute_query(...):
    ...
```

**Effort:** Medium (2 days)

### 13. 🟢 No API Versioning

**Location:** API routers

**Issue:**
All endpoints at `/api/*` without versioning:
```python
router = APIRouter(prefix="/api/graph-contexts")
```

**Impact:**
- Breaking changes affect all clients
- Hard to maintain backward compatibility
- No migration path for clients

**Recommendation:**
Implement versioning:
```python
# v1 router
v1_router = APIRouter(prefix="/api/v1")
v1_router.include_router(graph_contexts_router)
v1_router.include_router(explorations_router)

# v2 router with breaking changes
v2_router = APIRouter(prefix="/api/v2")
v2_router.include_router(graph_contexts_v2_router)

app.include_router(v1_router)
app.include_router(v2_router)
```

**Effort:** Medium (3-4 days)

### 14. 🟡 Missing Telemetry and Monitoring

**Location:** Backend application

**Issue:**
No structured logging, metrics, or tracing:
- No request timing
- No error tracking
- No performance metrics
- Hard to debug production issues

**Recommendation:**
Add observability stack:
```python
# Structured logging with structlog
import structlog

# Prometheus metrics
from prometheus_fastapi_instrumentator import Instrumentator

Instrumentator().instrument(app).expose(app)

# OpenTelemetry tracing
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

FastAPIInstrumentor.instrument_app(app)
```

**Effort:** Medium (3-4 days)

### 15. 🟢 Hardcoded Error Messages

**Location:** Multiple routers and services

**Issue:**
Error messages are hardcoded strings:
```python
raise HTTPException(status_code=404, detail="Context not found")
```

**Impact:**
- No internationalization support
- Inconsistent error messages
- Hard to maintain

**Recommendation:**
Use error code constants:
```python
# errors.py
class ErrorCode(Enum):
    CONTEXT_NOT_FOUND = "CONTEXT_NOT_FOUND"
    QUERY_EXECUTION_FAILED = "QUERY_EXECUTION_FAILED"

ERROR_MESSAGES = {
    ErrorCode.CONTEXT_NOT_FOUND: "Graph context not found",
    ErrorCode.QUERY_EXECUTION_FAILED: "Failed to execute query: {details}"
}

# Usage
raise HTTPException(
    status_code=404,
    detail={
        "code": ErrorCode.CONTEXT_NOT_FOUND,
        "message": ERROR_MESSAGES[ErrorCode.CONTEXT_NOT_FOUND]
    }
)
```

**Effort:** Medium (2-3 days)

### 16. 🟡 No Caching Layer

**Location:** Backend services

**Issue:**
No caching for:
- Graph contexts (frequently accessed)
- Catalog metadata
- Query results (for identical queries)

**Impact:**
- Unnecessary database queries
- Slower response times
- Higher database load

**Recommendation:**
Implement caching strategy:
```python
from fastapi_cache import FastAPICache
from fastapi_cache.backends.redis import RedisBackend
from redis import asyncio as aioredis

# Startup
@app.on_event("startup")
async def startup():
    redis = aioredis.from_url("redis://localhost")
    FastAPICache.init(RedisBackend(redis), prefix="graphlagoon")

# Usage
from fastapi_cache.decorator import cache

@router.get("/{context_id}")
@cache(expire=300)  # 5 minutes
async def get_context(context_id: str):
    ...
```

**Effort:** Medium (3-4 days)

**Partially addressed (2026-08-20, reframed 2026-08-23):** what began as the
"named graph cache" is now **precomputed graphs**
([services/precomputed/](api/graphlagoon/services/precomputed/)), which covers
the third bullet for the case that mattered most — a graph someone wants to
reopen, or hand to a colleague, without paying for the query again.

It was never a cache, and the rename says so: nothing is keyed by query text,
nothing is invalidated, nothing is evicted on a timer. A deployment declares
providers that decide what a named graph resolves to.

Contexts and catalog metadata are still uncached, and **precomputed graphs are
no longer the seam a real cache would implement** — a cache is about
invalidation and lifetime, which the provider protocol deliberately says nothing
about. An automatic cache would be a new mechanism, not an implementation of
this one.

---

### 24. 🟢 Databricks Files-API Client Duplicated

**Location:** [api/graphlagoon/services/blob_storage.py](api/graphlagoon/services/blob_storage.py)
and [api/graphlagoon/services/snapshot.py](api/graphlagoon/services/snapshot.py)

**Issue:**
`DatabricksBlobStore` and `DatabricksSnapshotService` carry near-identical copies
of `_auth_headers` (including the `"Bearer "` strip) and `_check_response` (the
status→exception taxonomy). `blob_storage.py` is the generalization —
path-keyed, listable — and `snapshot.py` could become a thin adapter over it.

**Why it was left duplicated:**
`snapshot.py` sits on the critical path of every exploration open and has **no
test coverage**. Its error taxonomy is load-bearing: `_persist_snapshot` maps
`PermissionError`/`TimeoutError`/`OSError` onto distinct HTTP codes, and
`loadExploration` in the frontend depends on the load path *throwing* to trigger
its query re-execution fallback. A refactor that flattened one of those into a
generic `OSError` would silently convert "fall back to re-running the query" into
"this exploration is broken", with no user-visible upside.

**Recommendation:**
Write characterization tests for `snapshot.py` first (`httpx.MockTransport`,
pinning each status→exception mapping and `load()` returning `None` on 404), then
re-express it over `BlobStore`. `blob_storage.py` was designed to make this
possible: keys can sit at the volume root, and `load()` already returns `None`
rather than raising.

**Effort:** Small (1 day, once the characterization tests exist)

---

### 25. 🟡 Snapshot Temp-File Collision on Concurrent Writes

**Location:** [api/graphlagoon/services/snapshot.py](api/graphlagoon/services/snapshot.py)
(`LocalSnapshotService.save`)

**Issue:**
```python
tmp = self._path(eid).with_suffix(".tmp")   # {uuid}.json.gz → {uuid}.json.tmp
tmp.write_bytes(data)
tmp.replace(self._path(eid))
```
The temp path is derived from the target, so two concurrent saves of the *same*
exploration share one temp file. Their writes interleave and `replace()`
publishes a corrupt blob — the atomic-write pattern defeating itself.

Narrow in practice (it needs two overlapping saves of one exploration), but the
failure is silent data corruption rather than an error.

**Recommendation:**
Use a unique temp name per write, as `LocalBlobStore._save_sync` does
(`.tmp-{uuid4().hex}`), and filter dot-prefixed files out of any listing so a
crashed write cannot surface as a phantom entry.

**Effort:** Trivial (few lines) — bundle with #24.

**Resolved (2026-08-26):** `LocalSnapshotService.save` now writes to a unique
`.tmp-{uuid4().hex}` in the base dir and cleans it up on failure, mirroring
`LocalBlobStore._save_sync`. Pinned by `api/tests/test_snapshot_local.py`
(concurrent-save integrity, no leftover temp files, cleanup on failed write).
#24 (Databricks client dedup) remains open — its characterization tests were
not written here.

---

### 26. 🟢 Exploration Snapshots Leak on Context Deletion

**Location:** [api/graphlagoon/routers/graph_contexts.py](api/graphlagoon/routers/graph_contexts.py)
(`delete_graph_context`)

**Issue:**
Deleting a context removes its database rows (explorations cascade) but never
touches the snapshot files those explorations owned, so they accumulate on the
volume with nothing left pointing at them.

Precomputed graphs got the matching cleanup when they were added
(`_purge_precomputed_graphs`, best-effort and never able to fail the deletion,
now fanning out across every registered provider); snapshots did not, because
their keys are flat per-exploration UUIDs with no per-context prefix to purge —
the ids have to be collected before the rows go.

**Recommendation:**
Collect the exploration ids inside the delete transaction, then delete their
snapshots after the commit, in the same never-raises style as
`_delete_snapshot_if_exists`.

**Effort:** Small (half a day)

---

### 27. 🟢 Derived Node Table Scans the Edge Table Twice

**Location:** [api/graphlagoon/services/graph_operations.py](api/graphlagoon/services/graph_operations.py)
(`derived_node_table_sql`)

**Issue:**
```sql
(SELECT node_id, 'Node' AS node_type FROM (
    SELECT src AS node_id FROM {edge_table}
    UNION
    SELECT dst AS node_id FROM {edge_table}
))
```
Every fetch against a nodeless (triple-store-only) context's virtual node
table reads the edge table twice, once per `UNION` arm. A single-scan
equivalent is available on Spark/Databricks —
`SELECT explode(array(src, dst)) AS node_id FROM {edge_table}` (dedup via
`SELECT DISTINCT` over that, or leave dedup to the caller, which already
joins against a `VALUES` id list) — but it was not used, to keep the
fragment portable dialect-agnostic SQL rather than a Spark builtin.

Disclosed to users in the [Triple Stores guide](/guide/triple-stores.md#performance)
(materialize a view for large triple stores) and in the docstring, but not
actually fixed, and not covered by a performance test — the ~40% cost
difference claimed for the `VALUES`-join pattern elsewhere in this file
(`build_node_query`) was never measured for this path.

**Recommendation:**
Benchmark the `explode(array(...))` rewrite against a large synthetic
triple table (the dev generator's typeless mode from #30 makes this easy
to set up) before switching — the current form's SQL-portability is a real
property to weigh against a single-scan gain.

**Effort:** Small (half a day, mostly benchmarking)

---

### 28. 🟢 `_get_edge_id` Composite Collides for Parallel Edges Without Full Structural Columns

**Location:** [api/graphlagoon/services/graph_operations.py](api/graphlagoon/services/graph_operations.py)
(`_get_edge_id`)

**Issue:**
With no `edge_id_col`, the edge id is synthesized as
`{src}@{relationship_type}@{dst}`. A typeless edge table
(`relationship_type_col=""`) drops the middle term, so the composite
becomes `src@@dst` for every edge — **any two parallel edges between the
same node pair collide onto one id.** The frontend then treats them as one
edge (last-write-wins in whatever downstream map keys on `edge_id`).

This is not a new failure mode — `edge_id_col=""` with a single
relationship type already collided the same way — but the typeless-columns
feature (`docs/dev/decision_log.md`, 2026-08-27 08:30 entry) is the first
place that makes "no edge id AND no relationship type" a first-class,
UI-reachable, documented configuration, so the collision now has a real
audience: any triple-store-only context whose warehouse also lacks an edge
id column, generating true multi-edges (the dev generator's
`multi_edges_max_count`/`multi_edges_ratio` produce exactly this shape).

**Recommendation:**
Either (a) document the limitation explicitly in the
[Triple Stores guide](/guide/triple-stores.md) ("parallel edges without an
edge id column are indistinguishable"), or (b) fold a row-sequence/hash
component into the composite when both columns are absent, at the cost of
the id no longer being derivable from `src`/`dst` alone (breaks the
implicit assumption in a few places that recomputing `_get_edge_id` from
just src/dst/type reproduces the same id). (a) is cheaper and honest; (b)
is the real fix if this proves to matter in practice.

**Effort:** Trivial for (a); Small for (b)

---

### 29. 🟢 Cypher Binding-Error Wrapper Can Mask Unrelated Errors on Constrained Contexts

**Location:** [api/graphlagoon/services/cypher.py](api/graphlagoon/services/cypher.py)
(`transpile_cypher_to_sql`)

**Issue:**
On a nodeless or typeless context, *any* `TranspilerBindingException` —
not just an unknown label/relationship-type — is rewritten into "no node
table / no type column, use :Node / :RELATED_TO". A query that fails to
bind for an unrelated reason (e.g. `a.nonexistent_property`, a malformed
pattern gsql2rsql reports as a binding error) gets the same misleading
message on these contexts, pointing the user at the wrong fix.

Accepted trade-off when the nodeless work introduced the wrapper (same
note applies here): the common case (an unavailable label/type) is common
enough that the better message for *that* case was judged worth the risk
of a wrong message in the uncommon case. Not revisited when the wrapper
was generalized to cover typeless columns too, which widens how often the
wrapper fires (four independent conditions can now trigger it instead of
one).

**Recommendation:**
Narrow the rewrite to binding exceptions whose message actually names an
unknown node/edge label (gsql2rsql's `TranspilerBindingException` message
format is stable enough to pattern-match — see the "Available node types:"
suffix observed in `test_cypher_schema_provider.py`), and re-raise
unchanged otherwise.

**Effort:** Small (half a day, needs a few negative-case tests)

---

### 30. 🟢 Dev-Generator Typeless-Column Support Has No Automated Test Coverage

**Location:** [warehouse/src/services/graph.py](warehouse/src/services/graph.py),
[warehouse/src/models/schemas.py](warehouse/src/models/schemas.py)

**Issue:**
The `warehouse/` package (the local PySpark random-graph generator used by
`make dev`'s "DEV Generator" and `/api/dev/random-graph`) had **zero test
coverage before this change** (`warehouse/tests/` contains only
`test_statements_async.py`, unrelated to graph generation) and still has
none after it. The row-building logic touches five separate code paths
(base edges, self-edges, multi-edges, bidirectional edges, and the node
schema/rows), each independently gated on
`if cols.relationship_type_col:` / `if cols.node_type_col:` — a plausible
place for one path to be missed or misindented (a `replace_all` edit here
initially broke indentation in three of the five and was caught only by
re-reading the diff, not by a test).

**Verified manually (2026-08-28):** ran `generate_random_graph` directly
against a real local `SparkSession` (`barabasi_albert`, 30 nodes,
multi-edges + self-edges + bidirectional-edges all enabled,
`ColumnConfig(node_type_col="", relationship_type_col="")`) and read the
written Parquet back. Node schema is exactly `{node_id, metadata}`, edge
schema exactly `{edge_id, src, dst, metadata}` — `node_type` and
`relationship_type` correctly absent from every one of the five row-build
paths, 127 edges and 30 nodes written without error. Confirms the earlier
`ast.parse` syntax check was matched by correct runtime behavior; the gap
that remains is the missing *automated* regression test, not unverified
code.

**Recommendation:**
Add a unit test for `generate_graph` covering
`ColumnConfig(node_type_col=None, relationship_type_col=None)` (asserting
the resulting DataFrames' schemas), using a local `SparkSession` fixture —
none exists in `warehouse/tests/` yet, so this is also the first step
toward testing the generator at all.

**Effort:** Small (mostly the missing Spark test fixture)

---

## Shared Technical Debts

### 17. 🟡 Inconsistent Naming Between Frontend and Backend

**Location:** Type definitions and schemas

**Issue:**
Frontend and backend use different naming conventions:
- Frontend: `node_id`, `node_type`, `edge_id`
- Backend: Sometimes `nodeId`, `node_id` (mixed)

**Impact:**
- Confusion when reading code
- Transformation logic needed
- Potential bugs

**Recommendation:**
Standardize on snake_case for JSON API (matches Python/SQL conventions):
```typescript
// Frontend types align with backend
interface Node {
  node_id: string       // Not nodeId
  node_type: string     // Not nodeType
  properties: Record<string, any>
}
```

**Effort:** High (affects many files, 5-7 days)

### 18. 🟢 No API Documentation

**Location:** Backend

**Issue:**
While FastAPI generates OpenAPI docs, there's no:
- User guide for API
- Examples and tutorials
- Integration guide for embedding

**Recommendation:**
Create comprehensive API documentation:
- Use FastAPI's description parameter
- Add example requests/responses
- Document authentication flow
- Create integration guide

**Effort:** Medium (3-4 days)

### 19. 🟡 Environment-Specific Configuration

**Location:** Configuration files

**Issue:**
No clear separation between dev/staging/prod configs:
- Dev mode defaults in code
- Environment variables not documented
- No .env.example file

**Recommendation:**
Create environment templates:
```bash
# .env.development
GRAPH_LAGOON_DATABASE_ENABLED=false
GRAPH_LAGOON_DEV_MODE=true
GRAPH_LAGOON_SHOW_ERROR_DETAILS=true

# .env.production
GRAPH_LAGOON_DATABASE_ENABLED=true
GRAPH_LAGOON_DEV_MODE=false
GRAPH_LAGOON_SHOW_ERROR_DETAILS=false
GRAPH_LAGOON_DATABASE_URL=postgresql+asyncpg://...
```

**Effort:** Low (1-2 days)

---

## Architecture Debts

### 20. 🟡 Missing Domain Layer

**Location:** Backend architecture

**Issue:**
Business logic mixed with service and router layers. No clear domain models separate from persistence models.

**Recommendation:**
Introduce domain layer:
```
domain/
├── models/          # Domain models (not tied to DB)
├── services/        # Domain services
└── repositories/    # Data access abstraction
```

**Effort:** High (7-10 days, major refactor)

### 21. 🟢 No GraphQL Support

**Location:** API

**Issue:**
REST API requires multiple round trips for complex graph operations. GraphQL would allow:
- Single request for complex queries
- Client-specified fields
- Better developer experience

**Recommendation:**
Add GraphQL endpoint using Strawberry or Graphene:
```python
from strawberry.fastapi import GraphQLRouter

graphql_router = GraphQLRouter(schema)
app.include_router(graphql_router, prefix="/graphql")
```

**Effort:** High (7-10 days)

---

### 24. 🟢 E2E MOCK_GRAPH_RESPONSE nodes carry properties at the top level

**Location:** [frontend/e2e/fixtures/mock-data.ts](frontend/e2e/fixtures/mock-data.ts) (`MOCK_GRAPH_RESPONSE`)

**Issue:**
Nodes are shaped `{ node_id, node_type, name, age }` — but the app expects
`properties: { name, ... }` (see `types/graph.ts`). E2E therefore renders
nodes with no usable properties: labels fall back to node ids and the detail
panel is empty. Tests pass because none assert on rendered labels, so the
suite silently exercises a degraded rendering path. The docs screenshot
fixture (`frontend/e2e/fixtures/screenshot-graph.ts`) uses the correct shape.

**Recommendation:**
Move the extra fields under `properties` and adjust any spec that reads them
from the top level. Verify no test relied on the fallback-to-id labels.

**Effort:** Small (half a day)

---

### 25. ⚪ Docs "living docs" hardening not yet applied beyond skill_feature_creation

**Location:** `.claude/skills/`, `.github/`

**Issue:**
The mandatory public-docs step (guide + sidebar + `make docs-build` +
`make docs-screenshots`) exists only in `skill_feature_creation` (Step 4.2).
Deliberately deferred (owner decision, 2026-08-26):
- No equivalent step in `skill_context_menu_action` or other skills
- No PR template checkbox
- No non-blocking CI warning when `frontend/src/**` changes without `docs/**`
- No visual-regression (`toHaveScreenshot`) — WebGL nondeterminism makes ROI low
- `PricingCards.vue` still shows three identical "Free" plans and a hardcoded
  mailto — product/content decision pending

**Recommendation:**
Revisit if features keep shipping without docs despite the skill gate.

**Effort:** Small (1-2 hours for skills/CI pieces)

---

### 26. 🟡 Dead or inert UI surfaces found during the docs audit (2026-08-26)

**Location:** frontend/src

**Issue:**
Writing user guides forced a behavior-level review; these shipped states
don't match their UI promises (none are documented in the public guides):

1. `PropertyFilterPanel.vue` is **not mounted anywhere** — no toolbar
   entry, no route; only its unit test references it. The store-level
   property/metric filters it edits ARE live (explorations can carry
   them), so the panel is finished but unreachable.
2. The Filters panel search placeholder says "Search in metadata..." but
   the search index only covers `node_id` + `node_type`.
3. Metrics → Visual Mapping "Scale" (log/sqrt) is never applied —
   `computeNodeAppearance` always normalizes linearly; `scaleValue()` has
   no non-test call sites.
4. Metrics → Edge Weight mapping has no renderer consumer — edge widths
   never respond to it.
5. Metrics "Real-time visual updates" checkbox is a no-op (partial-result
   callback is empty in `metricsCalculator.ts:64-68`).
6. `create_mountable_app`'s docstring example (`app.py:435-438`) still
   shows the old dict-returning `header_provider`; the real contract is a
   token string (the `__init__.py` docstring is correct).

**Recommendation:**
Wire up or delete the panel (1); fix the placeholder text (2); implement
or hide the inert controls (3-5); fix the docstring (6). Update
`docs/guide/exploring-the-graph.md` / `communities-metrics.md` when any of
these become real.

**Effort:** Small-Medium (placeholder/docstring minutes; the rest half a
day each)

**Resolved (2026-08-26):** all six items:
1. `PropertyFilterPanel` wired up — new toolbar button **Metric Filters**
   (`PanelId 'metric-filters'`), documented in `communities-metrics.md`
   with a screenshot scene (`communities-metrics-metric-filters`), E2E in
   `graph.spec.ts`.
2. Search placeholder now says "Search by node ID or type..." (matches the
   actual index and the public guide).
3. Scale (log/sqrt) is applied: `computeNodeAppearance` uses `scaleValue`;
   `AppearanceContext.nodeSizeMapping` carries `scale`.
4. Edge Weight mapping consumed: `computeLinkAppearance` returns a
   metric-mapped `width` (null = aesthetic base width, kept live), rendered
   via `linkWidth` in GraphCanvas3D.
5. Both inert real-time checkboxes removed from MetricsPanel;
   `enableRealTimeUpdates` now defaults to false in the calculator (the
   partial-result callback is a no-op, streaming was pure overhead). The
   store field/action remain for state compat.
6. `create_mountable_app` docstring example fixed (token string, not dict).

---

## Performance Debts

### 22. 🔴 No Pagination on Large Result Sets

**Location:** Frontend and backend

**Issue:**
Loading thousands of nodes/edges at once:
- Causes UI freezes
- High memory usage
- Slow rendering

**Recommendation:**
Implement cursor-based pagination:
```python
@router.post("/subgraph")
async def get_subgraph(
    limit: int = 100,
    cursor: Optional[str] = None
):
    # Return paginated results with next cursor
```

Frontend loads incrementally.

**Effort:** High (5-7 days)

### 23. 🟡 Force Layout Runs Continuously

**Location:** Frontend GraphCanvas components

**Issue:**
Force layout algorithms run indefinitely, consuming CPU even when graph is stable.

**Recommendation:**
Detect stabilization and stop:
```typescript
const checkStabilization = () => {
  const avgMovement = calculateAverageNodeMovement()
  if (avgMovement < STABILIZATION_THRESHOLD) {
    stopLayout()
    layoutStabilized.value = true
  }
}
```

**Effort:** Medium (2-3 days)

---

### 31. 🟡 No Content-Security-Policy — the custom-metric sandbox has a single fence

**Location:** [api/graphlagoon/app.py](api/graphlagoon/app.py), [frontend/index.html](frontend/index.html)

**Issue:**
The app sets no CSP. The custom-metric worker ([frontend/src/workers/customMetricWorker.ts](frontend/src/workers/customMetricWorker.ts)) strips network/storage/messaging globals from its scope before running user code, and the main thread enforces a timeout, but nothing at the browser-policy level backs that up. A CSP with `worker-src 'self'; connect-src 'self'` (plus whatever the Databricks Apps proxy and PrimeVue inline styles need) would make an escape that somehow re-obtained `fetch` still unable to reach a foreign host.

**Recommendation:** Add a CSP as a dedicated change (it touches the proxy setup, `/graphlagoon/static`, inline styles and the Neptune/REST datasources' allowed hosts), test it against `make dev-databricks`, then tighten `worker-src`/`connect-src`.

**Effort:** Medium

---

### 32. 🟡 Cluster programs still run unsandboxed on the main thread

**Location:** [frontend/src/stores/cluster.ts](frontend/src/stores/cluster.ts) (`computeClustersFromProgram`, `new Function` on the main thread)

**Issue:**
Custom metrics introduced a sandbox (dedicated worker, stripped scope, hard timeout, re-validated output). Cluster programs — the older user-JS feature — still compile with `new Function` on the main thread with full access to `window`, no timeout, and output validation only. The two features now have inconsistent security postures for the same kind of input (writer-authored JavaScript stored on the context).

**Recommendation:** Move cluster-program evaluation onto the custom-metric runner pattern (`services/customMetricRunner.ts` + `workers/customMetricSandbox.ts`), keeping the current output validation. Note cluster programs are also persisted per exploration, so the "only writers run writer code" argument does not fully apply to them — the sandbox matters more there, not less.

**Effort:** Medium

---

### 33. 🟢 Custom-metric snapshot is structured-cloned on every recompute cycle

**Location:** [frontend/src/services/customMetricRunner.ts](frontend/src/services/customMetricRunner.ts) (`serializeGraphForCustomMetrics`)

**Issue:**
Each recompute cycle clones the full filtered population (ids, types, properties) plus degrees, non-custom metric values and communities into the worker. On 200k+ node graphs with wide properties that is tens of MB per cycle. Cycles are debounced (750 ms) and coalesced, and adjacency is built inside the worker rather than cloned, so this is a latency cost rather than a correctness one.

**Recommendation:** If it shows up in `make perf-report`, transfer a JSON `ArrayBuffer` (transferable) or keep a long-lived worker and send property patches (`nodePatchVersion`) instead of the whole snapshot.

**Effort:** Medium

---

### 34. 🟢 `{metric:<name>}` resolves by first match when names collide

**Location:** [frontend/src/stores/metrics.ts](frontend/src/stores/metrics.ts) (`findMetricByName`, `metricResolver`)

**Issue:**
Label templates reference metrics by id or name. Custom-metric names are unique per context (validated server-side) and algorithm runs carry a timestamp, so collisions are rare — but two algorithm runs can have identical names if started in the same second, and a custom metric could be named like an algorithm run. Resolution is by id first, then the first name match in list order (built-ins, then insertion order).

**Recommendation:** Prefer ids in templates written by the Labels panel autocomplete (it currently inserts names for readability), or warn in `validateTemplate` when a name matches more than one metric.

**Effort:** Small

---

### 35. 🟢 Admin area DB-mode paths lack PostgreSQL coverage

**Location:** [api/graphlagoon/routers/admin.py](api/graphlagoon/routers/admin.py), [api/graphlagoon/services/environment.py](api/graphlagoon/services/environment.py), [api/graphlagoon/services/audit.py](api/graphlagoon/services/audit.py)

**Issue:**
The suite runs in memory mode. Every admin endpoint has a DB branch (counts via `func.count`, user list with grouped ownership counts, transfer with share cleanup in the same transaction, `alembic_version` read, `usage_logs` writes) that mirrors the memory branch and shares the same helpers, but is only exercised manually with `make dev-db`.

**Recommendation:** A PostgreSQL-backed integration job (docker compose already exists) running `test_admin.py` with `GRAPH_LAGOON_DATABASE_ENABLED=true`.

**Effort:** Small

---

### 36. 🟢 Precomputed / preset audit entries are declared, not behaviourally tested

**Location:** [api/tests/test_admin_registry.py](api/tests/test_admin_registry.py), [api/tests/test_audit.py](api/tests/test_audit.py)

**Issue:**
`AUDITED_ROUTES` lists the precomputed publish/delete and preset delete routes, and the registry test checks their modules call `audit.record`, but only the context/exploration handlers are exercised end-to-end for the audit line (they need no storage provider). A regression that moves the `audit.record` call above a raising storage call would not be caught.

**Recommendation:** Extend `test_precomputed_graphs.py` / `test_style_presets.py` (which already have provider fixtures) with one assertion on `InMemoryStore.usage_logs` after a successful PUT/DELETE.

**Effort:** Small

---

### 37. 🟢 `get_current_user` cannot await an async `user_provider`

**Location:** [api/graphlagoon/middleware/auth.py](api/graphlagoon/middleware/auth.py) (`get_current_user`)

**Issue:**
The admin work made `get_current_user` consult the `configure_auth` provider (so a mounted deployment without `AuthMiddleware` cannot be bypassed by a forged `X-Forwarded-Email`). It is a sync function used as a plain call inside handlers, so an *async* provider cannot be awaited there; it now fails closed with `500 AUTH_MISCONFIGURED` and tells the host to install `AuthMiddleware`. Correct, but a host with an async provider and no middleware gets a 500 instead of working.

**Recommendation:** Turn `get_current_user` into an async FastAPI dependency (`Depends`) across routers, or resolve the provider once in a lightweight ASGI middleware that is always installed by `create_mountable_app`.

**Effort:** Small–Medium

---

## Summary Table

| ID | Severity | Component | Description | Effort |
|----|----------|-----------|-------------|--------|
| 1  | 🟡 High | Frontend | Large store file (1127 lines) | Medium |
| 2  | 🟡 High | Frontend | Dual persistence complexity | Medium |
| 3  | 🟢 Medium | Frontend | Missing TypeScript strict mode | High |
| 4  | 🟡 High | Frontend | No unit tests | High |
| 5  | 🟢 Medium | Frontend | Hardcoded values | Low |
| 6  | ✅ Resolved (2026-08-26) | Frontend | Memory leaks risk with workers | Low |
| 7  | ✅ Resolved (2026-08-26) | Frontend | Error handling inconsistency | Medium |
| 8  | 🟢 Medium | Frontend | 3D Force Graph type safety | Low |
| 9  | ✅ Resolved (2026-08-26) | Backend | Missing DB pool config | Low |
| 10 | 🟡 High | Backend | Lazy init without health checks | Low |
| 11 | 🟡 High | Backend | SQL injection risk | Medium |
| 12 | 🟡 High | Backend | Missing request validation | Medium |
| 13 | 🟢 Medium | Backend | No API versioning | Medium |
| 14 | 🟡 High | Backend | Missing telemetry | Medium |
| 15 | 🟢 Medium | Backend | Hardcoded error messages | Medium |
| 16 | 🟡 High | Backend | No caching layer | Medium |
| 17 | 🟡 High | Shared | Inconsistent naming | High |
| 18 | 🟢 Medium | Shared | No API documentation | Medium |
| 19 | 🟡 High | Shared | Environment-specific config | Low |
| 20 | 🟡 High | Architecture | Missing domain layer | High |
| 21 | 🟢 Medium | Architecture | No GraphQL support | High |
| 22 | 🔴 Critical | Performance | No pagination | High |
| 23 | 🟡 High | Performance | Force layout runs continuously | Medium |
| 27 | 🟢 Medium | Backend | Derived node table scans edge table twice | Small |
| 28 | 🟢 Medium | Backend | `_get_edge_id` composite collides for parallel edges | Trivial–Small |
| 29 | 🟢 Medium | Backend | Cypher binding-error wrapper can mask unrelated errors | Small |
| 30 | 🟢 Medium | Backend | Dev-generator typeless columns lack automated tests (manually verified) | Small |
| 31 | 🟡 High | Frontend/Backend | No CSP behind the custom-metric sandbox | Medium |
| 32 | 🟡 High | Frontend | Cluster programs still run unsandboxed on the main thread | Medium |
| 33 | 🟢 Medium | Performance | Custom-metric snapshot cloned per recompute cycle | Medium |
| 34 | 🟢 Medium | Frontend | `{metric:name}` first-match resolution on name collisions | Small |
| 35 | 🟢 Medium | Backend | Admin DB-mode paths (counts, users, transfer, alembic_version) have no PostgreSQL test coverage | Small |
| 36 | 🟢 Medium | Backend | Precomputed/preset audit calls are declared, not behaviourally tested | Small |
| 37 | 🟢 Medium | Backend | `get_current_user` cannot await an async `user_provider` (500 without `AuthMiddleware`) | Small |

## Prioritization Recommendations

### Phase 1: Critical Fixes (1-2 weeks)
1. ~~Memory leaks risk (#6)~~ — resolved 2026-08-26
2. ~~Database connection pooling (#9)~~ — resolved 2026-08-26
3. Pagination for large datasets (#22)

### Phase 2: High-Priority Improvements (3-4 weeks)
1. Split large store file (#1)
2. Add unit tests (#4)
3. SQL injection mitigation (#11)
4. Error handling standardization (#7)
5. Request validation (#12)

### Phase 3: Medium-Priority Enhancements (2-3 months)
1. Dual persistence refactor (#2)
2. Caching layer (#16)
3. Telemetry and monitoring (#14)
4. API versioning (#13)
5. Environment configuration (#19)

### Phase 4: Long-Term Investments (3-6 months)
1. TypeScript strict mode (#3)
2. Domain layer architecture (#20)
3. API documentation (#18)
4. Naming consistency (#17)
