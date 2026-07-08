# Decision Log

## [2026-07-08 19:40] - Bug fix: Procedural BFS not enabled by default when opening a new context

**Report:** Opening a graph context (new or pre-existing) then opening the
"Advanced transpile & optimization settings" modal showed the **Procedural BFS**
("procedural query") toggle disabled. Expected: enabled by default.

**Root cause:** Commit `868043f` (2026-07-07) already flipped the *initial*
store default from `'cte'` to `'procedural'`
([graph.ts:298](../../frontend/src/stores/graph.ts#L298)), so a truly fresh page
load is fine. The residual bug is a **state leak across contexts in a single SPA
session**: the graph store is a Pinia singleton, and `clear()` — which runs on
unmount and between contexts
([GraphVisualizationView.vue:191](../../frontend/src/views/GraphVisualizationView.vue#L191),
[:197](../../frontend/src/views/GraphVisualizationView.vue#L197)) — reset
nodes/query/filters but **not** the transpilation options. So the sequence
"open an old exploration saved with `'cte'` → `loadExploration` sets
`vlpRenderingMode = 'cte'` → open a new context → `clear()` leaves it `'cte'`"
left Procedural BFS disabled on the new context.

**Design decision:** Reset the transpilation options to their defaults inside
`clear()`, so every newly-opened context starts from a clean slate (procedural
enabled). Saved explorations still override via `loadExploration`'s restore
(`|| 'procedural'`), so an explicit user choice within an exploration is
preserved — only the cross-context leak is fixed. Chose `clear()` over the
onMounted "new context" branch because `clear()` is the single choke point for
both the unmount and context-switch paths.

**Implementation:**
- Added `resetTranspileOptions()` helper (resets `vlpRenderingMode` →
  `'procedural'`, `materializationStrategy` → databricks-aware default,
  `proceduralOptimizations` → `DEFAULT_PROCEDURAL_BFS_OPTIONS`), called from
  `clear()` and exported from the store.

**Files Modified:**
- [frontend/src/stores/graph.ts](../../frontend/src/stores/graph.ts) —
  `resetTranspileOptions()` + call in `clear()` + export.
- [frontend/src/stores/__tests__/graph.exploration.test.ts](../../frontend/src/stores/__tests__/graph.exploration.test.ts)
  — new "transpile options reset on clear" describe block (4 regression tests).

**Testing:**
- [x] `graph.exploration` 21/21, `TranspileSettingsModal` 8/8.
- [x] `graph.actions` 31/31, `graph.filtering` 40/40 — no `clear()` regressions.
- [x] `vue-tsc --noEmit` clean.

**Status:** Fixed.

## [2026-07-08 16:20] - Test fix: gsql2rsql stub no longer poisons test_transpile_options

**Context:** After the previous bug fix, the full API suite showed 2 failures in
`test_transpile_options.py` — but they reproduced on clean `HEAD`, so they were
pre-existing, not a regression. Once the gsql2rsql transpiler bug itself was
fixed upstream, these were the only remaining reds. Root-caused to **our test
harness**, not the transpiler.

**Root cause:** Four test files stub the `gsql2rsql` package tree into
`sys.modules` with `MagicMock`, guarded by `if "gsql2rsql" not in sys.modules`.
`gsql2rsql` IS installed, but nothing imports it at collection time, so the
first-collected stubbing file (`test_catalog_schemas.py`, alphabetically first)
installed the mock for the entire session — poisoning the real import in
`test_transpile_options.py`. Hence: passes in isolation, fails in full-suite.

**Fix:** Replaced the guard in all four files with a real import attempt —
`try: import gsql2rsql / except ImportError: <install stubs>`. This never stubs
when the real package is importable (no pollution) and never raises (unlike
`importlib.util.find_spec`, which throws `ValueError` when an earlier file
already left a MagicMock in `sys.modules`).

**Files Modified:**
- [api/tests/test_catalog_schemas.py](../../api/tests/test_catalog_schemas.py)
- [api/tests/test_graph_error_handling.py](../../api/tests/test_graph_error_handling.py)
- [api/tests/test_table_query.py](../../api/tests/test_table_query.py)
- [api/tests/test_subgraph_schema_mapping.py](../../api/tests/test_subgraph_schema_mapping.py)

**Testing:** Full API suite `pytest -q` → **142 passed, 1 skipped, 0 failed**
(was 2 failed). `ruff check` clean.

**Status:** Fixed. Full backend suite is now green.

## [2026-07-08 16:05] - Bug Fixed: custom-schema contexts render an empty graph + blank edge dropdown

**Symptom (as reported):** Opening a context whose schema uses non-default
column names (e.g. node `node_id`/`node_type`; edge `edge_id` /
`source_node_id` / `target_node_id` / `edge_type`) produced: no graph rendered,
an empty "edge types" dropdown, and an auto-generated BFS query in the panel
that looked wrong (hardcoded label / "only returns r").

**Root cause (the real bug — backend):**
The subgraph and expand endpoints built the edge `NAMED_STRUCT` with **hardcoded
normalized keys** — `NAMED_STRUCT('edge_id', …, 'src', …, 'dst', …,
'relationship_type', …)`. But
[`process_graph_query_result`](../../api/graphlagoon/services/graph_operations.py)
reads the struct back through the context's **own** `ColumnConfig`
(`item.get(column_config.src_col)`, `…dst_col`, `…relationship_type_col`). For a
custom schema those lookups target `source_node_id` / `target_node_id` /
`edge_type`, which are **absent** from a struct keyed by `src`/`dst`/… → every
edge got `src="" dst="" relationship_type=""`, `node_ids` stayed empty (so the
node query was skipped → empty graph), and `graphStore.edgeTypes` (distinct of
`relationship_type`) was a single empty string → blank dropdown. It only ever
worked for the default `src`/`dst`/`relationship_type` schema — which is all the
existing tests covered. The transpiled cypher `/query` path was unaffected
because gsql2rsql emits the schema's real column names as struct keys.

**Design decision — fix at the struct, not the processor:**
`execute_graph_query_with_nodes` uses a single `ColumnConfig` for BOTH the edge
struct read AND the node-fetch query (`node_id_col`) + node parsing, so the node
side must keep the original names. Rather than thread a second "normalized" edge
config through, the clean single-point fix is to make the struct **keyed by the
context's own column names**, matching what the processor (and the cypher path)
already expect. Extracted `build_edge_named_struct(column_config, table_alias)`
and used it at all three edge-struct sites (subgraph + expand depth-1 + expand
depth-2), removing duplication.

**BFS query panel (frontend):** The report's "should RETURN p / the full path"
is **incorrect for this architecture** — validation and the result processor
REQUIRE `RETURN r`; the backend derives node data from each edge's src/dst in a
separate query. Kept `RETURN r`. The genuine issue was the *fallback* branch
injecting an arbitrary `:${node_types[0]}` label that could mismatch the node
the user substitutes. Extracted the generator into a pure, testable util
`utils/exampleQuery.ts`: always `RETURN r`, node-id property from
`node_structure.node_id_col` (never hardcoded), and **no** node-type label.
Once the backend fix lands, the initial load succeeds, so the panel normally
takes the real-node branch anyway.

**Files Modified:**
- [api/graphlagoon/routers/graph.py](../../api/graphlagoon/routers/graph.py) —
  added `build_edge_named_struct`; replaced the 3 hardcoded `NAMED_STRUCT`
  edge projections (subgraph + 2× expand); dropped now-unused `edge_id_col`.
- [frontend/src/components/GraphQueryPanel.vue](../../frontend/src/components/GraphQueryPanel.vue) —
  `generateExampleQuery` now delegates to the util.

**Files Created:**
- [frontend/src/utils/exampleQuery.ts](../../frontend/src/utils/exampleQuery.ts) —
  pure `generateBfsExampleQuery(context, displayedNodes)`.
- [frontend/src/utils/__tests__/exampleQuery.test.ts](../../frontend/src/utils/__tests__/exampleQuery.test.ts) — 6 tests.
- [api/tests/test_subgraph_schema_mapping.py](../../api/tests/test_subgraph_schema_mapping.py) —
  8 regression tests (custom-schema struct keys + struct→edges round-trip;
  `node_ids` non-empty is the key regression assertion).

**Testing:**
- [x] Backend: `pytest tests/test_subgraph_schema_mapping.py
  tests/test_graph_error_handling.py` → 20 passed. `ruff check` clean.
- [x] Frontend: `vitest run exampleQuery` → 6 passed. `vue-tsc --noEmit` clean.

**Status:** Fixed.

## [2026-07-07 10:36] - Feature Implemented: Elapsed-time counter on the query spinner

**Feature:** The "Running query…" spinner now shows how long the query has been
running — plain seconds under a minute ("42s"), switching to minutes + padded
seconds past one minute ("1m 05s").

**Requirements (from request):**
- Show elapsed time in seconds, then in minutes once past 60s.
- Truncate the value carefully as an integer/string so no float ever reaches the
  UI (avoid "12.999s" style artifacts).

**Design Decisions:**
1. **Self-contained timer in `QueryRunningState.vue`** — the overlay component is
   mounted only while a query runs (`v-if="loading"`), so a timer that starts in
   `onMounted` and clears in `onBeforeUnmount` needs no start-timestamp threaded
   through the graph/console stores. Simplest correct place.
2. **Integer-only arithmetic** — each tick does `Math.floor((performance.now() -
   startMs) / 1000)`, and formatting uses integer division/modulo with
   `String(seconds).padStart(2, '0')`. No float is ever formatted, so the
   truncation concern is structurally impossible rather than patched after the
   fact.
3. **1s tick via `setInterval`** — resolution matches the displayed unit; cleared
   on unmount to avoid a leaked interval.
4. **`showElapsed` prop (default true)** — lets any future call site opt out
   without removing the counter globally.

**Implementation:**

**Frontend Changes:**
- `QueryRunningState.vue`: added `elapsedSec` ref, `startMs`/`interval` lifecycle,
  `formatElapsed()` pure helper, `elapsedLabel` computed, `showElapsed` prop, the
  `query-running-elapsed` span, and `.elapsed-label` styles. Updated the header
  comment (previously stated there was "deliberately NO elapsed-seconds counter").

**Files Modified:**
- [frontend/src/components/QueryRunningState.vue](../../frontend/src/components/QueryRunningState.vue)
- [frontend/src/components/__tests__/QueryRunningState.test.ts](../../frontend/src/components/__tests__/QueryRunningState.test.ts)

**Testing:**
- [x] 4 new unit tests (Vitest fake timers): starts at 0s and counts seconds;
  floors 3.999s → "3s" (float-safety); switches to "1m 05s" / "2m 05s" past 60s;
  hidden when `showElapsed=false`.
- [x] Full file green: 9/9 tests pass.
- [x] `vue-tsc --noEmit` clean for the component.

**Known Limitations:**
- Timer resolution is 1s; the first visible tick appears ~1s after mount (initial
  render shows "0s").

## [2026-07-08 00:00] - Frontend Bug Investigation: Table freezes on large graphs (>200k)

**Issue:** Opening the node/edge Table drawer on a large graph (>200k nodes/edges,
e.g. after a high-depth BFS) freezes the browser tab completely — UI becomes
unresponsive.

**Reporter:** User bug report.

**Steps to Reproduce:**
1. Open a context in the application.
2. Run a query that yields a massive dataset (high-depth BFS).
3. Wait for the graph visualization to fully render.
4. Click the table button at the bottom of the page.
5. Browser freezes, UI is completely unresponsive.

**Investigation:**
- `DataTablePanel.vue` is mounted lazily via `v-if="showDataTable"`
  ([GraphVisualizationView.vue:366-371](../../frontend/src/views/GraphVisualizationView.vue#L366-L371)),
  so clicking the table button triggers first-evaluation of its full computed
  chain synchronously, on the main thread, with no chunking/deferral/worker.
- That chain, over the **entire** `filteredNodes`/`filteredEdges` array (no
  pagination or sampling):
  - `nodePropKeys`/`edgePropKeys` — one full pass collecting property key names.
  - `nodeCols`/`edgeCols` (`buildNodeColumns` in
    [useTableColumns.ts:108-123](../../frontend/src/composables/useTableColumns.ts#L108-L123)) —
    for **each** property column, calls `detectType()` (one full array pass:
    `Number()` coercion + date regex test + `Set` dedup per row) and, for
    categorical columns, `collectOptions()` (another full array pass). With P
    property columns this is up to 2P full O(n) passes.
  - `nodeRows`/`edgeRows` (`flattenNodeRows`) — one more full O(n × P) pass
    building a new flattened row object per node/edge.
  - Total: on the order of `(2P + 2) × n` operations, all synchronous, no
    `requestIdleCallback`/chunking/worker offload.
- **Reactivity multiplier:** `nodes`/`edges` are stored as `ref<Node[]>([])`
  ([stores/graph.ts:64-65](../../frontend/src/stores/graph.ts#L64-L65)), i.e.
  deep-reactive. `filteredNodes`/`filteredEdges` (computed) return a new plain
  array via `.filter()`, but its **elements are still the original
  Vue-reactive-proxied node/edge objects**. Every property read
  (`n.node_type`, `n.properties[k]`, …) inside the hot loops above goes through
  a Proxy `get` trap instead of a plain object property read, multiplying the
  cost of every one of the passes above for large n.
- `virtualScrollerOptions` on the PrimeVue `DataTable` only virtualizes DOM row
  rendering — it does nothing to reduce the upstream JS cost of building
  `nodeCols`/`nodeRows`, which happens before the table can render anything.
- Compare with `metricsWorker.ts` / `communityWorker.ts`, which already
  establish the project's pattern for offloading full-graph-scan computation
  to a Web Worker so the main thread doesn't block.

**Root Cause:** `DataTablePanel.vue` performs multiple synchronous, unbounded,
full-array passes (type detection, option collection, row flattening) over the
complete node/edge dataset on first mount, over deeply-reactive Vue proxies —
with no sampling, chunking, or worker offload. For 200k+ elements this blocks
the main thread for many seconds, which the browser reports as a full UI
freeze.

**Status:** Root cause identified; fix approach pending user decision (see
conversation) between: (a) sampling for type/option detection + `toRaw()` to
strip proxy overhead (cheap, bounds cost independent of n), vs (b) moving
column/row-building to a Web Worker (consistent with existing
metrics/community worker pattern, higher effort), vs (c) hard row cap /
warning banner above a size threshold.

**Files Involved:**
- [frontend/src/components/DataTablePanel.vue](../../frontend/src/components/DataTablePanel.vue)
- [frontend/src/composables/useTableColumns.ts](../../frontend/src/composables/useTableColumns.ts)
- [frontend/src/stores/graph.ts](../../frontend/src/stores/graph.ts)

**Solution (implemented):** Attack the data-prep cost directly rather than the
data volume. A **row cap was explicitly rejected** by the user because it would
break analysis: PrimeVue filters/sorts the array it is given, so slicing the
data would limit filtering to the first N rows. The requirement was "the filter
must work over all the data; only the *rendering* of rows should be capped" —
and rendering is already capped by the existing `virtualScrollerOptions` (only
visible rows exist in the DOM). So the fix keeps the full dataset flowing to the
table and only makes the prep cheap:

1. **Sampled type detection** ([useTableColumns.ts](../../frontend/src/composables/useTableColumns.ts))
   — `detectType()` now evaluates the expensive per-value checks (`Number()`
   coercion + date-regex + `new Date()`) over at most `TYPE_SAMPLE_CAP = 5000`
   non-null values instead of the whole column. Categorical detection **and**
   `collectOptions()` stay a full scan (cheap: a `Set` that early-exits at the
   30-unique threshold), so a MultiSelect filter never misses a value that only
   appears beyond the sample. Consequence of sampling: only the *filter widget /
   match-mode* of a column can be affected — never which rows exist, match, or
   export. The single realistic failure mode (a column that is text for its
   first 5000 rows but numeric/date afterwards getting a text filter) is
   negligible and non-destructive.
2. **Proxy stripping** ([DataTablePanel.vue](../../frontend/src/components/DataTablePanel.vue))
   — `filteredNodes`/`filteredEdges` are snapshotted once through `toRaw()`
   (`rawNodes`/`rawEdges` computeds); every downstream hot loop (prop-key
   collection, `buildNodeColumns`/`edgeCols`, `flattenNodeRows`/`edgeRows`, and
   the edge scan in `syncGraphFilter`) reads plain objects instead of hitting
   the Vue reactive Proxy get-trap on every property access.

**Measured:** isolated micro-benchmark of `detectType` over 250k values —
old **24.6ms → new 0.7ms per column (~34×)**, identical classification. That
34× is *per property column and without proxy overhead*; in-app the `toRaw`
change removes a further ~5–10× proxy multiplier across all passes, turning the
old multi-second main-thread block into sub-millisecond detection plus a cheap
raw flatten.

**Files Modified:**
- [frontend/src/composables/useTableColumns.ts](../../frontend/src/composables/useTableColumns.ts) — `TYPE_SAMPLE_CAP`, sampled `detectType`.
- [frontend/src/components/DataTablePanel.vue](../../frontend/src/components/DataTablePanel.vue) — `toRaw` snapshots threaded through all full-array passes.
- [frontend/src/composables/__tests__/useTableColumns.test.ts](../../frontend/src/composables/__tests__/useTableColumns.test.ts) — 6 regression tests.

**Testing:**
- [x] `useTableColumns.test.ts` — 13/13 pass (6 new: numeric/date detection on
  sampled prefix, sampling bounded to prefix, high-cardinality still `text` when
  distinct values appear only past the sample, low-cardinality stays
  categorical at scale, `collectOptions` returns values beyond the sample).
- [x] `vitest related` on the three changed files — 29/29 pass.
- [x] `vue-tsc --noEmit` clean.
- [x] Micro-benchmark on 250k values confirming ~34× detection speedup with
  identical output.

**Follow-up (implemented same session): debounced table global search.**
PrimeVue re-filters the whole array on every `global.value` write (one O(n ×
fields) pass per keystroke), which janks the table search at 200k+ rows even
after the open-freeze fix. Added a reusable
[useDebouncedModel.ts](../../frontend/src/composables/useDebouncedModel.ts)
composable that bridges the input to the slow filter value: the input updates
instantly (responsive typing) while writes to `global.value` are debounced
(300ms), collapsing a burst of keystrokes into a single filter pass. External
resets to the target (tab switch, "Clear") flow back into the input and cancel
any pending write; because a null→null reset is a no-op the back-sync can't
observe, `clearFilters()` and the tab-switch watcher also blank `globalSearch`
explicitly. Wired into both [DataTablePanel.vue](../../frontend/src/components/DataTablePanel.vue)
and the generic [DataGrid.vue](../../frontend/src/components/DataGrid.vue).
Note: the graph-side [FilterPanel.vue](../../frontend/src/components/FilterPanel.vue)
already had its own inline 300ms search debounce (`applySearchDebounced`), so
that path was already covered.

Debounce reduces *how often* filtering runs, not the O(n) cost of each pass —
so a single settled search over 200k+ rows still costs one full scan. That
residual per-pass cost (shared by the table and the graph FilterPanel, whose
`searchMatchedNodeIds`/`searchHiddenNodeIds` each do a full `nodes.value`
scan) is a separate, still-open item; an index (prebuilt lowercased search
field, or a Web Worker scan) would be the fix if it ever needs to be
instant rather than merely non-janky.

**Files Modified (debounce follow-up):**
- [frontend/src/composables/useDebouncedModel.ts](../../frontend/src/composables/useDebouncedModel.ts) — new composable.
- [frontend/src/composables/__tests__/useDebouncedModel.test.ts](../../frontend/src/composables/__tests__/useDebouncedModel.test.ts) — 4 tests (init, debounce window, keystroke collapsing, distinct-value back-sync + cancel).
- [frontend/src/components/DataTablePanel.vue](../../frontend/src/components/DataTablePanel.vue) — debounced `globalSearch`, explicit reset on clear/tab-switch.
- [frontend/src/components/DataGrid.vue](../../frontend/src/components/DataGrid.vue) — debounced `globalSearch`, explicit reset on clear.

**Testing (debounce follow-up):** `useDebouncedModel` 4/4, `vitest related` on
all changed files 33/33, `vue-tsc --noEmit` clean.

**Status:** Fixed (open-freeze) + debounced table search. Per-pass O(n) search
cost noted as a separate future optimization.

---

## [2026-07-08 15:50] - Perf: pre-built search index for graph search + table global search

**Motivation:** Follow-up to the two items above. Debounce cut *how often*
search runs but not the O(n × fields) cost of each pass. On 200k+ graphs both
the graph-side search (FilterPanel → store) and the table global search stayed
slow because every pass re-ran `toLowerCase()` over every field of every row —
and the graph scan did so over Vue reactive proxies, three times per keystroke.
User asked to make search itself fast and to share the mechanism across the
filter and the table.

**Solution:** A shared, pre-computed lowercased search string per entity, built
once when data loads instead of per keystroke.

- New util [searchText.ts](../../frontend/src/utils/searchText.ts):
  `buildSearchText(values)` → single lowercased, NUL-joined string;
  `SEARCH_FIELD` (`__search`) constant. The NUL separator preserves
  "match within a single field" semantics (a query can't match across value
  boundaries).
- **Graph store** ([graph.ts](../../frontend/src/stores/graph.ts)): new
  `nodeSearchIndex` computed (`toRaw(nodes)` + `buildSearchText`, rebuilt only
  when `nodes` changes). `searchMatchedNodeIds` now scans that index
  (plain-string `includes`, no per-node `toLowerCase`, no Proxy).
  `searchHiddenNodeIds` iterates the index ids, and the `filteredNodes`
  hide-mode block now **reuses the `searchMatchedNodeIds` Set** instead of a
  third independent `toLowerCase` scan — three full scans per keystroke → one
  indexed scan + Set reuse.
- **Tables**: `flattenNodeRows` / `buildGenericRows` / `DataTablePanel`'s inline
  `edgeRows` now emit a `__search` field; both `DataTablePanel.vue` and
  `DataGrid.vue` set `globalFilterFields = [SEARCH_FIELD]`, so PrimeVue's global
  search scans one string per row instead of every column (~O(columns)×
  reduction). `__search` is not a rendered column and is excluded from
  column-driven CSV export.

**Measured:** micro-benchmark of the graph scan over 200k nodes (5 simulated
keystrokes) — **74.3ms → 37.3ms (2.0×)** on plain objects; the real-world gain
is larger because the old path also paid Proxy overhead the index avoids, and
hide-mode dropped from three scans per keystroke to one.

**Files Modified:**
- [frontend/src/utils/searchText.ts](../../frontend/src/utils/searchText.ts) — new shared helper.
- [frontend/src/utils/__tests__/searchText.test.ts](../../frontend/src/utils/__tests__/searchText.test.ts) — 5 tests.
- [frontend/src/stores/graph.ts](../../frontend/src/stores/graph.ts) — `nodeSearchIndex`; rewired matched/hidden/filteredNodes search.
- [frontend/src/composables/useTableColumns.ts](../../frontend/src/composables/useTableColumns.ts) — `__search` in `flattenNodeRows` / `buildGenericRows`.
- [frontend/src/composables/__tests__/useTableColumns.test.ts](../../frontend/src/composables/__tests__/useTableColumns.test.ts) — 2 `__search` tests.
- [frontend/src/components/DataTablePanel.vue](../../frontend/src/components/DataTablePanel.vue), [frontend/src/components/DataGrid.vue](../../frontend/src/components/DataGrid.vue) — `globalFilterFields = [SEARCH_FIELD]`, edge `__search`.

**Testing:**
- [x] `searchText` 5/5, `useTableColumns` 15/15.
- [x] `graph.filtering` 40/40 — existing search behavior preserved (the store
  rewrite is behavior-identical, verified against pre-existing
  `searchMatchedNodeIds`/`searchHiddenNodeIds` tests).
- [x] `vitest related` across all changed files — 290/290 pass (incl.
  `graph.largeGraph`, `FilterPanel`, `queryConsole`).
- [x] `vue-tsc --noEmit` clean.

**Status:** Fixed.
