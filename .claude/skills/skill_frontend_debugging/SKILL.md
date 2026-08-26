---
name: skill_frontend_debugging

description: This skill guides you through debugging frontend issues in the graphlagoon-studio Vue 3 application. Use this when encountering bugs, unexpected behavior, or issues in the frontend visualization components.
---

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
frontend/
├── src/
│   ├── components/      # Vue components (Canvas, Panels)
│   ├── stores/          # Pinia stores (graph, metrics, contexts)
│   ├── services/        # API client
│   ├── views/           # Page components
│   ├── utils/           # Helper functions
│   ├── workers/         # Web Workers
│   └── types/           # TypeScript types
```

### Key Files

- **Graph Store:** [frontend/src/stores/graph.ts](frontend/src/stores/graph.ts) (1127 lines)
- **3D Canvas:** [frontend/src/components/GraphCanvas3D.vue](frontend/src/components/GraphCanvas3D.vue) (~850 lines, orchestrator, supports 3D and 2D-proj modes)
- **API Service:** [frontend/src/services/api.ts](frontend/src/services/api.ts)
- **Metrics Store:** [frontend/src/stores/metrics.ts](frontend/src/stores/metrics.ts)

#### Canvas3D Module Map

The 3D graph canvas is decomposed into composables and pure utility modules:

| Module | File | Responsibility |
|--------|------|---------------|
| **Component** | `components/GraphCanvas3D.vue` | Orchestrates graph lifecycle, watchers, ForceGraph3D init, tooltip, data building |
| **Camera** | `composables/useGraphCamera.ts` | Ortho camera patch, zoom-to-fit, center-on-match, camera movement tracking |
| **Layout** | `composables/useGraphLayout.ts` | Start/stop/reheat/scramble D3-force simulation |
| **Labels** | `composables/useGraphLabels.ts` | FastLabelRenderer lifecycle, label updates, visibility toggle |
| **Appearance** | `utils/graphAppearance.ts` | Pure functions: node/link color, size, hidden (testable without DOM) |
| **Forces** | `utils/forceConfig3D.ts` | Pure function: apply D3-force-3d config (charge, link, center, collide) |
| **Types** | `types/graph3d.ts` | Shared types: GraphNode, GraphLink, GraphData |

**Data flow:** Store state → `collectAppearanceContext()` (snapshot) → `computeNodeAppearance()` / `computeLinkAppearance()` (pure) → graph3d updates

**Composable wiring:** Component owns shared refs (`isLayoutRunning`, `initialLayoutDone`, etc.) and passes them + callback functions to composables at setup time.

## Git Submodules — 3D Force Graph Extensions

The 3D graph rendering depends on forked libraries in `frontend/ext-3d-force/`, managed as **git submodules**:

| Submodule | Path | Purpose |
|-----------|------|---------|
| `3d-force-graph` | `frontend/ext-3d-force/3d-force-graph` | Main 3D force graph component |
| `three-forcegraph` | `frontend/ext-3d-force/three-forcegraph` | Three.js force graph kapsule (perf instrumented) |
| `d3-force-3d` | `frontend/ext-3d-force/d3-force-3d` | D3 force simulation in 3D |

**After cloning:** `git submodule update --init --recursive`

**When debugging issues in submodule code** (e.g., `forcegraph-kapsule.js`):
- The code lives in a separate git repo inside the submodule path
- Changes must be committed inside the submodule first, then the updated reference committed in the main repo
- Check `git status` inside the submodule to see if you're on a detached HEAD (common after `submodule update`)

## Debugging Workflow

### Step 1: Reproduce the Issue

1. **Gather Information:**
   - What is the expected behavior?
   - What is the actual behavior?
   - Steps to reproduce
   - Browser and version
   - Console errors or warnings

2. **Check Recent Changes:**
   ```bash
   git log --oneline --graph --all --since="1 week ago"
   git diff HEAD~1
   ```

3. **Document in Decision Log:**
   ```markdown
   ## [YYYY-MM-DD HH:MM] - Frontend Bug Investigation Started

   **Issue:** [Brief description]
   **Reporter:** [Name/Source]
   **Steps to Reproduce:**
   1. [Step 1]
   2. [Step 2]

   **Environment:**
   - Browser: [Browser and version]
   - Context: [Context details if relevant]
   ```

### Step 2: Identify the Component

**Common Issue Categories:**

| Symptom | Likely Component | Key Files |
|---------|------------------|-----------|
| Graph not rendering | Canvas component | GraphCanvas3D.vue |
| Nodes/edges missing | Graph store, filters | stores/graph.ts |
| Wrong node colors/sizes | Appearance logic | utils/graphAppearance.ts (pure, testable) |
| Wrong data displayed | API service, stores | services/api.ts, stores/graph.ts |
| Performance issues | Layout, rendering | utils/HeliosLayoutEngine.ts, workers/ |
| 3D layout stuck/jittery | Force config or layout | utils/forceConfig3D.ts, composables/useGraphLayout.ts |
| 3D camera issues | Camera composable | composables/useGraphCamera.ts |
| 3D labels missing/wrong | Label composable | composables/useGraphLabels.ts, utils/FastLabelRenderer.ts |
| Filters not working | Graph store filters | stores/graph.ts (filter logic) |
| UI not responsive | Vue components | components/* |
| Metrics incorrect | Metrics store | stores/metrics.ts, workers/metricsWorker.ts |
| Labels wrong | Label formatter | utils/labelFormatter.ts |

### Step 3: Enable Debug Mode

**Browser DevTools:**
```javascript
// In console
localStorage.setItem('debug', 'true')
location.reload()
```

**Vue DevTools:**
1. Install Vue DevTools extension
2. Open DevTools → Vue tab
3. Inspect component tree
4. Check Pinia stores

**Verbose Logging:**
Add logging to suspected code:
```typescript
// In component or store
console.log('[DEBUG] Current state:', {
  nodes: nodes.value.length,
  edges: edges.value.length,
  filters: graphStore.filters
})
```

### Step 4: Common Frontend Issues

#### Issue: Graph Not Rendering

**Checklist:**
1. Check if data is loaded:
   ```typescript
   // In console or add to code
   console.log('Nodes:', graphStore.nodes.length)
   console.log('Edges:', graphStore.edges.length)
   ```

2. Check container element:
   ```typescript
   // Is container mounted?
   console.log('Container:', containerRef.value)
   console.log('Dimensions:', {
     width: containerRef.value?.clientWidth,
     height: containerRef.value?.clientHeight
   })
   ```

3. Check 3D Force Graph initialization:
   ```typescript
   // In GraphCanvas3D.vue
   console.log('Graph instance:', graph3d)
   ```

**Common Causes:**
- Container has zero size (CSS issue)
- Data not loaded (API error)
- Library not initialized (async timing)
- Filters hiding all nodes

**Fix Examples:**
```vue
<!-- Ensure container has size -->
<div ref="containerRef" style="width: 100%; height: 100%; min-height: 500px;">
```

```typescript
// Check data before rendering
if (nodes.value.length === 0) {
  console.warn('No nodes to render')
  return
}
```

#### Issue: Filters Not Working

**Debug Steps:**
1. Check filter state:
   ```typescript
   // In Vue DevTools or console
   graphStore.filters
   graphStore.searchQuery
   graphStore.propertyFilters
   ```

2. Check computed filteredNodes:
   ```typescript
   console.log('Total nodes:', graphStore.nodes.length)
   console.log('Filtered nodes:', graphStore.filteredNodes.length)
   console.log('Hidden by type:', graphStore.hiddenNodeTypes)
   ```

3. Trace filter logic:
   ```typescript
   // In stores/graph.ts - add logging to computed
   const filteredNodes = computed(() => {
     let result = nodes.value.filter(node => {
       // Type filter
       if (hiddenNodeTypes.value.has(node.node_type)) {
         console.log('Node hidden by type:', node.node_id, node.node_type)
         return false
       }
       // ... other filters
       return true
     })
     console.log('Filter result:', result.length, 'of', nodes.value.length)
     return result
   })
   ```

**Common Causes:**
- Filter logic inverted
- Case sensitivity issues
- Property not present on node
- Computed not updating (reactivity issue)

#### Issue: Performance Problems

**Performance Profiling:**
1. Chrome DevTools → Performance tab
2. Record during slow operation
3. Look for:
   - Long tasks (>50ms)
   - Excessive re-renders
   - Memory spikes

**Common Performance Issues:**

| Issue | Location | Fix |
|-------|----------|-----|
| Slow filtering | stores/graph.ts | Memoize expensive computations |
| Layout freezes UI | Force Atlas 2 | Move to Web Worker |
| Render lag | Canvas components | Reduce node count, use virtualization |
| Memory leak | Components | Add onUnmounted cleanup |
| Metrics calculation | stores/metrics.ts | Already in Web Worker, check data size |

**Example: Check for Memory Leaks**
```typescript
// In component
onUnmounted(() => {
  console.log('[CLEANUP] Component unmounted')

  // Cancel animations
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
  }

  // Terminate workers
  if (layoutWorker) {
    layoutWorker.terminate()
  }

  // Cleanup Three.js
  if (scene) {
    scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose()
      if (object.material) {
        if (Array.isArray(object.material)) {
          object.material.forEach(m => m.dispose())
        } else {
          object.material.dispose()
        }
      }
    })
  }
})
```

#### Issue: 3D Canvas — Node Appearance Wrong (Color/Size/Hidden)

The 3D canvas uses **pure functions** for appearance calculation. Debug by testing them directly:

```typescript
// In tests or console — reproduce with a minimal AppearanceContext
import { computeNodeAppearance, type AppearanceContext } from '@/utils/graphAppearance'

const ctx: AppearanceContext = {
  baseNodeSize: 8,
  nodeOpacity: 1,
  edgeOpacity: 0.6,
  nodeTypeFilter: [],
  hasNodeTypeFilter: false,
  // ... fill remaining fields
  getNodeTypeColor: (type) => '#cccccc',
  getEdgeTypeColor: (type) => '#999999',
}

const result = computeNodeAppearance('node1', 'Person', false, 0, null, ctx)
console.log(result) // { color: '...', size: ..., hidden: false }
```

**Node visibility pipeline** (evaluated in order inside `computeNodeAppearance`):
1. Type filter → hidden if type not in `nodeTypeFilter`
2. Search hide → hidden if in `searchHiddenIds`
3. Property filter → hidden if in `propFilterHiddenNodeIds`
4. Focus hide → hidden if `focusedNodeIds` active and node not in set
5. Degree dim → dimmed alpha if in `dimmedByDegreeIds`
6. Lens dim → dimmed alpha if lens active and node not in focus
7. Selection highlight → boosted size if in `selectedNodeIds`

**Key debug points:**
- `collectAppearanceContext()` in GraphCanvas3D.vue — check snapshot values
- `computeNodeAppearance()` / `computeLinkAppearance()` in `utils/graphAppearance.ts` — pure, testable
- Test files: `utils/__tests__/graphAppearance.test.ts` (62 tests), `utils/__tests__/forceConfig3D.test.ts` (9 tests)

#### Issue: 3D Force Layout Not Converging

**Debug steps:**
1. Check force settings: `graphStore.force3DSettings` in Vue DevTools
2. Test `applyForceConfig()` in isolation:
   ```typescript
   import { applyForceConfig } from '@/utils/forceConfig3D'
   // Pass mock graph3d to verify calls
   ```
3. Check layout composable state: `isLayoutRunning`, `layoutStabilized`, `initialLayoutDone`
4. Verify `onEngineStop` callback fires (sets `layoutStabilized = true`)

#### Issue: API Errors

**Debug API Calls:**
```typescript
// In services/api.ts - add interceptor
axios.interceptors.request.use(config => {
  console.log('[API Request]', config.method?.toUpperCase(), config.url, config.data)
  return config
})

axios.interceptors.response.use(
  response => {
    console.log('[API Response]', response.status, response.data)
    return response
  },
  error => {
    console.error('[API Error]', {
      url: error.config?.url,
      status: error.response?.status,
      data: error.response?.data
    })
    return Promise.reject(error)
  }
)
```

#### Issue: State Not Updating (Reactivity)

**Common Reactivity Issues:**

1. **Mutating array/object directly:**
   ```typescript
   // ❌ Wrong - not reactive
   nodes.value[0].x = 10

   // ✅ Correct - create new object
   nodes.value[0] = { ...nodes.value[0], x: 10 }

   // Or use Vue's reactive methods
   nodes.value = nodes.value.map(n =>
     n.id === targetId ? { ...n, x: 10 } : n
   )
   ```

2. **Not using `.value` with refs:**
   ```typescript
   // ❌ Wrong
   nodes = newNodes

   // ✅ Correct
   nodes.value = newNodes
   ```

3. **Accessing nested properties:**
   ```typescript
   // ❌ May lose reactivity
   const node = nodes.value.find(n => n.id === id)
   node.x = 10  // Not reactive

   // ✅ Better
   const index = nodes.value.findIndex(n => n.id === id)
   nodes.value[index] = { ...nodes.value[index], x: 10 }
   ```

### Step 5: Check Known Issues

Refer to [potential_bugs.md](potential_bugs.md) for known issues:

- **Race conditions** in context loading (#1)
- **Memory leaks** when switching views (#2)
- **Special characters** in node IDs (#3)
- **Concurrent queries** overwriting results (#7)

### Step 6: Test the Fix

**MANDATORY: Run the relevant test suite after any fix.**

The project has two test layers. Each serves a different purpose — use both or one depending on what you changed.

#### Unit Tests (Vitest) — lógica isolada

**Propósito:** Testa stores, services, composables, utils e componentes de forma isolada. Cobre lógica de estado, filtragem, computed properties, formatação, CRUD em localStorage, etc.

```bash
cd graphlagoon-frontend
npm run test:run          # Roda todos os testes unitários uma vez
npm run test:coverage     # Com relatório de cobertura
npm test                  # Watch mode (durante desenvolvimento)
```

**Config:** `frontend/vitest.config.ts` (happy-dom, @vitest/coverage-v8)
**Setup:** `frontend/src/__tests__/setup.ts` (localStorage mock)
**Fixtures:** `frontend/src/__tests__/fixtures/` (factory functions para mock data)
**Convenção:** `src/<area>/__tests__/<name>.test.ts`

**O que os testes unitários cobrem:**
| Área | O que testam |
|------|-------------|
| `stores/__tests__/graph.*.test.ts` | Ações do grafo, filtragem, property filters, explorations, integração com clusters |
| `stores/__tests__/auth.test.ts`, `contexts.test.ts`, `cluster.test.ts`, `metrics.test.ts`, `toolbar.test.ts` | State management de cada store |
| `services/__tests__/api.test.ts`, `algorithmRegistry.test.ts` | API calls, registro de algoritmos |
| `components/__tests__/FilterPanel.test.ts`, `BehaviorPanel.test.ts`, `PropertyFilterPanel.test.ts`, `QueryErrorModal.test.ts` | Renderização de painéis, interações de UI |
| `views/__tests__/LoginView.test.ts`, `ContextsView.logic.test.ts`, `DevGeneratorView.logic.test.ts` | Lógica de páginas, formulários |
| `utils/__tests__/labelFormatter.test.ts` | Regras de formatação de labels |
| `composables/__tests__/useToast.test.ts`, `usePersistence.test.ts` | Lógica de composables |

**Padrões importantes:**
- Usar `setActivePinia(createPinia())` (Pinia real, NÃO createTestingPinia) para computed properties funcionarem
- Usar `vi.useFakeTimers()` + `vi.setSystemTime()` quando ordem depende de timestamps
- Sem `toEndWith` no Vitest — usar `expect(str.endsWith('x')).toBe(true)`
- Componentes com Teleport: query via `document.body.querySelector()`, não `container`

#### E2E Tests (Playwright) — fluxos de usuário

**Propósito:** Testa fluxos completos como um usuário real: login, navegação, CRUD de contextos/explorations, carregamento do grafo, painéis da toolbar. Usa browser real (Chromium), API mockada via route interception.

```bash
cd graphlagoon-frontend
npm run e2e               # Roda todos os testes E2E (auto-starts dev server)
npm run e2e:headed        # Com browser visível
npm run e2e:ui            # Playwright UI mode interativo
npm run e2e:report        # Abre relatório HTML
```

**Config:** `frontend/e2e/playwright.config.ts` (Chromium, webServer auto-starts)
**Fixtures:** `frontend/e2e/fixtures/test-fixtures.ts` (authenticatedPage, unauthenticatedPage)
**Mock data:** `frontend/e2e/fixtures/mock-data.ts`
**API mocks:** `frontend/e2e/helpers/api-mocks.ts` (route interception, sem backend)

**O que os testes E2E cobrem:**
| Spec | O que testa |
|------|------------|
| `auth.spec.ts` | Login, logout, persistência de sessão, route guards |
| `navigation.spec.ts` | Navegação pela toolbar, back/forward, acesso direto por URL |
| `contexts.spec.ts` | CRUD de contextos, busca, modal de criação, deleção |
| `graph.spec.ts` | Carregamento do grafo, status bar, botões da toolbar, toggle de painéis |
| `explorations.spec.ts` | CRUD de explorations, busca, deleção |
| `dev-generator.spec.ts` | Visibilidade do modo DEV, página do gerador |

**Gotchas do Playwright:**
- `getByTitle('Filters', { exact: true })` — evita match com "Property Filters"
- `getByRole('heading', { name: 'X' })` — evita match com `<option>` de mesmo texto
- `page.on('dialog', d => d.accept())` — para `window.confirm()`
- localStorage keys usam prefixo `graphlagoon:` (ex: `graphlagoon:contexts`)

#### Quando rodar qual teste

| O que você mudou | Rodar |
|-----------------|-------|
| Lógica de store (filtros, ações, computed) | `npm run test:run` |
| Componente UI (painel, modal, formulário) | `npm run test:run` + `npm run e2e` |
| Navegação/rotas | `npm run e2e` |
| Integração com API | `npm run test:run` + `npm run e2e` |
| Qualquer fix antes de commitar | `npm run test:run` (pre-commit hook roda `vitest related` automaticamente) |
| Mudanças grandes / antes de PR | `make test-all` (roda ambos) |

#### Refletir sobre User-Journey Test

**ANTES de considerar o fix concluído**, reflita se o bug afeta um **fluxo cross-page** (o usuário navega entre 2+ páginas). Se sim, considere adicionar ou atualizar um teste em `e2e/tests/user-journeys.spec.ts`.

**Pergunte-se:**
- O bug quebra um fluxo que cruza páginas? (ex: criar contexto → abrir grafo → painéis não carregam)
- O fix altera comportamento de navegação, redirecionamento ou passagem de dados entre views?
- Já existe um user-journey test que deveria capturar esse bug mas não captura?

**Se sim**, adicione/atualize um teste em `user-journeys.spec.ts` para garantir que o fluxo completo funciona. Se o bug é contido em uma única página, o teste de regressão unitário ou no spec E2E da feature é suficiente.

#### Escrevendo teste de regressão para o fix

Sempre adicione um teste que reproduza o bug **antes** do fix, e verifique que passa depois:

```typescript
// Teste unitário (Vitest)
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGraphStore } from '@/stores/graph'

describe('Bug fix: [descrição]', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('reproduz e verifica o fix', () => {
    const store = useGraphStore()
    // Setup estado que provoca o bug
    // Assert que o fix funciona
  })
})
```

### Step 7: Document in Decision Log

**Template:**
```markdown
## [YYYY-MM-DD HH:MM] - Frontend Bug Fixed: [Issue Title]

**Issue:** [Detailed description]

**Root Cause:**
[Explanation of what caused the bug]

**Investigation:**
- Checked [component/file]
- Found [specific issue]
- Traced to [root cause]

**Solution:**
[Description of fix]

**Files Modified:**
- [frontend/src/path/to/file.ts](frontend/src/path/to/file.ts:line)
- [frontend/src/path/to/another.vue](frontend/src/path/to/another.vue:line)

**Code Changes:**
\`\`\`typescript
// Before
[old code]

// After
[new code]
\`\`\`

**Testing:**
- [x] Manual testing performed
- [x] Edge cases verified
- [ ] Unit tests added (if applicable)

**Related Issues:**
- See [potential_bugs.md](potential_bugs.md) #[issue number]
- Addresses technical debt #[debt number] in [technical_debts.md](technical_debts.md)
```

## Reference Materials

### Architecture Docs

See [architecture.md](architecture.md) for:
- Frontend architecture overview
- State management patterns
- Component hierarchy
- Data flow diagrams

### Code Patterns

See [code_patterns.md](code_patterns.md) for:
- Vue Composition API patterns
- Pinia store structure
- Error handling patterns
- Type definitions

### Technical Debts

See [technical_debts.md](technical_debts.md) for:
- Known architectural issues
- Areas for improvement
- Refactoring opportunities

## Tools and Commands

### Development Server

```bash
cd graphlagoon-frontend
npm run dev
```

### Build

```bash
npm run build
```

### Linting

```bash
npm run lint
```

### Type Checking

```bash
npm run type-check
```

### Unit Tests (Vitest)

```bash
cd graphlagoon-frontend
npm run test:run          # Roda todos os testes unitários uma vez
npm run test:coverage     # Com relatório de cobertura
npm test                  # Watch mode (dev)
npm run test:ui           # Vitest UI (browser)
```

### E2E Tests (Playwright)

```bash
cd graphlagoon-frontend
npm run e2e               # Roda todos os testes E2E
npm run e2e:headed        # Com browser visível
npm run e2e:ui            # Playwright UI interativo
npm run e2e:report        # Abre relatório HTML
```

### Ambos de uma vez (Makefile)

```bash
make test-all             # Roda unit + E2E juntos
```

### Debugging in VS Code

Create `.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "chrome",
      "request": "launch",
      "name": "Debug Frontend",
      "url": "http://localhost:5173",
      "webRoot": "${workspaceFolder}/frontend/src"
    }
  ]
}
```

## Common Pitfalls

### 1. Forgetting to Update Decision Log
Always document your debugging process and solution!

### 2. Not Testing Both Database Modes
Test fixes with database enabled and disabled (in-memory fallback).

### 3. Ignoring Browser Console
Always check console for errors and warnings.

### 4. Not Cleaning Up Resources
Remember to cancel animations, terminate workers, and dispose objects.

### 5. Breaking Reactivity
Use `.value` with refs and avoid direct mutations.

## Emergency Procedures

### App Won't Start

1. Clear node_modules and reinstall:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

2. Check for TypeScript errors:
   ```bash
   npm run type-check
   ```

3. Clear browser cache and localStorage:
   ```javascript
   localStorage.clear()
   location.reload()
   ```

### Severe Performance Issues

1. Check for infinite loops in computed properties
2. Profile with Chrome DevTools
3. Reduce data size for testing
4. Disable Force Atlas 2 layout

### Data Loss

1. Check localStorage (F12 → Application → Local Storage)
2. Check network tab for failed API calls
3. Check database if using API mode

## Getting Help

1. Check [potential_bugs.md](potential_bugs.md) for known issues
2. Check [technical_debts.md](technical_debts.md) for architectural context
3. Review recent commits for related changes
4. Search codebase for similar patterns
5. Document findings in decision log

## Remember

- **Document everything** in decision_log.md
- **Test thoroughly** including edge cases
- **Consider impact** on both database modes (enabled/disabled)
- **Update documentation** if architectural changes made
- **Communicate** fixes to team
