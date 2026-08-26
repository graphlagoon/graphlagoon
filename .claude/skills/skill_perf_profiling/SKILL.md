---
name: Performance Profiling for graphlagoon-studio

description: This skill guides you through collecting, analyzing, and optimizing frontend performance in the graphlagoon-studio application. Use this when investigating rendering bottlenecks, memory leaks, or slow interactions in the Vue 3 + Three.js frontend.
---

## Overview

The graphlagoon-studio frontend has a built-in performance instrumentation system that records timing data into `window.__PERF_METRICS__` (dev-only). A Playwright script harvests these metrics plus Three.js renderer stats and CDP browser metrics into a JSON report that Claude Code can read.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (dev mode)                                     │
│                                                          │
│  recordPerf()  ──►  window.__PERF_METRICS__              │
│  renderer.info ──►  window.__THREE_RENDERER_INFO__()     │
│  performance.mark/measure ──► User Timing API            │
└────────────────────────┬─────────────────────────────────┘
                         │ Playwright
                         ▼
┌──────────────────────────────────────────────────────────┐
│  e2e/perf-report.ts                                      │
│                                                          │
│  Collects:                                               │
│  - perfEntries + perfSummary (custom)                    │
│  - threeInfo (render calls, triangles, memory)           │
│  - userTiming (performance.measure entries)              │
│  - cdpMetrics (JSHeap, LayoutCount, Frames, etc.)        │
│  - memory (Chrome heap info)                             │
│                                                          │
│  Output: frontend/perf-report.json                       │
└──────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| [frontend/src/utils/perfMetrics.ts](frontend/src/utils/perfMetrics.ts) | `recordPerf()`, `getPerfSummary()`, window exposure, `perf()` console helper |
| [frontend/src/composables/useDevPerf.ts](frontend/src/composables/useDevPerf.ts) | stats-gl overlay composable (FPS/CPU/GPU panel in dev) |
| [frontend/e2e/perf-report.ts](frontend/e2e/perf-report.ts) | Playwright script to collect and dump metrics |
| [frontend/src/components/GraphCanvas3D.vue](frontend/src/components/GraphCanvas3D.vue) | Records `updateVisuals` timing, exposes `__THREE_RENDERER_INFO__`, attaches stats-gl |
| [frontend/ext-3d-force/three-forcegraph/src/forcegraph-kapsule.js](frontend/ext-3d-force/three-forcegraph/src/forcegraph-kapsule.js) | Records `forcegraphUpdate` timing (**git submodule** — see below) |
| [frontend/src/stores/cluster.ts](frontend/src/stores/cluster.ts) | Records `clusterProgramExec` timing |
| [frontend/src/workers/metricsWorker.ts](frontend/src/workers/metricsWorker.ts) | Reports `elapsedMs` in worker COMPLETE messages |

**Note:** `frontend/ext-3d-force/` contains git submodules (`3d-force-graph`, `three-forcegraph`, `d3-force-3d`). After cloning, run `git submodule update --init --recursive`. Changes to submodule files must be committed inside the submodule repo first, then the updated reference committed in the main repo.

## Visual Overlay (Developer)

When running in dev mode (`npm run dev` / `make dev`), the 3D graph canvas shows a **stats-gl overlay** in the top-left corner:

- **FPS** — frames per second
- **CPU** — JavaScript frame time (ms)
- **GPU** — GPU render time (ms, when `EXT_disjoint_timer_query` is available)

The overlay appears automatically on the 3D canvas. Click the panel to cycle through modes (FPS → CPU → GPU).

### Browser Console Helpers

In dev mode, two console helpers are available:

```javascript
// Print a formatted table of all recorded perf entries
perf()

// Access the raw entries and methods
__PERF_METRICS__.entries      // PerfEntry[]
__PERF_METRICS__.summary()    // PerfSummary[]
__PERF_METRICS__.clear()      // Reset all entries

// Three.js renderer info (live)
__THREE_RENDERER_INFO__()     // { render: { calls, triangles, frame }, memory: { geometries, textures }, programs }
```

## Step-by-Step: Collecting a Performance Report

### 1. Ensure dev server is running

```bash
make dev
# or just the frontend:
make run-frontend
```

### 2. Collect metrics

```bash
make perf-report
# Output: frontend/perf-report.json
```

Or with custom wait time (default 5s):

```bash
cd frontend && PERF_WAIT_MS=10000 npx tsx e2e/perf-report.ts > perf-report.json
```

### 3. Read and analyze the report

```bash
cat frontend/perf-report.json
```

The JSON contains:

```json
{
  "timestamp": "2026-02-17T...",
  "perfEntries": [
    { "label": "updateVisuals", "ms": 12.3, "ts": 1708..., "extra": { "nodes": 5.1, "links": 4.2, "kapsule": 3.0 } },
    { "label": "forcegraphUpdate", "ms": 8.7, "ts": 1708..., "extra": { "changedPropsCount": 3 } }
  ],
  "perfSummary": [
    { "label": "updateVisuals", "count": 15, "totalMs": 184.5, "avgMs": 12.3, "minMs": 8.1, "maxMs": 22.4, "lastMs": 10.2 }
  ],
  "threeInfo": {
    "render": { "calls": 42, "triangles": 128000, "frame": 1205 },
    "memory": { "geometries": 15, "textures": 3 },
    "programs": 8
  },
  "cdpMetrics": {
    "JSHeapUsedSize": 52428800,
    "LayoutCount": 12,
    "Frames": 180,
    "Timestamp": 1708...
  },
  "memory": {
    "usedJSHeapSize": 52428800,
    "totalJSHeapSize": 67108864,
    "jsHeapSizeLimit": 2172649472
  }
}
```

## Adding New Performance Measurements

### In Vue components or stores

```typescript
import { recordPerf } from '@/utils/perfMetrics'

const t0 = performance.now()
// ... expensive work ...
const elapsed = performance.now() - t0
recordPerf('myOperation', elapsed, { itemCount: items.length })
```

### In external JS (like forcegraph-kapsule.js)

```javascript
// No import needed — use the window global directly
if (typeof window !== 'undefined' && window.__PERF_METRICS__) {
  window.__PERF_METRICS__.entries.push({
    label: 'myOperation',
    ms: performance.now() - t0,
    ts: Date.now(),
  });
}
```

### Using User Timing API (shows in Chrome DevTools too)

```typescript
performance.mark('myOp-start')
// ... work ...
performance.mark('myOp-end')
performance.measure('myOp', 'myOp-start', 'myOp-end')
```

## Common Performance Investigations

### Slow visual updates

Check `perfSummary` for `updateVisuals` — if avgMs > 16ms, frames are being dropped:

1. Look at `extra.nodes` vs `extra.links` vs `extra.kapsule` to find the bottleneck
2. If `kapsule` is slow → forcegraph internal updates are heavy (check node/link counts)
3. If `nodes` is slow → `computeNodeAppearance` may have too many checks for the graph size

### High memory / memory leaks

Compare `cdpMetrics.JSHeapUsedSize` across multiple reports:

```bash
# Collect baseline
make perf-report && cp frontend/perf-report.json /tmp/baseline.json

# Interact with the app (load graphs, switch views, etc.)
# Then collect again
make perf-report && cp frontend/perf-report.json /tmp/after.json

# Compare
python3 -c "
import json
a = json.load(open('/tmp/baseline.json'))
b = json.load(open('/tmp/after.json'))
heap_a = a['cdpMetrics']['JSHeapUsedSize']
heap_b = b['cdpMetrics']['JSHeapUsedSize']
print(f'Heap: {heap_a/1e6:.1f}MB → {heap_b/1e6:.1f}MB (delta: {(heap_b-heap_a)/1e6:.1f}MB)')
"
```

### Three.js draw calls / triangles

Check `threeInfo.render.calls` and `threeInfo.render.triangles`:

- High draw calls → too many separate geometries (consider instanced rendering)
- High triangles → geometry LOD may help
- Check `threeInfo.memory.geometries` for leaked geometries

### Force graph update performance

Check `forcegraphUpdate` in `perfSummary` — this measures the full kapsule update cycle including node/link digestion.

## Production Safety

All instrumentation is zero-cost in production:

- `recordPerf()` returns immediately when `import.meta.env.PROD` is true
- `window.__PERF_METRICS__` and `window.__THREE_RENDERER_INFO__` are never exposed in production
- Vite tree-shakes the dead code paths in production builds
- The forcegraph-kapsule check (`window.__PERF_METRICS__`) is a simple falsy check that short-circuits

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PERF_WAIT_MS` | `5000` | How long to wait (ms) after page load before collecting metrics |
