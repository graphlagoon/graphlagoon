---
name: Community Detection for graphlagoon-studio

description: This skill guides you through debugging community detection issues, adding new community algorithms, or modifying community visualization. Use this when working on any code that touches community detection, radial layout, community coloring, or the Louvain algorithm.
---

## File Map

All community detection code lives in these files. **Read the relevant ones before making changes.**

### Core (dedicated files)

| File | Lines | Role |
|------|-------|------|
| `frontend/src/stores/community.ts` | ~377 | Pinia store: state, computed, actions, worker lifecycle |
| `frontend/src/workers/communityWorker.ts` | ~125 | Web Worker: graph building, Louvain execution, edge filtering |
| `frontend/src/types/graphology-communities-louvain.d.ts` | ~26 | Type declarations for the Louvain library |

### Modified files (community code mixed with existing code)

| File | Community lines | What was added |
|------|----------------|----------------|
| `frontend/src/components/ClusterProgramPanel.vue` | imports + lines ~163-304 + CSS | Communities tab UI: resolution, edge filter, detect button, toggles, community list |
| `frontend/src/components/GraphCanvas3D.vue` | 7,17,34,252,502-508,705-711,983-1010,1190-1195 | Store init, color context, radial force in initGraph/updateGraph, watchers |
| `frontend/src/utils/forceConfig3D.ts` | 193-252 | `applyCommunityRadialForce()` function |
| `frontend/src/utils/graphAppearance.ts` | 166-167, 200 | `communityColorMap` in AppearanceContext + color override in `computeNodeAppearance()` |
| `frontend/src/views/GraphVisualizationView.vue` | 7,36,155,174 | Store init + `clearCommunities()` on context change |
| `frontend/src/stores/cluster.ts` | watch on nodes | `clearClusters()` when graph data changes |
| `frontend/src/utils/__tests__/graphAppearance.test.ts` | 53 | `communityColorMap: null` in test helper |

## Architecture

```
User clicks "Detect" in ClusterProgramPanel (Communities tab)
  -> communityStore.runDetection()
    -> serializeGraph() from graphStore.filteredNodes/filteredEdges
    -> new Worker('communityWorker.ts')
      -> buildUndirectedGraph(graph, edgeTypeFilter)
        - self-loops: dropped
        - multi-edges: merged with weight
        - edge type filter: applied if non-empty
      -> louvain.detailed(graph, { resolution, weighted: true })
      -> postMessage({ type: 'RESULT', communities, count, modularity })
    -> communityStore.setCommunities()

Three visualization modes (independent toggles):
  1. Color:  communityColorMap (Map<nodeId, hex>) -> AppearanceContext -> computeNodeAppearance()
  2. Radial: communityRadialConfig (Map<communityId, {angle, radius}>) -> applyCommunityRadialForce()
  3. Collapse: syncToClusters() -> clusterStore (cluster_class: 'community')
```

### Reactivity chain (critical for debugging)

```
communityStore.communityColorMap changes
  -> watcher in GraphCanvas3D.vue (line ~1190) debounced 50ms
    -> updateVisuals() -> collectAppearanceContext() reads communityColorMap
      -> computeNodeAppearance() applies community color as baseColor

communityStore.radialLayoutEnabled changes
  -> watcher (line ~988) auto-switches viewMode to '2d-proj'
    -> viewMode watcher -> initGraph() -> applyCommunityRadialForce() inside initGraph
  -> watcher (line ~1001) also calls applyCommunityRadialForce() + reheat

graphStore.nodes changes (query/subgraph)
  -> watcher in community.ts -> clearCommunities()
  -> watcher in cluster.ts -> clearClusters()
```

### Force survival across re-init

`initGraph()` and `updateGraph()` both call `applyCommunityRadialForce()` at the end.
This is critical because changing viewMode triggers `initGraph()` which destroys and recreates the graph.

## Common Bugs & Debugging

### Colors not updating after detection

**Symptom:** Detection runs, count shows, but node colors don't change.

**Check:**
1. Is `communityStore.colorEnabled` true?
2. Is `communityStore.communityColorMap` non-null? (Vue DevTools -> Pinia -> community store)
3. Is the watcher in GraphCanvas3D firing? (The one watching `communityColorMap`)
4. Is `collectAppearanceContext()` including the map?

**Root cause pattern:** Missing watcher. `updateVisuals()` must be called when `communityColorMap` changes. The watcher at line ~1190 handles this.

### Radial layout not working

**Symptom:** Toggle radial layout, nothing happens.

**Check:**
1. Is `communityRadialConfig` non-null? (needs `radialLayoutEnabled=true` AND `communitiesById.size > 0`)
2. Is `applyCommunityRadialForce()` being called? Check both the watcher AND inside `initGraph()`
3. Is `d3ReheatSimulation()` called after applying forces?
4. **Race condition:** viewMode change triggers `initGraph()` which destroys forces. Forces must be re-applied inside `initGraph()`.

**Root cause pattern:** `initGraph()` destroys the graph3d instance. Any forces applied before `initGraph()` completes are lost. That's why `applyCommunityRadialForce()` is called inside both `initGraph()` and `updateGraph()`.

### Communities not clearing on new query

**Symptom:** Old community colors persist after running a new query.

**Check:** The watcher in `community.ts` watches `graphStore.nodes`. When nodes change, `clearCommunities()` fires. If it doesn't:
1. Is the watcher registered? (check store initialization)
2. Is `nodes.value` being replaced (not mutated in-place)?

### Edge type filter not taking effect

**Symptom:** Same communities regardless of edge filter.

**Check:**
1. Is `edgeTypeFilter` passed to the worker message? (`params.edgeTypeFilter`)
2. In worker, is `buildUndirectedGraph` receiving and using the filter?
3. Is the filter applied BEFORE graph construction, not after?

## Adding a New Community Algorithm

Follow these steps to add a new algorithm (e.g., Label Propagation, Leiden):

### 1. Install the library (if needed)

```bash
cd frontend && npm install graphology-communities-<name>
```

Add type declarations in `frontend/src/types/graphology-communities-<name>.d.ts`.

### 2. Extend the worker

In `frontend/src/workers/communityWorker.ts`:

1. Add the algorithm to `CommunityWorkerInput.params`:
   ```typescript
   params: { resolution: number; edgeTypeFilter: string[]; algorithm: 'louvain' | 'label-propagation' }
   ```

2. Add a switch/if in the message handler:
   ```typescript
   if (command.params.algorithm === 'label-propagation') {
     // run label propagation
   } else {
     // existing louvain code
   }
   ```

3. The output format stays the same: `{ communities: Record<string, number>, count, modularity }`.
   If the new algorithm doesn't compute modularity, set it to `null` and handle in the store/UI.

### 3. Extend the store

In `frontend/src/stores/community.ts`:

1. Add `algorithm` ref:
   ```typescript
   const algorithm = ref<'louvain' | 'label-propagation'>('louvain')
   ```

2. Pass it to the worker message in `runWorker()`.

3. Export it in the return object.

### 4. Extend the UI

In `frontend/src/components/ClusterProgramPanel.vue`:

Add an algorithm selector (dropdown or segmented control) above the resolution slider.
Some algorithms may have different params (e.g., no resolution) — conditionally show param controls.

### 5. Test

1. `npm run test:run` — verify existing tests pass (graphAppearance tests need `communityColorMap: null`)
2. Manual: run both algorithms on same graph, compare results
3. Toggle color/radial/collapse — all three modes should work regardless of algorithm

## Key Patterns

### Graph serialization
Community store serializes the graph the same way as `metricsCalculator.ts:serializeCurrentGraph()` (line 236-256). Uses `graphStore.filteredNodes/filteredEdges`.

### Per-node coloring (not per-type)
Normal nodes are colored by type (`getNodeTypeColor(nodeType)`). Community coloring overrides this at the per-node level via `communityColorMap?.get(nodeId)`. This is the only feature that colors individual nodes differently from their type.

### Cluster integration
Communities can be injected into the cluster store as clusters with `cluster_class: 'community'` and `source_program_id: '__community_detection__'`. The cluster store merge logic filters by `cluster_class` to avoid collisions with user-created clusters.

### Worker lifecycle
The community store manages its own dedicated worker (not the worker pool). Each `runDetection()` terminates the previous worker and creates a new one. No pause/resume support — Louvain is fast enough.

## Dependencies

- `graphology` (already in project — used by metricsWorker too)
- `graphology-communities-louvain` (added for this feature)
- `d3-force-3d`: `forceX`, `forceY`, `forceZ` (already imported in forceConfig3D.ts)
