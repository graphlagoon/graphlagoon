# Potential Bugs and Issues

## Overview

This document catalogs potential bugs, edge cases, and issues discovered through code analysis. These represent scenarios that may not have been fully tested or could fail under specific conditions.

## Classification

- **🔴 Critical:** Data loss, crashes, security vulnerabilities
- **🟡 High:** Incorrect behavior, user-facing errors
- **🟢 Medium:** Minor issues, edge cases
- **⚪ Low:** Cosmetic issues, minor UX problems

---

## Frontend Bugs

### 1. 🔴 Race Condition in Context Loading

**Location:** [graphlagoon-frontend/src/stores/graph.ts](graphlagoon-frontend/src/stores/graph.ts)

**Issue:**
When rapidly switching between contexts, multiple `loadContext()` calls may execute concurrently. The last call to complete wins, but it may not be the most recent call initiated.

**Scenario:**
```
User clicks Context A → loadContext(A) starts
User clicks Context B → loadContext(B) starts
loadContext(B) completes → context set to B
loadContext(A) completes → context set to A (wrong!)
```

**Impact:**
- Wrong context displayed
- Mismatched data (context A metadata with context B data)
- User confusion

**Reproduction:**
1. Create two contexts
2. Rapidly click between them in the contexts list
3. Observe incorrect context loaded

**Fix:**
```typescript
let currentLoadRequest = 0

const loadContext = async (contextId: string) => {
  const requestId = ++currentLoadRequest

  try {
    const context = await api.loadGraphContext(contextId)

    // Only update if this is still the latest request
    if (requestId === currentLoadRequest) {
      currentContext.value = context
    }
  } catch (error) {
    // Handle error
  }
}
```

**Priority:** High

---

### 2. 🟡 Memory Leak When Switching Between 2D/3D Views

**Location:** [graphlagoon-frontend/src/components/GraphCanvas3D.vue](graphlagoon-frontend/src/components/GraphCanvas3D.vue)

**Issue:**
When switching from 3D to 2D view and back, the previous 3D graph instance may not be fully cleaned up:
- Three.js objects remain in memory
- Animation frames may continue
- Event listeners not removed

**Impact:**
- Memory usage grows over time
- Performance degradation
- Browser tab crashes after multiple switches

**Reproduction:**
1. Load a graph with 1000+ nodes
2. Switch between 2D and 3D views 10-15 times
3. Check memory usage in browser DevTools

**Fix:**
```typescript
onUnmounted(() => {
  // Cancel animation frames
  if (heliosAnimationFrame !== null) {
    cancelAnimationFrame(heliosAnimationFrame)
  }
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
  }

  // Cleanup label renderer
  if (labelRenderer) {
    labelRenderer.dispose()
    labelRenderer = null
  }

  // Cleanup Helios engine
  if (heliosEngine) {
    heliosEngine.dispose()
    heliosEngine = null
  }

  // Cleanup 3D graph
  if (graph3d) {
    // Dispose Three.js objects
    graph3d._destructor()
    graph3d = null
  }
})
```

**Priority:** High

---

### 3. 🟡 Node IDs with Special Characters Break Selection

**Location:** Frontend graph components

**Issue:**
Node IDs containing quotes, backslashes, or other special characters may break:
- CSS selectors
- DOM queries
- Graph library internals

**Example:**
```
Node ID: O'Brien's Node
Query: document.querySelector(`[data-id="O'Brien's Node"]`)
// Breaks due to unescaped quote
```

**Impact:**
- Cannot select nodes
- Tooltips don't work
- Highlighting fails

**Reproduction:**
1. Create nodes with IDs: `"Node's ID"`, `"Node\"Quote"`, `"Node<>Special"`
2. Try to select these nodes
3. Observe errors in console

**Fix:**
```typescript
function escapeSelector(id: string): string {
  return id.replace(/["'\\]/g, '\\$&')
}

// Usage
const safeId = escapeSelector(node.id)
const element = document.querySelector(`[data-id="${safeId}"]`)
```

**Priority:** Medium

---

### 4. 🟡 Exploration State Not Fully Restored

**Location:** [graphlagoon-frontend/src/stores/graph.ts](graphlagoon-frontend/src/stores/graph.ts)

**Issue:**
When loading a saved exploration, some state may not be fully restored:
- Camera position/zoom (not saved)
- Pinned nodes (not saved)
- Layout progress (always restarted)
- Selected nodes (not saved)

**Impact:**
- User must manually reconfigure view
- Explorations don't truly preserve "state"
- Poor user experience

**Reproduction:**
1. Load a graph and arrange nodes
2. Pin some nodes
3. Select a node
4. Save exploration
5. Load exploration → state partially lost

**Fix:**
Extend `ExplorationState` to include:
```typescript
interface ExplorationState {
  // Existing fields
  filters: FilterState
  viewport: ViewportState
  layout_algorithm: LayoutAlgorithm

  // Add missing fields
  camera_position?: { x: number; y: number; z: number }
  camera_zoom?: number
  pinned_nodes?: string[]
  selected_node_ids?: string[]
  selected_edge_ids?: string[]
}
```

**Priority:** Medium

---

### 5. 🟢 Text Format Rules with Same Priority Override Each Other

**Location:** [graphlagoon-frontend/src/utils/labelFormatter.ts](graphlagoon-frontend/src/utils/labelFormatter.ts)

**Issue:**
When multiple text format rules have the same priority, the last one wins. This is inconsistent with user expectations (higher priority = more specific).

**Impact:**
- Unpredictable label formatting
- User confusion

**Fix:**
Add tie-breaking logic:
```typescript
// Sort by priority descending, then by specificity (fewer wildcards)
rules.sort((a, b) => {
  if (a.priority !== b.priority) {
    return b.priority - a.priority
  }

  // Count wildcards (fewer wildcards = more specific)
  const aWildcards = (a.node_type.match(/\*/g) || []).length
  const bWildcards = (b.node_type.match(/\*/g) || []).length

  return aWildcards - bWildcards
})
```

**Priority:** Low

---

### 6. 🟡 Property Filter on Undefined Metric Causes Crash

**Location:** [graphlagoon-frontend/src/stores/graph.ts](graphlagoon-frontend/src/stores/graph.ts)

**Issue:**
If a property filter references a metric that hasn't been computed yet (e.g., user adds filter before metrics finish calculating), accessing the metric value will be undefined, potentially causing errors.

**Impact:**
- Application crash
- Filters don't work

**Reproduction:**
1. Load large graph (slow metric calculation)
2. Immediately add property filter on "degree"
3. Metric not ready → undefined access

**Fix:**
```typescript
const metricsForNode = metricsStore.nodeMetrics.get(nodeId)
if (!metricsForNode) {
  // Metric not ready, consider node as passing filter
  return true
}

const value = metricsForNode[filter.property]
if (value === undefined) {
  return true  // or false, depending on desired behavior
}
```

**Priority:** Medium

---

### 7. 🔴 Concurrent Query Execution Overwrites Results

**Location:** [graphlagoon-frontend/src/stores/graph.ts](graphlagoon-frontend/src/stores/graph.ts)

**Issue:**
If user executes multiple queries rapidly (e.g., spamming "Execute" button), results may be overwritten by whichever query completes last, not necessarily the most recent query.

**Impact:**
- Wrong data displayed
- Confusing user experience
- Potential data inconsistency

**Reproduction:**
1. Execute slow query A
2. Execute fast query B before A completes
3. Query B completes → results shown
4. Query A completes → results overwritten

**Fix:**
```typescript
let activeQueryId = 0

const executeGraphQuery = async (query: string) => {
  const queryId = ++activeQueryId

  try {
    const result = await api.executeQuery(contextId, query)

    // Only update if this is still the most recent query
    if (queryId === activeQueryId) {
      nodes.value = result.nodes
      edges.value = result.edges
    }
  } catch (error) {
    // Handle error
  }
}
```

**Priority:** High

---

## Backend Bugs

### 8. 🔴 Node Query Fails with Empty Node IDs Set

**Location:** [graphlagoon-rest-api/graphlagoon/services/graph_operations.py:282](graphlagoon-rest-api/graphlagoon/services/graph_operations.py:282)

**Issue:**
If `node_ids` is an empty set, the SQL query will be:
```sql
SELECT * FROM nodes WHERE node_id IN ()
```

This is invalid SQL and will cause an error.

**Scenario:**
- Edge query returns edges with null `src` or `dst`
- All node IDs filtered out
- Empty `node_ids` set

**Impact:**
- Query execution fails
- 500 error to user

**Reproduction:**
1. Create edges with null source/destination
2. Query these edges
3. Observe error

**Fix:**
```python
if not node_ids:
    return GraphResponse(
        nodes=[],
        edges=response_partial.edges,
        truncated=response_partial.truncated,
        total_count=response_partial.total_count
    )

# Proceed with node query only if node_ids is not empty
```

**Priority:** High

---

### 9. 🟡 Context Sharing Allows Owner to Be Removed

**Location:** [graphlagoon-rest-api/graphlagoon/routers/graph_contexts.py](graphlagoon-rest-api/graphlagoon/routers/graph_contexts.py)

**Issue:**
The sharing endpoint doesn't prevent the context owner from being "shared with" themselves, or from having their ownership removed. This could lead to:
- Orphaned contexts (no owner)
- Permission confusion

**Impact:**
- Data access issues
- Authorization bugs

**Fix:**
```python
@router.post("/{context_id}/share")
async def share_context(
    context_id: str,
    share_data: ShareRequest,
    user_email: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    # Get context
    context = await get_context_by_id(db, context_id)

    if context.owner_email == share_data.email:
        raise HTTPException(
            status_code=400,
            detail="Cannot share context with owner"
        )

    # Proceed with sharing
```

**Priority:** Medium

---

### 10. 🟡 Databricks Token Expiration Not Handled

**Location:** [graphlagoon-rest-api/graphlagoon/services/warehouse.py](graphlagoon-rest-api/graphlagoon/services/warehouse.py)

**Issue:**
If Databricks token expires during a long-running session, subsequent requests will fail with 401 errors. The `header_provider` pattern helps, but:
- No automatic retry on 401
- No token refresh logic
- Error propagates to user

**Impact:**
- Failed queries
- Poor user experience
- Manual re-authentication required

**Fix:**
```python
async def execute_statement(self, statement: str, row_limit: int = None):
    try:
        result = await self._execute_with_retry(statement, row_limit)
        return result
    except HTTPError as e:
        if e.response.status_code == 401:
            # Token expired, refresh and retry
            await self._refresh_token()
            result = await self._execute_with_retry(statement, row_limit)
            return result
        raise
```

**Priority:** Medium

---

### 11. 🟢 Exploration State JSON Size Not Limited

**Location:** [graphlagoon-rest-api/graphlagoon/db/models.py](graphlagoon-rest-api/graphlagoon/db/models.py)

**Issue:**
The `state` column in `Exploration` is JSON with no size limit. Very large states (e.g., thousands of text format rules) could:
- Exceed database column limits
- Cause slow queries
- Use excessive storage

**Impact:**
- Database errors on save
- Performance degradation

**Fix:**
```python
# In Pydantic schema
class ExplorationCreate(BaseModel):
    state: Dict[str, Any]

    @validator('state')
    def validate_state_size(cls, v):
        import json
        state_json = json.dumps(v)
        if len(state_json) > 100_000:  # 100KB limit
            raise ValueError("Exploration state too large")
        return v
```

**Priority:** Low

---

### 12. 🟡 Concurrent Context Updates Cause Race Condition

**Location:** [graphlagoon-rest-api/graphlagoon/routers/graph_contexts.py](graphlagoon-rest-api/graphlagoon/routers/graph_contexts.py)

**Issue:**
If two users update the same context simultaneously, one update will be lost (last-write-wins). No optimistic locking or versioning.

**Impact:**
- Lost updates
- Data inconsistency
- User frustration

**Fix:**
Add version field:
```python
class GraphContext(Base):
    # ...
    version: Mapped[int] = mapped_column(Integer, default=1)

# On update
@router.put("/{context_id}")
async def update_context(
    context_id: str,
    data: GraphContextUpdate,
    expected_version: int,  # From client
    db: AsyncSession = Depends(get_db)
):
    context = await get_context_by_id(db, context_id)

    if context.version != expected_version:
        raise HTTPException(
            status_code=409,
            detail="Context was modified by another user"
        )

    # Update and increment version
    context.version += 1
    # ...
```

**Priority:** Medium

---

### 13. 🔴 SQL Warehouse Timeout Not Configured

**Location:** [graphlagoon-rest-api/graphlagoon/services/warehouse.py](graphlagoon-rest-api/graphlagoon/services/warehouse.py)

**Issue:**
httpx client has no timeout configured. Long-running queries will:
- Block indefinitely
- Consume server resources
- No way for user to cancel

**Impact:**
- Server hangs
- Poor user experience
- Resource exhaustion

**Fix:**
```python
import httpx

self.client = httpx.AsyncClient(
    timeout=httpx.Timeout(
        connect=10.0,   # 10s to establish connection
        read=300.0,     # 5 minutes for query execution
        write=10.0,
        pool=10.0
    )
)
```

**Priority:** High

---

## Integration Bugs

### 14. 🟡 gsql2rsql Transpilation Errors Not User-Friendly

**Location:** [graphlagoon-rest-api/graphlagoon/services/cypher.py](graphlagoon-rest-api/graphlagoon/services/cypher.py)

**Issue:**
When Cypher transpilation fails, the error message from gsql2rsql is highly technical and not helpful to end users:
```
ParseException: mismatched input 'MATCH' expecting 'RETURN'
```

**Impact:**
- User doesn't know how to fix query
- Poor user experience

**Fix:**
```python
try:
    transpiled = transpile_cypher_to_sql(...)
except Exception as e:
    # Wrap in user-friendly error
    user_message = simplify_transpilation_error(str(e))
    raise QueryExecutionError(
        message=f"Invalid Cypher query: {user_message}",
        query=cypher_query
    )

def simplify_transpilation_error(error: str) -> str:
    # Map technical errors to user-friendly messages
    error_map = {
        "mismatched input": "Syntax error in query",
        "expecting 'RETURN'": "Query must include RETURN clause",
        # ...
    }

    for key, message in error_map.items():
        if key in error:
            return message

    return "Query syntax error"
```

**Priority:** Medium

---

### 15. 🟢 localStorage Mode Doesn't Persist Across Browser Sessions

**Location:** Frontend localStorage implementation

**Issue:**
When using localStorage mode, contexts are stored in browser localStorage but:
- No explicit "save" button
- User may lose work if browser crashes
- No export functionality

**Impact:**
- Data loss risk
- Poor user experience

**Fix:**
Add export/import:
```typescript
const exportContext = (contextId: string) => {
  const context = localStorage.getItem(`context-${contextId}`)
  const blob = new Blob([context], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = `context-${contextId}.json`
  a.click()
}
```

**Priority:** Low

---

## Edge Cases

### 16. 🟡 Graph with No Edges Causes Layout Issues

**Location:** Frontend graph canvases

**Issue:**
Force-directed layout with only nodes (no edges) causes:
- Nodes fly apart infinitely
- Poor visualization
- Confusing user experience

**Impact:**
- Unusable visualization

**Fix:**
```typescript
if (edges.length === 0) {
  // Use circular layout for disconnected nodes
  useCircularLayout(nodes)
} else {
  // Use force layout
  useForceLayout(nodes, edges)
}
```

**Priority:** Medium

---

### 17. 🟢 Very Long Node Labels Overflow UI

**Location:** Frontend components

**Issue:**
Node labels with hundreds of characters:
- Overflow tooltips
- Break layout
- Slow rendering

**Impact:**
- Poor visual appearance
- Performance issues

**Fix:**
```typescript
function truncateLabel(label: string, maxLength: number = 50): string {
  if (label.length <= maxLength) return label
  return label.substring(0, maxLength - 3) + '...'
}
```

**Priority:** Low

---

### 18. 🟡 Self-Referencing Edges (Loops) Not Visualized Well

**Location:** Frontend graph renderers

**Issue:**
Edges where `source === target` (self-loops) are:
- Not visible in 2D (Sigma.js)
- Tiny in 3D
- Hard to interact with

**Impact:**
- Missing data in visualization
- User confusion

**Fix:**
Custom rendering for self-loops:
```typescript
// In Sigma.js program
if (edge.source === edge.target) {
  // Draw loop above node
  drawCircularLoop(context, node, edge)
} else {
  // Normal edge rendering
}
```

**Priority:** Medium

---

## Summary Table

| ID | Severity | Component | Description | Impact |
|----|----------|-----------|-------------|--------|
| 1  | 🔴 Critical | Frontend | Race condition in context loading | Wrong context displayed |
| 2  | 🟡 High | Frontend | Memory leak on view switching | Performance degradation |
| 3  | 🟡 High | Frontend | Special characters break selection | Cannot interact with nodes |
| 4  | 🟡 High | Frontend | Exploration state not fully restored | Poor UX |
| 5  | 🟢 Medium | Frontend | Text format rule priority ties | Unpredictable formatting |
| 6  | 🟡 High | Frontend | Undefined metric in property filter | Application crash |
| 7  | 🔴 Critical | Frontend | Concurrent query execution | Wrong data displayed |
| 8  | 🔴 Critical | Backend | Empty node IDs causes SQL error | Query fails |
| 9  | 🟡 High | Backend | Context owner can be removed | Authorization issues |
| 10 | 🟡 High | Backend | Databricks token expiration | Failed queries |
| 11 | 🟢 Medium | Backend | Exploration state size unlimited | Database errors |
| 12 | 🟡 High | Backend | Concurrent context updates | Lost updates |
| 13 | 🔴 Critical | Backend | No SQL warehouse timeout | Server hangs |
| 14 | 🟡 High | Integration | Transpilation errors not user-friendly | Poor UX |
| 15 | 🟢 Medium | Integration | localStorage no export | Data loss risk |
| 16 | 🟡 High | Edge Case | Graph with no edges | Unusable visualization |
| 17 | 🟢 Medium | Edge Case | Very long labels | UI overflow |
| 18 | 🟡 High | Edge Case | Self-loops not visualized | Missing data |

## Testing Recommendations

### High-Priority Test Cases

1. **Concurrent Operations:**
   - Rapid context switching
   - Multiple queries in flight
   - Concurrent updates to same resource

2. **Edge Cases:**
   - Empty result sets
   - Null/undefined values
   - Special characters in data
   - Very large graphs (10k+ nodes)

3. **Resource Cleanup:**
   - View switching memory leaks
   - Worker termination
   - Animation frame cancellation

4. **Error Handling:**
   - Network timeouts
   - Invalid SQL/Cypher
   - Expired authentication

### Automated Testing Strategy

```typescript
// Example test for race condition
describe('Context Loading Race Condition', () => {
  it('should load the most recently requested context', async () => {
    const contextA = 'context-a'
    const contextB = 'context-b'

    // Mock API with delays
    vi.mocked(api.loadGraphContext).mockImplementation((id) => {
      const delay = id === contextA ? 100 : 50
      return new Promise((resolve) => {
        setTimeout(() => resolve(mockContext(id)), delay)
      })
    })

    // Start loading A (slow)
    graphStore.loadContext(contextA)

    // Start loading B (fast) - should win
    await graphStore.loadContext(contextB)

    // Wait for A to complete
    await new Promise(resolve => setTimeout(resolve, 150))

    // Verify B is still loaded (not overwritten by A)
    expect(graphStore.currentContext?.id).toBe(contextB)
  })
})
```

## Monitoring Recommendations

Add monitoring for:
- Query execution times (alert on > 30s)
- Memory usage (alert on growth trend)
- Error rates by type
- Failed authentication attempts
- Database connection pool exhaustion

## Next Steps

1. Triage bugs by severity and impact
2. Create GitHub issues for each bug
3. Assign to sprints based on priority
4. Write regression tests before fixing
5. Document fixes in decision log
