---
name: Add Context Menu Action

description: This skill guides you through adding a new action to the graph context menu (right-click on nodes/edges). Use this when adding new actions like "Copy ID", "Expand Neighbors", "Pin Node", etc.
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

Besides code-registered actions, users can define actions per context (persisted in `graph_contexts.context_menu_actions`, opaque JSON): `open-url` (safe URL from item properties), `copy-text`, and `run-query-template` (bind properties to template params). Key files:

| File | Purpose |
|------|---------|
| `frontend/src/types/contextMenuActions.ts` | Config shape (discriminated union on `kind`) |
| `frontend/src/utils/menuActionMatcher.ts` | Visibility matcher (type lists + property conditions) |
| `frontend/src/utils/safeUrl.ts` | URL build/validate/open (protocol allowlist, per-value encoding) |
| `frontend/src/stores/contextMenuActions.ts` | Hydrate/persist (debounced PUT, write-access gated) |
| `frontend/src/composables/useConfigurableMenuActions.ts` | Reconciles configs → menu actions (`configurable-action:` prefix) |
| `frontend/src/components/ContextMenuActionsModal.vue` | Editor UI (+ Import JSON + Ask-AI skill modal) |
| `frontend/src/utils/contextMenuActionSkill.ts` | Ask-AI prompt builder (robot button) |

When a requested action fits one of these kinds, prefer configuring it (or extending the config union) over hardcoding a new action.

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

# Run full suite to check for regressions
npm run test:run
```

### Step 5: Verify Manually

```bash
make dev
```

1. Open the graph visualization
2. Right-click a node — verify your action appears
3. Right-click an edge — verify visibility filtering works
4. Click the action — verify the handler runs
5. Switch to 3D mode — repeat steps 2-4

## Key Files Reference

| File | Purpose |
|------|---------|
| `frontend/src/composables/useContextMenu.ts` | Singleton state, action registry, built-in actions |
| `frontend/src/components/GraphContextMenu.vue` | UI component (Teleport, positioning, dismiss) |
| `frontend/src/components/GraphCanvas3D.vue` | 3D integration (onNodeRightClick/onLinkRightClick) |
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
