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

## Summary Table

| ID | Severity | Component | Description | Effort |
|----|----------|-----------|-------------|--------|
| 1  | 🟡 High | Frontend | Large store file (1127 lines) | Medium |
| 2  | 🟡 High | Frontend | Dual persistence complexity | Medium |
| 3  | 🟢 Medium | Frontend | Missing TypeScript strict mode | High |
| 4  | 🟡 High | Frontend | No unit tests | High |
| 5  | 🟢 Medium | Frontend | Hardcoded values | Low |
| 6  | 🔴 Critical | Frontend | Memory leaks risk with workers | Low |
| 7  | 🟡 High | Frontend | Error handling inconsistency | Medium |
| 8  | 🟢 Medium | Frontend | 3D Force Graph type safety | Low |
| 9  | 🔴 Critical | Backend | Missing DB pool config | Low |
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

## Prioritization Recommendations

### Phase 1: Critical Fixes (1-2 weeks)
1. Memory leaks risk (#6)
2. Database connection pooling (#9)
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
