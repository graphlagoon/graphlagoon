# Code Patterns and Conventions

## Overview

This document outlines the coding patterns, conventions, and best practices used throughout the graphlagoon-studio project.

## Frontend Patterns (Vue 3 + TypeScript)

### 1. Component Structure

#### Composition API Pattern

All Vue components use the Composition API with `<script setup>`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useGraphStore } from '@/stores/graph'

// Props
interface Props {
  contextId: string
  viewMode?: '3d' | '2d-proj'  // '3d' = Three.js 3D, '2d-proj' = Three.js 2D projection
}

const props = withDefaults(defineProps<Props>(), {
  viewMode: '3d'
})

// Emits
const emit = defineEmits<{
  (e: 'node-selected', nodeId: string): void
  (e: 'error', error: Error): void
}>()

// State
const graphStore = useGraphStore()
const isLoading = ref(false)

// Computed
const filteredNodes = computed(() => {
  return graphStore.filteredNodes
})

// Methods
const handleNodeClick = (nodeId: string) => {
  emit('node-selected', nodeId)
}

// Lifecycle
onMounted(() => {
  // Initialize
})
</script>

<template>
  <div class="component">
    <!-- Template content -->
  </div>
</template>

<style scoped>
/* Component styles */
</style>
```

**Key Conventions:**
- Use `<script setup>` syntax
- Type all props with TypeScript interfaces
- Define emits with type signatures
- Use `withDefaults` for default prop values
- Organize imports, state, computed, methods, lifecycle in order

#### File Naming

- Components: PascalCase (e.g., `GraphCanvas.vue`, `SidePanel.vue`)
- Stores: camelCase (e.g., `graph.ts`, `metrics.ts`)
- Services: camelCase (e.g., `api.ts`, `localStorage.ts`)
- Types: camelCase (e.g., `graph.ts`, `metrics.ts`)
- Utils: camelCase (e.g., `labelFormatter.ts`)

### 2. State Management (Pinia)

#### Store Definition Pattern

```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useGraphStore = defineStore('graph', () => {
  // State (ref)
  const nodes = ref<Node[]>([])
  const edges = ref<Edge[]>([])
  const selectedNodeId = ref<string | null>(null)

  // Getters (computed)
  const selectedNode = computed(() => {
    if (!selectedNodeId.value) return null
    return nodes.value.find(n => n.id === selectedNodeId.value)
  })

  const nodeCount = computed(() => nodes.value.length)

  // Actions (functions)
  const selectNode = (nodeId: string | null) => {
    selectedNodeId.value = nodeId
  }

  const loadContext = async (contextId: string) => {
    try {
      // Load logic
    } catch (error) {
      console.error('Error loading context:', error)
      throw error
    }
  }

  // Return public API
  return {
    // State
    nodes,
    edges,
    selectedNodeId,

    // Getters
    selectedNode,
    nodeCount,

    // Actions
    selectNode,
    loadContext
  }
})
```

**Key Conventions:**
- Use setup function syntax (not options API)
- State: `ref()` for reactive values
- Getters: `computed()` for derived state
- Actions: async/await for API calls
- Error handling in actions
- Return explicit public API

#### Store Access in Components

```typescript
// In component
import { useGraphStore } from '@/stores/graph'

const graphStore = useGraphStore()

// Read state
const nodes = graphStore.nodes

// Call actions
await graphStore.loadContext(contextId)

// Access getters
const count = graphStore.nodeCount
```

### 3. API Service Pattern

#### Dual Persistence Abstraction

```typescript
// services/api.ts
import { usePersistence } from '@/composables/usePersistence'
import * as localStorage from './localStorage'

const { persistenceMode } = usePersistence()

export const loadGraphContext = async (id: string) => {
  if (persistenceMode.value === 'localStorage') {
    return localStorage.getContext(id)
  } else {
    const response = await axios.get(`/api/graph-contexts/${id}`)
    return response.data
  }
}

export const executeQuery = async (
  contextId: string,
  query: string,
  contextInfo?: GraphContextInfo
) => {
  if (persistenceMode.value === 'localStorage') {
    // Pass context_info with request
    const response = await axios.post(`/api/graph-contexts/${contextId}/query`, {
      query,
      context_info: contextInfo
    })
    return response.data
  } else {
    // Context already in backend, no need for context_info
    const response = await axios.post(`/api/graph-contexts/${contextId}/query`, {
      query
    })
    return response.data
  }
}
```

**Key Conventions:**
- Check `persistenceMode` for routing decisions
- Pass `context_info` in localStorage mode
- Handle errors consistently
- Return typed data

### 4. Type Definitions

#### Comprehensive Type Modeling

```typescript
// types/graph.ts

export interface Node {
  id: string
  node_type: string
  properties: Record<string, any>
  x?: number
  y?: number
  z?: number
  size?: number
  color?: string
}

export interface Edge {
  id: string
  source: string
  target: string
  relationship_type: string
  properties: Record<string, any>
  size?: number
  color?: string
  curvature?: number
}

export interface GraphResponse {
  nodes: Node[]
  edges: Edge[]
  metadata?: {
    total_nodes: number
    total_edges: number
    query_time_ms: number
  }
}

export interface GraphContextInfo {
  edge_table_name: string
  node_table_name: string
  edge_structure: EdgeStructure
  node_structure: NodeStructure
  edge_properties: PropertyColumn[]
  node_properties: PropertyColumn[]
}
```

**Key Conventions:**
- Export all types
- Use interfaces for object shapes
- Use `Record<string, any>` for dynamic properties
- Optional fields with `?`
- Descriptive names

### 5. Error Handling

#### Frontend Error Pattern

```typescript
// In store action
const loadContext = async (contextId: string) => {
  try {
    isLoading.value = true
    error.value = null

    const context = await api.loadGraphContext(contextId)
    currentContext.value = context

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    error.value = message
    console.error('Error loading context:', err)

    // Optionally show toast
    useToast().error(`Failed to load context: ${message}`)

    throw err // Re-throw for component handling
  } finally {
    isLoading.value = false
  }
}
```

**Key Conventions:**
- Try-catch-finally pattern
- Set loading state
- Clear/set error state
- Log errors to console
- Show user-friendly messages
- Re-throw for component-level handling

### 6. Composables

#### Reusable Composition Functions

```typescript
// composables/usePersistence.ts
import { ref, readonly } from 'vue'

const persistenceMode = ref<'localStorage' | 'api'>('localStorage')
const devMode = ref(false)

export const usePersistence = () => {
  const setPersistenceMode = (mode: 'localStorage' | 'api') => {
    persistenceMode.value = mode
  }

  return {
    persistenceMode: readonly(persistenceMode),
    devMode: readonly(devMode),
    setPersistenceMode
  }
}
```

**Key Conventions:**
- Prefix with `use`
- Return readonly refs for external state
- Provide setters as functions
- Keep stateful logic encapsulated

## Backend Patterns (FastAPI + SQLAlchemy)

### 1. Router Structure

#### Dependency Injection Pattern

```python
# routers/graph_contexts.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from graphlagoon.db.database import get_db
from graphlagoon.middleware.auth import get_current_user

router = APIRouter(prefix="/api/graph-contexts", tags=["graph-contexts"])

@router.get("/", response_model=list[GraphContextResponse])
async def list_contexts(
    user_email: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all contexts accessible to the user."""
    contexts = await get_user_contexts(db, user_email)
    return contexts

@router.post("/", response_model=GraphContextResponse, status_code=201)
async def create_context(
    data: GraphContextCreate,
    user_email: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new graph context."""
    context = await create_graph_context(db, data, owner_email=user_email)
    return context
```

**Key Conventions:**
- Use `APIRouter` with prefix and tags
- Type request/response with Pydantic models
- Use `Depends()` for injection
- Docstrings for each endpoint
- Async/await throughout

### 2. Service Layer Pattern

#### Business Logic Separation

```python
# services/graph_operations.py
from typing import List
from graphlagoon.models.schemas import Node, Edge, GraphResponse

class QueryExecutionError(Exception):
    """Raised when query execution fails."""
    pass

async def execute_graph_query_with_nodes(
    warehouse: WarehouseClient,
    query: str,
    node_id_column: str = "node_id",
    node_type_column: str = "node_type"
) -> GraphResponse:
    """
    Execute a graph query and return nodes with edges.

    Args:
        warehouse: Warehouse client for query execution
        query: SQL query to execute
        node_id_column: Column name for node IDs
        node_type_column: Column name for node types

    Returns:
        GraphResponse with nodes and edges

    Raises:
        QueryExecutionError: If query execution fails
    """
    try:
        result = await warehouse.execute_statement(query)
        graph_response = process_graph_query_result(
            result,
            node_id_column,
            node_type_column
        )
        return graph_response

    except Exception as e:
        raise QueryExecutionError(f"Query execution failed: {str(e)}") from e
```

**Key Conventions:**
- Business logic in services, not routers
- Async functions with `async def`
- Type hints for parameters and return values
- Comprehensive docstrings (Google style)
- Custom exceptions for domain errors
- Use `from e` for exception chaining

### 3. Database Models (SQLAlchemy 2.0)

#### Async ORM Pattern

```python
# db/models.py
from sqlalchemy import String, DateTime, JSON, ARRAY, ForeignKey
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from datetime import datetime
from typing import List
import uuid

class Base(DeclarativeBase):
    pass

class GraphContext(Base):
    __tablename__ = "graph_contexts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(String(1000), nullable=True)
    edge_table_name: Mapped[str] = mapped_column(String(255), nullable=False)
    node_table_name: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_email: Mapped[str] = mapped_column(String(255), ForeignKey("users.email"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # JSON columns
    edge_structure: Mapped[dict] = mapped_column(JSON, nullable=False)
    node_structure: Mapped[dict] = mapped_column(JSON, nullable=False)

    # Array columns
    node_types: Mapped[List[str]] = mapped_column(ARRAY(String), nullable=True)
    relationship_types: Mapped[List[str]] = mapped_column(ARRAY(String), nullable=True)

    # Relationships
    explorations: Mapped[List["Exploration"]] = relationship(back_populates="graph_context", cascade="all, delete-orphan")
    shares: Mapped[List["GraphContextShare"]] = relationship(back_populates="graph_context", cascade="all, delete-orphan")
```

**Key Conventions:**
- Use `Mapped[]` type hints (SQLAlchemy 2.0 style)
- Use `mapped_column()` for column definitions
- UUID primary keys with `uuid.uuid4` default
- Timestamps with `datetime.utcnow`
- JSON for complex structures
- ARRAY for lists
- Relationships with `back_populates`
- Cascade deletes where appropriate

### 4. Pydantic Schemas

#### Request/Response Models

```python
# models/schemas.py
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Dict, Any, Optional
from datetime import datetime
import uuid

class GraphContextBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=1000)
    tags: Optional[List[str]] = Field(default_factory=list)
    edge_table_name: str = Field(..., min_length=1)
    node_table_name: str = Field(..., min_length=1)

class GraphContextCreate(GraphContextBase):
    edge_structure: Dict[str, Any]
    node_structure: Dict[str, Any]
    edge_properties: List[Dict[str, Any]]
    node_properties: List[Dict[str, Any]]

class GraphContextResponse(GraphContextBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    owner_email: str
    created_at: datetime
    updated_at: datetime
    node_types: Optional[List[str]] = None
    relationship_types: Optional[List[str]] = None

class Node(BaseModel):
    id: str
    node_type: str
    properties: Dict[str, Any] = Field(default_factory=dict)

class Edge(BaseModel):
    id: str
    source: str
    target: str
    relationship_type: str
    properties: Dict[str, Any] = Field(default_factory=dict)

class GraphResponse(BaseModel):
    nodes: List[Node]
    edges: List[Edge]
```

**Key Conventions:**
- Base model for shared fields
- Separate Create/Update/Response models
- Use `Field()` for validation and defaults
- `ConfigDict(from_attributes=True)` for ORM compatibility
- Type hints for all fields
- `Optional[]` for nullable fields
- `default_factory` for mutable defaults

### 5. Async Database Sessions

#### Session Management Pattern

```python
# db/database.py
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from typing import AsyncGenerator

engine = None
async_session_maker = None

async def init_database(database_url: str):
    """Initialize database engine and session maker."""
    global engine, async_session_maker

    engine = create_async_engine(database_url, echo=False, pool_pre_ping=True)
    async_session_maker = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False
    )

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency for getting database session."""
    if async_session_maker is None:
        raise RuntimeError("Database not initialized")

    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
```

**Key Conventions:**
- Lazy initialization pattern
- Global engine and session maker
- Dependency function returns generator
- Auto-commit on success
- Auto-rollback on error
- Close session in finally

### 6. Error Handling

#### Backend Error Pattern

```python
# Custom exceptions
class QueryExecutionError(Exception):
    """Raised when query execution fails."""
    pass

class ResourceNotFoundError(Exception):
    """Raised when a resource is not found."""
    pass

# In router
@router.get("/{context_id}")
async def get_context(
    context_id: uuid.UUID,
    user_email: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    try:
        context = await get_context_by_id(db, context_id, user_email)
        if not context:
            raise HTTPException(status_code=404, detail="Context not found")
        return context

    except QueryExecutionError as e:
        raise HTTPException(status_code=500, detail=str(e))

    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")
```

**Key Conventions:**
- Custom exceptions for domain errors
- Convert to HTTPException in routers
- Appropriate status codes (404, 400, 500, etc.)
- Log unexpected errors
- User-friendly error messages
- Include details in dev mode

### 7. Configuration Pattern

#### Pydantic Settings

```python
# config.py
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="GRAPH_LAGOON_",
        env_file=".env",
        case_sensitive=False
    )

    # Database
    database_enabled: bool = False
    database_url: Optional[str] = None

    # Databricks
    databricks_mode: bool = False
    databricks_host: Optional[str] = None
    databricks_token: Optional[str] = None
    databricks_warehouse_id: Optional[str] = None
    databricks_catalog: Optional[str] = None
    databricks_schema: Optional[str] = None

    # Application
    dev_mode: bool = True
    port: int = 8000
    show_error_details: bool = False
    sql_warehouse_url: str = "http://localhost:8001"

settings = Settings()
```

**Key Conventions:**
- Use `pydantic_settings` for configuration
- Env prefix for all variables
- Load from `.env` file
- Type hints for all settings
- Sensible defaults
- Singleton instance

## Testing Patterns

### Frontend Testing

```typescript
// Component test with Vitest + Testing Library
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import GraphCanvas from '@/components/GraphCanvas.vue'

describe('GraphCanvas', () => {
  let wrapper

  beforeEach(() => {
    wrapper = mount(GraphCanvas, {
      global: {
        plugins: [createPinia()]
      },
      props: {
        contextId: 'test-context'
      }
    })
  })

  it('renders canvas element', () => {
    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('emits node-selected on node click', async () => {
    // Test logic
  })
})
```

### Backend Testing

```python
# Test with pytest + async
import pytest
from httpx import AsyncClient
from graphlagoon.app import create_app

@pytest.fixture
async def client():
    app = create_app()
    async with AsyncClient(app=app, base_url="http://test") as ac:
        yield ac

@pytest.mark.asyncio
async def test_list_contexts(client):
    response = await client.get("/api/graph-contexts")
    assert response.status_code == 200
    assert isinstance(response.json(), list)

@pytest.mark.asyncio
async def test_create_context(client):
    data = {
        "title": "Test Context",
        "edge_table_name": "edges",
        "node_table_name": "nodes",
        # ...
    }
    response = await client.post("/api/graph-contexts", json=data)
    assert response.status_code == 201
    assert response.json()["title"] == "Test Context"
```

## Naming Conventions

### Frontend

- **Components:** PascalCase (e.g., `GraphCanvas`, `SidePanel`)
- **Files:** Same as export (e.g., `GraphCanvas.vue`, `api.ts`)
- **Variables:** camelCase (e.g., `selectedNode`, `isLoading`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `API_BASE_URL`)
- **Types/Interfaces:** PascalCase (e.g., `Node`, `GraphResponse`)
- **Functions:** camelCase (e.g., `loadContext`, `executeQuery`)

### Backend

- **Modules:** snake_case (e.g., `graph_operations.py`)
- **Classes:** PascalCase (e.g., `GraphContext`, `WarehouseClient`)
- **Functions:** snake_case (e.g., `get_context_by_id`)
- **Variables:** snake_case (e.g., `context_id`, `user_email`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `DATABASE_URL`)
- **Private:** prefix with `_` (e.g., `_internal_helper`)

## Code Organization

### Frontend Directory Structure

```
src/
├── assets/          # Static assets (images, fonts)
├── components/      # Reusable Vue components
├── composables/     # Composition functions
├── router/          # Vue Router configuration
├── services/        # API and utility services
├── stores/          # Pinia stores
├── types/           # TypeScript type definitions
├── utils/           # Helper functions
├── views/           # Page-level components
├── workers/         # Web Workers
├── App.vue          # Root component
└── main.ts          # Application entry point
```

### Backend Directory Structure

```
graphlagoon/
├── db/              # Database models and sessions
├── middleware/      # Middleware (auth, etc.)
├── models/          # Pydantic schemas
├── routers/         # API route handlers
├── services/        # Business logic
├── static/          # Built frontend assets
├── app.py           # Application factory
├── config.py        # Configuration
└── main.py          # ASGI entry point
```

## Documentation Standards

### Code Comments

```typescript
// Frontend
/**
 * Executes a graph query and updates the visualization.
 *
 * @param query - SQL query to execute
 * @param options - Query execution options
 * @returns Promise resolving to graph response
 * @throws {Error} If query execution fails
 */
const executeGraphQuery = async (
  query: string,
  options?: QueryOptions
): Promise<GraphResponse> => {
  // Implementation
}
```

```python
# Backend
async def execute_graph_query_with_nodes(
    warehouse: WarehouseClient,
    query: str,
    node_id_column: str = "node_id",
    node_type_column: str = "node_type"
) -> GraphResponse:
    """
    Execute a graph query and return nodes with edges.

    Args:
        warehouse: Warehouse client for query execution
        query: SQL query to execute
        node_id_column: Column name for node IDs
        node_type_column: Column name for node types

    Returns:
        GraphResponse with nodes and edges

    Raises:
        QueryExecutionError: If query execution fails
    """
```

### Inline Comments

```typescript
// Good: Explain why, not what
// Hide labels during camera movement for better performance
if (cameraMoving) {
  labelRenderer.setVisible(false)
}

// Avoid: Stating the obvious
// Set labelRenderer visible to false
if (cameraMoving) {
  labelRenderer.setVisible(false)
}
```

## Git Commit Conventions

```
feat: Add new feature
fix: Fix bug
docs: Documentation changes
style: Code style changes (formatting, etc.)
refactor: Code refactoring
test: Add or update tests
chore: Build process or auxiliary tool changes
```

**Examples:**
```
feat(frontend): Add 3D label rendering with MSDF
fix(backend): Resolve context sharing permission bug
docs: Update architecture documentation
refactor(store): Simplify graph filtering logic
```

## Best Practices Summary

### Frontend

1. **Use TypeScript:** Type all props, emits, and function signatures
2. **Composition API:** Prefer `<script setup>` over Options API
3. **Reactive State:** Use `ref()` and `computed()` appropriately
4. **Error Handling:** Always handle async errors with try-catch
5. **Performance:** Use Web Workers for heavy computation
6. **Code Splitting:** Lazy load routes and components when possible

### Backend

1. **Async/Await:** Use async throughout for better performance
2. **Type Hints:** Type all function parameters and returns
3. **Dependency Injection:** Use FastAPI's `Depends()` pattern
4. **Service Layer:** Keep business logic out of routers
5. **Error Handling:** Use custom exceptions and HTTPException
6. **Database:** Use async sessions and ORM properly

### General

1. **DRY:** Don't repeat yourself - extract common logic
2. **SOLID:** Follow SOLID principles for maintainability
3. **Testing:** Write tests for critical functionality
4. **Documentation:** Document public APIs and complex logic
5. **Logging:** Log errors and important events
6. **Security:** Validate inputs, sanitize outputs
