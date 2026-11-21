---
name: Add Context Menu Action

description: This skill guides you through adding or changing graph context menu actions (right-click on nodes/edges) — built-in or code-registered ones like "Copy ID", "Expand Neighbors", "Pin Node", and the per-context configurable actions (open URL, copy text, run a query template as a graph or as a table, show only nodes with a value), including how they work on a case canvas and as agent (MCP) tools.
---

## Architecture Overview

The context menu system has three parts:

1. **Composable** — `frontend/src/composables/useContextMenu.ts`
   Singleton state + action registry. All context menu state lives here.

2. **Component** — `frontend/src/components/GraphContextMenu.vue`
   Renders action list via `<Teleport to="body">`. No action logic — purely UI.

3. **Integration** — actions are registered via `useContextMenu().addAction()` from any component or composable.

### Key Types

```typescript
// from frontend/src/composables/useContextMenu.ts

interface ContextMenuTarget {
  type: 'node' | 'edge';  // what was right-clicked
  id: string;              // node_id or edge_id
  label: string;           // display label (may be truncated)
}

interface ContextMenuAction {
  id: string;              // unique identifier (e.g. 'copy-id', 'expand-neighbors')
  label: string;           // display text in menu
  icon?: Component | string; // lucide component or emoji/short string
  handler: (target: ContextMenuTarget) => void | Promise<void>;
  visible?: (target: ContextMenuTarget) => boolean;   // hide action conditionally
  disabled?: (target: ContextMenuTarget) => boolean;   // gray out conditionally
}
```

### How Context Menu Triggers Work

- **3D (3d-force-graph)** — the menu is NOT wired through `.onNodeRightClick()` / `.onLinkRightClick()`: the library suppresses those callbacks on any pointer movement while the button is held. Instead `GraphCanvas3D.vue` uses an app-level `mouseup` handler (`maybeOpenContextMenu`) fed by hover state captured in `.onNodeHover()` / `.onLinkHover()`, with a 5px stationary-click guard (`utils/contextMenuTrigger.ts` — `isStationaryRightClick` / `resolveContextMenuTarget`; nodes win over links).
- Calls `contextMenu.show(event, { type, id, label })` which sets position + target + visible, and (for nodes) `graphStore.prioritizeNodeProperties(id)` so property-gated actions appear fast.
- The `GraphContextMenu.vue` component (rendered inside the canvas) picks up the state via the shared singleton refs.

### User-Configurable Actions (no code needed)

Besides code-registered actions, users configure actions per context (persisted in `graph_contexts.context_menu_actions`, opaque `list[dict]` on the backend — no schema, no migration for a new field). Kinds (`CONTEXT_MENU_ACTION_KINDS`; unknown kinds are skipped at runtime and on import):

| Kind | Does |
|------|------|
| `open-url` | Safe URL from the item's values (web or desktop-app scheme) |
| `copy-text` | Label-template text to the clipboard |
| `run-query-template` | Binds item values to a query template's params. `resultMode` absent/`graph`: the result replaces the graph (execute modal when a required param is unbound). `resultMode: 'table'`: runs **on the server** for the item and opens the rows in `MenuActionTableModal` — the graph stays |
| `show-same-value` | Isolates nodes with the same (or any) value of a field |

Key files:

| File | Purpose |
|------|---------|
| `frontend/src/types/contextMenuActions.ts` | Config shape (discriminated union on `kind`), `isTableAction` |
| `frontend/src/utils/menuActionMatcher.ts` | Visibility matcher (type lists + property conditions, `metric:` refs) |
| `frontend/src/utils/safeUrl.ts` | URL build/validate/open (literal scheme, any app scheme but never in-browser ones like `javascript:`; per-value encoding; app links hand off via `location.assign`) |
| `frontend/src/stores/contextMenuActions.ts` | Hydrate/persist (debounced PUT, write-access gated) |
| `frontend/src/composables/useConfigurableMenuActions.ts` | Reconciles configs → menu actions (`configurable-action:` prefix); dispatch per kind; `pendingTemplateExecution` / `pendingTable` refs the views bind to modals; **host adapter** (below) |
| `frontend/src/components/ContextMenuActionsModal.vue` | Editor UI (+ Import JSON + Ask-AI skill modal) |
| `frontend/src/utils/contextMenuActionImport.ts` | Import validation, one branch per kind |
| `frontend/src/utils/contextMenuActionSkill.ts` | Ask-AI prompt builder (robot button): describes every kind with a JSON example |
| `frontend/src/composables/useMenuActionTable.ts`, `components/MenuActionTableModal.vue` | Table actions: submit / poll / cancel, editable params, Add to case |
| `api/graphlagoon/services/menu_action_tables.py` | Table actions on the server: find action, server-side match and plain-placeholder bindings, template visibility, value rule, scoped read-only run |
| `api/graphlagoon/mcp/server.py` (`list_entity_actions`, `run_entity_action`) | The same table actions as agent tools |

**Where actions run.** Both `GraphVisualizationView` and `InvestigationView` call `register()`/`unregister()` and mount the modals. On a case canvas:
- only the actions of the one canvas context apply (`canvasContextId`); graph-replacing `run-query-template` actions are filtered out (`caseMenuActions`), table actions stay;
- ids are the case's (node `<id>@<ctx>` or identity-merged, edge `<source>:<edge_id>`), so the view passes a host adapter `useConfigurableMenuActions({ contextId, sourceNodeId, sourceEdge })` that maps back to the source graph's ids (`sourceEdgeIds` in `utils/unifyGraph.ts`). Anything that sends an id to the warehouse must go through it;
- hydration watches the canvas context's fields, not the `contexts` map (contexts are added by key and arrive after the canvas item).

**Agent-first.** A behavior people configure that reads data should also be reachable by agents: the table action's server route has MCP twins (registered in `mcp/registry.py`, docs generated by `make docs-api`). New REST routes need a tool or an `AGENT_EXEMPT_ROUTES` reason, and an `AUDITED_ROUTES` / `AUDIT_EXEMPT_ROUTES` entry.

**Adding a kind or a field to a kind** touches, at least: the type union, `useConfigurableMenuActions` (dispatch, icon, visibility), the editor (draft ref, `startEdit`, `buildConfig`, `actionSummary`, form block), `contextMenuActionImport.ts` (explicit branch — the last `else` is run-query-template), `contextMenuActionSkill.ts`, the `context_menu_actions` description in `models/schemas.py` + `make docs-api`, `docs/guide/context-menu-actions.md` (+ screenshot scene in `frontend/e2e/screenshots/generate.ts`), the case view filter if the kind replaces the graph, and the showcase seed (`api/graphlagoon/dev/seed_showcase.py`) when a demo helps. The decision log has the precedents (`show-same-value`, table result).

When a requested action fits one of these kinds, prefer configuring it (or extending the config union) over hardcoding a new action. For "show data about the clicked item", a query template in table mode usually covers it: filters are template parameters, neighbors are joins on the context's edge table, enriched data is any authorized table.

## How to Add a New Action

### Step 1: Choose Where to Register

Actions can be registered from **any** component or composable. Choose based on where the action's dependencies live:

| Action needs... | Register in... |
|----------------|---------------|
| Graph store (select, filter, expand) | `GraphCanvas3D.vue` (or a shared composable) |
| Clipboard only | Built-in (already in `useContextMenu.ts`) |
| Metrics store | `MetricsPanel.vue` or a composable |
| External API call | A service composable |
| No dependencies | Directly in `useContextMenu.ts` as a built-in |

### Step 2: Register the Action

**Option A — Built-in action (always available)**

Add to `createBuiltInActions()` in `frontend/src/composables/useContextMenu.ts`:

```typescript
function createBuiltInActions(): ContextMenuAction[] {
  const { success, error } = useToast();

  return [
    // Existing copy-id action...
    {
      id: 'copy-id',
      label: 'Copy ID',
      icon: '\u2398',
      handler: async (t) => { /* ... */ },
    },
    // NEW: Add your action here
    {
      id: 'your-action-id',
      label: 'Your Action Label',
      icon: '\u2713',  // optional Unicode icon
      handler: async (t) => {
        // t.type is 'node' or 'edge'
        // t.id is the node_id or edge_id
        success('Action completed');
      },
      // Optional: only show for nodes
      visible: (t) => t.type === 'node',
      // Optional: disable conditionally
      disabled: (t) => someCondition,
    },
  ];
}
```

**Option B — Dynamic action (registered from a component)**

Call `addAction()` in a component's `onMounted` or `setup`:

```typescript
import { useContextMenu } from '@/composables/useContextMenu';
import { useGraphStore } from '@/stores/graph';

const contextMenu = useContextMenu();
const graphStore = useGraphStore();

contextMenu.addAction({
  id: 'select-node',
  label: 'Select',
  icon: '\u2713',
  handler: (target) => {
    if (target.type === 'node') {
      graphStore.selectNode(target.id, false);
    }
  },
  visible: (target) => target.type === 'node',
});
```

**Important**: If registering dynamically, clean up on unmount to avoid duplicate entries:

```typescript
onUnmounted(() => {
  contextMenu.removeAction('select-node');
});
```

### Step 3: Add Tests

Add tests to `frontend/src/composables/__tests__/useContextMenu.test.ts`:

```typescript
it('your-action does the expected thing', async () => {
  const ctx = useContextMenu();
  const action = ctx.actions.value.find(a => a.id === 'your-action-id')!;

  await action.handler({ type: 'node', id: 'test-123', label: 'test' });

  // Assert the expected side effect
  expect(someMock).toHaveBeenCalledWith('test-123');
});
```

For visibility/disabled filtering:

```typescript
it('your-action is only visible for nodes', () => {
  const ctx = useContextMenu();
  const action = ctx.actions.value.find(a => a.id === 'your-action-id')!;

  expect(action.visible?.({ type: 'node', id: 'n1', label: 'n1' })).toBe(true);
  expect(action.visible?.({ type: 'edge', id: 'e1', label: 'e1' })).toBe(false);
});
```

### Step 4: Run Tests

```bash
# Run context menu tests
cd frontend && npx vitest run src/composables/__tests__/useContextMenu.test.ts src/components/__tests__/GraphContextMenu.test.ts

# Configurable actions (kinds, dispatch, table mode, editor, import, prompt)
cd frontend && npx vitest run src/composables/__tests__/useConfigurableMenuActions.test.ts src/utils/__tests__/contextMenuActionImport.test.ts src/utils/__tests__/contextMenuActionSkill.test.ts src/components/__tests__/MenuActionTableModal.test.ts
cd api && uv run pytest tests/test_menu_action_tables.py -q -p no:cacheprovider

# Right-click in a real browser (mocked API)
cd frontend && npx playwright test -c e2e/playwright.config.ts tests/context-menu.spec.ts --reporter=line --trace off
```

Then the type check once (slow; see `skill_feature_creation/reference/frontend.md`):
`cd frontend && flock /tmp/graphlagoon-heavy-checks.lock npm run typecheck`.

### Step 5: Verify Manually

```bash
make dev
```

1. Open the graph visualization
2. Right-click a node — verify your action appears
3. Right-click an edge — verify visibility filtering works
4. Click the action — verify the handler runs
5. Switch to 3D mode — repeat steps 2-4
6. If the action reads ids or data: repeat on a case canvas (`/investigations/<id>` with the exploration as a graph item)

## Key Files Reference

| File | Purpose |
|------|---------|
| `frontend/src/composables/useContextMenu.ts` | Singleton state, action registry, built-in actions |
| `frontend/src/components/GraphContextMenu.vue` | UI component (Teleport, positioning, dismiss) |
| `frontend/src/components/GraphCanvas3D.vue` | 3D integration (app-level `mouseup` → `maybeOpenContextMenu`) |
| `frontend/src/utils/contextMenuTrigger.ts` | Stationary right-click guard, node-over-link target |
| `frontend/e2e/tests/context-menu.spec.ts` | Real right-click in the browser (retry loop: the raycast runs per frame) |
| `frontend/src/composables/__tests__/useContextMenu.test.ts` | Composable tests |
| `frontend/src/components/__tests__/GraphContextMenu.test.ts` | Component tests |

## Design Constraints

- **No store coupling in the composable** — `useContextMenu.ts` must not import graph/metrics stores. Actions that need stores should be registered from components that already have access.
- **Module-level singleton** — `visible`, `x`, `y`, `target`, `actions` are module-level refs shared across all `useContextMenu()` calls (same pattern as `useToast`).
- **`resetActions()` exists for tests** — call it in `beforeEach` to restore built-in defaults when tests mutate actions.
- **Menu auto-closes after action** — `GraphContextMenu.vue` calls `hide()` after every action handler completes.
- **Viewport boundary adjustment** — the component repositions the menu via `nextTick` + DOM measurement to prevent overflow.

## Common Patterns

### Node-only action

```typescript
{
  id: 'select-node',
  label: 'Select',
  visible: (t) => t.type === 'node',
  handler: (t) => graphStore.selectNode(t.id, false),
}
```

### Edge-only action

```typescript
{
  id: 'filter-edge-type',
  label: 'Filter by This Type',
  visible: (t) => t.type === 'edge',
  handler: (t) => {
    const edge = graphStore.edges.find(e => e.edge_id === t.id);
    if (edge) graphStore.toggleEdgeType(edge.relationship_type);
  },
}
```

### Action with async + toast feedback

```typescript
{
  id: 'copy-properties',
  label: 'Copy Properties',
  handler: async (t) => {
    const item = t.type === 'node'
      ? graphStore.nodes.find(n => n.node_id === t.id)
      : graphStore.edges.find(e => e.edge_id === t.id);
    if (item?.properties) {
      await navigator.clipboard.writeText(JSON.stringify(item.properties, null, 2));
      toast.success('Properties copied');
    }
  },
}
```

### Conditionally disabled action

```typescript
{
  id: 'expand',
  label: 'Expand Neighbors',
  visible: (t) => t.type === 'node',
  disabled: (t) => graphStore.loading,  // gray out while loading
  handler: async (t) => {
    await graphStore.expandFromNode(t.id, 1);
  },
}
```
