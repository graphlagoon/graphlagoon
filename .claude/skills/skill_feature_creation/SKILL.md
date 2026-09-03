---
name: skill_feature_creation

description: This skill guides you through implementing new features in the graphlagoon-studio project. Use this when adding functionality to either the frontend (Vue 3) or backend (FastAPI), or both.
---
## Important: Decision Log

**EVERY action taken using this skill MUST be documented in [decision_log.md](../../../docs/dev/decision_log.md).**

Append an entry with:
- Date and time
- Feature description
- Design decisions
- Implementation approach
- Files created/modified
- Testing performed

## Feature Development Workflow

### Phase 1: Planning and Design

#### Step 1.1: Define Requirements

**Questions to Answer:**
1. What problem does this feature solve?
2. Who is the target user?
3. What are the acceptance criteria?
4. Are there any constraints (performance, compatibility)?
5. Does this affect both frontend and backend?

**Document Requirements:**
```markdown
## [YYYY-MM-DD] - Feature Planning: [Feature Name]

**Purpose:**
[Why are we building this?]

**User Story:**
As a [user type], I want [goal], so that [benefit].

**Requirements:**
- [ ] [Requirement 1]
- [ ] [Requirement 2]
- [ ] [Requirement 3]

**Constraints:**
- [Performance requirements]
- [Browser compatibility]
- [Database considerations]

**Out of Scope:**
- [What we're NOT doing]
```

#### Step 1.2: Design the Solution

**Architecture Decisions:**

1. **Frontend-Only Feature?**
   - UI components
   - Visualization enhancements
   - Client-side filtering

2. **Backend-Only Feature?**
   - New API endpoints
   - Database schema changes
   - Query optimizations

3. **Full-Stack Feature?**
   - New data models
   - API + UI integration
   - End-to-end functionality

**Design Checklist:**
- [ ] Data model defined (if needed)
- [ ] API contract specified (if backend)
- [ ] Component hierarchy planned (if frontend)
- [ ] State management approach decided
- [ ] Error handling strategy
- [ ] Performance considerations
- [ ] Security implications reviewed

**Document Design:**
```markdown
## Feature Design: [Feature Name]

**Architecture:**
[Frontend/Backend/Full-Stack]

**Components Affected:**
- Frontend: [List components]
- Backend: [List services/routers]
- Database: [Schema changes]

**Data Flow:**
[Diagram or description of how data flows]

**API Design (if applicable):**
- Endpoint: `POST /api/...`
- Request: `{...}`
- Response: `{...}`

**UI Design (if applicable):**
[Mockups, wireframes, or description]

**Alternatives Considered:**
1. [Alternative 1] - Rejected because [reason]
2. [Alternative 2] - Rejected because [reason]

**Selected Approach:**
[Explanation of chosen approach]
```

#### Step 1.3: Review Technical Debts

Check [technical-debts.md](../../../docs/dev/technical-debts.md) for:
- Existing issues that could be addressed
- Patterns to avoid
- Opportunities for improvement

**Example:**
If adding filtering, consider:
- Technical Debt #1: Large graph store file
- Could this be part of a filter refactoring?

### Phase 2: Implementation

#### Step 2.1: Set Up Branch

```bash
# Create feature branch
git checkout -b feature/feature-name

# Or fix branch for bug fixes
git checkout -b fix/issue-name
```

#### Step 2.2: Backend Implementation

**Follow Backend Patterns** (see [code-patterns.md](../../../docs/dev/code-patterns.md))

**A. Create Pydantic Models (if needed)**

Location: `api/graphlagoon/models/schemas.py`

```python
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

class FeatureDataBase(BaseModel):
    """Base model for feature data."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None

class FeatureDataCreate(FeatureDataBase):
    """Model for creating feature data."""
    config: dict[str, Any]

class FeatureDataResponse(FeatureDataBase):
    """Model for feature data responses."""
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    owner_email: str
    created_at: datetime
    updated_at: datetime
```

**B. Create Database Models (if needed)**

Location: `api/graphlagoon/db/models.py`

```python
from sqlalchemy import String, DateTime, JSON, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime
import uuid

class FeatureData(Base):
    __tablename__ = "feature_data"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(String(1000), nullable=True)
    config: Mapped[dict] = mapped_column(JSON, nullable=False)
    owner_email: Mapped[str] = mapped_column(String(255), ForeignKey("users.email"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
```

**C. Create Migration (if database schema changed)**

```bash
cd graphlagoon-rest-api
alembic revision --autogenerate -m "Add feature_data table"
alembic upgrade head
```

**D. Implement Service Logic**

Location: `api/graphlagoon/services/feature_service.py` (new file)

```python
from typing import List
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from graphlagoon.db.models import FeatureData
from graphlagoon.models.schemas import FeatureDataCreate, FeatureDataResponse

async def create_feature_data(
    db: AsyncSession,
    data: FeatureDataCreate,
    owner_email: str
) -> FeatureData:
    """Create new feature data."""
    feature = FeatureData(
        name=data.name,
        description=data.description,
        config=data.config,
        owner_email=owner_email
    )

    db.add(feature)
    await db.commit()
    await db.refresh(feature)

    return feature

async def get_feature_data_by_id(
    db: AsyncSession,
    feature_id: uuid.UUID,
    user_email: str
) -> FeatureData | None:
    """Get feature data by ID."""
    result = await db.execute(
        select(FeatureData)
        .where(FeatureData.id == feature_id)
        .where(FeatureData.owner_email == user_email)
    )
    return result.scalar_one_or_none()
```

**E. Create Router**

Location: `api/graphlagoon/routers/feature.py` (new file)

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from graphlagoon.db.database import get_db
from graphlagoon.middleware.auth import get_current_user
from graphlagoon.services import feature_service
from graphlagoon.models.schemas import FeatureDataCreate, FeatureDataResponse
import uuid

router = APIRouter(prefix="/api/feature-data", tags=["feature"])

@router.post("/", response_model=FeatureDataResponse, status_code=201)
async def create_feature_data(
    data: FeatureDataCreate,
    user_email: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create new feature data."""
    feature = await feature_service.create_feature_data(db, data, user_email)
    return feature

@router.get("/{feature_id}", response_model=FeatureDataResponse)
async def get_feature_data(
    feature_id: uuid.UUID,
    user_email: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get feature data by ID."""
    feature = await feature_service.get_feature_data_by_id(db, feature_id, user_email)

    if not feature:
        raise HTTPException(status_code=404, detail="Feature data not found")

    return feature
```

**F. Register Router in App**

Location: `api/graphlagoon/app.py`

```python
from graphlagoon.routers import feature

def create_api_router() -> APIRouter:
    api_router = APIRouter()

    api_router.include_router(graph_contexts.router)
    api_router.include_router(explorations.router)
    api_router.include_router(feature.router)  # Add new router
    # ...

    return api_router
```

#### Step 2.3: Frontend Implementation

**Follow Frontend Patterns** (see [code-patterns.md](../../../docs/dev/code-patterns.md))

**A. Define TypeScript Types**

Location: `frontend/src/types/feature.ts` (new file)

```typescript
export interface FeatureData {
  id: string
  name: string
  description?: string
  config: Record<string, any>
  owner_email: string
  created_at: string
  updated_at: string
}

export interface FeatureDataCreate {
  name: string
  description?: string
  config: Record<string, any>
}
```

**B. Add API Service Methods**

Location: `frontend/src/services/api.ts`

```typescript
import type { FeatureData, FeatureDataCreate } from '@/types/feature'

export const createFeatureData = async (
  data: FeatureDataCreate
): Promise<FeatureData> => {
  const response = await axios.post('/api/feature-data', data)
  return response.data
}

export const getFeatureData = async (
  featureId: string
): Promise<FeatureData> => {
  const response = await axios.get(`/api/feature-data/${featureId}`)
  return response.data
}
```

**C. Create Pinia Store (if complex state)**

Location: `frontend/src/stores/feature.ts` (new file)

```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { FeatureData, FeatureDataCreate } from '@/types/feature'
import * as api from '@/services/api'

export const useFeatureStore = defineStore('feature', () => {
  // State
  const features = ref<FeatureData[]>([])
  const currentFeature = ref<FeatureData | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Getters
  const featureCount = computed(() => features.value.length)

  // Actions
  const createFeature = async (data: FeatureDataCreate) => {
    try {
      loading.value = true
      error.value = null

      const feature = await api.createFeatureData(data)
      features.value.push(feature)
      currentFeature.value = feature

      return feature
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create feature'
      error.value = message
      throw err
    } finally {
      loading.value = false
    }
  }

  const loadFeature = async (featureId: string) => {
    try {
      loading.value = true
      error.value = null

      const feature = await api.getFeatureData(featureId)
      currentFeature.value = feature

      return feature
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load feature'
      error.value = message
      throw err
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    features,
    currentFeature,
    loading,
    error,

    // Getters
    featureCount,

    // Actions
    createFeature,
    loadFeature
  }
})
```

**D. Create Component**

Location: `frontend/src/components/FeaturePanel.vue` (new file)

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { useFeatureStore } from '@/stores/feature'
import type { FeatureDataCreate } from '@/types/feature'

const featureStore = useFeatureStore()

const name = ref('')
const description = ref('')

const isValid = computed(() => name.value.trim().length > 0)

const handleCreate = async () => {
  if (!isValid.value) return

  const data: FeatureDataCreate = {
    name: name.value,
    description: description.value || undefined,
    config: {}
  }

  try {
    await featureStore.createFeature(data)

    // Reset form
    name.value = ''
    description.value = ''

    // Show success message
    alert('Feature created successfully!')
  } catch (error) {
    console.error('Error creating feature:', error)
    alert('Failed to create feature')
  }
}
</script>

<template>
  <div class="feature-panel">
    <h2>Create Feature</h2>

    <form @submit.prevent="handleCreate">
      <div class="form-group">
        <label for="name">Name:</label>
        <input
          id="name"
          v-model="name"
          type="text"
          required
          :disabled="featureStore.loading"
        />
      </div>

      <div class="form-group">
        <label for="description">Description:</label>
        <textarea
          id="description"
          v-model="description"
          :disabled="featureStore.loading"
        />
      </div>

      <button type="submit" :disabled="!isValid || featureStore.loading">
        {{ featureStore.loading ? 'Creating...' : 'Create' }}
      </button>
    </form>

    <div v-if="featureStore.error" class="error">
      {{ featureStore.error }}
    </div>
  </div>
</template>

<style scoped>
.feature-panel {
  padding: 20px;
}

.form-group {
  margin-bottom: 15px;
}

.form-group label {
  display: block;
  margin-bottom: 5px;
  font-weight: bold;
}

.form-group input,
.form-group textarea {
  width: 100%;
  padding: 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
}

button {
  padding: 10px 20px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

button:disabled {
  background-color: #ccc;
  cursor: not-allowed;
}

.error {
  margin-top: 15px;
  padding: 10px;
  background-color: #f8d7da;
  color: #721c24;
  border-radius: 4px;
}
</style>
```

**E. Add to View/Parent Component**

```vue
<script setup lang="ts">
import FeaturePanel from '@/components/FeaturePanel.vue'
</script>

<template>
  <div>
    <!-- Existing components -->
    <FeaturePanel />
  </div>
</template>
```

#### Step 2.4: Add Error Handling

**Backend Error Handling:**
```python
from graphlagoon.services.graph_operations import QueryExecutionError

@router.post("/...")
async def endpoint(...):
    try:
        result = await service_method(...)
        return result
    except QueryExecutionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "QUERY_FAILED",
                "message": str(e),
                "query": e.query
            }
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")
```

**Frontend Error Handling:**
```typescript
try {
  const result = await api.someMethod()
  // Handle success
} catch (error) {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'object' && detail.code) {
      // Structured error
      handleStructuredError(detail)
    } else {
      // Simple error message
      showError(detail || error.message)
    }
  } else {
    showError('An unexpected error occurred')
  }
}
```

#### Git Submodules — 3D Force Graph Extensions

The 3D graph rendering depends on forked libraries in `frontend/ext-3d-force/`, managed as **git submodules**:

| Submodule | Path | Purpose |
|-----------|------|---------|
| `3d-force-graph` | `frontend/ext-3d-force/3d-force-graph` | Main 3D force graph component |
| `three-forcegraph` | `frontend/ext-3d-force/three-forcegraph` | Three.js force graph kapsule (perf instrumented) |
| `d3-force-3d` | `frontend/ext-3d-force/d3-force-3d` | D3 force simulation in 3D |

**After cloning the repo:**
```bash
git submodule update --init --recursive
```

**When modifying submodule code:**
1. `cd` into the submodule directory (it's a separate git repo)
2. Create a branch, make changes, commit and push to the submodule's remote
3. Back in the main repo, `git add frontend/ext-3d-force/<submodule>` to update the pinned commit
4. Commit the updated reference in the main repo

**Important:** Files inside submodule paths are NOT part of the main repo's git history. They are tracked as gitlink references (commit SHAs). Never `git add` individual files inside a submodule from the main repo.

**CI note:** Workflows that need submodule code must use `actions/checkout@v4` with:
```yaml
- uses: actions/checkout@v4
  with:
    submodules: recursive
```

#### Canvas3D Architecture — Extending 3D Graph Features

The 3D canvas (`GraphCanvas3D.vue`) is modular. When adding 3D visualization features, follow this architecture:

**Module structure:**
```
components/GraphCanvas3D.vue     — orchestrator (~850 lines)
composables/useGraphCamera.ts    — camera: ortho, zoom, tracking
composables/useGraphLayout.ts    — layout: start/stop/reheat/scramble
composables/useGraphLabels.ts    — labels: FastLabelRenderer lifecycle
utils/graphAppearance.ts         — pure: node/link color, size, hidden
utils/forceConfig3D.ts           — pure: D3-force-3d configuration
types/graph3d.ts                 — shared types: GraphNode, GraphLink, GraphData
```

**Where to add new features:**
- **New visual property** (e.g., node shape by type): Add to `AppearanceContext` + `computeNodeAppearance()` in `graphAppearance.ts`, write tests in `graphAppearance.test.ts`
- **New force behavior**: Add to `Force3DSettings` + `applyForceConfig()` in `forceConfig3D.ts`, write tests in `forceConfig3D.test.ts`
- **New camera mode**: Add function to `useGraphCamera.ts`, wire in component
- **New label style**: Modify `useGraphLabels.ts` (label rendering) or `FastLabelRenderer.ts` (GPU rendering)
- **New interaction** (e.g., right-click menu): Add to `initGraph()` in the component (ForceGraph3D callbacks)

**Key pattern — AppearanceContext snapshot:**
```typescript
// Component collects ALL store state once per update pass
const ctx = collectAppearanceContext();
// Pure functions use the snapshot — no store coupling
const result = computeNodeAppearance(nodeId, nodeType, isCluster, baseSize, color, ctx);
```

**Composable wiring pattern:**
```typescript
// Component owns shared refs
const isLayoutRunning = ref(true);
const initialLayoutDone = ref(false);
// Composables receive refs + callbacks at setup time
const labels = useGraphLabels(getGraph3d, initialLayoutDone, ...);
const layout = useGraphLayout(getGraph3d, { isLayoutRunning, ... }, { setLabelsVisible: labels.setLabelsVisible, ... });
const camera = useGraphCamera(getGraph3d, containerRef, initialLayoutDone, { setLabelsVisible: labels.setLabelsVisible, updateVisuals });
```

#### Step 2.4b: Permission Gating (Groups & Permissions)

**Ask for every new user-facing ACTION (not read/view):** should an admin be
able to restrict or deny it per group? If yes, wire it into the permission
system (docs: [docs/guide/permissions.md](../../../docs/guide/permissions.md),
[docs/dev/admin-area.md](../../../docs/dev/admin-area.md)). The whole recipe
is ~15 lines; everything else (admin matrix row, inspector, rules storage,
`/api/config` payload) renders the new entry automatically:

1. **Catalog entry** — `api/graphlagoon/services/permission_catalog.py`:
   ```python
   Permission(id="<resource>.<verb>", label="...", description="..."),
   ```
   Id shape: exactly one dot, AuditAction style. Default posture is
   `everyone`, so shipping the entry changes nothing until an admin writes
   a rule.
2. **Gate the route** — on the handler that IS the action:
   ```python
   user_email: str = Depends(require_permission("<resource>.<verb>")),
   ```
   (replaces the handler's `get_current_user(request)` line; existing
   ownership/share checks stay as separate AND-gates).
3. **Hide the affordance** — `v-if="can('<resource>.<verb>')"` via
   `usePermissions()` (HIDE model, not disable; keep read paths visible;
   empty states must still say what to do — "ask an administrator").
4. **Tests** — one allow/deny route case in
   `api/tests/test_permission_routes.py`; a hidden-affordance case in the
   feature's spec.

**Never** add a catalog entry without its `Depends` gate (a matrix row that
does nothing is security theater), and never a gate with an uncataloged id —
`test_admin_registry::test_permission_gates_reference_catalog` fails the
build on the latter.

Per-resource access ("this user on this context") is NOT this system — that
is ownership + shares. Scoped/conditional rules (per catalog, time-based)
are deliberately unsupported; raise a design discussion before attempting.

#### Step 2.5: Consider Performance

**Backend Performance:**
- [ ] Add database indexes if querying new columns
- [ ] Use async/await throughout
- [ ] Consider caching for frequently accessed data
- [ ] Paginate large result sets
- [ ] Add query timeouts

**Frontend Performance:**
- [ ] Use computed properties for derived state
- [ ] Implement virtual scrolling for large lists
- [ ] Debounce expensive operations
- [ ] Use Web Workers for heavy computation
- [ ] Lazy load components

**Example: Add Database Index**
```python
# In migration file
def upgrade():
    op.create_index(
        'idx_feature_data_owner',
        'feature_data',
        ['owner_email']
    )
```

### Phase 3: Testing

**MANDATORY:** Toda nova feature DEVE incluir testes. A suite existente deve continuar verde.

#### Infraestrutura de Testes Existente

**Unit Tests (Vitest) — lógica isolada:**
- Config: `frontend/vitest.config.ts` (happy-dom, @vitest/coverage-v8)
- Setup: `frontend/src/__tests__/setup.ts` (localStorage mock)
- Fixtures: `frontend/src/__tests__/fixtures/` (factory functions: createMockNode, createMockEdge, etc.)
- Convenção: `src/<area>/__tests__/<name>.test.ts`
- **Para que serve:** Testa stores, services, composables, utils e componentes de forma isolada

**E2E Tests (Playwright) — fluxos de usuário:**
- Config: `frontend/e2e/playwright.config.ts` (Chromium, auto-starts dev server)
- Fixtures: `frontend/e2e/fixtures/test-fixtures.ts` (authenticatedPage, unauthenticatedPage)
- Mock data: `frontend/e2e/fixtures/mock-data.ts`
- API mocks: `frontend/e2e/helpers/api-mocks.ts` (route interception, sem backend)
- Convenção: `e2e/tests/<feature>.spec.ts`
- **Para que serve:** Testa fluxos completos (login, CRUD, navegação, painéis) com browser real

#### Step 3.1: Write Unit Tests (Vitest)

**Where to place tests:**

| Feature area | Test location | Existing examples |
|-------------|---------------|-------------------|
| New Pinia store | `src/stores/__tests__/<store>.test.ts` | `graph.actions.test.ts`, `contexts.test.ts`, `auth.test.ts` |
| New service/util | `src/services/__tests__/<service>.test.ts` | `api.test.ts`, `algorithmRegistry.test.ts` |
| New component | `src/components/__tests__/<Component>.test.ts` | `FilterPanel.test.ts`, `BehaviorPanel.test.ts` |
| New view | `src/views/__tests__/<View>.test.ts` | `LoginView.test.ts`, `ContextsView.logic.test.ts` |
| New composable | `src/composables/__tests__/<composable>.test.ts` | `useToast.test.ts`, `usePersistence.test.ts` |
| New util | `src/utils/__tests__/<util>.test.ts` | `labelFormatter.test.ts`, `graphAppearance.test.ts`, `forceConfig3D.test.ts` |
| 3D graph composable | `src/composables/__tests__/<composable>.test.ts` | See Canvas3D Architecture below |

**Key testing patterns (MUST FOLLOW):**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

describe('MyFeature', () => {
  beforeEach(() => {
    // ALWAYS use real Pinia (NOT createTestingPinia) for real computed properties
    setActivePinia(createPinia())
  })

  it('does what it should', () => {
    // Use factory functions from src/__tests__/fixtures/ for mock data
    // Use vi.useFakeTimers() when testing timestamp-dependent behavior
    // No toEndWith in Vitest — use expect(str.endsWith('x')).toBe(true)
    // Vue ref proxy: toBe fails for objects — check properties individually
  })
})
```

**Component test patterns:**

```typescript
import { render, screen } from '@testing-library/vue'
import { createPinia, setActivePinia } from 'pinia'
import MyComponent from '@/components/MyComponent.vue'

// For components with <Teleport to="body">:
// Query via document.body.querySelector(), NOT container
// Clean up in afterEach

// For multiple text matches (same text in <h4> and <button>):
// Use container.querySelector() instead of getByText
```

#### Step 3.2: Write E2E Tests (Playwright)

Add E2E tests when the feature includes new **user-facing workflows** (pages, modals, navigation).

**E2E test patterns:**

```typescript
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { setupAPIMocks, seedContexts } from '../helpers/api-mocks';

test.describe('My Feature', () => {
  test('user can do the thing', async ({ authenticatedPage: page }) => {
    // Seed data via API mocks (later routes take precedence over setupAPIMocks defaults)
    await seedContexts(page, [MOCK_CONTEXT]);

    await page.goto('/my-route');
    // Use getByTestId, getByRole, getByTitle — prefer semantic selectors
    // Use { exact: true } for getByTitle when ambiguous
    // Use getByRole('heading', { name: 'X' }) to avoid matching <option> text
  });
});
```

**If adding new UI elements for E2E:**
- Add `data-testid` attributes to key elements (ver existentes em LoginView, Toolbar, ContextsView, ExplorationsView, GraphVisualizationView)
- Add mock API routes to `e2e/helpers/api-mocks.ts` if new endpoints are needed
- Add mock data to `e2e/fixtures/mock-data.ts` if new entities are needed

#### Step 3.3: Rodar a Suite de Testes

```bash
cd graphlagoon-frontend

# 1. Testes unitários (OBRIGATÓRIO antes de todo commit)
npm run test:run

# 2. Testes E2E (OBRIGATÓRIO para mudanças de UI/workflow)
npm run e2e

# 3. Verificar que cobertura não caiu
npm run test:coverage

# 4. Ou rodar ambos de uma vez
make test-all

# Nota: pre-commit hook roda `vitest related` automaticamente nos arquivos staged
```

**Quando rodar qual:**

| O que você mudou | Rodar |
|-----------------|-------|
| Lógica de store | `npm run test:run` |
| Componente UI | `npm run test:run` + `npm run e2e` |
| Nova página/rota | `npm run test:run` + `npm run e2e` |
| Service/util | `npm run test:run` |
| Integração com API | `npm run test:run` + `npm run e2e` |
| Qualquer coisa antes de PR | `make test-all` |

#### Step 3.4: Refletir sobre User-Journey Test

**ANTES de considerar a tarefa concluída**, reflita se a feature envolve um **fluxo cross-page** (o usuário navega entre 2+ páginas para completar uma ação). Se sim, considere adicionar ou atualizar um teste em `e2e/tests/user-journeys.spec.ts`.

**Pergunte-se:**
- A feature cria um fluxo que começa em uma página e termina em outra? (ex: criar contexto → abrir grafo)
- A feature altera um fluxo existente que já tem user-journey test?
- Um PM conseguiria validar essa feature apenas pelos testes de spec individual, ou precisa ver o fluxo completo?

**Se a resposta for sim para qualquer uma**, adicione/atualize um teste em `user-journeys.spec.ts`. Esse arquivo testa workflows completos que um PM/revisor quer validar: "o usuário consegue fazer X do início ao fim?"

**Se a feature é contida em uma única página** (ex: novo filtro no painel, novo campo no formulário), os testes no spec da feature (`contexts.spec.ts`, `graph.spec.ts`, etc.) são suficientes.

#### Step 3.5: Manual Testing

After automated tests pass:
- [ ] Happy path works in browser
- [ ] Error cases handled gracefully
- [ ] UI is responsive

### Phase 4: Documentation and Finalization

#### Step 4.1: Update Documentation

**Update Architecture Docs (if needed):**
- Update [architecture.md](../../../docs/dev/architecture.md) if adding new major component
- Update diagrams if data flow changed

**Update Code Patterns (if introducing new pattern):**
- Add pattern to [code-patterns.md](../../../docs/dev/code-patterns.md)
- Document conventions for similar features

**Update API Documentation:**
```python
# Add comprehensive docstrings
@router.post("/", response_model=FeatureDataResponse)
async def create_feature_data(
    data: FeatureDataCreate,
    user_email: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create new feature data.

    Creates a new feature data record owned by the authenticated user.

    Args:
        data: Feature data to create
        user_email: Authenticated user email (from header)
        db: Database session

    Returns:
        Created feature data with generated ID and timestamps

    Raises:
        HTTPException: 400 if validation fails
        HTTPException: 500 if server error

    Example:
        ```
        POST /api/feature-data
        {
          "name": "My Feature",
          "description": "Feature description",
          "config": {"key": "value"}
        }
        ```
    """
```

#### Step 4.2: Public Documentation (MANDATORY)

The public docs site (VitePress, `docs/` → GitHub Pages) is part of every
user-visible feature. **Do not open the PR until either the guide pages are
updated or the decision-log entry explicitly states "No public docs impact".**
Silence is not an option — force the negative statement.

**1. Does the change touch anything a user can see or configure?**
- New or changed UI (panel, modal, button, badge, banner)
- New env var, config key, or default
- New URL parameter (`?style=`, `?layout=`, `?template=`, …)
- New endpoint or Python API that end users / embedding apps call

If NONE apply → write "No public docs impact" in the decision-log entry and
skip to Step 4.3. Otherwise:

**2. Update or create the relevant guide page** in `docs/guide/<slug>.md`.
Follow the house style (reference: [docs/guide/labels.md](../../../docs/guide/labels.md)):
- **Start with a `::: tip TL;DR` block**: one sentence on what the feature
  is, then "**Use it when** …" and "**Not the tool for** …" bullets. The
  not-for bullet must be honest (real limits, and a link to the feature
  that IS the right tool).
- Then open with the problem it solves, explain *why* rules exist, use
  short tables for permissions/fields, real code/URL examples, and a
  "what happens when something is wrong" section.

Existing pages by feature:

| Guide page | Covers |
|---|---|
| `getting-started.md` | install, quick start, first context/graph walkthrough |
| `exploring-the-graph.md` | filters, query console, data table, selection/camera, expand, export, status bar |
| `explorations.md` | save/load/share explorations, `?exploration=`, permissions |
| `labels.md` | label template language, rules, Ask-AI |
| `clusters.md` | cluster programs (JS), scopes, right-click runs |
| `communities-metrics.md` | Louvain/communities, metrics panel, visual mapping |
| `style-presets.md` | `?style=` presets |
| `layout-url-overrides.md` | `?layout=` grammar |
| `query-templates.md` | saved queries, `?template=` |
| `context-menu-actions.md` | right-click actions config |
| `similarity.md` | similarity endpoints, Clusters → Similarity tab |
| `rest-connections.md` | REST datasources |
| `precomputed-graphs.md` | precomputed providers, `?precomputed=` |
| `integration.md` | Databricks / FastAPI embedding, auth |
| `databricks-apps.md` | deploy as a Databricks App |
| `configuration.md` | env var reference |
| `python-api.md` | public Python API reference (embedding) |

**3. New page?** Register it in the sidebar: `docs/.vitepress/config.ts`
(the `sidebar` items array).

**4. UI appearance changed?** Add or update a scene in the `SCENES` registry
of `frontend/e2e/screenshots/generate.ts` (naming: `<guide-slug>-<scene>.png`),
then run `make docs-screenshots` and commit the regenerated PNGs. The
generator runs against API mocks — no backend, no manual screenshots.

**5. Verify:** `make docs-build` MUST pass (it runs VitePress's dead-link
check over sidebar entries, cross-links, and image references).

#### Step 4.2b: Admin-Area Impact (MANDATORY)

The superuser admin area (`/admin`, `api/graphlagoon/routers/admin.py`) shows
the environment and audits destructive actions. Most of its coverage is
**enforced by `api/tests/test_admin_registry.py`** — a red test there is the
admin area telling you it needs an update. Full table:
[docs/dev/admin-area.md](../../../docs/dev/admin-area.md). Ask:

| Did you… | Then… |
|---|---|
| add a `Settings` field / env var | classify it in `routers/admin_registry.CONFIG_FIELD_KINDS` (`public` / `secret` / `hidden`) |
| add a table or in-memory collection | `CLEARABLE_TABLES` or `PRESERVED_TABLES`, `InMemoryStore.clear_all`, a count in `AdminCounts` if user-owned, and extend `graphlagoon.dev.seed` |
| add a `POST`/`PUT`/`DELETE` route | `AUDITED_ROUTES` + `services.audit.record(...)` + `AuditAction`, or `AUDIT_EXEMPT_ROUTES` with a reason |
| add a router module | `tests/test_admin_registry.ROUTER_MODULES` |
| add a new audit action | `describeAudit` in `frontend/src/utils/adminView.ts` |
| add a new user-owned entity | a tab or column in `AdminView.vue` so a superuser can see who owns it |
| add a user-facing action that admins may want to restrict | a permission catalog entry + `require_permission` gate + hidden affordance (see Step 2.4b) |

The decision-log entry MUST state either what was updated or the sentence
**"No admin-area impact"**. Silence is not an option.

#### Step 4.3: Document in Decision Log

```markdown
## [YYYY-MM-DD HH:MM] - Feature Implemented: [Feature Name]

**Feature:** [Brief description]

**Requirements:**
[Original requirements from planning phase]

**Design Decisions:**
1. **[Decision 1]:** [Rationale]
2. **[Decision 2]:** [Rationale]

**Implementation:**

**Backend Changes:**
- Created models: `FeatureData`, `FeatureDataCreate`, `FeatureDataResponse`
- Created service: `feature_service.py`
- Created router: `routers/feature.py`
- Database migration: `alembic/versions/xxx_add_feature_data.py`
- API endpoints:
  - `POST /api/feature-data` - Create feature
  - `GET /api/feature-data/{id}` - Get feature

**Frontend Changes:**
- Created types: `types/feature.ts`
- Created store: `stores/feature.ts`
- Created component: `components/FeaturePanel.vue`
- Updated API service: `services/api.ts`

**Files Created:**
- [api/graphlagoon/services/feature_service.py](api/graphlagoon/services/feature_service.py)
- [api/graphlagoon/routers/feature.py](api/graphlagoon/routers/feature.py)
- [frontend/src/types/feature.ts](frontend/src/types/feature.ts)
- [frontend/src/stores/feature.ts](frontend/src/stores/feature.ts)
- [frontend/src/components/FeaturePanel.vue](frontend/src/components/FeaturePanel.vue)

**Files Modified:**
- [api/graphlagoon/db/models.py](api/graphlagoon/db/models.py)
- [api/graphlagoon/models/schemas.py](api/graphlagoon/models/schemas.py)
- [api/graphlagoon/app.py](api/graphlagoon/app.py)
- [frontend/src/services/api.ts](frontend/src/services/api.ts)

**Testing:**
- [x] Backend unit tests added
- [x] Frontend component tests added
- [x] Manual testing performed
- [x] Integration tests pass
- [x] Tested with database enabled and disabled

**Public Docs:**
- [x] Public guide updated (list pages) / "No public docs impact" stated
- [x] `make docs-build` passes
- [x] Screenshots regenerated (`make docs-screenshots`) if UI changed

**Admin-Area Impact:**
- [x] Registries updated (`CONFIG_FIELD_KINDS` / tables / audited routes) or "No admin-area impact" stated

**Performance Considerations:**
- Database index added on `owner_email`
- Queries use async/await
- Frontend uses computed properties for reactivity

**Security Considerations:**
- Authentication required (user_email from headers)
- Authorization: users can only access their own data
- Input validation via Pydantic

**Known Limitations:**
- [Any known issues or limitations]

**Future Enhancements:**
- [Ideas for future improvements]

**Related:**
- Addresses feature request #[issue number]
- Related to technical debt #[debt number] in [technical-debts.md](../../../docs/dev/technical-debts.md)
```

#### Step 4.4: Create Pull Request

```bash
# Commit changes
git add .
git commit -m "feat: Add [feature name]

- Implemented backend API endpoints
- Created frontend components
- Added database models
- Added tests
- Updated documentation

Closes #[issue-number]
"

# Push to remote
git push origin feature/feature-name

# Create PR on GitHub/GitLab
```

**PR Description Template:**
```markdown
## Feature: [Feature Name]

### Description
[Brief description of the feature]

### Changes
- Backend:
  - Added API endpoints for ...
  - Created database models for ...
  - Implemented service layer for ...

- Frontend:
  - Created components for ...
  - Added Pinia store for ...
  - Updated UI to display ...

### Testing
- [x] Unit tests added and passing
- [x] Manual testing performed
- [x] Integration tests pass
- [x] No regressions found

### Documentation
- [x] API documentation updated
- [x] Code comments added
- [x] Decision log updated
- [x] Public guide (`docs/guide/`) updated or "No public docs impact" stated
- [x] `make docs-build` passes
- [x] Admin-area impact stated (registries updated or "No admin-area impact")

### Screenshots
[Run `make docs-screenshots` and commit the regenerated PNGs if UI changed]

### Related Issues
Closes #[issue-number]

### Migration Notes
[If database migration required]
```bash
alembic upgrade head
```
```

## Best Practices

### Code Quality

1. **Follow Existing Patterns:**
   - Study similar features in codebase
   - Use same patterns and conventions
   - Reference [code-patterns.md](../../../docs/dev/code-patterns.md)

2. **Type Safety:**
   - TypeScript types for frontend
   - Type hints for backend
   - Pydantic models for validation

3. **Error Handling:**
   - Handle all error cases
   - Provide user-friendly messages
   - Log errors for debugging

4. **Performance:**
   - Consider scalability
   - Profile if performance-critical
   - Optimize database queries

5. **Security:**
   - Validate all inputs
   - Sanitize outputs
   - Check authentication/authorization
   - Prevent SQL injection

### Testing Strategy — MANTER A SUITE VERDE

1. **Unit Tests (Vitest) — lógica isolada:**
   - `npm run test:run` — roda todos uma vez
   - `npm run test:coverage` — com relatório de cobertura
   - Cobre: stores, services, components, views, composables, utils
   - Usar Pinia real (`setActivePinia(createPinia())`), NÃO `createTestingPinia`
   - Usar factory fixtures de `src/__tests__/fixtures/`

2. **E2E Tests (Playwright) — fluxos de usuário:**
   - `npm run e2e` — roda todos (auto-starts dev server)
   - `npm run e2e:headed` — com browser visível
   - Cobre: auth, navegação, contextos, grafo, explorations, dev-generator
   - API mockada via `page.route()` — sem backend
   - Adicionar `data-testid` para novos elementos de UI

3. **Cobertura:**
   - Features novas não devem diminuir a cobertura
   - Rodar `npm run test:coverage` para verificar

4. **Pre-commit Hook:**
   - `.husky/pre-commit` roda `vitest related` nos arquivos staged automaticamente
   - Captura regressões antes do código chegar ao repo

### Documentation

1. **Code Documentation:**
   - Docstrings for functions
   - Comments for complex logic
   - Type annotations

2. **API Documentation:**
   - OpenAPI/Swagger docs
   - Example requests/responses
   - Error codes

3. **User Documentation:**
   - Feature description
   - Usage instructions
   - Screenshots/videos

## Common Pitfalls

1. **Not Following Existing Patterns:**
   - Always review similar features first
   - Don't reinvent the wheel

2. **Forgetting Decision Log:**
   - Document all design decisions
   - Update log throughout development

3. **Insufficient Testing:**
   - Test edge cases
   - Test error scenarios

4. **Breaking Changes:**
   - Consider backward compatibility
   - Use API versioning if needed
   - Migrate existing data

5. **Performance Regressions:**
   - Profile before and after
   - Test with large datasets
   - Monitor database queries

## Reference Materials

- [architecture.md](../../../docs/dev/architecture.md) - System architecture
- [code-patterns.md](../../../docs/dev/code-patterns.md) - Coding patterns and conventions
- [technical-debts.md](../../../docs/dev/technical-debts.md) - Known issues to avoid
- [potential-bugs.md](../../../docs/dev/potential-bugs.md) - Known bugs and edge cases

## Getting Help

1. Review existing similar features
2. Check documentation files
3. Search codebase for patterns
4. Ask team for design review
5. Document questions and answers in decision log

## Remember

- **Plan before coding** - Design the solution first
- **Follow patterns** - Use existing conventions
- **Test thoroughly** - Cover all scenarios
- **Document everything** - In decision_log.md and code
- **Consider impact** - Performance, security, compatibility
- **Get feedback** - Code review before merging
