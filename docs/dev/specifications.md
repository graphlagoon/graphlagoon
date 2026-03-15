# Graph Lagoon Studio: Interactive Graph Visualization System

## Overview

Graph Lagoon Studio is an interactive graph visualization system that allows users to explore, analyze, and share graph data stored in Spark SQL. The system leverages Spark SQL 4.1+ WITH RECURSIVE CTEs for efficient graph traversal operations.

> **Important**: All code, comments, variable names, and documentation must be written in English.

---

## Table of Contents

1. [Glossary](#glossary)
2. [Architecture](#architecture)
3. [Data Models](#data-models)
4. [Services Specification](#services-specification)
5. [API Contracts](#api-contracts)
6. [Frontend Specification](#frontend-specification)
7. [User Stories](#user-stories)
8. [Prioritization (MoSCoW)](#prioritization-moscow)
9. [Technical Decisions](#technical-decisions)

---

## Glossary

| Term | Definition |
|------|------------|
| **edge_table** | Parquet table storing graph edges in triple-store format (src, dst, edge_id, relationship_type, metadata) |
| **node_table** | Parquet table storing graph nodes (node_id, node_type, metadata) |
| **graph_context** | A user-defined combination of one edge_table + one node_table, with title, description, and tags |
| **exploration** | A saved snapshot of visualization state (node positions, selections, filters, viewport) for a graph_context |
| **sql-warehouse** | Backend service that stores graph data in Parquet and executes SQL queries with recursive CTEs |
| **WITH RECURSIVE** | SQL feature (Spark 4.1+) enabling recursive CTEs for graph traversal, BFS, pathfinding |
| **BFS expansion** | Breadth-first search from a selected node to discover connected nodes up to a given depth |

---

## Architecture

```mermaid
graph TB
    subgraph "Docker Compose"
        FE[graphlagoon-frontend<br/>Vue + 3D Force Graph]
        API[graphlagoon-rest-api<br/>FastAPI]
        PG[(PostgreSQL<br/>Users, Contexts,<br/>Explorations, Sharing)]
        WH[sql-warehouse<br/>FastAPI + Spark SQL]
        PQ[(Parquet Files<br/>Graph Data)]
    end

    FE -->|HTTP/JSON| API
    API -->|HTTP/JSON| WH
    API -->|SQL| PG
    WH -->|Spark SQL| PQ

    style FE fill:#42b883
    style API fill:#009688
    style WH fill:#ff6f00
    style PG fill:#336791
    style PQ fill:#ee8a1b
```

### Service Communication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant FE as Frontend
    participant API as graphlagoon-rest-api
    participant PG as PostgreSQL
    participant WH as sql-warehouse

    U->>FE: Select graph_context
    FE->>API: GET /api/graph-contexts/{id}
    API->>PG: Query context metadata
    PG-->>API: Context data
    API->>WH: POST /query (get subgraph)
    WH-->>API: Nodes + Edges
    API-->>FE: Graph data
    FE->>U: Render visualization
```

---

## Data Models

### Spark SQL Tables (Parquet)

#### edge_table schema
```sql
CREATE TABLE edge_table (
    edge_id STRING NOT NULL,        -- Unique identifier (UUID)
    src STRING NOT NULL,            -- Source node_id (FK to node_table)
    dst STRING NOT NULL,            -- Destination node_id (FK to node_table)
    relationship_type STRING NOT NULL,  -- Edge type (e.g., "KNOWS", "WORKS_AT")
    metadata MAP<STRING, STRING>    -- Flexible key-value metadata
);
```

#### node_table schema
```sql
CREATE TABLE node_table (
    node_id STRING NOT NULL,        -- Unique identifier (UUID)
    node_type STRING NOT NULL,      -- Node type (e.g., "Person", "Company")
    metadata MAP<STRING, STRING>    -- Flexible key-value metadata
);
```

### PostgreSQL Tables

```sql
-- Users (simplified, auth handled externally)
CREATE TABLE users (
    email VARCHAR(255) PRIMARY KEY,
    display_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Graph Contexts
CREATE TABLE graph_contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    tags TEXT[],
    edge_table_name VARCHAR(255) NOT NULL,  -- Reference to Spark table
    node_table_name VARCHAR(255) NOT NULL,  -- Reference to Spark table
    owner_email VARCHAR(255) REFERENCES users(email),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Graph Context Sharing
CREATE TABLE graph_context_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    graph_context_id UUID REFERENCES graph_contexts(id) ON DELETE CASCADE,
    shared_with_email VARCHAR(255) NOT NULL,
    permission VARCHAR(50) DEFAULT 'read',  -- 'read' | 'write'
    created_at TIMESTAMP DEFAULT NOW()
);

-- Explorations
CREATE TABLE explorations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    graph_context_id UUID REFERENCES graph_contexts(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    owner_email VARCHAR(255) REFERENCES users(email),
    state JSONB NOT NULL,  -- ExplorationState serialized
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Exploration Sharing
CREATE TABLE exploration_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exploration_id UUID REFERENCES explorations(id) ON DELETE CASCADE,
    shared_with_email VARCHAR(255) NOT NULL,
    permission VARCHAR(50) DEFAULT 'read',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Usage Logs
CREATE TABLE usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),  -- 'graph_context' | 'exploration' | 'query'
    resource_id UUID,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Pydantic Models (Backend)

```python
# models/graph.py
from pydantic import BaseModel, Field
from typing import Optional
from uuid import UUID
from datetime import datetime

class Node(BaseModel):
    node_id: str
    node_type: str
    metadata: dict[str, str] = Field(default_factory=dict)

class Edge(BaseModel):
    edge_id: str
    src: str
    dst: str
    relationship_type: str
    metadata: dict[str, str] = Field(default_factory=dict)

class GraphResponse(BaseModel):
    nodes: list[Node]
    edges: list[Edge]
    truncated: bool = False  # True if limit was reached
    total_count: Optional[int] = None  # Total before limit

class GraphContext(BaseModel):
    id: UUID
    title: str
    description: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    edge_table_name: str
    node_table_name: str
    owner_email: str
    shared_with: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

class NodeState(BaseModel):
    node_id: str
    x: float
    y: float
    selected: bool = False
    pinned: bool = False  # Pinned nodes don't move on layout recalculation

class EdgeState(BaseModel):
    edge_id: str
    selected: bool = False

class FilterState(BaseModel):
    node_types: list[str] = Field(default_factory=list)  # Empty = show all
    edge_types: list[str] = Field(default_factory=list)  # Empty = show all
    search_query: Optional[str] = None

class ViewportState(BaseModel):
    zoom: float = 1.0
    center_x: float = 0.0
    center_y: float = 0.0

class ExplorationState(BaseModel):
    nodes: list[NodeState]
    edges: list[EdgeState]
    filters: FilterState
    viewport: ViewportState
    layout_algorithm: str = "force-atlas-2"  # force-atlas-2 | circular | grid

class Exploration(BaseModel):
    id: UUID
    graph_context_id: UUID
    title: str
    owner_email: str
    shared_with: list[str] = Field(default_factory=list)
    state: ExplorationState
    created_at: datetime
    updated_at: datetime
```

### TypeScript Types (Frontend)

```typescript
// types/graph.ts

export interface Node {
  node_id: string;
  node_type: string;
  metadata: Record<string, string>;
  // Frontend-only (computed, not from API)
  x?: number;
  y?: number;
  selected?: boolean;
}

export interface Edge {
  edge_id: string;
  src: string;
  dst: string;
  relationship_type: string;
  metadata: Record<string, string>;
  // Frontend-only
  selected?: boolean;
}

export interface GraphResponse {
  nodes: Node[];
  edges: Edge[];
  truncated: boolean;
  total_count?: number;
}

export interface GraphContext {
  id: string;
  title: string;
  description?: string;
  tags: string[];
  edge_table_name: string;
  node_table_name: string;
  owner_email: string;
  shared_with: string[];
  created_at: string;
  updated_at: string;
}

export interface NodeState {
  node_id: string;
  x: number;
  y: number;
  selected: boolean;
  pinned: boolean;
}

export interface EdgeState {
  edge_id: string;
  selected: boolean;
}

export interface FilterState {
  node_types: string[];
  edge_types: string[];
  search_query?: string;
}

export interface ViewportState {
  zoom: number;
  center_x: number;
  center_y: number;
}

export type LayoutAlgorithm = "force-atlas-2" | "circular" | "grid";

export interface ExplorationState {
  nodes: NodeState[];
  edges: EdgeState[];
  filters: FilterState;
  viewport: ViewportState;
  layout_algorithm: LayoutAlgorithm;
}

export interface Exploration {
  id: string;
  graph_context_id: string;
  title: string;
  owner_email: string;
  shared_with: string[];
  state: ExplorationState;
  created_at: string;
  updated_at: string;
}

// Request types
export interface ExpandRequest {
  node_id: string;
  depth: number;
  edge_types?: string[];
  limit?: number;
}

export interface RandomGraphRequest {
  name?: string;
  node_types: string[];
  edge_types: string[];
  num_nodes: number;
  num_edges: number;
}

export interface CreateGraphContextRequest {
  title: string;
  description?: string;
  tags?: string[];
  edge_table_name: string;
  node_table_name: string;
}

export interface ShareRequest {
  email: string;
  permission: "read" | "write";
}
```

---

## Services Specification

### Service 1: sql-warehouse

**Purpose**: Store graph data in Parquet format and execute SQL queries with recursive CTEs for graph traversal.

#### Tech Stack
- FastAPI
- PySpark (Spark SQL 4.1+)
- Parquet files for data storage
- Pydantic for validation
- pytest for testing

#### Query Capabilities (WITH RECURSIVE)

The sql-warehouse uses Spark SQL WITH RECURSIVE for graph operations:

```sql
-- Example: BFS expansion from a node
WITH RECURSIVE neighbors AS (
  -- Base case: starting node
  SELECT
    node_id,
    0 AS depth,
    ARRAY(node_id) AS path
  FROM node_table
  WHERE node_id = :start_node

  UNION ALL

  -- Recursive case: find neighbors
  SELECT
    e.dst AS node_id,
    n.depth + 1,
    CONCAT(n.path, ARRAY(e.dst))
  FROM neighbors n
  JOIN edge_table e ON e.src = n.node_id
  WHERE n.depth < :max_depth
    AND NOT array_contains(n.path, e.dst)  -- Cycle detection
)
SELECT DISTINCT node_id, MIN(depth) AS distance
FROM neighbors
GROUP BY node_id
```

**Safety limits**:
- Default MAX RECURSION LEVEL: 100
- Default row limit: 1,000,000
- Configurable per query

#### Endpoints

See [API Contracts](#sql-warehouse-api) section.

---

### Service 2: graphlagoon-rest-api

**Purpose**: Main API that orchestrates communication between frontend and sql-warehouse, manages user data in PostgreSQL.

#### Tech Stack
- FastAPI
- Pydantic
- httpx (async HTTP client for sql-warehouse communication)
- SQLAlchemy + asyncpg (PostgreSQL)
- pytest
- uv (package manager)
- Makefile for common commands

#### Responsibilities
- Authenticate requests via `X-User-Email` header
- Manage graph_contexts and explorations in PostgreSQL
- Proxy and validate queries to sql-warehouse
- Handle sharing permissions
- Log usage for analytics

---

### Service 3: graphlagoon-frontend

**Purpose**: Interactive graph visualization interface.

#### Tech Stack
- Vue 3 (Composition API)
- Vite
- TypeScript
- Pinia (state management)
- 3D Force Graph (graph rendering)
- Axios (HTTP client)
- Vitest (testing)
- Makefile for common commands

---

## API Contracts

### sql-warehouse API

#### POST /datasets
List all available edge and node tables.

**Response:**
```json
{
  "edge_tables": ["edges_social", "edges_transactions"],
  "node_tables": ["nodes_people", "nodes_companies"]
}
```

#### POST /query
Execute arbitrary SQL query (with validation).

**Request:**
```json
{
  "sql": "SELECT * FROM nodes_people WHERE node_type = :type LIMIT :limit",
  "params": {"type": "Person", "limit": 100}
}
```

**Response:**
```json
{
  "columns": ["node_id", "node_type", "metadata"],
  "rows": [...]
}
```

#### POST /graph/{edge_table}/{node_table}/subgraph
Get a subgraph with limits.

**Request:**
```json
{
  "edge_limit": 1000,
  "node_types": ["Person", "Company"],
  "edge_types": ["WORKS_AT"]
}
```

**Response:** `GraphResponse`

#### POST /graph/{edge_table}/{node_table}/expand
BFS expansion from a node.

**Request:**
```json
{
  "node_id": "abc-123",
  "depth": 2,
  "edge_types": ["KNOWS", "WORKS_WITH"],
  "limit": 500
}
```

**Response:** `GraphResponse`

#### POST /graph/random (dev mode only)
Generate random graph for testing.

**Request:**
```json
{
  "name": "test_graph_001",
  "node_types": ["Person", "Company", "Product"],
  "edge_types": ["KNOWS", "WORKS_AT", "BOUGHT"],
  "num_nodes": 1000,
  "num_edges": 5000
}
```

**Response:**
```json
{
  "edge_table": "edges_test_graph_001",
  "node_table": "nodes_test_graph_001",
  "status": "created"
}
```

---

### graphlagoon-rest-api API

#### Authentication
All requests must include header: `X-User-Email: user@example.com`

#### Graph Contexts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/datasets` | List available tables from sql-warehouse |
| GET | `/api/graph-contexts` | List user's graph contexts (owned + shared) |
| POST | `/api/graph-contexts` | Create new graph context |
| GET | `/api/graph-contexts/{id}` | Get graph context details |
| PUT | `/api/graph-contexts/{id}` | Update graph context |
| DELETE | `/api/graph-contexts/{id}` | Delete graph context |
| POST | `/api/graph-contexts/{id}/share` | Share with another user |
| DELETE | `/api/graph-contexts/{id}/share/{email}` | Remove sharing |

#### Explorations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/graph-contexts/{id}/explorations` | List explorations for a context |
| POST | `/api/graph-contexts/{id}/explorations` | Create new exploration |
| GET | `/api/explorations/{id}` | Get exploration details |
| PUT | `/api/explorations/{id}` | Update exploration (save state) |
| DELETE | `/api/explorations/{id}` | Delete exploration |
| POST | `/api/explorations/{id}/share` | Share exploration |

#### Graph Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/graph-contexts/{id}/query` | Execute query on graph context |
| POST | `/api/graph-contexts/{id}/subgraph` | Get subgraph with limits |
| POST | `/api/graph-contexts/{id}/expand` | BFS expand from node |

#### Dev Mode Only

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/dev/random-graph` | Generate random graph |

---

## Frontend Specification

### Pages/Views

#### 1. Login Page (Dev Mode Only)
- Simple email input field
- Stores email in localStorage
- Adds `X-User-Email` header to all subsequent requests

#### 2. Dataset Management Page
- List all available edge_tables and node_tables from sql-warehouse
- Select one edge_table + one node_table to create a graph_context
- Form: title (required), description, tags
- Save as new graph_context

#### 3. Graph Context List Page
- Display user's graph contexts (owned + shared with user)
- Show: title, description, tags, owner, share count
- Actions: Open, Edit, Delete, Share
- Share modal: input email, select permission (read/write)

#### 4. Exploration List Page
- Filter by graph_context
- Display: title, graph_context name, last modified, owner
- Actions: Open, Delete, Share

#### 5. Graph Visualization Page

Main visualization interface with the following components:

##### 5.1 Toolbar
- [ ] Graph context selector dropdown
- [ ] Load exploration dropdown
- [ ] Save exploration button
- [ ] Layout algorithm selector (Force Atlas 2, Circular, Grid)
- [ ] Fullscreen toggle
- [ ] Export dropdown (PNG, JSON)

##### 5.2 Graph Canvas (3D Force Graph)
- [ ] Render nodes with colors based on node_type
- [ ] Render edges with colors based on relationship_type
- [ ] Zoom (scroll wheel)
- [ ] Pan (drag canvas)
- [ ] Select node (click)
- [ ] Select edge (click)
- [ ] Multi-select (Ctrl+click or drag box)
- [ ] Hover tooltip with basic info

##### 5.3 Side Panel (Node/Edge Details)
- [ ] Show when node or edge is selected
- [ ] Display all metadata as key-value list
- [ ] "Expand from this node" button (for nodes)
- [ ] Expansion options: depth (1-5), edge type filter

##### 5.4 Filter Panel
- [ ] Filter by node_type (multi-select checkboxes)
- [ ] Filter by relationship_type (multi-select checkboxes)
- [ ] Search in metadata (text input)
- [ ] Apply/Reset buttons

##### 5.5 Query Panel (Collapsible)
- [ ] Raw SQL input textarea
- [ ] Execute button
- [ ] Shows truncation warning if results were limited

##### 5.6 Status Bar
- [ ] Node count / Edge count
- [ ] Truncation indicator
- [ ] Loading spinner

### State Management (Pinia)

```typescript
// stores/graph.ts
interface GraphStore {
  // Current data
  nodes: Node[];
  edges: Edge[];

  // Selection
  selectedNodeIds: Set<string>;
  selectedEdgeIds: Set<string>;

  // UI state
  loading: boolean;
  error: string | null;

  // Visualization state
  filters: FilterState;
  viewport: ViewportState;
  layoutAlgorithm: LayoutAlgorithm;

  // Actions
  loadSubgraph(contextId: string): Promise<void>;
  expandFromNode(nodeId: string, depth: number): Promise<void>;
  applyFilters(filters: FilterState): void;
  recalculateLayout(algorithm: LayoutAlgorithm): void;
  saveExploration(title: string): Promise<void>;
  loadExploration(explorationId: string): Promise<void>;
  exportAsImage(): void;
  exportAsJson(): GraphResponse;
}
```

---

## User Stories

### US-001: Create Random Graph (Dev Mode)
**As a** developer
**I want to** generate a random graph with custom parameters
**So that** I can test the visualization without real data

**Acceptance Criteria:**
- [ ] Can specify number of nodes (1-10,000)
- [ ] Can specify number of edges (1-50,000)
- [ ] Can define node types (list of strings)
- [ ] Can define edge types (list of strings)
- [ ] Graph is created with auto-generated or user-provided name
- [ ] Feature only visible when `DEV_MODE=true`

---

### US-002: Create Graph Context
**As a** user
**I want to** create a graph context from available datasets
**So that** I can work with a specific graph

**Acceptance Criteria:**
- [ ] Can see list of available edge_tables and node_tables
- [ ] Can select one edge_table and one node_table
- [ ] Must provide a title
- [ ] Can optionally add description and tags
- [ ] Context is saved and appears in my list

---

### US-003: Visualize Graph
**As a** user
**I want to** visualize a graph context
**So that** I can explore the data visually

**Acceptance Criteria:**
- [ ] Can select a graph context to visualize
- [ ] Graph loads with max 1,000 edges (warning if truncated)
- [ ] Can zoom in/out with scroll
- [ ] Can pan by dragging
- [ ] Nodes colored by node_type
- [ ] Edges colored by relationship_type

---

### US-004: Inspect Node/Edge
**As a** user
**I want to** see details of a selected node or edge
**So that** I can understand the data

**Acceptance Criteria:**
- [ ] Clicking a node selects it
- [ ] Clicking an edge selects it
- [ ] Side panel shows all metadata
- [ ] Panel shows node_type or relationship_type

---

### US-005: Expand Node (BFS)
**As a** user
**I want to** expand connections from a selected node
**So that** I can discover related data

**Acceptance Criteria:**
- [ ] "Expand" button appears when node is selected
- [ ] Can choose depth (1-5)
- [ ] Can filter by edge types
- [ ] New nodes/edges are added to visualization
- [ ] Layout recalculates to accommodate new nodes
- [ ] Previously pinned nodes stay in place

---

### US-006: Filter Graph
**As a** user
**I want to** filter visible nodes and edges
**So that** I can focus on relevant data

**Acceptance Criteria:**
- [ ] Can filter by node_type (show/hide)
- [ ] Can filter by relationship_type (show/hide)
- [ ] Can search in metadata
- [ ] Filters are applied in real-time
- [ ] Can reset all filters

---

### US-007: Save Exploration
**As a** user
**I want to** save the current visualization state
**So that** I can return to it later

**Acceptance Criteria:**
- [ ] Can save current state with a title
- [ ] Saved state includes: node positions, selections, filters, viewport, layout
- [ ] Exploration appears in my list
- [ ] Can overwrite existing exploration

---

### US-008: Share Graph Context
**As a** user
**I want to** share a graph context with colleagues
**So that** they can also explore the data

**Acceptance Criteria:**
- [ ] Can share by entering email address
- [ ] Can set permission (read/write)
- [ ] Recipient sees shared context in their list
- [ ] Can remove sharing

---

### US-009: Export Graph
**As a** user
**I want to** export the current visualization
**So that** I can use it in documents or other tools

**Acceptance Criteria:**
- [ ] Can export as PNG image
- [ ] Can export as JSON (compatible with GraphResponse schema)
- [ ] Export includes current filter state

---

### US-010: Change Layout
**As a** user
**I want to** change the graph layout algorithm
**So that** I can better understand the structure

**Acceptance Criteria:**
- [ ] Can choose: Force Atlas 2, Circular, Grid
- [ ] Layout recalculates on selection
- [ ] Pinned nodes remain fixed
- [ ] Smooth animation during recalculation

---

## Prioritization (MoSCoW)

### Must Have (MVP)
- [ ] sql-warehouse with basic query endpoint
- [ ] sql-warehouse random graph generation (dev mode)
- [ ] graphlagoon-rest-api with graph context CRUD
- [ ] Frontend: fake login (dev mode)
- [ ] Frontend: dataset list and graph context creation
- [ ] Frontend: basic graph visualization (zoom, pan, select)
- [ ] Frontend: node/edge details panel
- [ ] Frontend: load graph context

### Should Have
- [ ] BFS expansion from node
- [ ] Filters (node_type, edge_type)
- [ ] Save/load explorations
- [ ] Share graph contexts
- [ ] Export PNG/JSON
- [ ] Multiple layout algorithms

### Could Have
- [ ] Share explorations
- [ ] Search in metadata
- [ ] Raw SQL query panel
- [ ] Usage logging
- [ ] Keyboard shortcuts

### Won't Have (v1)
- [ ] Real authentication (external)
- [ ] Real-time collaboration
- [ ] Graph editing (add/remove nodes/edges)
- [ ] Undo/redo
- [ ] Node annotations
- [ ] Community detection algorithms
- [ ] Path finding between nodes

---

## Technical Decisions

### ADR-001: Spark SQL over Neo4j

**Context:** Need a backend for graph storage and queries.

**Decision:** Use Spark SQL 4.1+ with Parquet files.

**Rationale:**
- WITH RECURSIVE CTEs enable graph traversal in pure SQL
- Scales to very large datasets (billions of edges)
- Integrates with existing data lake infrastructure
- Open source, no licensing costs
- Parquet provides efficient columnar storage

**Consequences:**
- Must implement traversal via recursive CTEs
- No native graph algorithms (must implement in SQL or frontend)
- Query syntax is SQL, not Cypher/SPARQL

---

### ADR-002: Separate sql-warehouse and graphlagoon-rest-api

**Context:** Could have a single API service.

**Decision:** Separate into two services.

**Rationale:**
- sql-warehouse may be shared by other consumers
- Clear separation of concerns (data vs. orchestration)
- sql-warehouse can scale independently
- PostgreSQL logic isolated from Spark logic

**Consequences:**
- Additional network hop (latency)
- Must maintain two services
- Need to handle service discovery in Docker Compose

---

### ADR-003: 3D Force Graph for Graph Visualization

**Context:** Need a frontend graph rendering library.

**Decision:** Use 3D Force Graph (Three.js-based) with 3D and 2D projection modes. Sigma.js 2D support was deprecated and removed.

**Rationale:**
- Excellent performance for large graphs
- Three.js WebGL rendering with instanced meshes
- Supports both 3D and 2D projection (numDimensions=2)
- D3 force layout engine
- Active community and documentation

---

## Error Handling

### API Error Responses

All API errors follow this format:

```json
{
  "error": {
    "code": "GRAPH_CONTEXT_NOT_FOUND",
    "message": "Graph context with id 'abc-123' not found",
    "details": {}
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid X-User-Email header |
| `FORBIDDEN` | 403 | User doesn't have permission |
| `GRAPH_CONTEXT_NOT_FOUND` | 404 | Graph context doesn't exist |
| `EXPLORATION_NOT_FOUND` | 404 | Exploration doesn't exist |
| `DATASET_NOT_FOUND` | 404 | Edge or node table doesn't exist |
| `INVALID_QUERY` | 400 | SQL query is invalid |
| `QUERY_TIMEOUT` | 408 | Query exceeded time limit |
| `RECURSION_LIMIT` | 400 | Query exceeded max recursion depth |
| `RESULT_LIMIT` | 200 | Results truncated (not an error, returned in response) |
| `SHARE_USER_NOT_FOUND` | 400 | Email to share with doesn't exist |

---

## Docker Compose Structure

Only PostgreSQL runs in Docker. All other services (sql-warehouse, graphlagoon-rest-api, frontend) run directly on the host machine during development.

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:16
    environment:
      - POSTGRES_USER=sgraph
      - POSTGRES_PASSWORD=sgraph
      - POSTGRES_DB=sgraph
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

volumes:
  postgres_data:
```

### Local Development Setup

```bash
# Start PostgreSQL
docker-compose up -d

# Run sql-warehouse (terminal 1)
cd sql-warehouse
make run  # runs on http://localhost:8001

# Run graphlagoon-rest-api (terminal 2)
cd graphlagoon-rest-api
make run  # runs on http://localhost:8000

# Run frontend (terminal 3)
cd graphlagoon-frontend
make dev  # runs on http://localhost:3000
```

### Environment Variables

**sql-warehouse/.env**
```env
SPARK_MASTER=local[*]
DEV_MODE=true
DATA_PATH=./data/parquet
PORT=8001
```

**graphlagoon-rest-api/.env**
```env
SQL_WAREHOUSE_URL=http://localhost:8001
DATABASE_URL=postgresql://sgraph:sgraph@localhost:5432/sgraph
DEV_MODE=true
PORT=8000
```

**graphlagoon-frontend/.env**
```env
VITE_API_URL=http://localhost:8000
```

---

## Development Guidelines

### Code Style
- All code, comments, and documentation in **English**
- Python: Follow PEP 8, use type hints
- TypeScript: Use strict mode, prefer interfaces over types
- Use meaningful variable and function names
- Write unit tests for all business logic

### Git Workflow
- Feature branches from `main`
- PR required for merge
- Squash merge preferred

### Testing
- Backend: pytest with async support
- Frontend: Vitest for unit, Playwright for E2E
- Minimum 80% coverage for critical paths
