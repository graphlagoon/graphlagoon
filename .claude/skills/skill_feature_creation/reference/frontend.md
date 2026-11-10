# Frontend (frontend/src)

## Contents
- Where things go
- Conventions that differ from a default Vue app
- Canvas3D: extending the 3D graph
- Git submodules (ext-3d-force)

## Where things go

| Piece | Location | Note |
|---|---|---|
| Types | `types/<area>.ts` (most graph types in `types/graph.ts`) | mirror the Pydantic schema field names (snake_case from the API) |
| HTTP calls | `services/api.ts` | methods on the `api` object using `this.client`; `encodeURIComponent` path segments that are user text |
| Pure logic | `utils/<name>.ts` | no Vue imports; first choice, easiest to test |
| Reactive wiring | `composables/use<Name>.ts` | receives refs and callbacks, owns no global state |
| Cross-view state | `stores/<area>.ts` | Pinia setup-store style; sibling: `stores/queryTemplates.ts` |
| UI | `components/`, `views/` | `<script setup lang="ts">`; add `data-testid` to anything a test must find |
| Heavy computation | `workers/` + `services/workerPool.ts` | keep the main thread free while the canvas renders |

`stores/graph.ts` and `GraphCanvas3D.vue` are already too large: grep for
the symbol and read the range around it; put new logic in a util or
composable and call it from there.

## Conventions that differ from a default Vue app

- User feedback: `useToast()`; destructive confirmation: `useConfirm()`.
  No `alert` / `confirm`.
- Error text shown to users: `utils/errorMessage.ts` (understands the
  backend's `detail.error.code` shape).
- Permission-gated action: `const { can } = usePermissions()` and
  `v-if="can('<resource>.<verb>')"`. Hide, do not disable. The empty state
  must still say what to do ("ask an administrator").
- Capability depends on the datasource (Databricks, Neptune, REST,
  precomputed): check `useDatasourceCapabilities` before offering the
  action.
- Modals: `useModalFocus` and `useEscapeToCloseModals`; long lists:
  `@tanstack/vue-virtual`; text inputs that trigger work: `useDebouncedModel`.
- A panel must work in both hosts when it applies to both: the exploration
  view (`GraphVisualizationView`) and the case canvas (`InvestigationView`).
  Check whether the case has no `currentContext` for your feature.
- Anything saved with an exploration or case view needs a field in the
  backend schema as well, or it is dropped (or rejected) on save.

## Canvas3D: extending the 3D graph

```
components/GraphCanvas3D.vue   orchestrator: owns shared refs, wires composables
composables/useGraphCamera.ts  camera: ortho, zoom, tracking
composables/useGraphLayout.ts  layout: start / stop / reheat / scramble
composables/useGraphLabels.ts  labels: FastLabelRenderer lifecycle
utils/graphAppearance.ts       pure: node/link color, size, hidden
utils/forceConfig3D.ts         pure: d3-force-3d configuration
types/graph3d.ts               GraphNode, GraphLink, GraphData
```

| New thing | Change | Test |
|---|---|---|
| Visual property (color, size, hidden, shape) | `AppearanceContext` + `computeNodeAppearance()` in `graphAppearance.ts`, fill the field in `collectAppearanceContext()` in the component | `utils/__tests__/graphAppearance.test.ts` |
| Force behavior | `Force3DSettings` + `applyForceConfig()` in `forceConfig3D.ts` | `utils/__tests__/forceConfig3D.test.ts` |
| Camera mode | function in `useGraphCamera.ts`, wired in the component | composable test |
| Label style | `useGraphLabels.ts` (what to show) or `FastLabelRenderer.ts` (GPU) | composable test |
| Pointer interaction | ForceGraph3D callbacks in `initGraph()` | e2e via `e2e/helpers/graph-hooks.ts` |

The rule that keeps this fast: the component snapshots **all** store state
once per update pass, and pure functions read only the snapshot.

```typescript
const ctx = collectAppearanceContext();
const a = computeNodeAppearance(nodeId, nodeType, isCluster, baseSize, color, ctx);
```

Never read a store inside a per-node or per-link function, and never add a
watcher that triggers a full restyle per changed node. Hiding nodes should
hide (appearance), not rebuild graph data, unless the layout must change.
If the feature may affect frame time or initial load, use
`skill_perf_profiling` to measure before and after.

## Git submodules (ext-3d-force)

`frontend/ext-3d-force/{3d-force-graph,three-forcegraph,d3-force-3d}` are
forks pinned as submodules. `make install` initializes them
(`git submodule update --init --recursive`).

To change one: commit and push inside the submodule's own repo on a branch,
then in the main repo `git add frontend/ext-3d-force/<name>` to move the
pinned SHA. Never `git add` individual files inside a submodule path from
the main repo. Prefer solving the problem in `frontend/src` first; a fork
change needs its own review and release order.

## Checks

```bash
cd frontend && npx vitest run src/<path>/__tests__/<name>.test.ts
cd frontend && npx vue-tsc --noEmit
```
