# Skill: Backend Debugging for graphlagoon-studio (graphlagoon-rest-api)

## Purpose

This skill guides you through debugging backend issues in the graphlagoon-studio FastAPI application. Use this when encountering API errors, database issues, query execution problems, or integration failures with SQL warehouses.

## Important: Decision Log

**EVERY action taken using this skill MUST be documented in [docs/dev/decision_log.md](docs/dev/decision_log.md).**

Append an entry with:
- Date and time
- Issue description
- Root cause analysis
- Solution implemented
- Files modified
- Testing performed

## Quick Reference

### Project Structure

```
api/
├── graphlagoon/
│   ├── routers/         # API endpoints
│   ├── services/        # Business logic
│   ├── db/              # Database models and sessions
│   ├── models/          # Pydantic schemas
│   ├── middleware/      # Auth and middleware
│   ├── app.py           # Application factory
│   ├── config.py        # Configuration
│   └── main.py          # ASGI entry point
```

### Key Files

- **App Factory:** [api/graphlagoon/app.py](api/graphlagoon/app.py)
- **Graph Operations:** [api/graphlagoon/services/graph_operations.py](api/graphlagoon/services/graph_operations.py)
- **Warehouse Client:** [api/graphlagoon/services/warehouse.py](api/graphlagoon/services/warehouse.py)
- **Graph Contexts Router:** [api/graphlagoon/routers/graph_contexts.py](api/graphlagoon/routers/graph_contexts.py)
- **Database Models:** [api/graphlagoon/db/models.py](api/graphlagoon/db/models.py)
- **Configuration:** [api/graphlagoon/config.py](api/graphlagoon/config.py)

## Debugging Workflow

### Step 1: Reproduce the Issue

1. **Gather Information:**
   - What API endpoint is affected?
   - What is the request payload?
   - What error response is returned?
   - Check logs for stack traces
   - Database mode enabled?
   - Databricks or local warehouse?

2. **Check Logs:**
   ```bash
   # If running with uvicorn
   tail -f logs/app.log

   # Or check stdout
   # Look for ERROR, WARNING, or exception tracebacks
   ```

3. **Document in Decision Log:**
   ```markdown
   ## [YYYY-MM-DD HH:MM] - Backend Bug Investigation Started

   **Issue:** [Brief description]
   **Endpoint:** [HTTP method and path]
   **Status Code:** [Response code]
   **Error Message:** [Error details]

   **Environment:**
   - Database Enabled: [true/false]
   - Warehouse: [local/Databricks]
   - Dev Mode: [true/false]

   **Request:**
   \`\`\`json
   [Request payload]
   \`\`\`

   **Response:**
   \`\`\`json
   [Error response]
   \`\`\`
   ```

### Step 2: Identify the Component

**Common Issue Categories:**

| Symptom | Likely Component | Key Files |
|---------|------------------|-----------|
| 404 Not Found | Router configuration | routers/*, app.py |
| 500 Internal Error | Service layer, database | services/*, db/* |
| Query execution fails | Graph operations, warehouse | services/graph_operations.py, services/warehouse.py |
| Database errors | SQLAlchemy models | db/models.py, db/database.py |
| Auth errors | Middleware | middleware/auth.py |
| Validation errors | Pydantic schemas | models/schemas.py |
| Timeout errors | Warehouse client | services/warehouse.py |
| Cypher transpilation | Cypher service | services/cypher.py |

### Step 3: Enable Debug Mode

**FastAPI Debug Logging:**
```python
# In config.py or environment
GRAPH_LAGOON_SHOW_ERROR_DETAILS=true

# Or modify app.py temporarily
import logging
logging.basicConfig(level=logging.DEBUG)
```

**Database Query Logging:**
```python
# In db/database.py
engine = create_async_engine(
    database_url,
    echo=True,  # Enable SQL logging
    pool_pre_ping=True
)
```

**HTTP Request/Response Logging:**
```python
# In services/warehouse.py
import httpx

# Add event hooks
async def log_request(request: httpx.Request):
    print(f"[HTTPX] Request: {request.method} {request.url}")
    print(f"[HTTPX] Headers: {request.headers}")

async def log_response(response: httpx.Response):
    print(f"[HTTPX] Response: {response.status_code}")
    print(f"[HTTPX] Body: {await response.aread()}")

client = httpx.AsyncClient(
    event_hooks={
        'request': [log_request],
        'response': [log_response]
    }
)
```

### Step 4: Common Backend Issues

#### Issue: Database Connection Errors

**Symptoms:**
- `RuntimeError: Database not initialized`
- Connection timeouts
- `asyncpg.exceptions.CannotConnectNowError`

**Debug Steps:**

1. **Check database is running:**
   ```bash
   # For PostgreSQL
   docker ps | grep postgres

   # Or connect directly
   psql -h localhost -U sgraph -d sgraph
   ```

2. **Verify configuration:**
   ```python
   # In config.py or check environment
   from graphlagoon.config import settings

   print("Database enabled:", settings.database_enabled)
   print("Database URL:", settings.database_url)
   ```

3. **Test connection manually:**
   ```python
   # Create test script
   import asyncio
   from graphlagoon.db.database import init_database, get_db

   async def test_db():
       await init_database(settings.database_url)
       async for session in get_db():
           result = await session.execute("SELECT 1")
           print("Connection OK:", result.scalar())

   asyncio.run(test_db())
   ```

**Common Causes:**
- Database not running
- Wrong credentials in DATABASE_URL
- Network issues
- Connection pool exhausted

**Fixes:**
```bash
# Start database
docker-compose up -d postgres

# Check environment variables
echo $GRAPH_LAGOON_DATABASE_URL

# Reset connection pool
# Restart application
```

**See also:** [technical_debts.md](technical_debts.md) #9 (Missing DB pool config)

#### Issue: Query Execution Failures

**Symptoms:**
- `QueryExecutionError` exceptions
- SQL syntax errors
- Empty result sets unexpectedly

**Debug Steps:**

1. **Log the actual SQL query:**
   ```python
   # In services/graph_operations.py or routers/graph.py
   print(f"[DEBUG] Executing query:\n{query}")
   ```

2. **Test query directly in warehouse:**
   ```bash
   # If using local Spark
   curl -X POST http://localhost:8001/query \
     -H "Content-Type: application/json" \
     -d '{"query": "SELECT * FROM nodes LIMIT 10"}'
   ```

3. **Check table names and column config:**
   ```python
   # In router
   print(f"[DEBUG] Context: {context.node_table_name}, {context.edge_table_name}")
   print(f"[DEBUG] Column config: {column_config}")
   ```

4. **Trace through graph_operations.py:**
   ```python
   # Add logging to process_graph_query_result
   def process_graph_query_result(...):
       print(f"[DEBUG] Columns: {columns}")
       print(f"[DEBUG] Row count: {len(rows)}")
       print(f"[DEBUG] First row: {rows[0] if rows else None}")
       # ...
   ```

**Common Causes:**
- Table doesn't exist in warehouse
- Wrong column names in context
- Malformed SQL (missing quotes, brackets)
- Empty result set (see potential_bugs.md #8)

**Fixes:**

```python
# Example: Handle empty node_ids
if not node_ids:
    return GraphResponse(
        nodes=[],
        edges=response_partial.edges,
        truncated=response_partial.truncated
    )

# Validate table exists before querying
try:
    await warehouse.execute_statement(f"DESCRIBE {table_name}")
except Exception:
    raise HTTPException(
        status_code=400,
        detail=f"Table {table_name} not found in warehouse"
    )
```

#### Issue: Authentication Errors

**Symptoms:**
- 401 Unauthorized
- Missing user_email
- Cannot access context (permission denied)

**Debug Steps:**

1. **Check headers:**
   ```python
   # In middleware/auth.py - add logging
   async def get_current_user(request: Request) -> str:
       email = (
           request.headers.get("X-User-Email") or
           request.headers.get("X-Forwarded-Email")
       )
       print(f"[AUTH] Headers: {dict(request.headers)}")
       print(f"[AUTH] Extracted email: {email}")

       if not email and settings.dev_mode:
           email = "devmessias@gmail.com"
           print(f"[AUTH] Using dev mode default: {email}")

       if not email:
           raise HTTPException(status_code=401, detail="User email required")

       return email
   ```

2. **Check request from frontend:**
   ```bash
   # In browser DevTools → Network tab
   # Check request headers for X-User-Email
   ```

3. **Verify context ownership:**
   ```python
   # In router
   context = await get_context_by_id(db, context_id)
   print(f"[AUTH] Context owner: {context.owner_email}")
   print(f"[AUTH] Current user: {user_email}")
   print(f"[AUTH] Shared with: {[s.shared_with_email for s in context.shares]}")
   ```

**Common Causes:**
- Frontend not sending X-User-Email header
- Dev mode disabled but no real auth
- User trying to access unshared context

**Fixes:**

```python
# Add better error messages
if context.owner_email != user_email:
    # Check shares
    shared = any(s.shared_with_email == user_email for s in context.shares)
    if not shared:
        raise HTTPException(
            status_code=403,
            detail=f"Access denied. Context owned by {context.owner_email}"
        )
```

#### Issue: Databricks Integration Errors

**Symptoms:**
- 401 Unauthorized from Databricks
- Connection refused
- Token expired
- Slow queries

**Debug Steps:**

1. **Check configuration:**
   ```python
   from graphlagoon.config import settings

   print("Databricks mode:", settings.databricks_mode)
   print("Host:", settings.databricks_host)
   print("Warehouse ID:", settings.databricks_warehouse_id)
   print("Token set:", bool(settings.databricks_token))
   ```

2. **Test Databricks connection:**
   ```bash
   # Direct API call
   curl -X GET \
     "https://${DATABRICKS_HOST}/api/2.0/sql/warehouses/${WAREHOUSE_ID}" \
     -H "Authorization: Bearer ${DATABRICKS_TOKEN}"
   ```

3. **Check warehouse client setup:**
   ```python
   # In services/warehouse.py
   print(f"[WAREHOUSE] Base URL: {self.base_url}")
   print(f"[WAREHOUSE] Headers provider: {self.header_provider}")
   ```

**Common Causes:**
- Token expired (see potential_bugs.md #10)
- Wrong warehouse ID
- Network/firewall issues
- Query timeout

**Fixes:**

```python
# Add token refresh logic
async def execute_statement(self, statement: str, **kwargs):
    try:
        return await self._execute(statement, **kwargs)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 401:
            # Refresh token and retry
            self.refresh_token()
            return await self._execute(statement, **kwargs)
        raise

# Add timeout configuration
client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=10.0, read=300.0)
)
```

**See also:** [technical_debts.md](technical_debts.md) #13 (SQL warehouse timeout)

#### Issue: Cypher Transpilation Errors

**Symptoms:**
- `ParseException` from gsql2rsql
- Invalid SQL generated
- Transpilation fails

**Debug Steps:**

1. **Log Cypher query:**
   ```python
   # In services/cypher.py
   print(f"[CYPHER] Input query:\n{cypher_query}")
   ```

2. **Check schema building:**
   ```python
   # In build_schema_provider
   print(f"[CYPHER] Node types: {context.node_types}")
   print(f"[CYPHER] Edge types: {context.relationship_types}")
   print(f"[CYPHER] Schema: {schema}")
   ```

3. **Test transpilation in isolation:**
   ```python
   # Create test script
   from graphlagoon.services.cypher import transpile_cypher_to_sql

   cypher = "MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b"
   try:
       sql = transpile_cypher_to_sql(cypher, context)
       print("Transpiled SQL:", sql)
   except Exception as e:
       print("Error:", e)
   ```

**Common Causes:**
- Invalid Cypher syntax
- Unsupported Cypher features
- Schema mismatch
- gsql2rsql library issues

**Fixes:**

```python
# Better error messages (see potential_bugs.md #14)
try:
    transpiled = transpile_cypher_to_sql(...)
except Exception as e:
    user_message = simplify_error(str(e))
    raise QueryExecutionError(
        message=f"Cypher error: {user_message}",
        query=cypher_query
    )

def simplify_error(error: str) -> str:
    if "mismatched input" in error:
        return "Syntax error in query"
    if "RETURN" in error:
        return "Query must include RETURN clause"
    return "Query syntax error"
```

### Step 5: Check Known Issues

Refer to [potential_bugs.md](potential_bugs.md) for known backend issues:

- **Empty node IDs** causes SQL error (#8)
- **Context owner removal** (#9)
- **Token expiration** (#10)
- **Exploration state size** (#11)
- **Concurrent updates** (#12)
- **No timeout** on warehouse (#13)

### Step 6: Test the Fix

**Manual API Testing:**

```bash
# Health check
curl http://localhost:8000/health

# List contexts
curl http://localhost:8000/api/graph-contexts \
  -H "X-User-Email: test@example.com"

# Create context
curl -X POST http://localhost:8000/api/graph-contexts \
  -H "Content-Type: application/json" \
  -H "X-User-Email: test@example.com" \
  -d '{
    "title": "Test Context",
    "edge_table_name": "edges",
    "node_table_name": "nodes",
    ...
  }'

# Execute query
curl -X POST http://localhost:8000/api/graph-contexts/{id}/query \
  -H "Content-Type: application/json" \
  -H "X-User-Email: test@example.com" \
  -d '{"query": "SELECT * FROM nodes LIMIT 10"}'
```

**Automated Testing (pytest):**

```python
# tests/test_graph_operations.py
import pytest
from graphlagoon.services.graph_operations import (
    process_graph_query_result,
    execute_graph_query_with_nodes
)

@pytest.mark.asyncio
async def test_empty_node_ids_handling(mock_warehouse):
    """Test that empty node_ids doesn't cause SQL error."""
    # Setup: query that returns edges with null src/dst
    columns = ['r']
    rows = [[{'src': None, 'dst': None, 'relationship_type': 'TEST'}]]

    column_config = ColumnConfig(
        src_col='src',
        dst_col='dst',
        relationship_type_col='relationship_type'
    )

    # Execute
    response, node_ids = process_graph_query_result(columns, rows, column_config)

    # Assert
    assert len(node_ids) == 0
    assert len(response.edges) == 1

    # Should not fail when executing full query with empty node_ids
    full_response = await execute_graph_query_with_nodes(
        mock_warehouse,
        "nodes_table",
        "SELECT * FROM edges",
        None,
        column_config
    )

    assert len(full_response.nodes) == 0  # No nodes to fetch
```

**Integration Testing:**

```bash
# Run full integration test
cd api
pytest tests/ -v

# Run specific test
pytest tests/test_graph_operations.py::test_empty_node_ids_handling -v
```

### Step 7: Document in Decision Log

**Template:**
```markdown
## [YYYY-MM-DD HH:MM] - Backend Bug Fixed: [Issue Title]

**Issue:** [Detailed description]
**Endpoint:** [Affected endpoint]

**Root Cause:**
[Explanation of what caused the bug]

**Investigation:**
- Checked [service/router/model]
- Found [specific issue]
- Traced to [root cause]

**Solution:**
[Description of fix]

**Files Modified:**
- [api/graphlagoon/path/to/file.py](api/graphlagoon/path/to/file.py:line)

**Code Changes:**
\`\`\`python
# Before
[old code]

# After
[new code]
\`\`\`

**Testing:**
- [x] Manual API testing performed
- [x] Integration tests added/updated
- [x] Tested with both local and Databricks warehouses (if applicable)

**Related Issues:**
- See [potential_bugs.md](potential_bugs.md) #[issue number]
- Addresses technical debt #[debt number] in [technical_debts.md](technical_debts.md)

**Migration Notes:**
[If database schema changed, alembic migration needed, etc.]
```

## Reference Materials

### Architecture Docs

See [architecture.md](architecture.md) for:
- Backend architecture overview
- Database schema
- API endpoints reference
- Service layer patterns

### Code Patterns

See [code_patterns.md](code_patterns.md) for:
- FastAPI patterns
- SQLAlchemy async patterns
- Pydantic schema conventions
- Error handling standards

### Technical Debts

See [technical_debts.md](technical_debts.md) for:
- Database connection pooling (#9)
- SQL injection risks (#11)
- Missing request validation (#12)
- Caching opportunities (#16)

## Tools and Commands

### Development Server

```bash
cd api
uvicorn graphlagoon.main:app --reload --port 8000
```

### Database Migrations

```bash
# Create migration
alembic revision --autogenerate -m "Description"

# Apply migrations
alembic upgrade head

# Rollback
alembic downgrade -1
```

### Testing

```bash
# Run all tests
pytest

# With coverage
pytest --cov=graphlagoon --cov-report=html

# Specific test file
pytest tests/test_graph_operations.py -v
```

### Linting

```bash
# Format code
black graphlagoon/

# Check types
mypy graphlagoon/

# Lint
ruff check graphlagoon/
```

### Interactive Debugging

```python
# Add breakpoint in code
import pdb; pdb.set_trace()

# Or use modern debugger
import ipdb; ipdb.set_trace()

# Or IDE debugger (VS Code)
# Set breakpoint in editor, run in debug mode
```

### Database Inspection

```bash
# Connect to database
docker exec -it <postgres_container> psql -U sgraph -d sgraph

# List tables
\dt

# Describe table
\d graph_contexts

# Query
SELECT * FROM graph_contexts;
```

## Common Pitfalls

### 1. Forgetting to Update Decision Log
Always document your debugging process and solution!

### 2. Not Testing Both Database Modes
Test fixes with database enabled AND disabled (in-memory mode).

### 3. Not Testing Databricks Integration
If changing warehouse client, test with both local Spark and Databricks.

### 4. Breaking Async/Await
Remember all database and HTTP operations must be `await`ed.

### 5. SQL Injection Risks
Always use parameterized queries, never string concatenation.

### 6. Not Handling Optional Dependencies
Database session can be None if database disabled.

## Emergency Procedures

### App Won't Start

1. Check configuration:
   ```bash
   python -c "from graphlagoon.config import settings; print(settings)"
   ```

2. Check database:
   ```bash
   docker ps | grep postgres
   docker logs <postgres_container>
   ```

3. Test imports:
   ```bash
   python -c "from graphlagoon.app import create_app; print('OK')"
   ```

### Database Corruption

1. Backup database:
   ```bash
   docker exec <postgres_container> pg_dump -U sgraph sgraph > backup.sql
   ```

2. Reset database:
   ```bash
   docker-compose down -v
   docker-compose up -d postgres
   alembic upgrade head
   ```

### Warehouse Unavailable

1. Check warehouse is running:
   ```bash
   curl http://localhost:8001/health
   ```

2. Fallback to local warehouse if Databricks down:
   ```bash
   export GRAPH_LAGOON_DATABRICKS_MODE=false
   export GRAPH_LAGOON_SQL_WAREHOUSE_URL=http://localhost:8001
   ```

## Performance Debugging

### Slow Queries

1. **Enable SQL query logging:**
   ```python
   engine = create_async_engine(database_url, echo=True)
   ```

2. **Profile query execution:**
   ```python
   import time

   start = time.time()
   result = await warehouse.execute_statement(query)
   elapsed = time.time() - start

   print(f"Query took {elapsed:.2f}s")
   ```

3. **Check database indexes:**
   ```sql
   SELECT * FROM pg_indexes WHERE tablename = 'graph_contexts';
   ```

### Memory Issues

1. **Check connection pool:**
   ```python
   print(engine.pool.status())
   ```

2. **Monitor async tasks:**
   ```python
   import asyncio
   print(len(asyncio.all_tasks()))
   ```

### High CPU Usage

1. Profile with `py-spy`:
   ```bash
   pip install py-spy
   py-spy top --pid <process_id>
   ```

## Getting Help

1. Check [potential_bugs.md](potential_bugs.md) for known issues
2. Check [technical_debts.md](technical_debts.md) for architectural context
3. Review FastAPI documentation
4. Review SQLAlchemy 2.0 documentation
5. Check recent commits for related changes
6. Document findings in decision log

## Remember

- **Document everything** in decision_log.md
- **Test thoroughly** including edge cases and both modes
- **Consider security** (SQL injection, auth bypass)
- **Check performance** impact of fixes
- **Update API docs** if endpoints change
- **Communicate** fixes to team
