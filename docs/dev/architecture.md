# graphlagoon-studio Architecture Documentation

## Overview

graphlagoon-studio is a comprehensive graph visualization system designed for exploring graph data stored in Spark SQL using the gsql2rsql library. The system integrates with Databricks SQL Warehouse and uses 3D Force Graph for rendering (3D and 2D projection modes).

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (Vue 3 SPA)                      │
│  ┌────────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  Vue Router    │  │    Pinia    │  │   Components    │  │
│  │  (Navigation)  │  │   Stores    │  │  (Canvas, UI)   │  │
│  └────────────────┘  └─────────────┘  └─────────────────┘  │
│                            │                                 │
│                    ┌───────▼───────┐                         │
│                    │   API Service │                         │
│                    │ (Persistence) │                         │
│                    └───────┬───────┘                         │
└────────────────────────────┼─────────────────────────────────┘
                             │ REST API (JSON)
┌────────────────────────────▼─────────────────────────────────┐
│                 Backend (FastAPI + SQLAlchemy)               │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │   Routers   │  │   Services   │  │    Database       │  │
│  │  (API)      │→ │  (Business)  │→ │   (PostgreSQL)    │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
│                            │                                 │
│                    ┌───────▼───────┐                         │
│                    │ WarehouseClient│                         │
│                    └───────┬───────┘                         │
└────────────────────────────┼─────────────────────────────────┘
                             │ SQL Queries
┌────────────────────────────▼─────────────────────────────────┐
│              SQL Warehouse (Spark SQL / Databricks)          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │         Graph Data (Parquet/Delta Lake)                 │ │
│  │  ┌───────────────┐        ┌──────────────────┐         │ │
│  │  │ Nodes Table   │        │   Edges Table    │         │ │
│  │  └───────────────┘        └──────────────────┘         │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Frontend (graphlagoon-frontend)

**Technology Stack:**
- Vue 3.4+ with TypeScript
- Vite 5.0+ (build tool)
- Pinia 2.1+ (state management)
- 3D Force Graph 1.79+ (3D and 2D projection rendering)
- CodeMirror 6 (SQL/Cypher editor)

**Key Directories:**
- `src/views/` - Page-level components (ContextsView, GraphVisualizationView, ExplorationsView)
- `src/components/` - UI components (Canvas, Panels, Toolbar)
- `src/stores/` - Pinia stores (graph, metrics, contexts, auth)
- `src/services/` - API client and utility services
- `src/workers/` - Web Workers for background computation
- `src/utils/` - Helper utilities (label formatting, rendering)

#### State Management (Pinia)

**Graph Store** (`stores/graph.ts` - 1127 lines):
- **Data:** nodes, edges, graph metadata
- **Filters:** node_types, edge_types, search_query (row-level filtering lives in the Data Table panel)
- **Layout:** Force Atlas 2 settings, Helios 3D settings
- **Aesthetics:** colors, opacity, sizes, labels
- **Behaviors:** focusOnSelection, searchMode, centerOnSearch, viewMode (`'3d'` | `'2d-proj'` | `'2d'`)
- **Text Formatting:** label template rules with priority
- **Actions:** loadContext, loadSubgraph, executeGraphQuery, transpileCypher, saveExploration

**Metrics Store** (`stores/metrics.ts`):
- Computes graph metrics (centrality, clustering, etc.)
- Uses Web Workers for parallel computation
- Provides computed properties for filtering

**Contexts Store** (`stores/contexts.ts`):
- Manages graph contexts list
- Handles creation, editing, deletion

**Auth Store** (`stores/auth.ts`):
- User authentication state
- User email management

#### Visualization Components

**3D Canvas** (`components/GraphCanvas3D.vue`):
- 3D Force Graph (Three.js-based), used for both `'3d'` and `'2d-proj'` viewModes
- D3 Force layout engine (default physics simulation)
- 2D projection mode (`'2d-proj'`): `numDimensions(2)`, ortho camera, rotation locked, z=0 constraint
- FastLabelRenderer with MSDF (Multi-channel Signed Distance Field)
- Camera movement detection for performance optimization
- Supports pinned nodes for stable layout
- Controls: TrackballControls (default) — use `noRotate` to disable rotation, NOT `enableRotate`

### 2. Backend (graphlagoon-rest-api)

**Technology Stack:**
- FastAPI 0.109+
- SQLAlchemy 2.0+ with asyncio
- asyncpg 0.31+ (PostgreSQL driver)
- Pydantic 2.5+ (validation)
- Alembic 1.13+ (migrations)
- httpx 0.26+ (async HTTP client)
- gsql2rsql (Cypher transpiler)

**Key Directories:**
- `graphlagoon/routers/` - API route handlers
- `graphlagoon/services/` - Business logic layer
- `graphlagoon/db/` - Database models and session management
- `graphlagoon/models/` - Pydantic schemas
- `graphlagoon/middleware/` - Authentication and middleware

#### Application Factory Pattern

```python
# Standalone app
app = create_app()

# Mountable app (for embedding in existing FastAPI apps)
mountable_app = create_mountable_app()

# API router only (no frontend serving)
api_router = create_api_router()
```

#### Database Layer

**ORM Models** (`db/models.py`):
- `User` - User accounts (email, display_name)
- `GraphContext` - Graph context metadata and configuration
- `GraphContextShare` - Context sharing permissions
- `Exploration` - Saved visualization states
- `ExplorationShare` - Exploration sharing permissions
- `UsageLog` - Analytics and usage tracking
- Investigation models - see [Investigations](#investigations)

**Lazy Initialization Pattern:**
- Database is configured but not initialized until first use
- `is_database_available()` checks both config and connection
- Graceful fallback to in-memory store if database unavailable

#### Service Layer

**Graph Operations** (`services/graph_operations.py`):
- Process SQL query results into graph format
- Parse nodes and edges from raw query results
- Build GraphResponse with Node/Edge objects

**Warehouse Client** (`services/warehouse.py`):
- Abstraction over SQL warehouse (local Spark or Databricks)
- Dynamic header provider for token refresh
- Methods: `list_datasets()`, `execute_statement()`, etc.

**Cypher Transpilation** (`services/cypher.py`):
- Integrates gsql2rsql library
- Builds schema from GraphContext
- Transpiles Cypher queries to Spark SQL

### 3. SQL Warehouse (sql-warehouse)

**Purpose:** Mock Spark SQL warehouse for development to simulate Databricks SQL Warehouse.

**Key Features:**
- Parquet file storage for graph data
- Spark SQL 4.1+ with recursive CTEs
- Supports BFS expansion, path finding
- Catalog/metadata operations
- REST API on port 8001

**Note:** This is a development tool, not part of the production system.

## Data Flow

### Graph Query Execution

```
1. User Action (UI)
   ↓
2. Frontend Action (GraphStore method)
   ├─ executeGraphQuery(sql)
   ├─ executeCypherQuery(cypher)
   └─ expandFromNode(nodeId)
   ↓
3. API Service (services/api.ts)
   ├─ Detect persistence mode (localStorage vs API)
   ├─ Build context_info if localStorage mode
   └─ POST to backend endpoint
   ↓
4. FastAPI Backend (routers/graph.py)
   ├─ Auth middleware extracts user email
   ├─ Validate context access (owner or shared_with)
   └─ Call warehouse client
   ↓
5. WarehouseClient (services/warehouse.py)
   ├─ POST /query to Spark SQL or Databricks
   └─ Return statement results
   ↓
6. Graph Operations (services/graph_operations.py)
   ├─ Parse raw results into Node/Edge objects
   ├─ Extract properties and metadata
   └─ Build GraphResponse
   ↓
7. Backend Response
   └─ Return JSON (nodes + edges)
   ↓
8. Frontend Store Update
   ├─ Update nodes and edges in state
   ├─ Trigger computed properties (filteredNodes, filteredEdges)
   └─ Re-render visualization
   ↓
9. Canvas Rendering
   └─ 3D Force Graph with D3 force (3D and 2D projection modes)
```

### Context Creation Flow

```
1. User fills form (ContextsView.vue)
   ↓
2. POST /api/graph-contexts
   ├─ title, description, tags
   ├─ edge_table_name, node_table_name
   ├─ edge_structure, node_structure
   └─ properties arrays
   ↓
3. Backend validates and stores
   ├─ Extract node_types and relationship_types
   ├─ Create GraphContext in database
   └─ Set owner_email from auth
   ↓
4. Return GraphContextResponse
   ↓
5. Frontend stores context_id
   └─ Navigate to /graph/:context_id
```

## Persistence Modes

### Mode 1: localStorage (Offline)

**Characteristics:**
- Default when `GRAPH_LAGOON_DATABASE_ENABLED=false`
- Uses browser localStorage API
- No multi-device or sharing support
- Frontend passes `context_info` with every request

**Advantages:**
- Fast, no network overhead for metadata
- Suitable for demos and standalone usage
- No database setup required

**Limitations:**
- No collaboration or sharing
- Data tied to single browser
- Manual export/import needed

### Mode 2: PostgreSQL (Production)

**Characteristics:**
- Enabled with `GRAPH_LAGOON_DATABASE_ENABLED=true`
- Stores contexts, explorations, shares
- Multi-user support with permissions
- Alembic migrations for schema management

**Advantages:**
- Persistent storage across devices
- User collaboration via sharing
- Analytics and usage tracking
- Production-ready

**Configuration:**
```bash
GRAPH_LAGOON_DATABASE_ENABLED=true
GRAPH_LAGOON_DATABASE_URL=postgresql+asyncpg://user:pass@host:port/db
```

## Databricks Integration

### Configuration

```bash
GRAPH_LAGOON_DATABRICKS_MODE=true
GRAPH_LAGOON_DATABRICKS_HOST=adb-123.azuredatabricks.net
GRAPH_LAGOON_DATABRICKS_TOKEN=dapi...
GRAPH_LAGOON_DATABRICKS_WAREHOUSE_ID=abc123
GRAPH_LAGOON_DATABRICKS_CATALOG=my_catalog
GRAPH_LAGOON_DATABRICKS_SCHEMA=my_schema
```

### Features

- Connect to Databricks SQL Warehouse
- Use Unity Catalog or workspace catalogs
- Automatic schema discovery and preview
- Token refresh via `header_provider` pattern

### Header Provider Pattern

```python
# Callable that returns auth token (sync or async)
def get_token() -> str:
    return get_fresh_databricks_token()

warehouse = WarehouseClient(
    base_url=databricks_url,
    header_provider=get_token
)
```

## Cypher-to-SQL Transpilation

### Process Flow

```
1. User writes Cypher query
   MATCH (a:Person)-[r:KNOWS]->(b:Person)
   WHERE a.age > 25
   RETURN a, r, b
   ↓
2. Frontend calls transpileCypher()
   ↓
3. Backend (services/cypher.py)
   ├─ Build schema from GraphContext
   │  ├─ NodeSchema for each node_type
   │  └─ EdgeSchema for each (src, edge, dst) tuple
   ├─ Parse Cypher with OpenCypherParser
   ├─ Optimize logical plan
   └─ Render to Spark SQL
   ↓
4. Return transpiled SQL
   ↓
5. Frontend displays SQL
   ├─ User reviews (unless inMessiWeTrust=true)
   └─ Execute as regular query
```

### Schema Building

The transpiler requires schema information:
- Node types with property columns
- Edge types with source/destination types
- Property data types (mapped from Spark types)

## Investigations

A case (`Investigation`) gathers graphs, tables, queries, documents and notes
from any context into one workspace and ends in decisions recorded by people.
What a case means to the org (types, fields, vocabulary, decision catalog,
SLAs, templates) is data. Plans: `docs/dev/plans/investigation/` (05 then 06);
user guide: `docs/guide/investigations.md` and `docs/guide/agents-mcp.md`.

**Entities** (`db/models.py`, migration `016_cases`, mirrored by the in-memory
store with the same child-table helpers in `services/cases.py`):
- `Investigation` - title, owner, assignee, `case_type`, `fields` (JSON,
  validated by the type), `external_ref` (idempotent creation), `status`
  (`open` ⇄ `analysis`; `closed` only by a decision), `stage`, `sla_hours`,
  `settings` (identity keys, edge semantics, vocabularies, suggest kinds,
  label templates), `state` (view only), `decisions` (JSON, append-only)
- `InvestigationShare` - nominal e-mail shares only (no wildcards)
- `CaseItem` / `CaseItemVersion` - every item (graph, table, query, document,
  note) with author, status (`suggested` | `confirmed` | `rejected`), `query`,
  `mapping`, `anchor`, `state` (a table's chart) and immutable versions
  (sha256, blob, run metadata, pin)
- `CaseAnnotation` - role, tag, group, same_as, hypothesis, hypothesis_status,
  status_change, task, decision_proposal
- `CaseEntity` - the entities of each case's unified graph by uid, with a
  stamp of the graph's inputs ("seen in other cases")
- `InvestigationEvent` - append-only journal, actor `human` or `agent`
- `CaseType` (slug, spec JSON; `general` is code), `OrgLibrary` (playbooks,
  report templates, file mappings), `AgentToken` (hash only, scope, expiry)

**Decisions** (`services/cases.py`): an outcome of the type's catalog (or a
free one), targets, tasks (created as `task` annotations before the
decision's event), rationale, pinned evidence and an optional reviewer. Each
decision stores the sha256 of the canonical journal up to its own
`decision.recorded`; `verify_decisions` recomputes it and checks the version
bytes it cited. A closing outcome sets `status=closed` (409 on every change
except tasks and drafted reports) — after a four-eyes approval when the
outcome requires review. Reopen is human-only and keeps the decisions.

**Access** (`services/cases.py`): read = owner, assignee, any share,
superuser (a case-scoped agent token: only its cases); write = owner,
assignee, editor share; manage (share, delete) = owner or superuser.
Unreadable cases answer 404. Five permissions gate actions:
`investigation.create`, `.upload`, `.decide`, `.share`, `.agent`
(`services/permission_catalog.py`).

**Storage** (`services/investigation_storage.py`): one `BlobStore` rooted at
`investigations_volume_path` (a Unity Catalog Volume through the Files API)
or `{exploration_snapshots_dir}/investigations` on disk; every version is
written once under `{investigation_id}/items/{item_id}/{sha256}`, with its
text extraction next to it. Exports are generated on request and audited
with their sha256, never stored. A table with `mapping.as = graph` is
interpreted on read (`services/file_mapping.py`, twin of
`frontend/src/utils/fileMapping.ts`, delimited or fixed-width).

**Unified graph and analyses.** The browser unifies items by identity keys
(`frontend/src/utils/unifyGraph.ts`) and runs trace and paths in workers; the
server has Python ports at parity (`services/case_graph.py`, `trace.py`,
`paths.py`, `entity_resolution.py`) behind
`POST /api/investigations/{id}/analysis/{trace,paths,er}`, checked against
shared fixtures (`frontend/src/__tests__/fixtures/`). The server's full graph
of a case refreshes its `case_entities` rows.

**Data, not code** (`services/case_types.py`, `org_library.py`,
`reports.py`): case types (copied into a new case: vocabulary, suggest
kinds, SLA hours, starter queries; read live: label, catalog, notice,
playbook, templates, trace defaults), report templates rendered with
`{{placeholders}}` into markdown items, saved file mappings.

**MCP** (`mcp/server.py`, optional `mcp` extra): an `MCPServer` (official
`mcp` SDK) mounted at `{prefix}/mcp` (Streamable HTTP) when `agents_enabled`,
authenticated by personal agent tokens (`Bearer glt_…`, `middleware/auth.py`,
per-token rate limit). Tools call the same services as the REST routes with
the token owner as user and the agent as actor, return data wrapped in
`untrusted_data` (images from `read_item` as MCP image content), and never
decide: `propose_decision` writes a `decision_proposal` a person takes up.
`mcp/registry.py` maps every investigation route to its tool or to a reason it
has none; `human-only:` routes (decisions, reviews, export, share, delete,
reopen, confirm/reject, tokens) carry `forbid_agents`, and
`tests/test_agent_registry.py` enforces the coverage. `graphlagoon
mcp-bridge` is a local stdio bridge for clients behind the Databricks Apps
proxy.

## API Endpoints

### Authentication

- Uses header-based authentication
- Headers: `X-User-Email` or `X-Forwarded-Email`
- Dev mode default: `devmessias@gmail.com`
- Custom user providers for parent app integration
- Superusers (env-configured via `GRAPH_LAGOON_SUPERUSER_EMAILS`) bypass
  ownership/share checks on contexts, explorations, and query templates
  (predicates in `graphlagoon/utils/authz.py`); share-target domain
  validation still applies

### Graph Contexts

```
GET    /api/graph-contexts              # List all contexts
POST   /api/graph-contexts              # Create context
GET    /api/graph-contexts/{id}         # Get context
PUT    /api/graph-contexts/{id}         # Update context
DELETE /api/graph-contexts/{id}         # Delete context
POST   /api/graph-contexts/{id}/share   # Share with user
DELETE /api/graph-contexts/{id}/share/{email} # Unshare
```

### Graph Queries

```
GET    /api/datasets                           # List tables in warehouse
POST   /api/graph-contexts/{id}/subgraph      # Get subgraph
POST   /api/graph-contexts/{id}/expand        # BFS expansion from node
POST   /api/graph-contexts/{id}/query         # Execute SQL
POST   /api/graph-contexts/{id}/cypher        # Execute Cypher
POST   /api/graph-contexts/{id}/cypher/transpile # Transpile only
```

### Explorations

```
GET    /api/explorations                              # List all accessible
GET    /api/graph-contexts/{id}/explorations          # List context's explorations
POST   /api/graph-contexts/{id}/explorations          # Create exploration
GET    /api/explorations/{id}                         # Get exploration
PUT    /api/explorations/{id}                         # Update exploration
DELETE /api/explorations/{id}                         # Delete exploration
POST   /api/explorations/{id}/share                   # Share exploration
```

### Investigations

```
GET|POST         /api/investigations                       # Paged queue (filters, fields, sort) / create (idempotent by external_ref)
GET              /api/investigations/tasks                 # Tasks across readable cases (?mine, state, overdue)
GET              /api/investigations/entities/cases?uid=   # Cases where an entity is present or of interest
GET|PATCH|DELETE /api/investigations/{id}                  # Case (DELETE: retention)
POST|DELETE      /api/investigations/{id}/share[/{email}]  # Nominal shares (human-only)
*                /api/investigations/{id}/items[/{item}/versions|pin|run|text|content|confirm|reject]
*                /api/investigations/{id}/annotations[/{aid}/confirm|reject]
POST             /api/investigations/{id}/analysis/{trace|paths|er}
POST             /api/investigations/{id}/reports          # Render an org template into a markdown item
POST             /api/investigations/{id}/decisions        # Human-only; a closing outcome freezes the case
POST             /api/investigations/{id}/decisions/{did}/review  # Four eyes (human-only)
POST             /api/investigations/{id}/reopen           # Human-only
GET              /api/investigations/{id}/export?format=json|csv
GET              /api/org/case-types[/{slug}] · /api/org/library[/{slug}]
PUT|DELETE       /api/admin/case-types/{slug} · /api/admin/library[/{slug}]
GET|POST|DELETE  /api/agent-tokens[/{id}]                  # Personal agent tokens
POST             /api/admin/investigations/{id}/transfer   # Superuser: new owner
```

### Catalog (Databricks)

```
GET    /api/catalog/catalogs    # List catalogs
GET    /api/catalog/databases   # List databases in catalog
GET    /api/catalog/tables      # List tables
GET    /api/catalog/schema      # Get table schema
GET    /api/catalog/preview     # Preview table data
POST   /api/catalog/refresh     # Refresh catalog
```

### System

```
GET    /api/config    # Get system configuration
GET    /health        # Health check
```

## Configuration

### Environment Variables

All variables use the `GRAPH_LAGOON_` prefix:

**Database:**
```bash
GRAPH_LAGOON_DATABASE_ENABLED=true|false
GRAPH_LAGOON_DATABASE_URL=postgresql+asyncpg://user:pass@host:port/db
```

**Databricks:**
```bash
GRAPH_LAGOON_DATABRICKS_MODE=true|false
GRAPH_LAGOON_DATABRICKS_HOST=adb-123.azuredatabricks.net
GRAPH_LAGOON_DATABRICKS_TOKEN=dapi...
GRAPH_LAGOON_DATABRICKS_WAREHOUSE_ID=abc123
GRAPH_LAGOON_DATABRICKS_CATALOG=my_catalog
GRAPH_LAGOON_DATABRICKS_SCHEMA=my_schema
```

**Local Warehouse:**
```bash
GRAPH_LAGOON_SQL_WAREHOUSE_URL=http://localhost:8001
```

**Application:**
```bash
GRAPH_LAGOON_DEV_MODE=true|false
GRAPH_LAGOON_PORT=8000
GRAPH_LAGOON_SHOW_ERROR_DETAILS=true|false
```

## Deployment Modes

### 1. Standalone Application

```python
from graphlagoon.app import create_app

app = create_app()
# Run with uvicorn
```

**Use Case:** Running as independent service

### 2. Mountable in Existing FastAPI App

```python
from fastapi import FastAPI
from graphlagoon.app import create_mountable_app

parent_app = FastAPI()
graph_viz_app = create_mountable_app()

parent_app.mount("/graph-viz", graph_viz_app)
```

**Use Case:** Embedding in existing FastAPI application

### 3. API Router Only

```python
from fastapi import FastAPI
from graphlagoon.app import create_api_router

app = FastAPI()
api_router = create_api_router()

app.include_router(api_router, prefix="/api/graph-viz")
```

**Use Case:** Custom frontend or API-only deployment

## Security Considerations

### Authentication

- Header-based user identification
- Custom user providers for parent app integration
- Auto-create users in database on first request

### Authorization

- Owner-based access control
- Share mechanism with permissions
- Context and exploration isolation

### SQL Injection Prevention

- Parameterized queries in SQLAlchemy
- Warehouse client uses prepared statements
- No direct SQL string concatenation

## Performance Optimization

### Frontend

- Web Workers for metrics calculation
- GPU-accelerated rendering (Three.js)
- Camera movement detection (hide labels during interaction)
- Lazy loading of exploration states

### Backend

- Async/await throughout (FastAPI + SQLAlchemy)
- Connection pooling for database
- Lazy database initialization
- httpx async HTTP client for warehouse

### Visualization

- MSDF labels for efficient 3D text rendering
- InstancedMesh for label geometry
- Culling and LOD (level of detail)
- Computed properties for reactive filtering

## Monitoring and Debugging

### Frontend

- Vue DevTools support
- Console logging in development mode
- ResourceMonitorModal for performance tracking
- Error boundary with QueryErrorModal

### Backend

- FastAPI automatic OpenAPI docs (`/docs`)
- Health check endpoint (`/health`)
- Detailed error responses in dev mode
- Usage logging to database

## Future Considerations

### Scalability

- Consider caching layer for frequent queries
- Implement query result pagination
- Add graph data streaming for large graphs

### Features

- Real-time collaboration on explorations
- Graph diff/versioning
- Advanced analytics and metrics
- Export to various formats (GraphML, Gephi, etc.)

### Integration

- REST API clients for other languages
- Jupyter notebook integration
- BI tool connectors (Tableau, Power BI)

## References

- [Vue 3 Documentation](https://vuejs.org/)
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [3D Force Graph Documentation](https://github.com/vasturiano/3d-force-graph)
- [Databricks SQL Connector](https://docs.databricks.com/dev-tools/python-sql-connector.html)
- [gsql2rsql Library](https://github.com/willduff/gsql2rsql)
