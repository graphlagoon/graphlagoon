# Decision Log

## [2026-07-20] - Feature: Ego ring ordering strategies + same-ring edge arcs

**Purpose:** Dense ego networks rendered as a hairball. Two independent causes: (1) angular
position within each ring was decided by sorted-node-id — carrying neither meaning nor any
crossing optimization; (2) edges between nodes on the *same* ring were drawn as straight
chords across the disc interior, obscuring the radial BFS tree that is the layout's main
reading. This adds a ring-ordering strategy selector and arc routing for same-ring edges.

**Domain research shaped the design as much as the graph-drawing literature.** The tool
targets financial fraud/AML analysis, which rules out several standard decluttering moves:

- **Edge bundling rejected outright** (not deferred). It creates false connections that users
  demonstrably follow; it is topology-independent, so bundles are layout artifacts rather than
  structure; it finds apparent structure even in random disconnected edges; and it measurably
  degrades path-tracing — the analyst's second most common task. In an artifact that may be
  attached to a SAR filing, visually merging a legitimate transfer with one to a sanctioned
  shell fabricates a relationship.
- **Density-based edge fade rejected.** Fraud is low-frequency/high-consequence: the single
  transaction to the shell company *is* the case, and is exactly the outlier a fade discards.
  (Cf. OpenOwnership practice: ceased relationships are greyed, never removed.)
- **Degree-based filtering rejected.** The high-degree node is frequently the investigation
  target (mule aggregator, shared terminal, nominee director).

**Design decisions:**

1. **Strategies are mutually exclusive, not composable.** `ringOrdering` is one of
   `id | barycenter | node-type | community | property`. A ring's angle carries one meaning at
   a time, so two runs remain comparable. Composition (sector + barycenter tiebreak) was
   considered and rejected as harder to explain and test for marginal benefit.
2. **Determinism is the feature, not a side effect.** Ehlers et al. (*Computers & Graphics*
   125:104123, 2024) found **no significant task-performance difference between radial,
   layered and straight-line** ego representations. The justification for investing in the ring
   is therefore reproducibility/comparability — Krzywinski et al.'s hive-plot argument
   (*Brief. Bioinform.* 13(5), 2012) that force layouts lack a coordinate system and cannot be
   compared across runs. Fixed sweep counts, stable sorts and id tiebreaks throughout.
3. **Heterogeneity is a first-class requirement.** Graphs here are attribute-sparse: a node may
   simply lack the field being sectored by. Such nodes get a sentinel key and form **one
   contiguous trailing sector** — never scattered, never hidden ("these N nodes lack this
   field" is itself analyst-relevant). If *no* node carries the attribute, the layout falls
   back to id order and sets `ringOrderingDegraded`, which the panel surfaces rather than
   silently drawing a meaningless ordering. The panel also reports partial coverage.
4. **Arc routing, explicitly not bundling.** Same-ring edges follow their ring; the BFS tree
   stays dead straight; every edge remains individually traceable and selectable — precisely
   what bundling gives up. Curvature is clamped so an arc's peak never reaches the neighbouring
   ring (an arc invading its neighbour would read as passing through nodes it does not touch).

**Implementation:**

- `computeTreeLayout` gained `ringOrdering` / `ringOrderingKey` / `communityMap` options and
  now returns `parents` (BFS forest) and `ringOrderingDegraded`. Sibling reordering is the only
  degree of freedom used — it never breaks the DFS slot pass's subtree contiguity.
- Barycenter strategy: radial-Sugiyama sweeps (Bachmaier, *IEEE TVCG* 2007 — radial crossing
  minimization is NP-hard, hence a heuristic). Each subtree rotates toward the vector sum of
  its non-tree neighbours' angles, measured *relative to the parent's angle* so the 0/2π seam
  is harmless. 3 fixed sweeps.
- `computeEgoLinkCurvatures`: tree edges → 0; same-ring → `sign(Δ)·min(1.15·tan(|Δ|/4), kMax)`
  where `tan(|Δ|/4)` puts the Bézier peak exactly on the ring and `kMax` caps it at
  `r + 0.6·gap`; cross-ring non-tree → bounded gentle fan. The multi-edge fan value is
  composed additively and bounded on its own — clamping the *total* would have pulled wide arcs
  back inside their ring (caught by a test).
- Unreachable ring: under any non-`id` ordering, orphans are sorted by the circular mean of
  their reachable neighbours' angles instead of by id, removing the longest chords.

**Files Modified:**
- frontend/src/utils/layoutModes.ts — strategies, `circularMean`, `computeEgoLinkCurvatures`.
- frontend/src/types/graph.ts — `RingOrdering` type; 3 new `EgoLayoutConfig` fields.
- frontend/src/stores/graph.ts — defaults (`barycenter`, arcs on). Saved-state merge already
  spread defaults first, so old explorations pick up the new fields unchanged.
- frontend/src/components/GraphCanvas3D.vue — ego branch options; curvature application
  mirroring the hive path; `restoreHiveCurvatures` → `restoreModeCurvatures`; community watcher
  extended to ego.
- frontend/src/components/LayoutPanel.vue — ordering select, property picker, arc toggle,
  degradation/coverage hints, Graph Lens suggestion.
- frontend/src/utils/__tests__/layoutModes.test.ts, .../LayoutPanel.test.ts — 21 new tests.

**Testing:**
- [x] Full frontend suite green: **1140 tests / 64 files** (was 1119). `vue-tsc --noEmit` clean.
- [x] Regression test asserts the default path is bit-identical to explicit `ringOrdering: 'id'`.
- [x] Arc geometry verified numerically (Bézier midpoint evaluated against ring radius/headroom).
- [ ] Manual browser verification pending.

**Known limitations / follow-ups (deliberately out of scope):**
- **Parallel-edge aggregation** is likely the next largest win: multi-edge curvature saturates
  at ~4 edges (`STEP=0.15`, `CAP=0.6` in `graphAppearance.ts`), so N repeated transfers between
  one pair — the norm in transaction graphs, and the signature of structuring/smurfing — become
  a solid smear. NEVA (*CGF* 39(6), 2020) aggregates to one edge with width = frequency plus a
  linked temporal view. Blocked on there being no per-edge weight encoding at all today
  (`edgeWidth` is a single global slider; no `numericEdgeProperties` counterpart exists).
- **Tapered edges** for direction (Holten et al., PacificVis 2011 — beat arrowheads specifically
  at high-degree vertices, i.e. the dense hub case). Requires submodule geometry changes.
- **Motif glyphs** (fan = smurfing, connector = intermediary; Dunne & Shneiderman, CHI 2013).
- Semantic-angle-by-flow-direction was considered and dropped: it presumes meaningfully
  bidirectional edges, which the shipped IEEE-CIS pipeline does not have (all edges radiate
  outward from Transaction nodes, so in/out hemispheres would be degenerate).

**Status:** Superseded by the follow-up below (3 bugs found and fixed).

## [2026-07-21] - Fix: 3 geometry bugs in the ego ring layout + UX for no-op controls

**Purpose:** Post-implementation introspection of the entry above, with every claim measured
against the real `computeTreeLayout` / `computeEgoLinkCurvatures` (not standalone simulation).
Found 3 confirmed bugs and 2 fragilities; also closed the UX gap where several ego controls
could be silent no-ops depending on graph shape.

**Bugs found and fixed (measured before → after):**

1. **`nodeSpacing` was an average, not a minimum.** `capacityRadius = count·nodeSpacing/2π`
   assumes an even angular spread, but the tidy-tree allocates angular width per **leaf**, not
   per ring member. A ring mixing a deep bushy subtree with a shallow one packed the shallow
   side far tighter than the average implied. Measured on a hub(10×5 leaves) + chain(5 leaves)
   fixture — the convergence-star shape of the IEEE-CIS pipeline, so the worst case is the
   common case: **ring 2 arc 13.7 against a contract of 26** (1.9×, nodes overlapping).
   Fix: resolve angles first (they depend only on slots, never on radius), then size each ring
   by its actual tightest circular gap: `radius = max(prev + levelSpacing, capacityRadius,
   nodeSpacing / minCircularGap)`. Bounded by `nodeSpacing·totalSlots/2π` since two ring
   members are always ≥ 1 slot apart. `capacityRadius` retained as a floor, so uniform fixtures
   (and the `[60,145,210]` radius regression) are unchanged. **After: 26.0.**

2. **The "never invade the next ring" clamp was defeated by multi-edges.** The arc was clamped
   to peak ≤ `r + 0.6·gap`, then the multi-edge fan was added *afterwards*. With the fan at its
   CAP of 0.6: **peak 343.8 with the next ring at 260**. Parallel transfers are the norm in
   transaction graphs, so this fired constantly. Fix: compute the headroom left by the arc and
   rescale the fan linearly into it (`fanScale = min(1, headroom / 0.6)`, ceiling
   `r + 0.9·gap`). Parallel edges stay ordered and distinct, just compressed. **After: 254.0.**

3. **Single-ring ego graphs lost their arcs entirely.** `gapByLevel` seeded `lastGap = 0`, so a
   lone `levelStat` yielded `gap = 0` → `peakLimit = radius` → the arc flattened exactly onto
   the ring. `maxHops = 1` is a common setting and hit this every time. Fix: fall back to
   `levelSpacing` (passed through `EgoCurvatureDeps`) when there is no ring outward.
   **After: peak 201.02 vs radius 200.**

**Fragilities also fixed:** (a) near-antipodal endpoints sat on the `wrapToPi` seam where
sub-pixel jitter flipped the arc's side — now resolved by the same id-based tiebreak already
used for radially collinear pairs; (b) the cross-ring bow scaled with chord length
(chord 521 × k 0.3 = 156px displacement), letting a ring-1→ring-5 edge sweep across every ring
between — now capped in world units at `0.5·levelSpacing`.

**Checked and found NOT to be bugs:** the quadratic Bézier's midpoint *is* its true maximum
(the curve is symmetric — verified by sweeping t ∈ [0,1]), so clamping the midpoint does bound
the whole arc; and measuring the outermost real ring's gap against the unreachable ring is
acceptable behaviour.

**UX — the rings now explain themselves:**
- Ring guide labels carry population: `"1 · 3"`, `"2 · 450"`, `"unreachable · 12"`. "Where is
  the mass?" is the first thing read off an ego view and previously required counting dots.
- `computeTreeLayout` now returns `nonTreeEdgeCount` / `sameRingEdgeCount`, published to
  `graphStore.egoLayoutStats` (derived, not persisted). The panel uses them to say when a
  control is a **no-op on this graph**: crossing reduction has nothing to uncross in a pure
  convergence star (zero non-tree edges — the common fraud-attribute shape), and same-ring arcs
  have nothing to redraw when no edge joins two nodes on one ring. Previously the user toggled
  these and nothing happened, with no explanation.
- A hint states that ego pins nodes analytically, so the simulation controls do not apply — and
  that the same graph always yields the same picture, which is the property that makes two ego
  views comparable (the reason to prefer radial at all, per Ehlers et al. 2024).
- **Progressive disclosure**, matching the force-directed block's existing `Advanced` toggle.
  The ego block had grown to ~8 controls and 5 hints, all flat. Split by "what does the analyst
  reach for to answer a question?": **visible** = focus node, direction, edge types, max hops,
  ring ordering (the analytical choices); **Advanced** = ring spacing, same-ring arcs, and the
  pinning/lens explanations (visual refinement, set once). Reuses the existing
  `.advanced-toggle` markup and CSS rather than inventing a second disclosure idiom.

**Files Modified:**
- frontend/src/utils/layoutModes.ts — `minCircularGap`; angles-before-radii; fan rescaling;
  gap fallback; sign stability; cross-ring offset cap; edge-shape counts; labels with counts.
- frontend/src/stores/graph.ts — `egoLayoutStats` (+ reset).
- frontend/src/components/GraphCanvas3D.vue — publish/clear stats; pass `levelSpacing`.
- frontend/src/components/LayoutPanel.vue — 3 new hints; `Advanced` disclosure for the ego block.
- frontend/src/utils/__tests__/layoutModes.test.ts, .../LayoutPanel.test.ts — 12 new tests.

**Testing:**
- [x] Full suite green: **1152 tests / 64 files** (was 1140). `vue-tsc --noEmit` clean.
- [x] All three bugs re-measured against the fixed code (numbers above).
- [x] Two pre-existing curvature tests updated — they had encoded the broken additive
      composition; the contract is now "fan compressed into remaining headroom, order preserved".
- [ ] Manual browser verification still pending (unchanged from the previous entry).

**Status:** Implemented, unit-tested and numerically verified; manual verification pending.

## [2026-07-21] - Feature: circular sifting — the crossing reduction was nearly useless

**Purpose:** Asked whether "fewest crossings" had tunable parameters, we benchmarked what it
actually achieves. The answer was uncomfortable: on a 40-node convergence star with 60 lateral
edges, **455 → 443 crossings, a 2.6% reduction** — against the ~30% the radial-Sugiyama
literature reports. The shipped default was close to a placebo.

**Root cause (structural, not a tuning problem):** the barycenter implementation reorders
*siblings within each parent*. On a convergence star — one focus, every alter a direct child —
there is exactly one parent, so the algorithm degenerates to "sort 40 siblings by mean neighbour
angle". That is a **circular seriation** problem: the target angles are computed from positions
the sort is about to change, so a single ordering pass cannot converge. More sweeps do not help.
This is precisely the shape the IEEE-CIS pipeline produces, so the weakest case was the common
one. Note the existing no-op hint did *not* cover this: there were 58 non-tree edges, so nothing
warned that the pass was achieving almost nothing.

**Implementation — `crossingHeuristic`, three deterministic options:**

| Heuristic | Crossings (40-node star) | Time | Notes |
|---|---|---|---|
| `barycenter` | 443 (−2.6%) | 1.4ms | previous default; sibling sweeps by mean angle |
| `median` | 429 (−5.7%) | 2.7ms | circular median; Eades & Wormald (1994) 3-approximation, which the mean lacks |
| **`sifting`** | **71 (−84%)** | 29ms | circular sifting (Baur & Brandes, GD 2004) — **new default** |

Sifting lifts each node out of the ring, tries every position, and keeps the one that crosses
least, counting real chord crossings. It works on the ring itself rather than on sibling order,
which is the lever the sweeps do not have. Applied per sibling group so subtree sectors stay
contiguous; strict-improvement-only with lowest-index tie-breaks keeps it deterministic.

**Cost control (the interesting engineering constraint).** A naive implementation recounted all
crossings for every trial position — O(n³·E²), measured at 40→77ms, 150→9.4s, **250→68s**, which
would freeze the UI. Rewritten to count only the crossings involving the moved node (its delta
is all sifting needs): 40→29ms, 80→217ms, 150→1.4s, 250→7.5s. Still steep, so
`siftingMaxRingSize` defaults to **100** — the layout re-runs inside a 150ms debounce, and rings
past that keep the cheap sweeps and set `siftingSkippedLargeRing`, which the panel reports.
Earlier draft used 400; the measurements showed that was ~30 seconds of frozen UI.

**Parameters exposed** (in the ego Advanced disclosure, per the previous entry's split):
`crossingHeuristic` select, and a `crossingSweeps` slider (0–8) shown only for the sweep-based
heuristics, since sifting ignores it. Determinism is preserved — the user picks *which*
deterministic algorithm runs, not a randomness level; the same graph plus the same settings still
yields the same picture, which is the property the whole radial layout is justified on.
A hint warns that the sweep heuristics are weak on hub-dominated graphs.

**Files Modified:**
- frontend/src/utils/layoutModes.ts — `circularMedian`, `chordsCross`, `siftRingOrder`;
  `crossingHeuristic` / `crossingSweeps` / `siftingMaxRingSize` options; `siftingSkippedLargeRing`.
- frontend/src/types/graph.ts — `CrossingHeuristic`; 2 new `EgoLayoutConfig` fields.
- frontend/src/stores/graph.ts — defaults (`sifting`, 3 sweeps); stat field.
- frontend/src/components/GraphCanvas3D.vue — pass the options through, publish the skip flag.
- frontend/src/components/LayoutPanel.vue — heuristic select, sweeps slider, 2 hints.
- frontend/src/utils/__tests__/layoutModes.test.ts, .../LayoutPanel.test.ts — 14 new tests,
  including a geometric crossing counter asserting sifting beats the sweeps by >50%.

**Testing:**
- [x] Full suite green: **1166 tests / 64 files** (was 1152). `vue-tsc --noEmit` clean.
- [x] Crossing counts and timings measured directly (tables above), not estimated.
- [ ] Manual browser verification still pending.

**Known limitation:** sifting's cost is superlinear, so the largest rings — arguably where
uncrossing matters most — fall back to the weak sweeps. A bounded-window variant (only trying
positions near the node's current one) would extend the budget considerably and is the obvious
next step if large rings prove important.

**Follow-up the same day — the default was wrong, and the guard was one-dimensional.**

Shipping sifting as the default was a bad call, made from a single 40-node fixture. Broader
measurement showed the cost curve depends on **size × density**, which a size-only cap misses:

| ring | lateral edges | sifting | median |
|---|---|---|---|
| 40 | 1.5·N | 25ms | 0.4ms |
| 80 | 1.5·N | 199ms | 0.4ms |
| 100 | 0.5·N | 66ms | 0.4ms |
| 100 | 1.5·N | **440ms** | 0.8ms |

440ms is ~3× the 150ms debounce, and the layout re-runs on *every* config nudge — dragging the
ring-spacing slider would have stuttered badly. Two corrections:

1. **Default reverted to `barycenter`** — the cheapest option and the one already in production,
   so this feature adds capability without changing anyone's default behaviour or cost. (An
   intermediate revision defaulted to `median`, which is marginally better for the same order of
   cost — 429 vs 443 crossings — but that was an unforced change of a shipped default; keeping
   the incumbent is the smaller claim.) Median and sifting are both selectable, and the UI states
   sifting's cost. The strongest algorithm should be opt-in when it is 500× more expensive.
2. **`siftingWorkBudget`** (ring size × ring chords) replaces the size-only cap as the real
   guard, since density matters as much as size. Calibrated empirically rather than derived:
   20000 still allowed a 209ms ring; 6000 rejected nearly every ring above 60 nodes; **10000**
   lands at ~89ms worst case while still sifting about half the sampled shapes. `siftingMaxRingSize`
   remains as a coarse first gate (150).

Added a test asserting the budget rejects a ring that is too **dense** at a size the cap allows —
the case the previous guard would have waved through.

## [2026-07-17] - Fix: `nodePropertyIconConfigs` silently dropped by backend on exploration save

**Purpose:** Same bug class as the `layout_mode_config` fix below, found during that
investigation and fixed as a follow-up: the frontend saves and restores
`nodePropertyIconConfigs` (per-node-type property→icon mapping) in the exploration state, but
the backend `ExplorationState` Pydantic schema never declared the field, so Pydantic v2's
default `extra="ignore"` stripped it on every save — the mapping was lost on reload.

**Implementation:** one-line schema addition (`nodePropertyIconConfigs: Optional[dict] = None`,
opaque-dict pattern), plus a first frontend restore test for the field (the existing
save/load wiring in `graph.ts` was already correct and needed no changes).

**Files Modified:**
- api/graphlagoon/models/schemas.py — added `nodePropertyIconConfigs: Optional[dict]` to
  `ExplorationState`.
- frontend/src/stores/__tests__/graph.actions.test.ts — added `loadExploration` restore test
  (field previously had zero test coverage).

**Testing:**
- [x] Full frontend suite green: 1097 tests. Full backend suite green: 266 passed, 1 skipped.

**Status:** Implemented.

## [2026-07-17] - Fix: layout persistence gap in Exploration (`layout_mode_config`, `force3DSettings`)

**Purpose:** User asked whether the selected layout is saved in an exploration the same way
communities are. Investigation found `layout_algorithm` (which layout mode is active) already
round-trips correctly, but two other layout-related pieces of state did not:

1. **Bug:** `layout_mode_config` (per-mode params for ego/hive/hierarchical layouts) was already
   built and sent by the frontend on every save (`getExplorationState()`), and `loadExploration()`
   already knew how to restore it — but the backend `ExplorationState` Pydantic schema never
   declared the field. Since no `model_config = {"extra": ...}` is set anywhere in
   `schemas.py`, Pydantic v2's default `extra="ignore"` silently dropped it on every save, so any
   saved exploration lost its ego/hive/hierarchical parameters on reload.
2. **Gap:** `force3DSettings` (the d3-force-3d simulation params used in `LayoutPanel.vue` — charge
   strength, link distance, gravity, collision, pointer repulsion/vacuum, clipping plane) was not
   persisted anywhere at all, frontend or backend. It always reset to hardcoded defaults on reload.

**Design Decisions:**
1. **`Optional[dict]` opaque fields on the backend**, matching the exact existing pattern used by
   `community`, `clusters`, `behaviors`, `aesthetics`, `similarity` — no typed Pydantic sub-schema.
   The `Exploration.state` DB column is a single generic JSON blob, so no migration was needed.
2. **`force3d_settings` (snake_case) as the wire/schema field name**, distinct from the store's
   `force3DSettings` (camelCase) ref — mirrors the existing `layout_mode_config`/`layoutModeConfig`
   naming split.
3. **Extracted `defaultForce3DSettings()` factory** (previously an inline object literal on the ref
   declaration) so the same defaults can be reused for initialization, the `loadExploration()`
   merge-over-defaults restore, and `resetExploration()` — same pattern as `DEFAULT_BEHAVIORS`.
4. **No backend test added**: confirmed the same-pattern fields (`community`, `clusters`,
   `behaviors`, `aesthetics`) have no dedicated backend round-trip test either — the convention
   relies on frontend tests plus the fields being untyped passthrough JSON.
5. **Sanitizing merge on restore (`mergeForce3DSettings`)**, found in self-review: the initial
   naive spread (`{...defaults, ...saved}`) had a real bug — `d3DistanceMax: Infinity` cannot be
   represented in JSON and round-trips as `null`; spread raw, that `null` reaches d3-force's
   `distanceMax()` setter (`null*null = 0`) and silently disables node repulsion after a single
   save/load cycle. The merge now keeps only keys present in the defaults whose saved value has
   the same `typeof` as the default — which simultaneously fixes the Infinity/null round-trip,
   drops wrong-typed corrupted values, and prevents keys removed from the schema in the future
   from riding along in store state.

**Files Modified:**
- api/graphlagoon/models/schemas.py — added `layout_mode_config: Optional[dict]` and
  `force3d_settings: Optional[dict]` to `ExplorationState`.
- frontend/src/types/graph.ts — added `force3d_settings?: Record<string, unknown>` to
  `ExplorationState` (`layout_mode_config` was already declared).
- frontend/src/stores/graph.ts — extracted `defaultForce3DSettings()`; wired `force3DSettings` into
  `getExplorationState()`, `loadExploration()` (merge over defaults), and `resetExploration()`.
- frontend/src/stores/__tests__/graph.exploration.test.ts — added `force3DSettings persistence`
  describe block (default/updated capture, cross-Pinia-instance restore, legacy-exploration
  defaults).
- frontend/src/stores/__tests__/graph.actions.test.ts — added `force3d_settings` cases to the
  existing `loadExploration layout migration` describe block (mocked `api.getExploration`),
  including corrupted/stale-value cases (null from JSON Infinity, wrong type, removed key,
  non-object blob).

**Testing:**
- [x] Full frontend suite green: 1096 tests, 63 files.
- [x] `npx vue-tsc --noEmit` clean.
- [x] Full backend suite green: 266 passed, 1 skipped (pre-existing).

**Status:** Implemented.

## [2026-07-17 10:25] - Feature: cluster programs with context/exploration scope (`graph_contexts.cluster_programs`)

**Purpose:** A cluster program created today did not appear when opening an already-saved
exploration of the same context. Root cause: programs were persisted **only** inside each
exploration's `state.clusters.programs` blob, and `clusterStore.loadState()` replaced the whole
`programs` array with that snapshot — a program created after the exploration was saved was wiped.

**Design Decisions:**
1. **New JSON column `graph_contexts.cluster_programs` (migration 009)**, mirroring the
   `default_behaviors` pattern exactly: opaque `list[dict]` pass-through in Pydantic, the frontend
   owns the shape. The existing `PUT /api/graph-contexts/{id}` already does partial updates (all
   `GraphContextUpdate` fields are `Optional`), so no new endpoint.
2. **Dual scope (user-requested):** `ClusterProgram.scope: 'context' | 'exploration'`.
   Context-scoped programs are shared by all explorations and auto-saved (debounced 500 ms) on
   create/update/delete; exploration-scoped ones keep living inside the exploration state as
   before. The editor modal shows a "Save to" radio **only when the user has write access to the
   context** — otherwise the program is silently exploration-scoped (users with write access only
   on a shared exploration can't write to the context anyway).
3. **Built-in defaults are never persisted.** The 3 built-ins (orphan / group-by-type / BFS,
   stable ids in `DEFAULT_PROGRAM_IDS`) are recreated from code on every hydration, filtered out
   of every persist payload, and now **formally undeletable** (`deleteProgram` returns false; the
   panel hides the delete button). Editing a built-in works in-session but reverts on reload —
   documented limitation; a context program with a default's id defensively shadows the built-in.
4. **Back-compat by merge-import:** `loadState()` no longer replaces programs. Legacy programs
   (no `scope`) found in old exploration states are imported into the context (and persisted)
   when the user has context write access, kept exploration-local otherwise; ids already present
   are skipped (context wins). New exploration saves embed only exploration-scoped programs.
5. **Hydration is the single reset path:** `loadContext` and `clearAll`/`clearPrograms` all go
   through `hydrateProgramsFromContext(currentContext?.cluster_programs)` — no cross-context
   leakage, and an `isHydrating` guard ensures hydration never fires a PUT.

**Files Created:**
- [api/graphlagoon/alembic/versions/009_add_context_cluster_programs.py](../../api/graphlagoon/alembic/versions/009_add_context_cluster_programs.py)
- [api/tests/test_context_cluster_programs.py](../../api/tests/test_context_cluster_programs.py) (29 tests)
- [frontend/src/stores/__tests__/graph.contextClusterPrograms.test.ts](../../frontend/src/stores/__tests__/graph.contextClusterPrograms.test.ts)

**Files Modified:**
- Backend: `db/models.py`, `db/memory_store.py`, `models/schemas.py`, `routers/graph_contexts.py` (all four `default_behaviors` touch points mirrored)
- Frontend core: `stores/cluster.ts` (scope resolution, debounced `persistProgramsToContext`, `hydrateProgramsFromContext`, merge-`loadState`, filtered `getState`, delete guard, exported `DEFAULT_PROGRAM_IDS`/`isDefaultProgramId`), `stores/graph.ts` (`loadContext` hydrates)
- Frontend types: `types/cluster.ts` (`ClusterProgramScope`), `types/graph.ts` (`cluster_programs` on context + create request)
- UI: `ClusterProgramEditorModal.vue` (scope radio, permission-gated), `ClusterProgramPanel.vue` (scope badges, delete hidden for built-ins), `GraphVisualizationView.vue` (`flushPersist()` on unmount)
- Tests updated: `cluster.test.ts` (+19 new), `useClusterProgramMenuActions.test.ts`, `ClusterProgramEditorModal.test.ts` (+3)

**Testing:** frontend 1088/1088 (`npm run test:run`), backend 266 passed + 1 skipped
(`uv run pytest`), `vue-tsc --noEmit` clean.

**Known Limitations / accepted risks:**
- One-time resurrection: a pre-change exploration saved with program P re-imports P after it was
  deleted from the context; re-saving that exploration ends the loop.
- Exploration-scoped programs not yet saved into an exploration are lost on reload (same as before).
- Multi-tab: last-write-wins on the whole `cluster_programs` array.
- A debounced persist within 500 ms of navigation is flushed by `onUnmounted`, but a hard tab
  close can still drop it.

## [2026-07-13 16:30] - Feature: opening a context runs no query by default (`behaviors.autoLoadOnOpen`)

**Purpose:** Opening a context always fired an implicit `GET /subgraph` with `edge_limit: 1000`
("load all nodes"). On large graphs that's expensive and almost never what the user wants in the
first second. The default is now **fetch nothing**; a context opts in to auto-loading.

**Design Decisions:**
1. **No new DB column — reused the opaque `default_behaviors` JSON.** The user explicitly asked to
   avoid a new parameter if possible, and it was: `graph_contexts.default_behaviors` (migration 007)
   is `Column(JSON)` in the DB and a bare `dict` in Pydantic — the backend **never inspects the
   keys**, it just passes the dict through. So `autoLoadOnOpen` is just another key in it: **zero
   migration, zero backend change** (the API suite stayed at 184 passing, untouched), and it
   inherits the whole precedence chain for free:
   `built-in < server config < context < user's panel < saved exploration`.
2. **Gated exactly two call sites, deliberately not a third.** `loadSubgraph` has three callers:
   GraphVisualizationView's `onMounted` and its `watch(contextId)` — both gated — and
   [graph.ts:1736](frontend/src/stores/graph.ts#L1736), the fallback inside `loadExploration` for
   explorations saved without a `graph_query`. That one is **left alone**: gating it would make
   saved explorations open empty and useless.
3. **No new UI.** An empty state already existed
   ([GraphVisualizationView.vue:238](frontend/src/views/GraphVisualizationView.vue#L238)): *"No nodes
   to display — Run a query to start visualizing your graph"*. It is exactly the UX the new default
   needs, so: no "Load graph" button, no auto-opening the query panel.
4. **Fixed a dead end the flip would otherwise create.** The query panel pre-fills a BFS example from
   `generateBfsExampleQuery`, which seeds from a **random node already on screen**. With an empty
   graph there is no seed, and it fell through to a literal placeholder
   (`MATCH (root { node_id: "{node_id_value}" })`) that **cannot run** — and the user had no node on
   screen to copy an id from. Now, with no nodes, it emits a runnable seedless edge scan:
   `MATCH ()-[r]-() RETURN r LIMIT 1000` (user-confirmed as working through the transpiler). With
   nodes present, the BFS is unchanged. Both still project `RETURN r`, per the backend contract
   documented at [exampleQuery.ts:6](frontend/src/utils/exampleQuery.ts#L6).

**Files Modified:**
- [frontend/src/stores/graph.ts](frontend/src/stores/graph.ts) — `autoLoadOnOpen: false` in `DEFAULT_BEHAVIORS`
- [frontend/src/views/GraphVisualizationView.vue](frontend/src/views/GraphVisualizationView.vue) — gate both `loadSubgraph({})` calls (state resets stay outside the guard)
- [frontend/src/utils/exampleQuery.ts](frontend/src/utils/exampleQuery.ts) — seedless runnable query when no nodes
- [frontend/src/components/BehaviorPanel.vue](frontend/src/components/BehaviorPanel.vue) — "Load graph on open" checkbox (Reset needed no change — it delegates to `resolveInitialBehaviors()`)
- [frontend/src/views/ContextsView.vue](frontend/src/views/ContextsView.vue) — placeholder now shows `{"autoLoadOnOpen": true}`
- [frontend/e2e/fixtures/mock-data.ts](frontend/e2e/fixtures/mock-data.ts) — `MOCK_CONTEXT` opts in; new `MOCK_CONTEXT_NO_AUTOLOAD`
- [frontend/e2e/perf-report.ts](frontend/e2e/perf-report.ts) — opt in, or the harness would silently benchmark an **empty** graph

**Testing:**
- [x] **E2E: 80 passing.** The new test is the one that matters — it opens a context without the
      opt-in and asserts **no `/subgraph` request is ever made** (listening on `page.on('request')`),
      plus `0 nodes` / `0 edges` and the empty state. That proves the feature end-to-end in a real
      browser, not just the store state.
- [x] Unit: **846 passing / 48 files** (was 838). Rewrote 3 `exampleQuery` tests that asserted the
      old placeholder — they encoded the very dead end being fixed. New assertions: the seedless
      query contains **no** `{`-placeholder, does contain `RETURN r`, and doesn't reference
      `node_id_col` at all.
- [x] Store tests: context opt-in seeds `autoLoadOnOpen`, and switching to a context **without** it
      drops the previous context's opt-in (no leak).
- [x] **API: 184 passing, untouched** — the proof that no backend/DB work was needed.
- [x] `vue-tsc --noEmit` clean.

**Known Limitations:**
- Not exercised by hand in a browser (E2E covers the flow, including the no-fetch assertion).
- Existing contexts in the DB have `default_behaviors = {}`, so they all adopt the new default and
  will open empty. That is the intended behavior change, but it **is** a change for every existing
  context; a user who wants the old feel ticks "Load graph on open" or sets it on the context.

**Status:** Implemented.

## [2026-07-13 15:52] - Feature: Google-Maps-style cursor-locked pan (`behaviors.mapStylePan`)

**Purpose:** Right-drag pan felt wrong — the graph didn't follow the mouse. Make it feel like
Google Maps: whatever you grab stays under the cursor.

**Investigation (three defects, none of them taste):** The term is right — TrackballControls
maps `RIGHT: MOUSE.PAN` and the handler is `_panCamera()`. The app never overrides its
settings, so we inherited all three:
1. **`panSpeed = 0.3`** — the world moves at a third of the mouse. Whatever you grab slides
   out from under the cursor *by construction*. This is the main culprit.
2. **Upstream ortho bug** (TrackballControls.js:268): `scale_y` divides by `clientWidth`
   instead of `clientHeight`. Ortho is our default, so **vertical pan is off by a factor of
   `aspect`** — ~1.78x too slow on 16:9. OrbitControls gets this right and even comments on
   it ("we use only clientHeight here so aspect ratio does not distort speed",
   OrbitControls.js:603). Research found **no upstream issue** for this — treat as unreported.
3. `multiplyScalar(_eye.length())` — distance-scaled, same shape as the zoom problem.

**Design Decisions:**
1. **Kept TrackballControls; did not switch to MapControls.** MapControls is just
   OrbitControls + `screenSpacePanning=false` + swapped buttons, and critically it **does not
   actually lock the point under the cursor** — its `2*delta*targetDistance/clientHeight` is
   exact only on the plane through `target`. (Tell: upstream added `zoomToCursor` but never a
   `panToCursor`.) Swapping would also have meant re-deriving 2D lock, axis-constrained
   rotation, and the context-menu drag detection — all for an approximation.
2. **Exact math, no raycast.** The canonical cursor-lock technique raycasts an anchor plane
   each move. For our *patched* ortho camera we don't need it: the projection makes the
   visible extent `ORTHO_FRUSTUM_SIZE*aspect/zoom` wide and `ORTHO_FRUSTUM_SIZE/zoom` tall, so
   with `aspect = clientWidth/clientHeight`, world-per-pixel collapses to the **same value on
   both axes**: `ORTHO_FRUSTUM_SIZE / (zoom * clientHeight)`. Move camera+target by exactly
   that and the grab cannot drift. This kills the aspect bug as a side effect.
   Perspective has no single answer (world-per-pixel varies with depth), so we solve at the
   target's depth — exact for anything on that plane, same as OrbitControls.
3. **Screen basis from the camera matrix** (`setFromMatrixColumn` 0/1), not world axes — so
   pan stays correct under any rotation, including the axis-constrained 3D views.
4. **Default ON** (`mapStylePan: true`). Unlike the (since-reverted) constant-zoom toggle,
   the old pan isn't a legitimate alternative — it's simply defective (panSpeed 0.3 + the
   aspect bug), so there's no taste trade-off to preserve.
5. **Extended the existing right-click `mousedown` handler** rather than adding a competing
   one: it already does drag-vs-click detection so the context menu only opens on a
   *stationary* right-click. Right-drag was therefore already the pan gesture — no conflict.
   `mousemove`/`mouseup` listen on `window` so a drag that leaves the canvas still tracks and
   still ends.

**Files Modified:**
- [frontend/src/stores/graph.ts](frontend/src/stores/graph.ts) — `mapStylePan: true`
- [frontend/src/composables/useGraphCamera.ts](frontend/src/composables/useGraphCamera.ts) — `syncPanMode()`, `applyMapStylePan()`
- [frontend/src/components/GraphCanvas3D.vue](frontend/src/components/GraphCanvas3D.vue) — pan drag handlers + listener cleanup + init/watcher
- [frontend/src/components/BehaviorPanel.vue](frontend/src/components/BehaviorPanel.vue) — checkbox (Reset needed no change — it already delegates to `resolveInitialBehaviors()`)

**Files Created:**
- [frontend/src/composables/__tests__/useGraphCamera.pan.test.ts](frontend/src/composables/__tests__/useGraphCamera.pan.test.ts)

**Testing:**
- [x] 12 pan tests. The load-bearing ones **project the grabbed world point through the real
      projection matrix** and assert it moved exactly `dx`/`dy` screen pixels — a genuine
      cursor-lock proof, not a restatement of the formula. Ortho at zoom 0.25/1/4, plus
      perspective at target depth. Also: **equal vertical and horizontal rates on a 16:9
      viewport** (the upstream bug, pinned), world follows the drag (not against it), zoom
      scaling, rigid camera+target translation, redraw.
- [x] 4 panel tests: default on, untick, checkbox reflects store, Reset restores.
- [x] Full frontend suite: **857 passed / 49 files** (was 841). `vue-tsc` clean.

**Known Limitations:**
- **Not exercised in a browser** — verification is numeric (projection-matrix round-trip).
  The feel should be confirmed by hand.
- **Touch/trackpad pinch-pan still goes through TrackballControls** (`TOUCH_ZOOM_PAN`), which
  `noPan` does not cover — same gap as the zoom work. Wheel and right-drag are ours; touch
  is not.
- Perspective lock is exact only at the target's depth plane (unavoidable without a raycast
  anchor); ortho — our default — is exact everywhere.

**Status:** Implemented.

## [2026-07-13 15:32] - Feature: per-context default behaviors (`GraphContext.default_behaviors`)

**Purpose:** Set graph behavior defaults at context-creation time. Different graphs want
different defaults — a 100k-node graph and a 500-node one don't want the same view mode,
label density or zoom feel — and a single server-wide setting can't express that.

**Design Decisions:**
1. **Required a real DB migration (007).** Unlike the exploration `behaviors` (which rode
   along in an existing free-form blob), `graph_contexts` has **no free-form JSON column** —
   every field (`edge_structure`, `node_structure`, …) is structural and typed. So: new
   `default_behaviors` JSON column + Alembic `007` (copying 006's inspector-guarded,
   idempotent `add_column`) + `MemoryGraphContext` dataclass field + both branches of
   create/update in the router.
2. **Precedence: built-in < server config < context < user panel < exploration.**
   The user chose *exploration wins* over *context wins*: the context is a **starting
   default**, not a policy lock. If someone deliberately saved an exploration in 2D, reopening
   it must not silently force it to 3D because the context says so.
   **This fell out for free** — `loadContext` runs before `loadExploration`
   (GraphVisualizationView), and `loadExploration` merges saved behaviors over whatever is
   current. No ordering change needed.
3. **The seam is `loadContext`, and it *re-resolves* rather than merges.** `clear()` does
   **not** reset `behaviors`, so merging would have leaked the previous context's settings
   into the next one on a context switch. Re-resolving from scratch
   (`resolveInitialBehaviors(ctx.default_behaviors)`) fixes that. There's a test for exactly
   this trap.
4. **Reused the existing validator, generalized.** `resolveInitialBehaviors()` now takes an
   optional context-overrides arg and layers server-then-context through a shared
   `applyBehaviorOverrides()`. Same defence as before (unknown keys dropped, per-key typeof
   mismatch rejected) — which matters more here, since a context's behaviors get serialized
   into every exploration saved from it.
5. **UI: a JSON textarea, not 23 form controls.** Replicating the whole Behaviors panel
   inside the create-context modal would be a maintenance sink; the textarea matches the
   opaque dict the backend already passes through. Parse errors are shown inline and
   **disable the submit button**, with a redundant guard in the handler so a malformed dict
   can never reach the API.

**Follow-on fix:** `BehaviorPanel.resetBehaviors()` would now have been wrong — it reset to
the *server* defaults, ignoring the context's. It now passes
`graphStore.currentContext?.default_behaviors` to the resolver.

**Files Modified:**
- [api/graphlagoon/models/schemas.py](api/graphlagoon/models/schemas.py) — field on Create/Update/Response
- [api/graphlagoon/db/models.py](api/graphlagoon/db/models.py) — `default_behaviors` JSON column
- [api/graphlagoon/db/memory_store.py](api/graphlagoon/db/memory_store.py) — dataclass field + `create_graph_context` param (update path already worked via its `setattr` loop)
- [api/graphlagoon/routers/graph_contexts.py](api/graphlagoon/routers/graph_contexts.py) — `context_to_response` (with `or {}` for pre-migration NULL rows) + both branches of create and update
- [frontend/src/types/graph.ts](frontend/src/types/graph.ts) — `GraphContext` + `CreateGraphContextRequest`
- [frontend/src/stores/graph.ts](frontend/src/stores/graph.ts) — `applyBehaviorOverrides()`, `resolveInitialBehaviors(contextBehaviors?)`, seeding in `loadContext`
- [frontend/src/views/ContextsView.vue](frontend/src/views/ContextsView.vue) — JSON textarea + validation + payload + form reset
- [frontend/src/components/BehaviorPanel.vue](frontend/src/components/BehaviorPanel.vue) — Reset honours the context

**Files Created:**
- [api/graphlagoon/alembic/versions/007_add_context_default_behaviors.py](api/graphlagoon/alembic/versions/007_add_context_default_behaviors.py)
- [api/tests/test_context_default_behaviors.py](api/tests/test_context_default_behaviors.py)
- [frontend/src/stores/__tests__/graph.contextBehaviors.test.ts](frontend/src/stores/__tests__/graph.contextBehaviors.test.ts)

**Testing:**
- [x] 14 new API tests: schema defaults/passthrough, memory-store create/update round-trip,
      **no shared mutable default dict across contexts**, update of another field leaves
      behaviors intact, migration chains 007→006 and targets the right table/column.
- [x] 13 new frontend tests: context-over-server precedence, unknown-key/wrong-type
      rejection, `loadContext` seeding, **context-switch does not leak** the previous
      context's behaviors, failed load leaves behaviors alone, user-overrides-context,
      **exploration-overrides-context**, context behaviors serialized into explorations.
- [x] Full API suite: **184 passed, 1 skipped** (was 170 + 1).
- [x] Full frontend suite: **841 passed / 48 files** (was 828).
- [x] `vue-tsc --noEmit` clean.
- [x] `test_transpile_options` still green (the new test file sorts before it; used the
      `try/import/except ImportError` gsql2rsql stub guard per the known project gotcha).

**Migration verified against a real Postgres (2026-07-13 15:40):**
- Applied `006 → 007` on the dev DB (`alembic current` → `007 (head)`; `information_schema`
  → `default_behaviors`, `json`, default `'{}'::json`). Existing contexts got `{}`, so their
  behavior is unchanged. The failing `SELECT` from the traceback now runs.
- **Deploy needs no manual step.** Both lifespans — `mountable_lifespan` (Databricks Apps)
  and the standalone one — call `create_tables()`, which runs `alembic upgrade head` on the
  existing connection. Simulated a fresh deploy against an empty DB via `create_tables()`:
  it chained `001 → 007` and emitted the `ALTER TABLE`. No `make migrate` required in prod.
- **Checked the trap:** `create_tables()` falls back to `Base.metadata.create_all` when
  `alembic.ini` is missing — and `create_all` does **not** add columns to existing tables, so
  a wheel without the migrations would reproduce the `UndefinedColumnError` in prod. Built
  the wheel and inspected it: `alembic.ini` *and* all of `alembic/versions/` (incl. `007`)
  are packaged. `pyproject.toml` only `force-include`s the `.ini`/`.mako`, but
  `packages = ["graphlagoon"]` carries the version `.py` files.
- Note: the original error hit because a hot-reloading dev server picks up new Python
  without re-running the startup lifespan. A restart fixes it — a dev-loop artifact, not a
  deploy one.

**Known Limitations:**
- Rollback caveat: redeploying an *older* app version over a `007` DB is safe (the column is
  simply unused), but running `alembic downgrade` drops the column and loses configured
  defaults.
- Not exercised in a browser.
- **No edit UI after creation.** `contextsStore.updateContext` supports the field and the
  API accepts it, but ContextsView has no edit modal at all (only Open/Share/Delete), so
  behaviors can only be set at creation or via the API. A natural follow-up is a "Save
  current behaviors as this context's default" button in BehaviorPanel.
- Still only `behaviors` — `aesthetics`/`force3DSettings` are not context-configurable.

**Status:** Implemented.

## [2026-07-13 15:08] - Feature: server-configurable frontend behavior defaults (`GRAPH_LAGOON_DEFAULT_BEHAVIORS`)

**Purpose:** Let whoever deploys the app set the initial values of the Behaviors
panel (e.g. ship with `mapStylePan: false`, or default to 3D) without
patching the frontend.

**Design Decisions:**
1. **One opaque JSON env var, not ~23 typed fields.** `GRAPH_LAGOON_DEFAULT_BEHAVIORS`
   → `Settings.default_behaviors: Optional[str]` + a `default_behaviors_dict`
   property that parses it (mirrors the existing `allowed_share_domain_list`
   pattern). The backend **passes the dict through without interpreting it**, so
   any behavior the frontend adds later works with zero backend change. A field
   per behavior would have coupled the API to every frontend visual tweak.
2. **Validation lives on the frontend, where the schema actually is.**
   `resolveInitialBehaviors()` (stores/graph.ts) drops unknown keys and rejects
   per-key type mismatches, warning on each. This matters because `behaviors` is
   serialized wholesale into every saved exploration — a typo'd key
   (`constantZoom`) or an env-var footgun (the *string* `"false"`, which is truthy)
   would otherwise be injected into the store and persisted forever.
3. **Precedence (lowest→highest): built-in defaults < server defaults < user's panel
   changes < loaded exploration.** The last one falls out for free: `loadExploration`
   merges saved behaviors over *whatever is current*, which is now the server value.
4. **Malformed config is a warning, not a crash.** Bad JSON / non-object JSON →
   `{}` + a logged warning. These are cosmetic UI defaults; taking the API down over
   one is the wrong trade.
5. **Both config producers updated.** `render_spa` (app.py, the Jinja template path)
   *and* `GET /api/config` (routers/config.py, what `npm run dev` fetches). Touching
   only the first would have made the feature work in the built app but silently not
   in dev.

**Drive-by fix:** `BehaviorPanel.resetBehaviors()` hardcoded its own copy of the
defaults, which had **already drifted** from the store (`hideLabelsOnCameraMove` and
`useOrthographicCamera` were both inverted — Reset was *changing* behavior, not
restoring it). It now calls `resolveInitialBehaviors()`, so Reset can't drift again
and correctly resets to the *server's* defaults.

**Files Modified:**
- [api/graphlagoon/config.py](api/graphlagoon/config.py) — `default_behaviors` field + `default_behaviors_dict` property
- [api/graphlagoon/app.py](api/graphlagoon/app.py) — inject into `render_spa`'s config dict
- [api/graphlagoon/routers/config.py](api/graphlagoon/routers/config.py) — inject into `GET /api/config`
- [api/.env.example](api/.env.example) — document the var
- [frontend/src/services/api.ts](frontend/src/services/api.ts) — `default_behaviors` on the `Window.__GRAPH_LAGOON_CONFIG__` type
- [frontend/src/stores/graph.ts](frontend/src/stores/graph.ts) — extracted `DEFAULT_BEHAVIORS` + `resolveInitialBehaviors()`; `behaviors` ref now seeded from it
- [frontend/src/components/BehaviorPanel.vue](frontend/src/components/BehaviorPanel.vue) — `resetBehaviors()` reuses the resolver

**Files Created:**
- [api/tests/test_default_behaviors.py](api/tests/test_default_behaviors.py)
- [frontend/src/stores/__tests__/graph.serverBehaviors.test.ts](frontend/src/stores/__tests__/graph.serverBehaviors.test.ts)

**Gotchas hit:**
- Extracting the `behaviors` literal to a module constant nearly collapsed its `as
  'off' | 'hide' | 'dim'` / `'3d' | '2d-proj'` narrowings to `string`, which would
  have broken BehaviorPanel's radio bindings. The literal is the type source
  (`typeof DEFAULT_BEHAVIORS`); the `as` annotations are load-bearing. `vue-tsc`
  confirms they survived.
- `api/tests/test_default_behaviors.py` sorts **before** `test_transpile_options.py`,
  so its gsql2rsql `sys.modules` stub uses the `try/import/except ImportError` guard
  (not `not in sys.modules`), per the known project gotcha. Full API suite confirms
  `test_transpile_options` still passes.

**Testing:**
- [x] 10 new API tests: parse, type preservation, unknown-key pass-through, empty
      string, malformed JSON, non-object JSON (list/scalar/null) → all ignored not
      fatal. Plus two tests asserting **both** config producers include the key
      (the dev/prod parity trap).
- [x] 13 new frontend tests: no-config fallback, override, all scalar types,
      untouched keys keep defaults, unknown key dropped, wrong-type value rejected,
      one bad key doesn't poison the good ones, fresh object per call, store seeding,
      user-override-wins, exploration-override-wins, server defaults serialized.
- [x] Full API suite: **170 passed, 1 skipped** (was 160 + 1 skip).
- [x] Full frontend suite: **828 passed / 47 files** (was 815).
- [x] `vue-tsc --noEmit` clean.

**Known Limitations:**
- Not exercised against a running server (no dev server driven this session);
  verification is unit-level on both sides, incl. the two-producer parity assertion.
- Only `behaviors` is server-configurable. `aesthetics` and `force3DSettings` are not
  (the latter isn't even serialized into explorations — pre-existing gap).
- Server defaults are global. No per-user or per-context override.

**Status:** Implemented.

## [2026-07-13 14:52] - Feature: opt-in constant zoom speed (`behaviors.constantZoomSpeed`) — **REVERTED 2026-07-13 16:05**

> **REVERTED.** The setting and all its machinery were removed at the user's request
> ("deixe só o adaptativo para simplificar"). Since the default was already `false`, the
> revert is **behaviour-neutral** — the zoom is TrackballControls' adaptive one, exactly as
> before this entry. Removed: `behaviors.constantZoomSpeed`, `syncZoomMode()`,
> `applyConstantZoomStep()` and its constants (`STEP_FRACTION`, `MIN_ZOOM_DISTANCE`,
> `MAX_ZOOM_DISTANCE_FACTOR`, `MAX_ORTHO_ZOOM`, `getGraphSpan()`), the panel checkbox, the
> component's wheel branch/watcher, and `useGraphCamera.zoom.test.ts` (19 tests). The wheel
> handler is back to clipping-plane-only. Tests that merely *used* the key as a probe for
> server/context/exploration precedence were re-pointed at `mapStylePan`, not deleted.
> Frontend suite: 838 passing.
>
> The investigation below is kept because it documents why TrackballControls' zoom behaves
> as it does — still true, and directly relevant to the pan work that followed.

**Purpose:** The zoom "changes speed" — it decelerates as you approach the graph
and accelerates as you pull away. Users who want to sweep the space in
predictable increments had no way to turn that off.

**Root of today's behavior (investigated first):** the zoom is *not* our code. We
never pass `controlType`, so `three-render-objects` gives us its default
(`'trackball'`, three-render-objects.mjs:439) → Three.js **TrackballControls**.
Its `_zoomCamera()` is *multiplicative*, not additive:

- Perspective (TrackballControls.js:371-377): `factor = 1 + Δ*zoomSpeed`, then
  `_eye.multiplyScalar(factor)`. `_eye` is the target→camera vector, so each
  tick scales the **distance to target** — it moves the camera by a *percentage*
  of the current distance (at distance 5000 a tick ≈ 60 units; at 200, ≈ 2.4).
  That percentage-of-distance rule *is* the perceived speed change. It is also
  asymptotic: it never reaches the target.
- Orthographic (TrackballControls.js:381): `camera.zoom /= factor` — also
  multiplicative, on the projection instead of the position.

Our only pre-existing `wheel` handler (GraphCanvas3D.vue:1946) just intercepted
Alt+scroll for the clipping plane; plain scroll fell through to the controls.

**Design Decisions:**
1. **Name/polarity: `constantZoomSpeed`, default `false`.** Constant zoom ships as an
   **opt-in**; the trackball's distance-scaled zoom stays the default. Because the
   default *is* the pre-existing behavior, nothing changes for anyone who doesn't tick
   the box, and explorations saved before this setting existed are entirely unaffected
   (the key is absent, so the merge-over-defaults restore falls through to `false`).
   No migration exists or is needed.
   *(This flip-flopped during review: shipped `false`, flipped to `true` — "the good
   default beats the zero-churn default" — then reverted to `false` on the user's call.
   Final state: `false`.)*
2. **Store bucket: `behaviors`, not `force3DSettings`.** `behaviors` is already
   serialized by `getExplorationState()` and merged over defaults on load;
   `force3DSettings` is **not serialized at all** (pre-existing gap — Pointer
   Tools/Clipping Plane settings are silently lost on save). Backend
   `ExplorationState.behaviors` is `Optional[dict]` (schemas.py:339), a free-form
   JSON blob → **zero backend/schema/migration changes**. Old explorations
   missing the key fall back to the default via merge-over-defaults.
3. **Mechanism: `controls.noZoom = true` + own the wheel.** Rather than forking
   TrackballControls or fighting `zoomSpeed` (which only rescales the factor and
   stays multiplicative), we disable the controls' zoom and extend the wheel
   handler we already own. Alt+scroll (clipping) keeps priority and still blocks
   zoom.
4. **Step = fraction of graph extent (`0.04 × getGraphBbox()` span), no slider.**
   Scales across small/large graphs with zero user configuration.
5. **Ortho steps in reciprocal space.** `w = 1/zoom` is linear in visible world
   width, so equal steps in `w` feel like equal steps on screen. Stepping `zoom`
   directly would have reintroduced the very acceleration being removed.
6. **Clamped both ends** so a fixed step can't overshoot *through* the target
   (perspective) or invert the projection (ortho) — the multiplicative default
   got that for free; a constant step does not.

**Files Modified:**
- [frontend/src/stores/graph.ts](frontend/src/stores/graph.ts) — `constantZoomSpeed: false` in `behaviors`
- [frontend/src/composables/useGraphCamera.ts](frontend/src/composables/useGraphCamera.ts) — `syncZoomMode()`, `applyConstantZoomStep()`, step/clamp constants
- [frontend/src/components/GraphCanvas3D.vue](frontend/src/components/GraphCanvas3D.vue) — wheel handler branches; `syncZoomMode()` on controls init + runtime watcher (no re-init needed)
- [frontend/src/components/BehaviorPanel.vue](frontend/src/components/BehaviorPanel.vue) — checkbox under Advanced ▸ 3D Rendering + `resetBehaviors()` entry

**Files Created:**
- [frontend/src/composables/__tests__/useGraphCamera.zoom.test.ts](frontend/src/composables/__tests__/useGraphCamera.zoom.test.ts)

**Testing:**
- [x] 14 new zoom tests. The load-bearing one asserts the *same* wheel tick moves
      the camera the *same* 40 units at distance 200 and at distance 5000 —
      i.e. the distance-scaling is genuinely gone. Plus ortho equal-steps-in-
      visible-width, both clamps, direction preservation, wheel deltaMode
      normalization (px/line/page), zero-delta no-op.
- [x] 9 new panel/persistence tests: default off, checkbox unchecked by default,
      ticking opts in, checkbox reflects store, Reset restores the default.
      Persistence round-trip deliberately saves the **non-default** (`true`) so a
      passing restore can't be a default leaking through; a further test pins that a
      legacy exploration (key absent) **keeps** the pre-existing zoom behavior.
- [x] Full frontend suite green at every step (846 → 857 as later features landed).
- [x] `vue-tsc --noEmit` clean.
- [ ] `npm run lint` — **pre-existing failure**, unrelated: the repo has no
      ESLint config file at all (verified by stashing my changes and re-running
      on a clean tree; fails identically). Not introduced here.

**Known Limitations:**
- Not manually exercised in a browser (no dev server driven in this session);
  verification is via unit tests over the zoom math + store round-trip.
- Touch pinch-zoom still goes through TrackballControls' `TOUCH_ZOOM_PAN` branch,
  which is multiplicative and *not* covered by `noZoom`. Constant zoom currently
  applies to the scroll wheel only.
- `force3DSettings` remains unserialized into explorations (pre-existing; called
  out here because it's why this setting deliberately went into `behaviors`).

**Status:** Implemented.

## [2026-07-09 08:25] - Perf fix: "Rendering graph…" froze the UI for ~90s on large graphs — settle moved to a Web Worker

**Issue:** Even after the overlay/chunked-build fixes, large graphs still took
very long after the query and the UI still lagged/froze.

**Measured first (new harness):** synthetic 100k-node/150k-edge graph via a
Playwright script (adapted from `e2e/perf-report.ts`) with a long-task
observer, plus new per-phase instrumentation inside the vendored kapsule's
`forcegraphUpdate` metric (`nodesMs`/`linksMs`/`forceMs` — submodule change in
`frontend/ext-3d-force/three-forcegraph`). Results:
- The suspected kapsule digest was CHEAP: nodes 155ms + links 93ms + force 0.
- The killer: **six ~14.5s long tasks (~87s of blocked main thread)** — the
  headless settle. It yielded every **20 fixed ticks**, but one d3-force tick
  costs ~730ms at this size (~2.9µs per node+link), so each "chunk" froze the
  tab for ~14s. Full convergence ≈ 111 ticks ≈ 80s of pure computation.

**Fixes:**
1. **Settle runs in a Web Worker** — new
   [workers/layoutWorker.ts](../../frontend/src/workers/layoutWorker.ts) +
   [workers/layoutWorkerTypes.ts](../../frontend/src/workers/layoutWorkerTypes.ts)
   (types split so the client import doesn't execute the worker's
   `self.onmessage`) + client
   [utils/settleLayoutClient.ts](../../frontend/src/utils/settleLayoutClient.ts)
   (`settleLayoutAuto`: slim structured-clone payloads — id/size/xyz + endpoint
   ids only; positions returned as a transferred Float32Array and copied back;
   abort by polling the token and terminating the worker; automatic fallback
   to the in-thread settle on worker failure). GraphCanvas3D's two call sites
   just switched `settleLayoutHeadless` → `settleLayoutAuto`. Same pattern as
   metricsWorker/communityWorker.
2. **Time-budget chunking** in
   [utils/headlessLayout.ts](../../frontend/src/utils/headlessLayout.ts): when
   `ticksPerChunk` is not explicitly passed, chunks are sized by wall-clock
   (default 40ms, min 1 tick) instead of a fixed tick count — the in-thread
   fallback can no longer produce multi-second blocks.
3. **Size-aware tick cap** (`computeSettleTickCap`): work budget of 8.5M
   node+link units per settle — full estimated tick count (exact behavior) up
   to ~75k nodes+links, degrading gradually to a 30-tick floor for huge graphs
   (explicit quality-for-latency trade, allowed by the product decision that
   only small graphs must stay exact).

**Validated (same 100k/150k harness, before → after):**
- Blocked main thread (long tasks): **91.5s → 5.2s** (biggest remaining: 2.7s
  at boot ≈ 22MB JSON parse; the 14.5s settle blocks are gone entirely).
- Wall time to scene: **91s → 41s** (35.7s = worker settle at the 34-tick cap;
  UI responsive with animated progress throughout).
- buildGraphData 1.26s wall (chunked), kapsule digest 452ms.

**Tuning knob:** `SETTLE_WORK_BUDGET` in headlessLayout.ts controls the
quality/latency trade for huge graphs.

**Note (submodule):** the kapsule phase instrumentation lives in the
`three-forcegraph` submodule — needs a commit inside the submodule, then a
pointer bump in the main repo.

**Testing:**
- [x] 4 new tests (tick cap small/huge/floor; time-budget chunking yields per
  tick and settles) — headlessLayout 12/12.
- [x] `vitest related` 284/284; `vue-tsc --noEmit` clean; E2E `graph.spec.ts`
  21/21 (real browser, exercises the worker path end-to-end via the harness
  runs above).

**Status:** Fixed — validated by direct measurement.

## [2026-07-08 23:05] - Perf fix: "Expand from node" lagged — global layout reheat to place a handful of nodes

**Issue:** Expand from node (depth ≤2, edge_limit ≤1000) should be near-instant
but lagged for seconds on large graphs.

**Root cause:** the merged new nodes have no entry in `updateGraph`'s
`positionMap` → `hasNewNodes=true` → not a fresh layout, so no settle → falls
into `reheatLayout()`, which (1) unpins and perturbs (±100) EVERY node — not
just the new ones, (2) re-digests the entire scene a second time
(`graph3d.graphData(data)` inside reheat), and (3) restarts the global
simulation with the adaptive cooldown (≥10k: 800 ticks × 24/frame) — seconds of
O(n log n + m)-per-tick work and a layout jolt, all to place a few nodes.

**User constraint honored:** small graphs keep today's behavior EXACTLY — the
organic global re-layout is cheap and looks good there; no approximation is
introduced below the threshold.

**Fix:**
- New pure util
  [seedNewNodePositions.ts](../../frontend/src/utils/seedNewNodePositions.ts):
  every position-less node is placed at a bounded random offset (radius ~40)
  around a positioned neighbor and pinned; multi-pass so a depth-2 ring anchors
  on the ring-1 seeds; isolated additions fall back to the centroid of known
  positions; `is2D` forces z=0.
- [GraphCanvas3D.vue](../../frontend/src/components/GraphCanvas3D.vue)
  `updateGraph`: when `hasNewNodes && !freshRequested && !isFreshLargeLayout`
  and the graph is large (`> HEADLESS_SETTLE_EDGE_THRESHOLD` = 2000 edges, the
  component's single "large" definition), seed the new nodes and take the
  `stopLayout()` branch — existing positions untouched (exact, better than the
  old reheat which perturbed everything), zero simulation, single digest.
  Small graphs and running-layout cases keep the previous branches verbatim.
- Camera already stays put for expand (`shouldRefit` false) and the chunked
  build + "Rendering graph…" overlay from the previous fix cover the remaining
  digest.

**Testing:**
- [x] 6 unit tests for the seeder (anchor radius + pinning, multi-pass chains,
  centroid fallback, 2D mode, known positions untouched, no-op).
- [x] `vitest related` 290/290; `vue-tsc --noEmit` clean; E2E `graph.spec.ts`
  21/21.
- [ ] Manual: expand on a ~20k+ graph — new nodes pop next to the expanded node
  near-instantly, rest of the graph does not move; small graph keeps the
  organic re-layout.

**Status:** Fixed (pending manual confirmation).

## [2026-07-08 22:05] - Perf fix: post-query freeze + blank white canvas before a large graph appears

**Issue:** On large graphs, after "Running query…" finished and "Computing
layout…" hit 100%, the canvas stayed blank white for a long period AND the UI
froze during that window.

**Root cause (four compounding problems on the post-settle path):**
1. **Duplicate full scene digest.** With `preSettled` layouts,
   `updateGraph` still hit the `hasNewNodes → reheatLayout()` branch (a fresh
   query makes every node "new"). `reheatLayout()` unpins + perturbs (±100)
   every node — jolting the just-settled layout — AND calls
   `graph3d.graphData(data)` a second time, re-running the entire synchronous
   kapsule digest. The freeze was ~2× the digest cost for nothing.
2. **Synchronous O(n+m) `buildGraphData`** (appearance + label template
   formatting per node/edge) blocked the main thread in one pass.
3. **Overlay dropped too early.** `isHeadlessSettling=false` ran in the
   `finally` right after the settle — BEFORE the synchronous
   `graph3d.graphData()` digest (instanced-mesh build + shader compile + force
   re-init). That block then ran over a blank `#fafafa` scene with no feedback.
4. **Camera never re-framed on the query path.** Only `initGraph` calls
   `zoomToFit` (after 500ms); `updateGraph` never did — a fresh settled layout
   could sit entirely off-frame, indefinitely blank until the user orbits.

**Fixes ([GraphCanvas3D.vue](../../frontend/src/components/GraphCanvas3D.vue)):**
1. `preSettled` now goes to `layout.stopLayout()` instead of `reheatLayout()`:
   no perturbation, no second digest, `initialLayoutDone` flips immediately so
   labels/icons appear right away (they were gated on it).
2. `buildGraphData` is now **chunked/async**: yields the main thread every
   ~12ms (`BUILD_CHUNK_BUDGET_MS`), takes a `shouldAbort` token (superseding
   init/update bails cleanly), and snapshots its source arrays so reactive
   recomputes mid-build can't swap them under the iteration.
3. **The overlay now covers the whole window**: "Rendering graph…"
   (`isRenderingScene`) during the chunked build → "Computing layout… N%"
   during the settle → "Rendering graph…" again through the one remaining
   un-chunkable synchronous block (the vendored kapsule digest; `nextPaint()`
   guarantees the overlay paints before it starts) → dropped only after the
   new scene's first painted frame (double rAF).
4. `updateGraph` now calls `camera.zoomToFit()` on fresh layouts
   (`freshRequested || preSettled`), on the first painted frame — incremental
   updates (expand) keep the camera untouched.

**What remains synchronous (accepted):** one kapsule `graphData()` digest per
rebuild — inside the vendored lib, not chunkable from the component; it now
runs once (not twice) and under a visible overlay. Instrumented via the fork's
`forcegraphUpdate` perf metric.

**Found during investigation:**
- **FIXED (follow-up, same day):** `InstancedNodeRenderer._sortIndices` was a
  `Uint16Array` while `MAX_NODES_DEFAULT = 100000` — indices wrapped past
  65535 (measured: at 100k nodes, 34,464 duplicated/lost sort entries), so the
  camera-distance sort drew some nodes twice and dropped others, and
  `getDataByInstanceId` picking resolved to the wrong node. One-line fix in the
  `three-forcegraph` submodule: `Uint32Array`. Cost analysis: +195KB memory
  (vs ~11MB the node renderer already allocates — ~1.8%), zero CPU delta (sort
  cost is comparator calls + `_distances` lookups; index width doesn't change
  comparison/swap counts, and the sort only runs when the camera moves). The
  link renderer's own index arrays already used `Uint32Array` — the node one
  was an oversight, not a design choice. The link renderer's remaining
  `Uint16Array`s hold per-link COUNTS (≤ 24), which are safe.
- **NOT changed (deliberate memory guards, not typo-bugs):** rendering caps of
  100k nodes / 20k instanced links. Measured allocation at maxLinks=20k:
  ~33MB upfront (linePositions 5.8MB + lineColors 7.7MB + 240k-instance
  cylinder InstancedMesh 15.4MB + index arrays); raising to 200k would be
  ~330MB upfront plus per-frame cost. Raising them is a product decision with
  a real memory tradeoff. Open follow-up: the caps are SILENT — a 200k-edge
  graph renders 20k edges with no indication; a "showing X of Y" UI notice
  would be the honest cheap fix.

**Testing:**
- [x] `vue-tsc --noEmit` clean; `vitest related` 284/284; E2E `graph.spec.ts`
  21/21 (exercises the async init/update path end-to-end).
- [ ] Manual on a 200k graph: overlay visible through the whole pipeline, UI
  responsive during "Rendering graph…" (chunked build), graph framed by the
  camera when the overlay drops, no layout jolt after settle.

**Status:** Fixed (pending manual confirmation on a large graph).

## [2026-07-08 21:05] - Perf fix: node/edge type checkbox toggles froze the UI (full 3D rebuild + layout reheat)

**Issue:** After the search freeze was fixed, toggling a node-type or edge-type
checkbox in FilterPanel still froze the interface even at ~20k edges.

**Root cause:**
1. A type toggle shrinks the store's `filteredNodes`/`filteredEdges` → the
   canvas data watcher fires (its search-only guards don't cover type filters)
   → `updateGraph()` → `buildGraphData()` + `graph3d.graphData()` = full
   Three.js object recreation + d3-force re-init.
2. Worse, on RE-enabling a type the re-added ids are absent from the engine's
   `positionMap` → `hasNewNodes=true` → `reheatLayout()`
   ([useGraphLayout.ts](../../frontend/src/composables/useGraphLayout.ts))
   unpins ALL nodes, perturbs every position by ±100 and re-runs the whole
   layout — the violent freeze + "graph explodes" effect.
3. Key finding: the appearance pipeline ALREADY supported visual type hiding —
   `computeNodeAppearance` (`isTypeHidden`), `computeLinkAppearance`
   (`isEdgeTypeHidden` + hides links whose endpoints are in `hiddenNodeIds`),
   with `collectAppearanceContext` populating the sets from
   `filters.node_types`/`edge_types` — but it was **dead code**, because
   `buildGraphData` only ever iterated already-type-filtered arrays. Same for
   property filters (`propFilterHidden*Ids`) and search-hide (`searchHiddenIds`).
   Visual hiding is cheap and position-preserving: `nodeVisibility` accessor
   changes re-digest only visible objects, without re-initing the simulation
   (the kapsule feeds d3-force the full `graphData.nodes`).

**Fix — feed the canvas the FULL dataset, hide visually (the architecture the
appearance pipeline was built for):**
- [graph.ts](../../frontend/src/stores/graph.ts): the canvas data chain
  (`displayNodes`/`displayEdges` → `enhancedNodes`/`enhancedEdges`) is now
  based on the full `nodes`/`edges` instead of `filteredNodes`/`filteredEdges`.
  Only filters with no visual equivalent stay data-level in that chain:
  table-filter ids, the self-edge toggle, and similarity display mode (their
  toggles are rare, so the rebuild they trigger is acceptable). With this, a
  type/property/search toggle no longer even invalidates the canvas computeds
  (same per-property tracking mechanism as the search fix), so the data
  watcher never fires — no rebuild, no reheat; nodes reappear at their exact
  previous positions.
- [GraphCanvas3D.vue](../../frontend/src/components/GraphCanvas3D.vue): the
  existing "filter changes — visuals only" watcher now also calls
  `updateOverlays()` (labels/icons of newly hidden/shown nodes — previously
  refreshed implicitly by the full rebuild). `updateVisuals` and
  `buildGraphData` already aggregate `hiddenNodeIds` and pass it to
  `computeLinkAppearance`, so links with hidden endpoints hide correctly and
  rebuilds while filters are active keep hidden nodes present-but-flagged.

**Contract change (audited):** `enhancedNodes`/`enhancedEdges` are consumed
only by the canvas. Status bar, DataTablePanel, metrics, community and
similarity all read `filteredNodes`/`filteredEdges` and keep filtered
semantics. `enhancedMultiEdgeStats`/`enhancedHasMultiEdges` (Toolbar badge,
AestheticsPanel toggle) now reflect the full dataset rather than the filtered
view — minor, accepted.

**Bonus fix (latent bug):** previously, any full rebuild while a hide-search or
filter was active removed hidden nodes from the engine's data entirely —
clearing the search/filter could not un-hide them without another rebuild, and
their positions were lost. With the full-dataset canvas chain this class of
inconsistency is gone.

**Documented caveat:** hidden nodes still participate in the force simulation
when a layout runs (same as search-hide before) — they cost simulation time
but no draw calls.

**Testing:**
- [x] 4 new regression tests in
  [graph.filtering.test.ts](../../frontend/src/stores/__tests__/graph.filtering.test.ts):
  type toggles keep `displayNodes`/`enhancedNodes`/`displayEdges`/`enhancedEdges`
  cached (array identity, warm-up read pattern); canvas chain holds the full
  dataset while `filteredNodes` stays filtered; self-edge toggle and table
  filter still apply to `displayEdges`.
- [x] 49/49 graph.filtering; 283/283 across `vitest related` on graph.ts +
  GraphCanvas3D.vue (incl. selfEdges, clusterIntegration, largeGraph, metrics);
  `vue-tsc --noEmit` clean.
- [x] E2E `graph.spec.ts`: 21/21 passed.
- [ ] Manual perf check: toggle type checkboxes on a ~20k+ graph — no freeze,
  nodes fade in place (no layout jump), `window.__PERF_METRICS__` records no
  new `buildGraphData` entries per toggle.

**Status:** Fixed (pending manual perf confirmation).

**Follow-up (same session): table filtering moved to the visual path too.**
User asked whether filtering via the DataTablePanel (which syncs
`setTableFilteredIds` to the graph) had the same bug — it did: the table-filter
ids had been deliberately left data-level in `displayNodes`/`displayEdges`
(no visual equivalent existed), so brushing a table filter still triggered the
full rebuild, and clearing it re-added nodes through `reheatLayout()`.
Implemented the visual equivalent:
- [graphAppearance.ts](../../frontend/src/utils/graphAppearance.ts): new
  `tableVisibleNodeIds`/`tableVisibleEdgeIds` KEEP-sets in `AppearanceContext`
  (null = no filter; non-null = only those ids visible). Cluster nodes are
  exempt (sets hold real node ids); cluster-aggregate edges (`cluster_*`
  synthetic ids) are exempt from the edge set — hiding every aggregate while a
  table filter is active would visually disconnect closed clusters (same
  matched-by-id limitation as `propFilterHiddenEdgeIds`, documented).
- [graph.ts](../../frontend/src/stores/graph.ts): table-filter ids removed from
  `displayNodes`/`displayEdges` (canvas chain now only excludes self-edges and
  similarity display mode); `tableFilteredNodeIds`/`tableFilteredEdgeIds`
  exported for the appearance context.
- [GraphCanvas3D.vue](../../frontend/src/components/GraphCanvas3D.vue):
  `collectAppearanceContext` passes the sets; new identity watcher on the two
  sets → `updateVisuals()` + `updateOverlays()`.
- Tests: 6 new appearance tests (KEEP-set node/edge hiding, null = all visible,
  cluster node/edge exemptions, endpoint aggregation) — graphAppearance 67/67;
  updated + new store regression tests (table filter no longer recomputes the
  canvas chain, self-edge toggle still data-level) — graph.filtering 50/50;
  full related sweep 351/351; `vue-tsc` clean; E2E graph.spec 21/21.

## [2026-07-08 20:30] - Bug fix: graph-query Cancel button did nothing (overlay swallowed the click)

**Issue:** Running a graph query (default path), the loading overlay showed a
working spinner + a **Cancel** button, but clicking it did nothing — the query
kept running and the overlay never dismissed. The table Query Console Cancel
button worked fine.

**Investigation:** Traced the full chain — `QueryRunningState.vue` button →
`@cancel` → `graphStore.cancelGraphQuery()` → `useCancellableQuery.cancelQuery()`
→ `api.cancelGraphQueryJob()`. All of the frontend state-machine logic and the
backend submit→poll→cancel endpoints (`async_job.cancel_job`,
`warehouse.cancel_statement`) were correct in isolation. The table console path
(identical component, identical composable) worked.

**Root cause:** The only difference between the two paths is the container. The
graph Cancel button lives inside `.loading-overlay` in
[GraphVisualizationView.vue](../../frontend/src/views/GraphVisualizationView.vue),
which shares a CSS rule with the error/empty overlays setting
**`pointer-events: none`** (so the translucent backdrop doesn't block orbiting
the graph while loading). That rule also disabled the interactive Cancel button
inside it — every click fell straight through the overlay to the 3D `<canvas>`
behind it (the orbit-controls target). Playwright confirmed it verbatim:
*"canvas … subtree intercepts pointer events."* The table console button isn't
inside any `pointer-events: none` overlay, so it was unaffected.

**Design decision:** Keep the overlay pass-through (preserves graph interaction
during load) but re-enable pointer events on just the interactive element:
```css
.loading-overlay :deep(.cancel-btn) { pointer-events: auto; }
```
`:deep()` is required because `.cancel-btn` is scoped inside the child
`QueryRunningState` component. Narrowest possible override — the error/empty
overlays (no interactive children) are untouched.

**Why the bug shipped undetected:** the existing E2E regression test
(`graph.spec.ts`) clicked via `dispatchEvent('click')`, which **bypasses**
Playwright's pointer-events/hit-test actionability check, so it passed against
an unclickable button. Its comment misattributed the need for `dispatchEvent`
to canvas "frame stability"; the real cause was `pointer-events: none`.

**Files modified:**
- [frontend/src/views/GraphVisualizationView.vue](../../frontend/src/views/GraphVisualizationView.vue) — added `.loading-overlay :deep(.cancel-btn) { pointer-events: auto; }`
- [frontend/e2e/tests/graph.spec.ts](../../frontend/e2e/tests/graph.spec.ts) — cancel test now uses a **real** `cancelBtn.click()` (a true pointer-events regression guard) instead of `dispatchEvent('click')`

**Testing:**
- Verified the updated test **fails** with the fix reverted (canvas intercepts pointer events) and **passes** with it applied.
- Full `graph.spec.ts` + `query-console.spec.ts` E2E suites: **35 passed**.

**Note (separate issue — fixed in the next entry):** on the default **inline**
graph path (`use_external_links=false`), `execute_graph_query_with_nodes` called
`execute_statement` without `on_submit`, so the warehouse `statement_id` was
never captured and `cancel_job` could not send `cancel_statement` to the
warehouse — cancellation stopped API-side processing but the underlying
warehouse statement kept burning compute. Fixed below.

## [2026-07-08 20:55] - Bug fix: inline graph query cancel didn't stop the warehouse statement

**Issue (follow-up to the pointer-events fix above):** even with the Cancel
button now clickable, cancelling a graph query on the default **inline** path
(`use_external_links=false`) only cancelled the API-side asyncio task — it never
told the warehouse to stop, so the underlying statement kept running and burning
compute (a real cost issue on Databricks; a simulated no-op locally).

**Root cause:** `execute_graph_query_with_nodes` forwarded the job's `on_submit`
callback (which records the warehouse `statement_id` into the job so
`cancel_job` → `warehouse.cancel_statement(sid)` can reach it) **only on the
EXTERNAL_LINKS branch**. The inline branch called `warehouse.execute_statement()`
— a single blocking POST with a long `wait_timeout` that never exposes the
`statement_id` before completion — so `record["statement_ids"]` stayed empty and
nothing was ever cancelled at the warehouse.

**Fix (Databricks-safe):**
- `WarehouseClient.execute_statement` gains an optional `on_submit`. When
  provided, it routes through a new `_execute_statement_polled` that submits with
  a short `wait_timeout` (via the existing `submit_statement`), hands the
  `statement_id` to `on_submit` immediately, then polls `get_statement` to a
  terminal state — the **same submit→poll shape already proven against Databricks
  by `execute_statement_external`**, minus the external-link download (stays
  INLINE). When `on_submit` is absent, the original single blocking POST is
  untouched — so Databricks and every other caller behave exactly as before.
- `execute_graph_query_with_nodes` now passes `on_submit=on_submit` on the inline
  edge and node calls too.

Net: cancelling an inline graph query now cancels the asyncio task **and** sends
`cancel_statement` to the warehouse. Bonus: because the API task now spends its
wait in `asyncio.sleep` between polls (instead of one long blocking POST), it is
promptly interruptible by `task.cancel()`.

**Files modified:**
- [api/graphlagoon/services/warehouse.py](../../api/graphlagoon/services/warehouse.py) — `execute_statement(on_submit=…)` + new `_execute_statement_polled`
- [api/graphlagoon/services/graph_operations.py](../../api/graphlagoon/services/graph_operations.py) — forward `on_submit` on the inline edge + node `execute_statement` calls

**Files created:**
- [api/tests/test_cancellable_statement.py](../../api/tests/test_cancellable_statement.py) — submit→poll captures the id before completion; blocking path unchanged without `on_submit`; fast query returns without polling

**Testing:**
- New tests + `test_graph_error_handling.py` (added an inline-forwards-`on_submit` regression test) pass.
- Full API suite: **146 passed, 1 skipped**. The Databricks/default blocking path is explicitly asserted unchanged (no `submit_statement`/`get_statement`, single POST) so the integration can't silently regress.

## [2026-07-08 19:50] - Perf fix: search froze the UI on 200k+ graphs — full 3D rebuild per keystroke

**Issue:** Even after the search index (scan ~37ms) and the debounced inputs,
typing in the FilterPanel graph search froze the tab on 200k+ graphs. User
hypotheses: (a) offload search to a Web Worker, or (b) "the graph layout being
altered" — noting (b) seemed odd since zoom/pan stays fast.

**Root cause (hypothesis b confirmed, exactly):** zoom/pan only moves the
camera (GPU; no reactive data changes). A search keystroke, however, hit two
compounding problems:

1. **Full 3D rebuild per keystroke (the freeze).** The "data changes" watcher in
   [GraphCanvas3D.vue](../../frontend/src/components/GraphCanvas3D.vue) watched
   `() => [filteredNodes.value.length, filteredEdges.value.length]` — a getter
   returning a **fresh array** every evaluation, so Vue fired it whenever the
   filtered/enhanced chain recomputed even with both lengths identical. Its
   guard only skipped in `'hide'` search mode; in the **default `'highlight'`
   mode** it fell through to `updateGraph()` → `buildGraphData()` O(n+m) →
   `graph3d.graphData(newArray)` = **recreation of every Three.js object +
   d3-force simulation re-init** — seconds of main-thread block, pure waste
   (highlight never changes node/edge membership).
2. **Redundant store cascade.** `applyFilters` replaced the whole `filters`
   object (`filters.value = {...filters.value, ...new}`), invalidating every
   computed reading *any* filter field. So each keystroke recomputed
   `filteredNodes` → `filteredEdges` (Set of all node ids + full edge filter,
   over deep-reactive proxies) → `enhancedNodes`/`enhancedEdges`/
   `enhancedMultiEdgeStats` — several O(n+m) proxy passes, pulled independently
   by the canvas watcher, a metrics-store watcher, and the status bar.

**Why NOT a Web Worker:** the bottleneck was not workerizable computation (the
string scan is ~ms); it was Three.js object recreation + layout re-init, which
is main-thread-only and simply should not run. What legitimately remains per
settled keystroke — `updateVisuals()` + `updateLabels()` (O(n+m), in-place
mutation, no recreation; instrumented via `recordPerf`) — must run on the main
thread anyway to paint the highlight.

**Fixes:**
1. [GraphCanvas3D.vue](../../frontend/src/components/GraphCanvas3D.vue) — the
   data watcher now tracks previous counts and skips `updateGraph()` when the
   change is search-triggered and counts are unchanged (highlight mode). All
   other triggers (new query results, type filters, cluster collapse — even
   equal-count filter swaps, which fire exactly as before) keep the old
   behavior; the existing `'hide'`-mode guard is preserved.
2. [graph.ts](../../frontend/src/stores/graph.ts) `applyFilters` now mutates in
   place (`Object.assign(filters.value, newFilters)`) — Vue's per-property
   tracking keeps readers of unrelated filter fields cached. Audited all
   identity-dependent watchers: only FilterPanel's own-state sync watch reads
   the object reference, and it only needs to fire for wholesale replacements
   (`resetFilters` :1216, `loadExploration` :1676), which still replace the
   object. Only FilterPanel itself calls `applyFilters`, so no external caller
   relied on the sync.
3. [graph.ts](../../frontend/src/stores/graph.ts) `filteredNodes` hide-mode
   condition reordered to `searchMode === 'hide' && search_query` — in
   highlight mode the short-circuit means `search_query` is never read, so the
   computed (and the whole downstream chain) is not even a dependency of the
   search text.

**Net effect per keystroke (highlight, default):** before — indexed scan +
filtered/enhanced O(n+m) proxy chain (pulled 3×) + `buildGraphData` + Three.js
recreation + d3-force re-init + updateVisuals + updateLabels; after — indexed
scan + updateVisuals + updateLabels only.

**Testing:**
- [x] 5 new regression tests in
  [graph.filtering.test.ts](../../frontend/src/stores/__tests__/graph.filtering.test.ts):
  highlight-mode keystroke keeps `filteredNodes`/`filteredEdges` cached (array
  identity), hide-mode still recomputes, `searchMatchedNodeIds` still updates,
  `applyFilters` partial-merge preserved. Note: the `filteredEdges` test needs a
  warm-up read — the first-ever evaluation lazily creates `useSimilarityStore()`
  inside the computed, whose reactive writes destabilize the next *cold*
  (subscriber-less) read; in the app the computed always has subscribers.
- [x] 45/45 graph.filtering; 279/279 across `vitest related` on all changed
  files; `vue-tsc --noEmit` clean.
- [ ] Manual perf check (needs running app): type a search on a 200k+ graph and
  confirm `window.__PERF_METRICS__` records **no new `buildGraphData` entries
  per keystroke** (`updateVisuals` still records — legitimate); layout must not
  jitter/restart while typing.

**Deferred:**
- `shallowRef` for `nodes`/`edges` (would kill proxy overhead app-wide; broad
  refactor, reactivity risk).
- Incremental (dirty-set) `updateVisuals`/`updateLabels` — only if the manual
  measurement above shows the remaining O(n+m) paint is still material.
- Web Worker — ruled out for this problem (see above).

**Status:** Fixed (pending the manual perf confirmation above).

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

---

## [2026-07-09 08:35] - Feature: Alt+Click to auto-expand node neighbors (3D)

**Feature:** In the 3D canvas, holding **Alt** while clicking a node triggers the
"expand neighbors" action (depth 1) — the same operation available via the
right-click context menu — without opening any menu.

**User Story:** As a graph explorer, I want to expand a node's neighbors with a
single modifier-click, so that I can traverse the graph quickly without
right-clicking and picking a menu item each time.

**Design Decisions:**
1. **Alt+Click, not Ctrl+Click:** The original request was Ctrl+Click, but
   `event.ctrlKey` is already consumed by multi-select in `onNodeClick`
   (`graphStore.selectNode(node.id, event.ctrlKey)`). Reusing Ctrl would break
   multi-selection. Chose **Alt+Click** so multi-select (Ctrl) is preserved.
2. **Depth 1:** Matches the existing "Expand neighbors" context-menu action
   (`expandFromNode(id, 1)`) for consistency.
3. **Select then expand:** Alt+Click also selects the node (single-select) so the
   expansion origin is visible, then calls `expandFromNode`. Guarded by
   `!graphStore.loading` to avoid overlapping expansions, mirroring the
   context-menu action's `disabled: () => graphStore.loading`.
4. **Discoverability:** Added an `Alt+Click Expand node` entry to the on-canvas
   controls hint.

**Implementation:**
- `onNodeClick` handler in `GraphCanvas3D.vue`: added an early branch —
  `if (event.altKey && !graphStore.loading) { selectNode(id); void expandFromNode(id, 1); return; }`
  placed after the cluster check (clusters aren't expandable) and before the
  lens/multi-select logic. Reuses the existing store action; no new store/API code.

**Files Modified:**
- [frontend/src/components/GraphCanvas3D.vue](../../frontend/src/components/GraphCanvas3D.vue) — Alt+Click branch in `onNodeClick`; controls-hint entry.

**Testing:**
- [x] `vue-tsc --noEmit` — no GraphCanvas3D errors.
- [x] `graph.actions` 31/31 — `expandFromNode`/`selectNode` store actions unchanged and green.
- Note: the `onNodeClick` callback is wired inside `initGraph()` (ForceGraph3D +
  Three.js) and is not unit-testable in isolation; the underlying store actions it
  calls are already covered.

**Status:** Implemented.

## [2026-07-09 09:00] - Feature Implemented: `$hash(...)` query macro (client-side Databricks xxhash64)

**Feature:** Users can write `$hash('some_key')` anywhere in a graph/Cypher/SQL query.
Before the query is sent to the transpile/execute endpoint, each `$hash(...)` call is
replaced client-side by the signed 64-bit integer that Databricks `xxhash64(<str>, 42)`
would produce. Needed because some graphs use a Databricks `xxhash64` of a natural key as
the node/edge ID, and typing the raw 64-bit int by hand is impractical.

**Design Decisions:**
1. **Token `$hash(...)`** (not `hash(...)`): a distinct marker so it never shadows
   Databricks' native SQL `hash()` / `xxhash64()`. Confirmed with user.
2. **Argument semantics:** strip one pair of surrounding `'`/`"` quotes, hash the inner
   string as UTF-8. So `$hash('foo')` and `$hash(foo)` produce the same value.
   Parity with Spark `xxhash64` holds for STRING inputs only (both hash UTF-8 bytes);
   numeric/other Spark types use a different byte encoding and are out of scope — node/
   edge IDs here are string keys.
3. **Single choke point:** substitution applied in the four `api.ts` methods that POST a
   query (`submitGraphQueryJob`, `submitCypherQueryJob`, `transpileCypher`,
   `executeTableQuery`) rather than in stores/components. The editor and store state keep
   the literal `$hash(...)` text (good UX); only the outgoing payload carries the
   substituted ints, and the returned transpiled SQL naturally shows the real ints.
4. **WASM fast-path:** `substituteHashCalls` returns the query unchanged, without
   initializing xxhash-wasm, when no `$hash(` substring is present — keeps existing api
   unit tests fast and WASM-free.

**Implementation:**
- New util `frontend/src/utils/queryHash.ts`:
  - `databricksXxhash64(input)` — memoized `xxhash()` singleton, `h64(input, 42n)`,
    `BigInt.asIntN(64, unsigned)`.
  - `substituteHashCalls(query)` — regex `/\$hash\(\s*([^)]*?)\s*\)/g`, quote-strip,
    dedup, decimal-int replace.
  - `resetHasher()` — test hook.
- Wired into the 4 `api.ts` methods (`const req = { ...request, query: await substituteHashCalls(request.query) }`).
- Added `xxhash-wasm` to `frontend/package.json` (first WASM dep; Vite handles it).

**Files Created:**
- [frontend/src/utils/queryHash.ts](frontend/src/utils/queryHash.ts)
- [frontend/src/utils/__tests__/queryHash.test.ts](frontend/src/utils/__tests__/queryHash.test.ts)

**Files Modified:**
- [frontend/src/services/api.ts](frontend/src/services/api.ts) (4 methods)
- [frontend/package.json](frontend/package.json) + package-lock.json

**Testing:**
- [x] Unit tests added (10) — golden parity vector `xxhash64('melao_pf', 42) == -1480451197245718748`
      (confirmed against Databricks), plus quoted/bare/double-quoted args, multiple
      occurrences, whitespace, no-op cases.
- [x] Full unit suite green (789 tests, 44 files).
- [x] `vue-tsc --noEmit` clean.
- [ ] Manual end-to-end pending (run a query with `$hash('key')` in `make dev`).

**Known Limitations:**
- Arg regex uses `[^)]*` — a quoted arg containing a literal `)` is unsupported.
- Only string inputs match Databricks (UTF-8 bytes); numeric `xxhash64(<long>)` is out of scope.

**Status:** Implemented.

## [2026-07-09 11:00] - Bug Fixed: cypher transpiler schema hardcoded `edge_id` — custom `edge_id_col` contexts got a wrong gsql2rsql schema

**Issue:**
Contexts accept arbitrary structure column names (`node_id_col`, `edge_id_col`, ...
in `NodeStructure`/`EdgeStructure` — free-form strings, no validation). A full
audit of API + frontend for hardcoded `node_id`/`edge_id` found:

1. **Real bug** — `services/cypher.py` `build_schema_provider` read `src_col`,
   `dst_col` and `relationship_type_col` from the context's `edge_structure`
   but hardcoded the edge-id property as the literal `"edge_id"`
   (`edge_id_col` was never read anywhere in the file). For a context with
   e.g. `edge_id_col="rel_id"`, the schema handed to gsql2rsql declared a
   nonexistent `edge_id` column and omitted the real one — Cypher queries
   touching the edge id rendered SQL that failed at the warehouse, while the
   subgraph/expand SQL path (which honors `edge_id_col`) worked.
2. **Latent bug** — the frontend allows `edge_id_col: ""` ("None" option),
   but `routers/graph.py` `build_edge_named_struct` did not filter falsy
   columns, emitting `NAMED_STRUCT('', `` , ...)` — invalid SQL.
   (`_get_edge_id` already handles a falsy `edge_id_col` via composite keys.)
3. **Verified correct** (now pinned by tests): `merge_column_config`,
   subgraph/expand SQL, `process_graph_query_result`, `process_nodes_result`,
   node fetch join. The `AS node_id` strings in graph.py are internal CTE
   aliases, not table-column assumptions. The frontend is correct by design:
   it consumes the canonical `Node.node_id`/`Edge.edge_id` model that the
   backend normalizes results into; query-construction paths
   (`exampleQuery.ts`, `QueryConsolePanel` id-column detection) use the
   configured names.

**Fix:**
- `cypher.py`: read `edge_id_col = edge_struct.get("edge_id_col", "edge_id") or None`
  (missing key → default `edge_id` for backward compat; `""` → no edge-id
  property). Edge property list hoisted above the type-combination loop and
  the edge-id property appended only when `edge_id_col` is truthy.
- `graph.py` `build_edge_named_struct`: filter falsy column names so an empty
  `edge_id_col` is omitted from the struct (composite ids via `_get_edge_id`).

**Files Modified:**
- api/graphlagoon/services/cypher.py
- api/graphlagoon/routers/graph.py
- api/tests/test_subgraph_schema_mapping.py (FULL_CUSTOM_CONFIG: merge,
  named-struct, round-trip, `_get_edge_id`, `process_nodes_result` with all
  six columns renamed — the existing CUSTOM_CONFIG kept both id columns at
  their defaults, which was exactly the coverage gap)

**Files Created:**
- api/tests/test_cypher_schema_provider.py — regression tests for
  `build_schema_provider` with custom `node_id_col`/`edge_id_col` (RED before
  the fix), empty and missing `edge_id_col` semantics. Needs the REAL
  gsql2rsql (property-name asserts are meaningless on a MagicMock stub), so
  it uses `pytest.importorskip` + a module-level skip if an earlier-collected
  test left a MagicMock stub in `sys.modules` — deliberately does NOT add a
  stub itself (see the [2026-07-08] stub-poisoning entry).
- frontend/src/components/__tests__/QueryConsolePanel.test.ts — nodeIdField
  detection with a custom `node_id_col` (custom match, literal `node_id`
  fallback, no id-like column).

**Testing:**
- [x] TDD: new cypher schema tests RED (2 failures) before the fix, GREEN after.
- [x] Empty-`edge_id_col` named-struct test RED before the graph.py fix, GREEN after.
- [x] Full API suite: 160 passed, 1 (pre-existing, unrelated) skip;
      `test_transpile_options` still green (collection-order check).
- [x] Full frontend suite: 792 tests, 45 files, green.

**Known Limitations (deferred):**
- `ContextsView.vue` pre-fills `node_id`/`edge_id` defaults and auto-select
  only overrides them when a column literally named `node_id`/etc. exists in
  the fetched schema — a user can still save a context pointing at a
  nonexistent column (backend queries then fail at run time). UX validation
  gap, not a data-correctness bug; left for a follow-up.

**Status:** Implemented.

## [2026-07-16 16:00] - Feature Implemented: "View community members" context menu action + CommunityNodeModal

**Feature:** Right-clicking a node that belongs to a detected community
(Louvain or a cluster program run as the community algorithm) now shows a
"View community members" context menu action that opens a modal table listing
every node in that community — same table UX as the existing cluster-program
`ClusterNodeModal` (search, sortable columns, CSV export).

**Requirements:**
- Action only visible when the right-clicked target is a node AND it has an
  entry in `communityStore.communityMap` (works for both Louvain and
  cluster-program-derived communities).
- Modal shows all community members with node_id, node_type, and all property
  columns (auto-detected via `useTableColumns` helpers), community color dot,
  algorithm badge, node count.

**Design Decisions:**
1. **New `CommunityNodeModal.vue` instead of reusing `ClusterNodeModal.vue`:**
   communities only exist as `Cluster` objects when `collapseEnabled` is on —
   the community map is the always-available source of truth. The modal reads
   `communityStore.communitiesById` + `graphStore.nodes` directly, so it works
   regardless of the collapse toggle. Table logic reuses the shared
   `buildNodeColumns`/`flattenNodeRows` composables (same as ClusterNodeModal).
2. **Action registration via a dedicated composable
   (`useCommunityTableAction`)** rather than inline in `GraphCanvas3D.vue`:
   the modal lives in `GraphVisualizationView.vue`, which owns all other
   modals; the composable owns the `selectedCommunityId` ref + explicit
   `register()`/`unregister()` so the logic is unit-testable without mounting
   the whole view. The view calls register/unregister in its
   onMounted/onUnmounted (pattern documented in skill_context_menu_action).
3. **No toggle open/close button in the modal** (unlike ClusterNodeModal):
   communities are not collapsible entities unless synced to clusters —
   out of scope here.
4. **Community naming:** modal shows "Community {id}". For cluster-program
   communities the original cluster names are not retained by the community
   store (it only keeps node→index) — surfacing program cluster names is a
   future enhancement.

**Files Created:**
- frontend/src/components/CommunityNodeModal.vue
- frontend/src/composables/useCommunityTableAction.ts
- frontend/src/components/__tests__/CommunityNodeModal.test.ts (9 tests)
- frontend/src/composables/__tests__/useCommunityTableAction.test.ts (10 tests)

**Files Modified:**
- frontend/src/views/GraphVisualizationView.vue — mounts the modal, wires
  register/unregister, binds `selectedCommunityId`.

**Testing gotcha discovered (worth knowing for future tests):**
The community store watches `graphStore.nodes` and clears communities when it
changes. In tests, seeding `graphStore.nodes` leaves that watcher job pending;
the first reactive flush (e.g. `render()` mount) then wipes a just-seeded
`communityMap`. Fix: `await nextTick()` between seeding nodes and seeding
`communityMap` (see `seedStores()` in CommunityNodeModal.test.ts).

**Testing:**
- [x] 19 new unit tests (composable visibility/handler/register-unregister;
      modal rendering, search, sort, empty state, close events, algorithm badge).
- [x] Full frontend suite green: 968 tests, 57 files.
- [x] `npx vue-tsc --noEmit` clean.
- [ ] E2E: not added — single-page feature; context menu + modal covered by
      unit/component tests (repo-wide ESLint config still broken, vue-tsc +
      tests used as quality gate per existing convention).

**Status:** Implemented.

## [2026-07-16] - Fix: literal `node_id`/`edge_id` columns shadowed by configured id columns in the UI

**Problem (user report):** With an unusual configured id column (e.g.
`node_id_col = "id_hash"`) and a table that ALSO has a literal `node_id`
column, the UI appeared to "overwrite" `node_id` with `id_hash` values.
Same suspicion for `edge_id`.

**Diagnosis (full-stack verification):**
- Data is NEVER overwritten. Backend puts the configured id into the dedicated
  `Node.node_id`/`Edge.edge_id` model fields and excludes only the *configured*
  columns from `properties` (`graph_operations.py` `structure_cols`); a literal
  `node_id` column survives as `properties["node_id"]`. Node fetch is
  `SELECT n.*` (no aliasing); the `AS node_id` in `routers/graph.py` are
  intermediate BFS CTEs only. Cypher schema provider registers properties by
  real column names — no query-layer collision. Frontend store assigns API
  responses verbatim; cluster programs and snapshots keep `properties` nested.
- Real bug 1 (main): `labelFormatter.getPropertyValue` resolved built-ins
  (`node_id`, `edge_id`, `node_type`, `relationship_type`, `src`, `dst`)
  BEFORE `item.properties`, and the parser discarded the `prop:` prefix — so
  `{prop:node_id}` collapsed to the built-in and a literal `node_id`/`edge_id`
  column was unreachable in labels, conditionals and date tokens. Default node
  template is `{node_id|truncate:10:...}`, so every node label showed the
  configured id. Applies equally to `edge_id`.
- Real bug 2: `TemplateEditorModal.vue` DEFAULT_QUERY hardcoded
  `MATCH (root { node_id: "$node_id" })` — with `id_hash` configured, the
  Cypher filter hit the wrong (literal) column or nothing.
- Real bug 3 (cosmetic): node/edge tables showed a generic "ID" header next to
  a `prop_node_id`/`prop_edge_id` column — correct values, ambiguous headers.

**Design decisions:**
1. **`prop:` = properties-first with built-in fallback.** Tokens written with
   the `prop:` prefix (placeholders, `date:prop:`, all conditionals) now carry
   `fromProps: true` and look up `item.properties[name]` first, falling back to
   the built-in when the property is absent (backward compatible — e.g.
   `{prop:node_type}` keeps working on nodes without such a property). Bare
   `{node_id}`/`{edge_id}` keep resolving to the configured id (unchanged).
2. **Template default query uses the configured column** (same pattern as
   `exampleQuery.ts`: `node_structure?.node_id_col || 'node_id'`).
3. **Table ID headers show the configured column name** when it differs from
   the literal name: `ID (id_hash)` instead of `ID`. `buildNodeColumns` gained
   an optional `idColName` param; DataTablePanel also disambiguates the edge ID
   header from `edge_structure.edge_id_col`.

**Files Modified:**
- frontend/src/utils/labelFormatter.ts — `fromProps` flag on ParsedToken;
  properties-first lookup in `getPropertyValue`; placeholder docs.
- frontend/src/components/TemplateEditorModal.vue — DEFAULT_QUERY uses
  configured `node_id_col`.
- frontend/src/composables/useTableColumns.ts — `buildNodeColumns(…, idColName?)`.
- frontend/src/components/DataTablePanel.vue — passes configured node/edge id
  column names into column builders.
- frontend/src/components/CommunityNodeModal.vue, ClusterNodeModal.vue — pass
  configured `node_id_col` to `buildNodeColumns`.
- frontend/src/components/TextFormatHelpModal.vue — documents `{node_id}` vs
  `{prop:node_id}` semantics.

**Testing:**
- [x] 9 new labelFormatter tests (prop: precedence for node_id/edge_id/src,
      built-in fallback regression, modifier/conditional/date paths).
- [x] 4 new useTableColumns tests (header disambiguation + row values).
- [x] Full frontend suite green: 981 tests, 57 files.
- [x] `npx vue-tsc --noEmit` clean.

**Status:** Implemented.

## [2026-07-16 18:40] - Feature Implemented: Parameters for cluster programs

**Feature:** Cluster programs can now declare typed parameters (text, number,
boolean, select), mirroring the query-template pattern. Create/edit moved from
the inline Programs-tab form to a dedicated modal; running a parameterized
program prompts for values; and when a program is used as a community
algorithm, its parameters render inline in the Communities tab.

**Design Decisions:**
1. **`context.params` injection, not `$param` substitution.** Values reach the
   program code as a typed `params` object (`const { nodes, edges,
   selectedNodeIds, selectedEdgeIds, params } = context`). Textual substitution
   (the template approach) is fragile in JS (string literals, no types);
   number/boolean values arrive already coerced.
2. **Inline params in the Communities tab** (user choice over a modal on
   Detect), consistent with the Louvain resolution slider. Values live in the
   community store keyed by program id (`programParams`) and persist through
   the exploration state; Detect is disabled while required params are empty.
3. **Resolution rules centralized in a pure util**
   (`utils/clusterProgramParams.ts`): defaults overlaid by provided values,
   stale keys (removed from the declaration) dropped, number coercion with NaN
   rejection, select values validated against options, boolean always resolves
   (`default ?? false`), required-empty fails with a clear error. Store-level
   `computeClustersFromProgram(programId, paramValues?)` falls back to declared
   defaults when no values are passed, keeping all pre-existing call sites and
   the zero-param behavior identical.
4. **Backward compatibility:** `parameters?` is optional on `ClusterProgram`,
   so old exploration states load unchanged; parameterless programs (incl. the
   two defaults) run immediately from the Run button exactly as before.
5. **Run modal seeds from defaults each open** (no last-used memory), matching
   TemplateExecuteModal. Execution history records `params_used`.

**Frontend Changes:**
- Types: `ClusterProgramParameter`, `ClusterProgramParamValues`;
  `ClusterProgram.parameters?`, `ClusterProgramContext.params`,
  `ClusterProgramExecution.params_used?` (types/cluster.ts).
- Cluster store: `computeClustersFromProgram`/`executeProgram` accept optional
  `paramValues`; `createProgram` persists `parameters`; `params` added to the
  `new Function` destructure.
- Community store: `programParams` state + `ensureProgramParams(programId)`
  (seed defaults, drop stale keys); `runClusterProgramAsCommunity` passes the
  stored values; `getState`/`loadState` round-trip `programParams`.
- New components: `ClusterProgramEditorModal.vue` (create/edit + param cards,
  modeled on TemplateEditorModal, embeds JavaScriptEditor),
  `ClusterProgramRunModal.vue` (parameter fill + run, inline error),
  `ClusterProgramParamInputs.vue` (shared typed inputs; `compact` variant for
  the panel).
- `ClusterProgramPanel.vue`: inline create/edit form removed in favor of the
  editor modal; Run opens the run modal only for parameterized programs;
  Communities tab renders inline param inputs below the algorithm select and
  gates Detect on missing required params; program meta shows param count.
- `JavaScriptEditor.vue` autocomplete and `clusterProgramSkill.ts` prompt now
  document `params`.

**Files Created:**
- frontend/src/utils/clusterProgramParams.ts
- frontend/src/components/ClusterProgramParamInputs.vue
- frontend/src/components/ClusterProgramEditorModal.vue
- frontend/src/components/ClusterProgramRunModal.vue

**Files Modified:**
- frontend/src/types/cluster.ts
- frontend/src/stores/cluster.ts
- frontend/src/stores/community.ts
- frontend/src/components/ClusterProgramPanel.vue
- frontend/src/components/JavaScriptEditor.vue
- frontend/src/utils/clusterProgramSkill.ts
- frontend/src/__tests__/fixtures/clusters.ts (createClusterProgramParameter)

**Testing:**
- [x] New: utils/clusterProgramParams.test.ts (13 tests — defaults, overlay,
      stale keys, coercion, select validation, required).
- [x] New: ClusterProgramParamInputs / ClusterProgramEditorModal /
      ClusterProgramRunModal component tests (16 tests, Teleport →
      document.body convention, JavaScriptEditor stubbed).
- [x] Extended: cluster.test.ts (+8 param tests incl. legacy-state load),
      community.clusterProgram.test.ts (+6 programParams tests).
- [x] Full frontend suite green: 1026 tests, 61 files.
- [x] `npx vue-tsc --noEmit` clean.

**Known Limitations:**
- Community-store `getState()` still returns `undefined` before the first
  detection, so param values chosen before ever clicking Detect are not
  persisted (same contract as `resolution`/`edgeTypeFilter`).

**Status:** Implemented.

## [2026-07-16 18:45] - Feature: "BFS from Node" default cluster program (parameterized)

**Feature:** Third built-in cluster program (`default-bfs-from-node`), the first
default to use the new parameter system. Runs a BFS from a start node and
clusters the reached nodes by depth level.

**Parameters:**
- `start_node_id` (text, required) — BFS anchor; clear error if not in graph.
- `depth` (select `1|2|3`, default `3`) — max BFS levels.
- `allow_types` (text, optional, default empty = all) — comma-separated node
  types the traversal may visit; nodes outside the list are dropped AND not
  traversed through (they block paths). The start node is always included
  since it is explicitly requested by id.

**Design Decisions:**
1. One cluster per BFS level (`BFS start: <id>`, `BFS depth 1..N`), all
   `state: 'open'` with per-level colors — the point is visualizing rings, not
   collapsing them. Empty levels are skipped (BFS stops early).
2. `depth` as a select of `'1'|'2'|'3'` (per request) — code converts with
   `Number(params.depth)`.
3. Undirected adjacency (same convention as the Orphan Clusters default).

**Files Modified:**
- frontend/src/stores/cluster.ts — new program in `createDefaultPrograms()`,
  `DEFAULT_PROGRAM_IDS.BFS_FROM_NODE`.
- frontend/src/stores/__tests__/cluster.test.ts — init tests now expect 3
  defaults + param declaration checks; 7 behavior tests (depth limiting,
  default depth, allow-list drop/block, empty allow list, missing/nonexistent
  start node).

**Testing:**
- [x] Full frontend suite green: 1034 tests, 61 files.
- [x] `npx vue-tsc --noEmit` clean.

**Status:** Implemented.

## [2026-07-16 18:56] - Fix: BFS default returns one cluster; community labels carry cluster names

**Problem (user report):** Running "BFS from Node" as a community algorithm
produced many communities (one per depth ring + a singleton with just the
root), when the expected result was two: the BFS set and "others". Separately,
communities were displayed as anonymous "Community 0/1/2..." — no way to tell
which one was the BFS and which was "others" (cluster names were dropped by
`buildCommunityMapFromClusters`).

**Changes:**
1. **BFS default now returns a SINGLE cluster** (`BFS from <id>`) containing
   the start node plus everything reached — as a community algorithm this
   yields exactly two communities (BFS set + "Others"). The per-level rings
   remain available via a new boolean parameter `group_by_level`
   (default false), which also exercises the boolean param type in a default
   program.
2. **Community labels:** new `communityLabels` state
   (`Record<number, string>`) in the community store. The cluster-program path
   fills it with the clusters' `cluster_name` (community id = cluster index)
   and labels the uncovered-nodes bucket "Others". Louvain resets it (UI falls
   back to "Community <id>"). `communitiesSorted` gained a `label` field;
   `ClusterProgramPanel` community list and `CommunityNodeModal` header render
   it. Labels persist via `getState`/`loadState` and are cleared by
   `clearCommunities`.

**Files Modified:**
- frontend/src/stores/cluster.ts — BFS default program: single-cluster default
  + `group_by_level` param.
- frontend/src/stores/community.ts — `communityLabels` state, label fill in
  `runClusterProgramAsCommunity`, Louvain/clear resets, persistence,
  `communitiesSorted.label`.
- frontend/src/components/ClusterProgramPanel.vue,
  CommunityNodeModal.vue — render `label` instead of `Community {{ id }}`.
- Tests: cluster.test.ts (single-cluster default, `group_by_level` rings),
  community.clusterProgram.test.ts (two-community BFS assertion, labels +
  "Others", Louvain fallback, label persistence).

**Testing:**
- [x] Full frontend suite green: 1040 tests, 61 files.
- [x] `npx vue-tsc --noEmit` clean.

**Status:** Implemented.

## [2026-07-16 19:47] - Feature Implemented: Cluster programs in the node context menu (with node-property bindings)

**Feature:** Cluster programs flagged with `show_in_context_menu` appear as
items in the node right-click menu (labeled with the program name). Clicking
one runs the program as a COMMUNITY algorithm on that node: parameter
defaults, overridden by node-bound parameters whose values come from the
clicked node (`node_id`, `node_type`, or a named property such as
`id_simples`). Replaces the manual flow (open panel → Communities tab →
select program → copy-paste node id → Detect).

**Design Decisions:**
1. **Flat optional fields, not a nested config object.**
   `ClusterProgram.show_in_context_menu?: boolean` +
   `ClusterProgramParameter.node_binding?: 'node_id'|'node_type'|'prop:<name>'`.
   A per-param field dies with its param card (no stale bindings keyed by
   param id), maps 1:1 to the editor UI, and rides through exploration
   persistence for free. Optional → old states load unchanged.
2. **Menu runs use DEFAULTS + bound values**, intentionally overwriting
   panel-edited `programParams` so the Communities tab afterwards shows
   exactly what ran (honest, persisted state).
3. **Missing binding = hard abort with a clear toast** (user choice), even
   when the param has a default — a silent default would substitute a value
   from the wrong context. Missing = property absent/null/empty-string/
   non-primitive.
4. **Toast-only feedback** (user choice): success shows
   `"<count> communities: <top labels>"` (labels from `communitiesSorted`);
   graph recolors via existing community reactivity. No panel opens.
5. **BFS default ships enabled** (`show_in_context_menu: true`,
   `start_node_id` bound to `node_id`) — the flagship use case works out of
   the box.
6. **Reconcile-by-replace action registry.** New composable
   `useClusterProgramMenuActions` watches a computed of eligible programs
   (id + name) and drop-and-re-adds its actions — covers create/delete/
   rename/flag-toggle and wholesale replacement by exploration `loadState`.
   `visible` requires the target id to exist in `graphStore.nodes` (excludes
   cluster synthetic nodes); `disabled` while `communityStore.computing`.

**Files Created:**
- frontend/src/composables/useClusterProgramMenuActions.ts
- frontend/src/composables/__tests__/useClusterProgramMenuActions.test.ts

**Files Modified:**
- frontend/src/types/cluster.ts — `ClusterProgramNodeBinding`, `node_binding`,
  `show_in_context_menu`.
- frontend/src/utils/clusterProgramParams.ts — `resolveNodeBoundValues`
  (+ `NodeBindingSource`, `ResolveNodeBoundResult`).
- frontend/src/stores/cluster.ts — `createProgram` pass-through; BFS default
  flag + binding.
- frontend/src/components/ClusterProgramEditorModal.vue — "Show in node
  right-click menu" checkbox; per-param "Node binding" select
  (None/Node ID/Node type/Property…) with property-name input + validation.
- frontend/src/views/GraphVisualizationView.vue — register()/unregister()
  wiring alongside useCommunityTableAction.
- Tests extended: clusterProgramParams.test.ts (+5 binding tests),
  ClusterProgramEditorModal.test.ts (+3), cluster.test.ts (+2).

**Testing:**
- [x] 12 new composable tests (registration reconciliation, visible/disabled,
      handler success with bound values, missing-property/deleted-program/
      ghost-node/program-throw error paths — toasts asserted via the useToast
      singleton).
- [x] Full frontend suite green: 1062 tests, 62 files.
- [x] `npx vue-tsc --noEmit` clean.

**Known Limitations:**
- Explorations saved before this feature carry the old BFS declaration
  without the flag — the menu item won't appear for them (accepted, no
  migration).
- No editor warning yet when enabling the menu flag on a program that has a
  required, unbound, default-less parameter (run fails with a clear toast).

**Status:** Implemented.

## [2026-07-20 09:49] - Fix: Intermittent right-click context menu on nodes/edges

**Bug:** Right-clicking a node sometimes opened the context menu, sometimes did
nothing (only the hover tooltip showed).

**Root cause:** `three-render-objects` (under `3d-force-graph`) marks
`isPointerDragging = true` on ANY `pointermove` while a mouse button is held —
for mouse pointers there is no pixel threshold. On `pointerup` it then skips
`onRightClick` entirely (`clickAfterDrag` is hardcoded to `false` by
`3d-force-graph`). A natural human right-click almost always includes 1–3px of
jitter between press and release, so the library's `onNodeRightClick` fired
only when the hand was perfectly still. The app-level 5px drag threshold in
`GraphCanvas3D` never ran because the library discarded the event first. The
hover tooltip kept working because the hover raycast is a separate path.

**Design Decisions:**
1. **App-level mouseup trigger, not a library patch:** the menu now opens from
   the component's own `window` `mouseup` (button 2) handler
   (`maybeOpenContextMenu`), keeping the fix out of the `3d-force-graph`
   submodule / npm `three-render-objects`. The library still `preventDefault()`s
   the native `contextmenu` event, so no browser menu appears.
2. **Synchronous hover tracking:** `hoveredNodeSync`/`hoveredLinkSync` are set
   directly inside `onNodeHover`/`onLinkHover` (no RAF debounce, unlike
   `graphStore.hoveredNodeId`) so the mouseup handler resolves the same target
   the user sees under the tooltip. Reset on `initGraph` re-init.
3. **Existing 5px threshold kept:** `isStationaryRightClick` still suppresses
   the menu after a right-drag (camera pan / map-style pan).
4. **Library right-click callbacks removed:** `.onNodeRightClick`/
   `.onLinkRightClick` are no longer registered — a single trigger path avoids
   double-opens.
5. **Dev-only e2e hook:** `window.__GRAPH_NODE_SCREEN_COORDS__(nodeId)`
   (guarded by `import.meta.env.DEV`, same pattern as
   `__THREE_RENDERER_INFO__`) exposes node screen coords so Playwright can
   target WebGL nodes deterministically.

**Files Created:**
- frontend/src/utils/contextMenuTrigger.ts — `isStationaryRightClick`,
  `resolveContextMenuTarget`, `truncateMenuLabel` (pure, unit-tested).
- frontend/src/utils/__tests__/contextMenuTrigger.test.ts — 14 tests.
- frontend/e2e/tests/context-menu.spec.ts — regression e2e: right-click with
  2px jitter opens the menu (always failed pre-fix); right-drag does not.
  Hover is made deterministic by waiting for the lib's `clickable` class on
  the canvas before clicking.

**Files Modified:**
- frontend/src/components/GraphCanvas3D.vue — sync hover refs, mouseup-driven
  `maybeOpenContextMenu`, removed `.onNodeRightClick`/`.onLinkRightClick`,
  dev-only screen-coords hook.

**Testing:**
- [x] Unit suite green: 1111 tests, 64 files (14 new).
- [x] Full e2e suite green: 85 tests (2 new); new spec passed 3x repeated.
- [x] `npx vue-tsc --noEmit` clean.

**Known Limitations:**
- Touch long-press still doesn't open the menu (was already the case — the
  library only right-click-dispatches on `pointerup` with `button === 2`).

**Status:** Implemented.

## [2026-07-20 10:25] - Fix follow-up: context menu target latched at mousedown (CI failure)

**Bug:** The new e2e regression test failed on CI (passed locally). Reproduced
locally with CDP `Emulation.setCPUThrottlingRate` (6x): the previous fix
resolved the menu target at MOUSEUP from the synchronous hover state, but when
the pointer jitters while the right button is held, `three-render-objects`
flags `isPointerDragging` and its next render tick forces `topObject = null`,
firing a hover-out that wipes `hoveredNodeSync` BEFORE mouseup. On fast
machines the down→jitter→up sequence fits inside one frame (~16ms) so no tick
lands mid-click; on slow runners (CI SwiftShader) one always does.

**Fix:** capture the menu target at right-button mousedown
(`rightClickDownTarget`) — what the user saw when they pressed — and use it at
mouseup, falling back to mouseup-time hover for stationary presses where the
throttled raycast only caught the node after the press.

**Test hardening (e2e):**
- `freezeLayout()` helper: stops the simulation via the Layout panel Stop
  button before interacting (Stop pins fx/fy/fz), so node screen positions
  can't drift on slow runners. Added `data-testid="graph-toolbar-layout"`
  (GraphVisualizationView) and `data-testid="layout-run-btn"` (LayoutPanel).
- Hover-engage timeout raised to 2s; explicit `menu.waitFor(visible)`.
- Verified with 6x and 12x CPU throttling, 3x repeats: all green.

**Files Modified:**
- frontend/src/components/GraphCanvas3D.vue — `rightClickDownTarget` latch.
- frontend/src/views/GraphVisualizationView.vue — testid on Layout button.
- frontend/src/components/LayoutPanel.vue — testid on Run/Stop button.
- frontend/e2e/tests/context-menu.spec.ts — freezeLayout + robustness.

**Testing:**
- [x] Unit suite green: 1111 tests. `vue-tsc --noEmit` clean.
- [x] Full e2e green: 85 tests; new spec green under 12x CPU throttle.

**Status:** Implemented.

## [2026-07-29 10:00] - Feature Implemented: Public sharing ("*") + "Share with my domain" quick action

**Feature:** Contexts and explorations can now be shared publicly with ALL
users (read-only), in addition to the existing per-email and `*@domain`
wildcard sharing. The share modal also gained quick-action buttons: "Make
public" and "Share with my domain".

**Design Decisions:**
1. **Sentinel share row (`shared_with_email = "*"`)** instead of an
   `is_public` column: no migration, reuses the existing share tables,
   endpoints (`POST /{id}/share`, `DELETE /{id}/share/{email}`), response
   shape (`shared_with`) and the established `*@domain` sentinel pattern.
2. **Public is always read-only.** `ShareRequest` coerces
   `{email: "*", permission: "write"}` to `read` (model validator), and
   `user_has_write_access` excludes public shares unconditionally
   (defense-in-depth against hand-inserted DB rows).
3. **Owner or superuser can publish** — existing `can_manage` rule, no change.
4. **No new config flag** — available whenever sharing is enabled
   (`database_enabled`). The public sentinel bypasses
   `allowed_share_domains` validation.
5. **`share_match_emails()` helper** replaces the 3x duplicated SQL wildcard
   blocks (graph_contexts list, explorations list, context-access check) so
   DB-mode matching can't drift from `email_matches_share` again.
6. **"Share with my domain" button** only renders when the logged-in user's
   domain is in `allowed_share_domains` (backend would reject otherwise);
   shares as `read` — write remains available via the manual form.

**Backend Changes:**
- `api/graphlagoon/utils/sharing.py` — `PUBLIC_SHARE_EMAIL`,
  `is_public_share()`, public match in `email_matches_share()`, public
  exclusion in `user_has_write_access()`, public branch first in
  `validate_share_email()` (before the `@` format check, which would reject
  `"*"`), new `share_match_emails()`.
- `api/graphlagoon/models/schemas.py` — `ShareRequest` model validator
  coercing public shares to read.
- `api/graphlagoon/routers/graph_contexts.py`,
  `api/graphlagoon/routers/explorations.py` — list/access SQL now uses
  `shared_with_email.in_(share_match_emails(user))`. Memory-mode branches
  needed no changes (they funnel through `email_matches_share`).
- `db/memory_store.py` — unchanged (exact-string store/delete works for `"*"`).

**Frontend Changes:**
- `frontend/src/services/api.ts` — `encodeURIComponent()` on unshare path
  params (hardening; `"*"` passes through unchanged).
- `frontend/src/views/ContextsView.vue`, `ExplorationsView.vue` — share modal
  quick actions (`make-public-btn`, `share-domain-btn` testids), `"*"`
  rendered as "Everyone (public)" with a `badge-public` chip, Public badge on
  list cards (owner included), modal stays open after quick-share so the new
  entry is visible (mirrors `unshare()` refresh, unlike `share()` which
  closes).

**Testing:**
- [x] `api/tests/test_sharing_utils.py` +13 tests: public matching, write
  exclusion (key security assertion), validation ordering,
  `share_match_emails`, ShareRequest coercion.
- [x] New `api/tests/test_public_sharing.py` (TestClient, memory mode):
  publish → stranger sees read-only, PUT/DELETE 403, stranger cannot publish,
  literal `*` in DELETE path (regression), exact write share survives public
  read, public exploration reveals parent context, superuser
  publish/unpublish. Backend: 290 passed.
- [x] `frontend/src/services/__tests__/api.test.ts` — `"*"` share/unshare
  paths (note: existing unshare assertion updated to `a%40b.com` due to
  encodeURIComponent).
- [x] `frontend/e2e/tests/sharing-ui.spec.ts` +7 tests (Public sharing +
  Share with my domain describes). E2E: 20 passed. Full unit suite: 1170
  passed. `vue-tsc --noEmit` clean.

**Known Limitations:**
- `make lint-api` (black --check) fails on 6 files — pre-existing before this
  feature (verified via stash), including the two routers touched here.
- No DB-mode (PostgreSQL) integration test for the new SQL conditions; the
  `.in_()` substitution is covered by `share_match_emails` unit tests.

## [2026-07-30] - Analysis: Initial graph load performance (evaluation only, no code)

**Feature:** Avaliação de abordagens para acelerar o fetch inicial do grafo
(construção incremental, edges-first, re-avaliação de joins).

**Deliverable:** [initial_load_perf_analysis.md](initial_load_perf_analysis.md)
— mapeia 6 problemas com localização exata no código, propõe 5 fases
independentes e documenta trade-offs e alternativas rejeitadas.

**Key findings:**
1. `ORDER BY RAND()` no `/subgraph` sem filtro (routers/graph.py:250) — shuffle
   da tabela inteira de arestas em todo auto-load.
2. `SELECT n.*` na fase 2 (graph_operations.py:410-419) — todas as colunas de
   todos os nós, sempre; `properties` domina o payload mas não é usada para
   renderizar (só tooltip/detalhes/busca).
3. Sequencialidade estrita arestas→nós + resposta em blob único; resposta
   edges-only já existe internamente (graph_operations.py:386-397), não exposta.
4. Caminho Cypher refaz o fetch de nós mesmo quando o SQL transpilado já os
   trouxe (redundância).
5. `nodes`/`edges` são ref profundo no Pinia — Proxy em cada dict de properties.
6. Buracos de instrumentação: loadContext, graph3d.graphData(), computed chain.

**Design decisions (validated in code):**
- Patch-in-place de properties é seguro: o data watcher do canvas
  (GraphCanvas3D.vue:1324) só dispara em mudança de contagem; watchers de
  community/similarity observam identidade do array.
- "Types-first" (SELECT node_id, node_type) em vez de esqueleto puro: node_type
  dita cor/tamanho/ícone e é assado no build do canvas.
- Polling com partials preferido a streaming SSE (reaproveita job machine,
  preserva mocks E2E).
- Carga progressiva será padrão ligado no auto-load (decisão do usuário).
- markRaw preferido a shallowRef total (raio de explosão nos ~905 testes).
- **P1 (`ORDER BY RAND()`) mantido como está** (decisão do usuário, 2026-07-30):
  a amostra aleatória é intencional e o custo só incide no auto-load — fora de
  escopo. Fase 1 fica restrita a P2 (projeção de colunas) e P4 (redundância
  Cypher).

**Files created:**
- docs/dev/initial_load_perf_analysis.md

**Testing:** n/a (análise; nenhum código alterado).

**Next steps:** decidir escopo do branch feat/improve_perf (recomendação:
Fases 0–2, com Fase 1 restrita a P2/P4 após exclusão do P1).

## [2026-07-30] - Phase 0: Instrumentação baseline do carregamento inicial

**Feature:** Fechar os buracos de medição (P6 de
[initial_load_perf_analysis.md](initial_load_perf_analysis.md)) para que as
fases seguintes tenham antes/depois mensurável.

**Design decisions:**
1. **`recordChainRecompute` dentro do store, não em `recordGraphLoad`:** a
   cadeia derivada (`enhancedNodes`/`enhancedEdges`) só é alcançável do escopo
   do setup do store. Forçar a avaliação logo após o assign mede um recompute
   real (computeds sujos), e não adiciona custo — o canvas dispararia o mesmo
   trabalho instantes depois via data watcher.
2. **`assignMs` real nos caminhos query/cypher:** estava hardcoded como `0`,
   escondendo justamente o custo de wrap reativo que a Fase 4 pretende atacar.
3. **Snapshot sem `recordChainRecompute`:** o caminho depende de ordenação
   `nextTick()` frágil com o community store; medir fetch/assign é suficiente e
   não vale o risco de perturbar a ordem.
4. **`graphDataApply` mede só a parte síncrona:** o kapsule (`three-forcegraph`)
   adia o build de meshes para um digest tick, então o grosso do custo aparece
   em `forcegraphUpdate` (já instrumentado). Comentários no código explicitam
   que os dois devem ser lidos juntos — medido: 0.0ms vs 207ms em 7 chamadas.

**Bug encontrado e corrigido no harness:** `e2e/perf-report.ts` navegava para
`BASE_URL` (lista de contextos) e nunca abria a rota do grafo, produzindo
relatórios com **zero entradas** que pareciam execuções bem-sucedidas. Agora
navega para `/graph/{id}`, mocka o GET de contexto individual (faltava, e o
`loadContext` depende dele para resolver `autoLoadOnOpen`) e **falha com exit 1**
se nenhuma entrada for registrada.

**Files modified:**
- `frontend/src/stores/graph.ts` — `load:context:fetch`; `assignMs` real em
  query/cypher; `recordChainRecompute()` + chamadas em subgraph/query/cypher;
  `load:snapshot:*` no caminho de exploration.
- `frontend/src/components/GraphCanvas3D.vue` — `graphDataApply` e
  `initGraphDataApply`.
- `frontend/e2e/perf-report.ts` — navegação corrigida, rota de contexto
  individual, guarda de relatório vazio, payload escalável via
  `PERF_NODES`/`PERF_EDGES`/`PERF_PROPS`, metadata no mock.

**Files created:**
- `frontend/src/stores/__tests__/graph.perfInstrumentation.test.ts` (9 testes)
- `docs/dev/perf_baseline_initial_load.json` — baseline versionado

**Baseline (10k nós / 20k arestas / 30 props, payload mockado, sem warehouse):**

| Etapa | ms |
|---|---|
| `load:context:fetch` | 138.4 |
| `load:subgraph:fetch` | 293.5 |
| `load:subgraph:assign` | 0.1 |
| `load:subgraph:chain` | 29.9 |
| `buildGraphData` | 126.0 |
| `headlessSettle` | 3401.4 |
| `forcegraphUpdate` (7×) | 207.7 |

Leitura: com payload mockado o fetch é otimista (sem custo de warehouse) e
`headlessSettle` domina — mas ele já roda em Web Worker, fora do main thread.
O que as Fases 1–2 atacam (`fetch` + `chain` + parte de `buildGraphData`) soma
~450ms aqui e cresce com a largura da tabela de nós, que o mock não reproduz.
**Baseline contra warehouse real ainda é necessário** para dimensionar P2.

**Testing:**
- [x] 9 testes novos; verificado que 3 deles falham se a instrumentação for
      removida (não são tautológicos).
- [x] Suite unit: 1179 passed (65 arquivos). E2E: 92 passed. `vue-tsc` limpo.

**Known Limitations:**
- Baseline usa payload mockado: não mede `ORDER BY RAND()` (P1, fora de escopo)
  nem o custo real do `SELECT n.*` (P2). Rodar contra `make dev-db` com dataset
  grande antes de dimensionar a Fase 1.
- Falta uma métrica end-to-end "mount → primeiro frame pintado"; hoje é preciso
  somar labels manualmente.

## [2026-07-30] - Phase 1: Projeção de colunas + eliminação do refetch Cypher

**Feature:** P2 e P4 de
[initial_load_perf_analysis.md](initial_load_perf_analysis.md). P1
(`ORDER BY RAND()`) permanece fora de escopo por decisão do usuário.

**Implementação:**

*P2 — projeção de colunas.* `build_node_projection()` substitui o
`SELECT n.*` incondicional. Quando o contexto declara `node_properties`,
seleciona apenas as colunas estruturais + essas propriedades;
`resolve_node_columns()` (router) deriva a lista do contexto. Contextos **sem**
propriedades configuradas mantêm `n.*` — não fomos informados de quais colunas
importam, e estreitar silenciosamente quebraria tooltips e a data table.

*P4 — colheita de nós.* `harvest_nodes_from_result()` reaproveita os nós que o
SQL transpilado do Cypher já retornou (`RETURN r, a, b`). Só a diferença
(`node_ids - harvested`) vai para a segunda query; quando nada falta, a query
de nós **não roda** (`node_query_ms=0.0`).

**Bug encontrado durante a validação contra warehouse real:**
os dois caminhos produziam **tipos diferentes** para a mesma propriedade —
`isFraud` vinha como `float` (1.0) no caminho colhido e `str` ("1.0") no
caminho antigo, porque campos dentro de um NAMED_STRUCT sobrevivem à decodificação
JSON como números reais, enquanto colunas de topo chegam já stringificadas pela
statements API. Isso quebraria filtros de propriedade e ordenação no frontend,
que comparam valores crus. Corrigido com `_stringify_scalar()`.

Verificado empiricamente contra o warehouse (`SELECT true, 1.5` →
`['True', '1.5']`): a serialização é `str()` do Python, **incluindo o booleano
capitalizado**. Minha suposição inicial (`'true'` minúsculo, à la Spark) estava
errada e foi corrigida antes de virar código.

**Design decisions:**
1. **Narrowing opt-in por dados, não por flag:** o contexto já declara quais
   colunas a UI exibe; usar isso evita um parâmetro novo na API e mantém
   contextos legados intactos.
2. **Colheita é aditiva:** uma query sem variáveis de nó colhe zero e o fluxo
   antigo roda inalterado — o caminho `/subgraph` não muda em nada.
3. **Preferir o struct mais rico:** o mesmo nó pode aparecer em várias
   projeções, algumas só com o id.
4. **Renomeada a variável local `node_columns` → `result_columns`** no funil:
   colidia com o novo parâmetro homônimo (funcionava por ordem de uso, mas era
   uma armadilha para a próxima edição).

**Medições contra warehouse real** (`fraud.nodes_ieee_cis`, 25 colunas;
contexto largo `SELECT n.*` vs. estreito com 3 propriedades; melhor de 3):

| limit | payload | node_query | wall |
|---|---|---|---|
| 3.000 arestas | 0.99 → 0.64 MB (**-35%**) | 110 → 106 ms (-3%) | 243 → 229 ms (-6%) |
| 20.000 arestas | 1.37 → 0.90 MB (**-34%**) | 163 → 106 ms (-35%) | 309 → 241 ms (-22%) |

Leitura honesta: a **redução de payload (~35%) é o efeito consistente**; o ganho
de tempo de query varia muito com o cache do Spark (numa primeira medição a frio
chegou a -51%, no melhor-de-3 caiu a -3% no limit menor). O payload menor é o que
importa para a Fase 2, porque também reduz o custo de wrap reativo no cliente.

*P4 validado end-to-end:* `MATCH (a)-[r]->(b) RETURN r, a, b LIMIT 300` →
`node_query_ms=0.0` (segunda query eliminada); mesmos 218 nós e **zero** valores
divergentes vs. `RETURN r`.

**Files modified:**
- `api/graphlagoon/services/graph_operations.py` — `build_node_projection`,
  `harvest_nodes_from_result`, `_stringify_scalar`, `_quote_identifier`,
  parâmetro `node_columns` no funil, merge dos nós colhidos.
- `api/graphlagoon/routers/graph.py` — `resolve_node_columns` + wiring nos 5
  call sites (subgraph, expand, query, cypher, job assíncrono).

**Files created:**
- `api/tests/test_node_projection.py` (35 testes)

**Testing:**
- [x] 35 testes novos; verificado que removendo a colheita 2 deles falham.
- [x] Backend: 325 passed, 1 skipped. Frontend: 1179 passed. E2E: 92 passed.
- [x] Validação manual contra warehouse local com dataset real (25 colunas).

**Known Limitations:**
- `make lint-api` (black) continua falhando em `graph.py` e
  `graph_operations.py` — **pré-existente**, verificado com `git show HEAD:`.
- A colheita depende do transpiler emitir NAMED_STRUCT com os nomes de coluna do
  contexto (garantido hoje por `build_schema_provider`). Se o gsql2rsql mudar
  para nomes lógicos, a colheita silenciosamente para de encontrar nós — degrada
  para o comportamento antigo, sem quebrar.

## [2026-07-30] - Phase 2: Carga progressiva (render primeiro, properties depois)

**Feature:** P3 de [initial_load_perf_analysis.md](initial_load_perf_analysis.md).
`/subgraph` com `nodes_mode='types'` devolve nós renderizáveis (id + type,
`properties: null`); o canvas pinta imediatamente e o store busca as
propriedades em lotes de background via `POST /graph-contexts/{id}/nodes/batch`,
aplicando-as com **patch in-place**.

**Por que o patch in-place é seguro (verificado no código e por teste):**
- `nodes.value` mantém a **identidade do array** → watchers de
  community/similarity (que observam identidade) não disparam;
- **contagens** de nós/arestas não mudam → o data watcher do canvas
  (GraphCanvas3D.vue:1324, que só reage a contagens) não reconstrói a cena nem
  reaquece o layout;
- o refresh visual passa por um sinal explícito (`nodePatchVersion`) →
  `refreshNodeContent()` recalcula labels e chama `updateVisuals()`/
  `updateOverlays()`, **sem** `graph3d.graphData()`. Medido em ~1ms para 3086 nós.

**MEDIÇÃO — o resultado mais importante, e ele qualifica a premissa do plano.**
Live browser + warehouse real (`fraud.nodes_ieee_cis`, 25 colunas, 13 props/nó):

| escala | primeiro paint | total |
|---|---|---|
| 970 nós | 700 → 759 ms (**pior**) | pior |
| 3086 nós | 972 → **827 ms (-15%)** | 972 → ~1330 ms (+37%) |

Backend isolado (limit 20k): payload do primeiro paint **-44%**, primeiro
fetch **-25%**; enriquecimento adiciona ~350ms.

**Conclusão honesta: a carga progressiva NÃO é ganho universal.** Ela troca
custo total maior por primeiro paint menor, e só compensa quando o payload de
properties é grande o suficiente. Em grafos pequenos (~1k nós) ela é
*mensuravelmente pior*. Por isso o comportamento é uma flag
(`behaviors.progressiveLoad`, default `true` conforme decidido) e não um
caminho único — e por isso vale considerar ligá-la por limiar de tamanho numa
iteração futura, em vez de sempre.

**Design decisions:**
1. **"Types-first", não esqueleto puro:** `node_type` dita cor/tamanho/ícone e é
   assado no `buildGraphData`; trazê-lo já no primeiro fetch evita rebuild
   visual quando as properties chegam. Confirmado: o refresh custa ~1ms.
2. **Nós colhidos (Fase 1) mantêm properties mesmo em modo "types":** já vieram
   de graça no resultado da query; descartá-las seria desperdício. Nesse caso
   `properties_deferred=false` e nada fica pendente.
3. **Endpoint aceita apenas ids:** a projeção vem do contexto, então o cliente
   não pode ampliar a query nem nomear colunas arbitrárias.
4. **Enriquecimento é best-effort:** um lote que falha loga e para; o grafo já
   está renderizado e usável. Erro bloqueante ali seria pior que tooltip vazio.
5. **Token de cancelamento:** troca de contexto/novo load/`clear()` incrementa
   `enrichmentToken`; lotes em voo abandonam seus patches (testado).
6. **Ids sem retorno saem do pending:** linha deletada no warehouse deixaria o
   id pendente para sempre e o loop nunca terminaria (testado).

**Bugs encontrados durante a implementação:**
- **Teste com objeto compartilhado:** `TYPES_RESPONSE` era um literal de módulo;
  como o store atribui `response.nodes` direto e o patch muta in-place, um teste
  contaminava o seguinte com nós já enriquecidos. Trocado por factory.
- **`mockReturnValue` com Promise:** devolve *a mesma instância* a todas as
  chamadas; uma promise resolvida por outro teste fazia o lote resolver na hora.
  Trocado por `mockImplementation`.
- Ambos eram defeitos de teste, não de produção — mas só apareceram porque os
  testes rodaram em conjunto.

**Files modified:**
- `api/graphlagoon/models/schemas.py` — `nodes_mode`, `NodeBatchRequest/Response`,
  `properties_deferred`.
- `api/graphlagoon/services/graph_operations.py` — `build_node_query`,
  `fetch_nodes_by_ids` (extraídos e reutilizados), `nodes_mode` no funil.
- `api/graphlagoon/routers/graph.py` — endpoint `POST .../nodes/batch`.
- `frontend/src/stores/graph.ts` — `patchNodeProperties`,
  `enrichNodeProperties`, `prioritizeNodeProperties`, estado
  `pendingPropertyNodeIds`/`nodePatchVersion`/`enriching`, behavior
  `progressiveLoad`.
- `frontend/src/components/GraphCanvas3D.vue` — `refreshNodeContent()` + watcher.
- `frontend/src/types/graph.ts`, `services/api.ts` — tipos + `getNodesBatch`.
- `frontend/e2e/helpers/api-mocks.ts` — rota `/nodes/batch`.
- `frontend/src/stores/__tests__/graph.actions.test.ts` — asserção do payload
  atualizada para o novo contrato.

**Files created:**
- `frontend/src/stores/__tests__/graph.progressiveLoad.test.ts` (19 testes)
- `frontend/e2e/tests/progressive-load.spec.ts` (3 testes)

**Testing:**
- [x] Backend 325 passed; frontend 1198 passed; E2E 95 passed; `vue-tsc` limpo.
- [x] E2E verificados contra regressão (desligando `progressiveLoad`, 1 falha).
- [x] Validação live: browser real + warehouse real, ambos os modos comparados.

**Known Limitations:**
- Só `/subgraph` é progressivo. Exploration snapshots, `expandFromNode` e o job
  de query/Cypher continuam em modo `full` — intencional (Fase 3 cobriria o job).
- Só o clique em nó dispara `prioritizeNodeProperties`; hover não (evita uma
  requisição por nó sobrevoado). Se o tooltip de hover se mostrar lento na
  prática, vale um debounce em vez de chamada direta.
- Enriquecimento não tem retry: um lote que falha deixa aqueles nós sem
  properties até o próximo load. Aceitável por ora (best-effort), mas é a
  primeira coisa a endurecer se aparecer em uso real.

**Follow-up aplicado na mesma sessão:** `prioritizeNodeProperties` ligado ao
clique em nó (GraphCanvas3D `onNodeClick`) e indicador discreto
"loading properties…" na status bar (`graph-status-enriching`), com E2E
cobrindo aparecer/desaparecer. Suites finais: backend 325, frontend 1198,
E2E 96.

## [2026-07-30] - Phase 2b: Tabelas largas (100 colunas) — limiar + enriquecimento em 2 ondas

**Contexto:** o usuário apontou que tabelas de nós podem ter **100 colunas**.
Isso invalida a conclusão da Fase 2 (medida em tabela de 13 propriedades, onde
a carga progressiva era marginal ou até pior). Criei
`graphs.nodes_wide100` (100 colunas, 20k nós) + `graphs.edges_wide100` (40k
arestas) no warehouse local e remedi tudo.

**Medições — 100 colunas, 20k arestas, ~18,7k nós:**

| variante | payload 1º fetch | tempo até o grafo |
|---|---|---|
| `SELECT n.*` (hoje) | 35,8 MB | 3151 ms (backend) / **7898 ms (browser)** |
| projeção estreita (5 props) | 4,5 MB (-87%) | 847 ms |
| progressiva types-only | 2,95 MB (**-92%**) | 741 ms / **1731 ms (browser)** |

**Achado que só apareceu no browser:** o backend responde os 35,8 MB em ~3,0 s,
mas o `load:subgraph:fetch` do cliente marca **7,3 s** — ou seja, ~4,2 s são
puramente download + parse de JSON no browser. As medições server-side
subestimavam o problema pela metade. **Browser real: 7898 ms → 1731 ms (-78%).**

**Mudança 1 — `progressiveLoad` vira `'auto' | 'always' | 'never'`.**
A Fase 2 media que a carga progressiva é *pior* em tabelas estreitas; com 100
colunas é dramaticamente melhor. Nenhum default fixo serve aos dois casos, então
`'auto'` decide por largura (`PROGRESSIVE_LOAD_MIN_PROPERTIES = 20`, ponto
conservador dentro do intervalo medido). Um contexto **sem** `node_properties`
conta como largo: o backend cai em `SELECT n.*`, largura desconhecida e
potencialmente enorme — exatamente o caso que a feature existe para resolver.

**Mudança 2 — enriquecimento em 2 ondas.** Buscar as 98 colunas de todos os nós
custava +76% de trabalho total (5054 ms). Agora a primeira onda pede só as
colunas que *mudam o que é desenhado* (referenciadas por templates de label
`{prop:...}` e por ícones por propriedade) e a segunda pede o resto:

- onda 1 (3 colunas): 1482 ms, 1,96 MB — **6% do payload, 29% do tempo**
- onda 2 (98 colunas): 5054 ms, 33,8 MB

Resultado: grafo em 741 ms, **labels/ícones corretos em 2223 ms** (vs 3151 ms
do monolítico) e o bulk chega depois sem bloquear nada.

**Mudança 3 — `columns` opcional no `/nodes/batch`.** Validado contra o
`node_properties` do contexto: só pode **estreitar**, nunca ampliar. Um contexto
sem propriedades configuradas **ignora** o campo — honrar nomes arbitrários ali
deixaria um caller sondar o schema da tabela observando quais dão erro. (O
quoting em `build_node_projection` já impede injeção — verificado: um nome com
`` ` `` e `;` vira um identificador único e inerte — mas não impede a sondagem.)

**Bug pego por teste durante a implementação:** a segunda onda **apagava** as
colunas da primeira (`node.properties = props` substitui o dict inteiro). O
teste "keeps first-wave columns when the full wave lands" falhou e expôs isso;
`patchNodeProperties` ganhou a opção `merge`. Minha primeira tentativa de
correção (`merge: !clearPending`) estava com a lógica invertida — reescrita para
parâmetros explícitos por onda.

**Files modified:**
- `frontend/src/stores/graph.ts` — `ProgressiveLoadMode`,
  `PROGRESSIVE_LOAD_MIN_PROPERTIES`, `shouldLoadProgressively()`,
  `visualPropertyColumns()`, enriquecimento em 2 ondas, `patchNodeProperties`
  com `merge`/`clearPending`.
- `frontend/src/services/api.ts` — `getNodesBatch(ctx, ids, columns?)`.
- `api/graphlagoon/models/schemas.py` — `NodeBatchRequest.columns`.
- `api/graphlagoon/routers/graph.py` — validação/estreitamento de `columns`.
- `frontend/src/stores/__tests__/graph.progressiveLoad.test.ts` — +11 testes.
- `api/tests/test_node_projection.py` — +7 testes.

**Testing:** backend 332, frontend 1209, E2E 96, `vue-tsc` limpo. Validação
live em browser real contra tabela de 100 colunas.

**Known Limitations:**
- O limiar usa a contagem de `node_properties` do contexto, não a largura real
  da tabela. Um contexto que declara 5 propriedades sobre uma tabela de 100
  colunas é classificado como estreito — correto, porque a projeção da Fase 1 já
  o torna barato.
- A onda 1 detecta colunas visuais por regex `{prop:...}` nos templates. Um
  template construído dinamicamente em runtime não seria detectado; nesse caso a
  degradação é apenas perder a onda rápida, não incorreção.

## [2026-07-30] - Phase 2c: Exposição no painel + validação de enum

**Pergunta que originou:** "progressive load é configurado no settings e é salvo
no contexto?" A resposta era **meio sim**, e a investigação achou um bug.

**Como a persistência realmente funciona (verificado, não suposto):**
`progressiveLoad` vive em `behaviors`, que é resolvido por
`resolveInitialBehaviors()` na ordem: DEFAULTS → `window.__GRAPH_LAGOON_CONFIG__
.default_behaviors` (servidor) → `context.default_behaviors`. Explorations
salvas mesclam por cima ao carregar. Então **sim, persiste** por contexto e por
exploration — mas NÃO por sessão: mudar no painel vale só até o reload, igual a
todos os outros behaviors. Isso é consistente com o resto do app, e o teste E2E
diz isso explicitamente em vez de fingir o contrário.

**Bug encontrado — validação de enum ausente.** `applyBehaviorOverrides`
validava por `typeof`, que não distingue `'auto'` de `'banana'`: um valor
inválido vindo de um contexto salvo ou de config do servidor era **aceito** e
virava o modo ativo, contaminando toda exploration salva depois. Não era
específico do `progressiveLoad` — `edgeLensMode`, `searchMode` e `viewMode`
tinham o mesmo buraco desde antes desta sessão.

Corrigido com `BEHAVIOR_ENUMS`: cada behavior de união de strings declara seus
valores válidos e o resto é rejeitado com warning. Cobre também o formato antigo
(`progressiveLoad: true`, boolean), que já era rejeitado por `typeof` mas agora
tem teste.

**Exposição na UI.** O painel de Behaviors ganhou a seção "Property Loading"
(radio Automatic / Always progressive / All at once) ao lado de "Load graph on
open", com descrição por modo citando o ganho medido. Antes disso o único jeito
de mexer era escrever JSON cru no `default_behaviors` do contexto — inaceitável
para uma opção cujo default correto depende dos dados.

**Files modified:**
- `frontend/src/stores/graph.ts` — `BEHAVIOR_ENUMS` + checagem.
- `frontend/src/components/BehaviorPanel.vue` — seção "Property Loading".

**Files modified (tests):**
- `graph.progressiveLoad.test.ts` +5 (persistência via contexto, rejeição de
  valor inválido, rejeição do boolean legado, os outros enums, round-trip).
- `progressive-load.spec.ts` +2 (painel muda o modo sem refetch; default 'auto'
  refletido no radio).

**Testing:** frontend 1214, E2E 98, backend 332, `vue-tsc` limpo. Verificado que
os testes novos falham se a checagem de enum for removida (2 falhas).

**O QUE AINDA FALTA (avaliação honesta do estado):**
1. **`node_properties` não é auto-descoberto.** Um contexto de 100 colunas criado
   sem preencher as propriedades cai em `SELECT n.*` — a Fase 1 não ajuda e o
   usuário nem sabe. Existe `POST /api/schema-discovery`; ligá-lo ao formulário
   de contexto é provavelmente o maior ganho restante por esforço.
2. **Expand e exploration snapshots não são progressivos.** Um snapshot salvo
   guarda todas as properties; reabrir uma exploration de 100 colunas ainda paga
   o custo inteiro.
3. **Enriquecimento sem retry nem cancelamento por prioridade.** Um lote que
   falha deixa aqueles nós vazios até o próximo load.
4. **Fase 3 (partials no job de query/Cypher) e Fase 4 (markRaw) não feitas.**
   Com 100 colunas o custo de wrap reativo da Fase 4 provavelmente é maior do
   que eu estimei — vale medir antes de decidir.
5. **`total_count` é `len(edges)`, não um COUNT real** — o cliente não consegue
   dizer ao usuário quanto do grafo está vendo.

## [2026-07-30] - Phase 2d: Limiar 10 + correção de duas afirmações minhas erradas

**Mudança:** `PROGRESSIVE_LOAD_MIN_PROPERTIES` 20 → **10** (decisão do usuário:
"por default sempre vamos ter tabelas com muitas propriedades"). Teste de
fronteira adicionado — 9 colunas → monolítico, 10 → progressivo.

**CORREÇÃO 1 — "node_properties não é auto-descoberto" estava ERRADO.**
Verifiquei `ContextsView.vue:320`: ao criar um contexto, o formulário já carrega
o schema das tabelas e deriva `node_properties` de TODAS as colunas
não-estruturais, automaticamente. Não há passo manual. (O que o botão
"discover schema" faz é outra coisa: preenche `node_types` e
`relationship_types`.) O item 1 da minha lista de pendências não existia.

O gap real, bem menor: **não há caminho de edição** de um contexto já criado, e
`resolve_node_columns` retorna `None` (→ `SELECT n.*`) para contextos legados
salvos antes desse preenchimento automático. Esses caem no ramo "assume largo"
de `shouldLoadProgressively()`, então a carga progressiva os cobre — só a
projeção da Fase 1 não os beneficia.

**CORREÇÃO 2 — "expand não é progressivo" estava tecnicamente certo mas
irrelevante.** `ExpandRequest.edge_limit` é `le=1000` (default 100), duas ordens
de magnitude abaixo do load inicial. O usuário apontou corretamente que o expand
só busca as linhas retornadas. Não vale complexidade; removido das pendências.

**Snapshots — medido, não suposto.** Um snapshot de 18,7k nós × 98 colunas:
31,9 MB crus → **5,6 MB gzipados** (83% de compressão, `snapshot.py:44`). Não
toca o warehouse. O custo residual é descompressão + parse no browser, bem menor
que os 35,8 MB do `SELECT n.*`. Baixa prioridade.

**RESPOSTA À PERGUNTA SOBRE A FASE 4 (markRaw) — agora com número.**
Medido com 18.700 nós × 98 colunas:

| operação | deep reactive | `markRaw(properties)` |
|---|---|---|
| atribuir `nodes.value = [...]` | **0 ms** | 0 ms |
| percorrer todas as properties | **381 ms** | **12 ms** |

A atribuição é grátis — o Vue proxifica sob demanda, não na hora. O custo
aparece em quem **lê**: `DataTablePanel.vue:60` itera `Object.keys(n.properties)`
de todo nó para montar as colunas, e cada acesso atravessa um Proxy. Com 100
colunas isso é ~370 ms de main thread travado ao abrir a tabela de dados.

`markRaw` no dict de properties elimina isso porque nada no app depende de
reatividade *dentro* do dict — o patch da Fase 2 já substitui o objeto inteiro.
Custo: a convenção "substitua o objeto, não mute dentro" vira obrigatória.

**Nota sobre minha medição inicial:** o primeiro teste que escrevi percorria as
properties dentro do que eu chamei de "cadeia de computeds", sugerindo 358 ms no
caminho de carregamento. Isso estava errado — `nodeSearchIndex` usa `toRaw()` e
lê só `node_id`/`node_type`. O custo real não é no load, é ao abrir painéis que
leem properties. Refiz a medição antes de reportar.

**Files modified:** `frontend/src/stores/graph.ts` (limiar 10),
`graph.progressiveLoad.test.ts` (+1 teste de fronteira).

**Testing:** frontend 1215, E2E 98, backend 332, `vue-tsc` limpo.

**PENDÊNCIAS ATUALIZADAS (revisadas):**
1. **Fase 4 (markRaw)** — agora quantificada: ~370 ms de travamento ao abrir a
   tabela de dados com 100 colunas. Melhor relação impacto/esforço restante.
2. **Sem edição de `node_properties`** em contexto existente; contextos legados
   ficam em `SELECT n.*`.
3. **Fase 3 (partials no job de query/Cypher)** — o console ainda espera o job
   inteiro.
4. **Enriquecimento sem retry.**
5. **`total_count` é `len(edges)`**, não um COUNT real.

## [2026-07-30] - Phase 4: markRaw nas properties — implementada, mas o ganho previsto NÃO se confirmou

**O que eu previ:** ~370 ms de main thread destravado ao abrir a tabela de dados
com 100 colunas.

**O que medi no app real (A/B, mesma página, tabela de 100 colunas, 18,7k nós):**

| | abrir a tabela de dados |
|---|---|
| sem markRaw | 1542 ms |
| com markRaw | 1587 ms |

**Sem diferença mensurável.** A previsão estava errada.

**Por quê.** `DataTablePanel.vue:52` já faz `toRaw(n)` em cada nó antes de ler
as properties — o painel nunca pagou o custo do Proxy. Meu benchmark original
percorria as chaves através do Proxy reativo, o que **nenhum consumidor real
faz**. Microbenchmark refinado por padrão de acesso (18,7k × 98):

| acesso | reativo | markRaw |
|---|---|---|
| percorrer todas as chaves | 398 ms | 11 ms |
| ler 1 chave por nó (`getDistinctPropertyValues`) | 20 ms | 13 ms |
| passar o dict por referência (`buildGraphSnapshot`) | 10 ms | 6 ms |

Só a primeira linha é dramática, e é justamente a que o único candidato já
evitava com `toRaw`. Os consumidores que de fato existem tocam poucas chaves,
onde a diferença é de milissegundos.

**Decisão: manter mesmo assim.** Não pelo ganho hoje (é ruído), mas porque
elimina uma classe de precipício latente: qualquer código futuro que percorra
properties sem lembrar de `toRaw` custaria ~400 ms, e a guarda é gratuita
(`markRaw` não tem custo de runtime perceptível — a atribuição já era 0 ms).
O comentário no código diz exatamente isso, com os números, para que ninguém
leia a mudança como uma otimização que ela não é.

**Trade-off que passa a valer:** "substitua o objeto de properties inteiro,
nunca mute uma chave in-place". Verificado que nenhum código atual viola isso
(grep por `properties.x =` / `properties[k] =` / `delete properties` não
retorna nada fora do patch da Fase 2, que já substitui o objeto). 6 testes
travam a invariante e falham se o `markRaw` for removido (verificado).

**Files modified:**
- `frontend/src/stores/graph.ts` — helper `rawProperties()` aplicado nos 5
  pontos de ingestão (subgraph, expand, query, cypher, snapshot) +
  `patchNodeProperties` marcando o dict resultante.

**Files modified (tests):**
- `graph.progressiveLoad.test.ts` +6 (nó/aresta carregados são raw, enriquecido
  é raw, merge preserva raw, substituir o dict ainda notifica readers, nós sem
  properties não quebram).

**Testing:** frontend 1221, E2E 98, backend 332, `vue-tsc` limpo.

**Lição de método:** o microbenchmark sintético mediu um padrão de acesso que o
app não usa. Só o A/B contra a aplicação real revelou isso — vale desconfiar de
qualquer estimativa de perf que não tenha passado pelo caminho de código
verdadeiro.

**PENDÊNCIAS RESTANTES:**
1. **Fase 3 (partials no job de query/Cypher)** — o console ainda espera o job
   inteiro. Agora é a maior pendência real.
2. **Sem edição de `node_properties`** em contexto existente; contextos legados
   ficam em `SELECT n.*` (cobertos pela carga progressiva, mas sem a projeção).
3. **Enriquecimento sem retry.**
4. **`total_count` é `len(edges)`**, não um COUNT real.

## [2026-07-30] - Phase 4 REVERTIDA — ganho zero não paga uma restrição permanente

**Decisão do usuário, e ele está certo.** Eu tinha mantido o `markRaw` alegando
que "elimina um precipício latente" — mas isso trocava um ganho **medido como
zero** por uma regra permanente no código ("nunca mute uma chave de properties
in-place"), que todo desenvolvedor futuro precisaria conhecer e respeitar.
Otimizar contra um problema hipotético ao custo de uma restrição real é uma
troca ruim. Revertido.

**O que foi desfeito:**
- helper `rawProperties()` e o import de `markRaw` (graph.ts);
- os 5 pontos de ingestão voltaram a `nodes.value = response.nodes` etc.;
- `patchNodeProperties` voltou a atribuir o dict sem envolver;
- os 6 testes que travavam a invariante foram removidos (a invariante não
  existe mais — mantê-los seria testar uma regra que ninguém precisa seguir).

Verificado: `git diff` das linhas de ingestão contra HEAD está vazio, e a
contagem de `markRaw` bate com a do HEAD (zero).

**O que fica registrado (a medição continua útil):**

| acesso a properties, 18,7k nós × 98 colunas | reativo | markRaw |
|---|---|---|
| percorrer todas as chaves | 398 ms | 11 ms |
| ler 1 chave por nó | 20 ms | 13 ms |
| passar o dict por referência | 10 ms | 6 ms |

A primeira linha é a única dramática, e o único consumidor que faria isso
(`DataTablePanel`) já chama `toRaw()` antes (DataTablePanel.vue:52). A/B contra
o app real: abrir a tabela de dados num grafo de 100 colunas levou 1542 ms sem
markRaw e 1587 ms com — sem diferença.

**Se um dia isso voltar a importar:** o sinal é alguém escrever um loop que
percorre `node.properties` de todos os nós SEM `toRaw`. Aí a correção certa é
`toRaw` naquele call site (localizada, sem regra global), não markRaw no ingest.

**Testing pós-reversão:** frontend 1215, E2E 98, backend 332, `vue-tsc` limpo.

**PENDÊNCIAS (inalteradas pela reversão):**
1. **Fase 3 (partials no job de query/Cypher)** — maior pendência real.
2. **Sem edição de `node_properties`** em contexto existente.
3. **Enriquecimento sem retry.**
4. **`total_count` é `len(edges)`**, não um COUNT real.

## [2026-07-30] - Phase 3: Resultados parciais no caminho de query (o que os usuários usam)

**Contexto que mudou a prioridade:** o usuário informou que seus usuários "fazem
queries específicas, novas, várias vezes" — ou seja, usam o **painel Query**, não
o auto-load. As Fases 1 e 2 tinham otimizado o caminho errado: o auto-load caiu
de 7898→1731 ms, mas quem roda query no painel continuava esperando ~8 s.

**Medição antes de implementar** (tabela de 100 colunas, 20k arestas):

| etapa | tempo |
|---|---|
| fase de arestas | 2511 ms |
| query de nós (98 colunas) | 4408 ms |
| **total até aparecer algo** | **8046 ms** |

Busca types-only dos mesmos 20k nós: **1604 ms / 1,15 MB** → previsão de
~4115 ms para o primeiro paint (-49%).

**Implementação.** `execute_graph_query_with_nodes` ganhou `on_partial`: quando
fornecido (e `nodes_mode != "types"`), roda primeiro um fetch de nós só com as
colunas estruturais, publica isso como `GraphResponse` renderizável e depois
segue para o fetch completo. `_start_graph_job` grava em `record["partial"]` e
incrementa `partial_seq`; o endpoint de polling devolve os dois; o
`useCancellableQuery` chama `applyPartial` **uma vez por seq** (o mesmo parcial
viaja em todo poll subsequente).

**A parte delicada — `applyGraphResponse()`.** Quando o resultado final cobre
exatamente os mesmos nós do parcial, substituir os arrays descartaria a cena já
renderizada e reaqueceria o layout: o grafo saltaria na tela sem motivo. O
helper detecta esse caso e faz **patch in-place** das properties (mesmo
mecanismo da Fase 2), preservando posições e identidade do array. Se o conjunto
de nós mudou, aí sim substitui e pede layout novo.

Removi também dois `freshLayoutRequested = true` que estavam nos dois
`pendingGraphApply` — eles anulariam o benefício do patch, forçando relayout
mesmo no caminho patcheado. A flag agora é decidida só dentro do helper.

**RESULTADO — browser real, painel Query, tabela de 100 colunas:**

| | tempo |
|---|---|
| grafo aparece | **5616 ms** |
| resultado completo | 15385 ms |
| **ganho** | **63% mais cedo** |

Backend isolado: parcial em 4641 ms vs 10418 ms completo (55% mais cedo).

**Design decisions:**
1. **Parcial só quando há callback:** sem `on_partial` o comportamento é
   idêntico ao anterior (2 statements), então `/subgraph` e `/expand` não pagam
   o round-trip extra.
2. **Pulado em `nodes_mode="types"`:** ali a query principal já É a de tipos.
3. **Falha no parcial não derruba o job:** capturada e logada; o fetch completo
   abaixo produz o resultado real de qualquer forma (testado).
4. **`partial_seq` em vez de comparar payloads:** o poller vê o mesmo parcial em
   todo poll; comparar objetos seria caro e frágil.

**Files modified:**
- `api/graphlagoon/services/async_job.py` — `partial`/`partial_seq` no registro.
- `api/graphlagoon/services/graph_operations.py` — parâmetro `on_partial` +
  fetch types-only antecipado; `logging` importado.
- `api/graphlagoon/routers/graph.py` — `on_partial` no job, `partial` no status.
- `api/graphlagoon/models/schemas.py` — `partial`/`partial_seq` no
  `GraphJobStatusResponse`.
- `frontend/src/composables/useCancellableQuery.ts` — `applyPartial` + guarda
  por `partialSeq`.
- `frontend/src/stores/graph.ts` — `applyGraphResponse()` (patch vs replace),
  `applyPartial` no job machine.
- `frontend/src/types/graph.ts` — tipos do parcial.

**Files created:**
- `frontend/src/stores/__tests__/graph.partialResults.test.ts` (8 testes)
- `api/tests/test_node_projection.py` +5 testes de parcial

**Testing:** backend 337, frontend 1223, E2E 98, `vue-tsc` limpo. Verificado que
os testes falham nas duas regressões plausíveis: parcial não aplicado (4 falhas)
e replace-em-vez-de-patch (2 falhas). Validado no browser real.

**Known Limitations:**
- A fase de arestas (~2,5 s) é irredutível nesta abordagem: os ids dos nós só
  são conhecidos depois que TODAS as arestas foram baixadas e parseadas. Para ir
  abaixo disso seria preciso streaming real de arestas em chunks.
- O parcial não é publicado no caminho síncrono `/query` e `/cypher` (não-async),
  que não tem para onde entregar um intermediário.
- O job registry ainda retém resultados para sempre (sem TTL) — agora guarda
  também o parcial, então o vazamento cresceu um pouco. Continua na lista.

## [2026-07-30] - total_count / truncated: o problema real era o `truncated`

**O que eu encontrei ao investigar** (e que muda o pedido):
1. `total_count` **nunca é lido pelo frontend** — existe só no tipo TypeScript.
2. `truncated` estava **hardcoded como `False`** em `process_graph_query_result`
   (linha 246). O usuário **nunca** era avisado quando o grafo foi cortado.

O segundo é o problema de verdade: um grafo truncado é visualmente idêntico a
um completo, e conclusões tiradas dele podem simplesmente não valer. Consertar
o `total_count` sem consertar isso seria polir o campo errado.

**Decisão sobre o significado de `total_count`.** Mantive "quantas arestas esta
resposta carrega", explicitamente documentado. A alternativa — o total
disponível na tabela — exigiria rodar a query de arestas de novo dentro de um
`COUNT(*)`, dobrando o custo da metade cara de todo carregamento. Para um campo
que ninguém lê, é um preço absurdo. Se um dia a UI quiser mostrar "1.000 de
53.412", aí sim vale discutir um COUNT opcional sob demanda.

**Truncation detection.** `/subgraph` e `/expand` passam o cap explicitamente;
os endpoints de query passam `limit=None`, porque o LIMIT vive no SQL do
usuário. Criei `extract_query_limit()` usando **sqlglot** (já é dependência do
projeto) em vez de regex — assim um `LIMIT` dentro de um CTE ou subquery não é
confundido com o externo. SQL não-parseável devolve `None`: sem cap conhecido,
não dá para afirmar truncamento.

Falso positivo aceito conscientemente: um resultado que bate exatamente no cap é
marcado como truncado. Distinguir "exatamente N" de "N de muitos" exigiria o
COUNT que estamos evitando.

**UI.** Badge `⚠ truncated` na status bar, com cor (diferente do
"loading properties…", que é discreto e some sozinho). Truncamento muda quais
conclusões o grafo sustenta, então não deve se misturar ao ruído de fundo. O
tooltip explica o que fazer: aumentar o limite ou estreitar a query.

**Validado contra warehouse real** (tabela de 40.000 arestas):

| caminho | cap | arestas | truncated |
|---|---|---|---|
| /subgraph | 100 | 100 | **True** |
| /subgraph | 100.000 | 40.000 | False |
| query SQL | `LIMIT 50` | 50 | **True** |
| query SQL | `LIMIT 999999` | 40.000 | False |

**Falha do meu próprio processo, registrada:** ao verificar se os testes pegavam
regressão, sabotei a linha errada (a do `loadSubgraph`) e os testes passaram —
o que me fez pensar por um momento que eram tautológicos. Na verdade eles
cobriam só o caminho de query. Sabotando a linha certa, 3 falharam. Depois
adicionei 2 testes para o caminho `/subgraph`, que não tinha cobertura — e
confirmei que falham quando aquela linha é removida. **A lição: "os testes
passaram após sabotagem" pode significar que sabotei a linha errada, não que os
testes são fracos.**

**Files modified:**
- `api/graphlagoon/services/sql_validation.py` — `extract_query_limit()`.
- `api/graphlagoon/services/graph_operations.py` — detecção de truncamento no
  funil; comentário corrigido em `process_graph_query_result`.
- `frontend/src/stores/graph.ts` — ref `truncated`, setado no subgraph e em
  `applyGraphResponse`, resetado em `clear()`.
- `frontend/src/views/GraphVisualizationView.vue` — badge + estilo.

**Testing:** backend 345 (+8), frontend 1229 (+6), E2E 100 (+2), `vue-tsc`
limpo. Regressões verificadas nos dois caminhos.

**PENDÊNCIAS RESTANTES:**
1. **Job registry sem TTL** — retém resultados (e agora parciais) para sempre.
2. **Sem edição de `node_properties`** em contexto existente.
3. **Enriquecimento sem retry.**

## [2026-07-30] - schema-discovery: avaliado, NENHUMA mudança necessária

**Avaliação do usuário, confirmada no código e por medição:** o
`POST /api/schema-discovery` roda `SELECT DISTINCT` em `node_type_col` e
`relationship_type_col` (warehouse.py:489 e :511), **uma única vez**, no
formulário de criação de contexto. Não há paginação, limite nem entrega parcial
envolvidos — e não faz sentido haver: o resultado é um punhado de strings, o
usuário está preenchendo um formulário (não olhando um grafo), e nada é
desenhado enquanto isso.

**Medido** contra a tabela de 100 colunas (20k nós / 40k arestas):
**211 ms**, retornando `['Alpha','Beta','Gamma']` e `['LINKS','REFERS']`.

Nenhuma otimização aplicada. Registrado para que a pergunta não volte.

**Nota:** isto é diferente do preenchimento de `node_properties`, que vem do
schema das tabelas em `ContextsView.vue:320` — também automático, também uma vez
só. Os dois caminhos estão corretos como estão.

## [2026-08-11] - Feature: Context schema drift detection, resync, edit UI and guard rails

**Purpose:** `GraphContext` stores a frozen snapshot of its source warehouse tables' schema
(`node_structure`/`edge_structure`, `node_properties`/`edge_properties`, `node_types`/
`relationship_types`), captured once in the browser at creation time and never revalidated.
When the underlying table changes, the context silently rots. Directly resolves the second
"PENDÊNCIA RESTANTE" logged in the 2026-07-30 entry above ("Sem edição de `node_properties`
em contexto existente").

**Verified failure modes (before this feature):**
- Property column dropped/renamed → hard failure of every graph load (`resolve_node_columns`
  turns `node_properties` into an explicit `SELECT` projection).
- Column added → silently invisible (projection stays narrowed to the stored list).
- Structural column renamed → **worst case, empty graph, zero error**: `merge_column_config`
  substituted hardcoded defaults for missing keys, and `process_graph_query_result` built
  `src=src_id or ""` without ever populating `node_ids` — HTTP 200, blank canvas, no signal.
  A related latent bug was found and fixed along the way: `_get_edge_id`'s composite-key
  fallback used direct dict indexing (`row_dict[src_col]`) instead of `.get()`, so the same
  scenario could instead crash with an unhandled `KeyError` → 500, before the new guard even
  had a chance to classify it.
- New node/relationship type → invisible to Cypher (`build_schema_provider` builds the
  transpiler schema only from stored `node_types`), while raw-SQL subgraph queries return the
  same nodes — the canvas shows nodes the query layer denies exist.
- Table dropped/renamed → unrecoverable (delete-and-recreate, losing explorations/templates/
  cluster programs).

**Design decisions:**

1. **No dedicated write endpoint for resync.** `GET .../schema-drift` returns a `proposed`
   snapshot; the frontend reviews it (optionally editing rename mappings / deselecting fixes)
   and echoes the result back through the existing `PUT /graph-contexts/{id}` — which was
   already implemented, unit-tested, and had zero production callers. A second write endpoint
   would mean a second dual-path (DB + memory-store) implementation, and computing-then-
   applying server-side would open a TOCTOU window between what the user reviewed and what
   gets written.
2. **Table names stay immutable.** No repointing to a different/renamed table. A missing table
   is diagnosed instantly (`TABLE_NOT_FOUND` finding, `status: "error"`) instead of an opaque
   Spark error, but recovery is still delete-and-recreate. Reopening this later is a small
   change — `validate_context_tables` (built for structural-column validation, see below)
   already does everything repointing would need; it would just gain two more fields on
   `GraphContextUpdate`.
3. **Renames are never inferred.** A renamed column surfaces as a `PROPERTY_COLUMN_MISSING` +
   a `PROPERTY_COLUMN_ADDED` finding; the review UI offers an explicit "was this renamed to…?"
   mapping control that carries `display_name`/`description` across. Heuristic name-matching
   would silently repoint label templates and filters at data the user never confirmed was
   the same thing.
4. **Missing columns are dropped on apply, not retired.** Dropping is what un-breaks graph
   loading. Deselecting a `PROPERTY_COLUMN_MISSING` finding in the review modal reconstructs
   the old entry from `finding.stored` (which the diff always carries) rather than requiring a
   second round-trip or a `retired_properties` field/migration for a case assumed to be rare
   (a column that vanished and is expected to reappear).
5. **Drift detection is entirely user-initiated — no automatic check anywhere, columns or
   types.** The first pass fired a fire-and-forget column `DESCRIBE` (2 statements) at the end
   of every `loadContext()`, reasoning that it was cheap. Reconsidered mid-review: "cheap" per
   call still means two extra warehouse round-trips on *every single graph open*, for an event
   (schema drift) that is rare — the wrong tradeoff in a codebase with a standing perf-focused
   branch and profiling tooling for exactly this kind of load-path cost. Detection is instead:
   a "Check schema" action in `ContextsView` (row-level, never on mount — which would fire 2N
   statements for N contexts) and a matching manual action in `ContextInfoPanel` on the graph
   view (both share the `useSchemaDrift` cache). Reactive detection — the case that actually
   matters — is unaffected: a query that fails because of drift still surfaces the classified
   `STALE_CONTEXT_SCHEMA` error with the "Check context schema" CTA regardless of whether
   anyone ran a manual check first.
   **Corollary, decided immediately after:** *because* the check is now manual, type discovery
   (`SELECT DISTINCT`, a full scan of both tables) flipped from opt-in to **on by default** —
   `useSchemaDrift.check()` sends `check_types=true` unless told otherwise. Types were opt-in
   only to keep the once-automatic on-load check cheap; that justification died with the
   automatic check. A check whose cost is bounded by a deliberate click should return the
   complete answer, and the two-step version had a real failure mode: a user clicks "Check
   schema", sees "ok", and walks away from a context whose new node types are invisible to
   Cypher — precisely the silent drift this feature exists to catch. Cost control moved to the
   right place (the user decides *whether* to check); apply control stays per-finding in the
   review modal. `types_checked: false` in a response now means discovery **failed**, not that
   it was skipped, so the modal shows an honest "discovery failed / Retry" instead of an
   "Also refresh types" opt-in.
6. **Structural validation is strict but skippable.** `validate_context_tables` runs on
   `POST`/`PUT` whenever a structure is present in the payload — a structural column absent
   from the live table is a 400 `CONTEXT_STRUCTURE_INVALID`. But if the table can't be
   described at all (warehouse down, dev mode without it running), validation is **skipped**,
   not failed: editing or creating a context must never be blocked by warehouse unavailability.
7. **Exploration references: warn-only, never rewritten.** A resync never edits saved
   exploration state. `contextReferences.ts` walks every structured field that embeds a column
   name (label templates via the real tokenizer, icon configs, hive/ego layout keys, property
   filters, similarity `keyProperty`, cluster-program `node_binding`) and reports dangling
   references before Apply; raw Cypher/SQL (`graph_query`, `cte_prefilter`, query templates)
   gets only a best-effort word-boundary substring scan (`certain: false`) since it can't be
   parsed. The review modal requires an explicit "I understand" checkbox before Apply when any
   *certain* dangling reference exists.
8. **The generic edit form (Phase 4) never touches `node_properties`/`edge_properties` — but
   it does offer type "Discover".** Editing title/description/tags/structural-column-names/
   types/default-behaviors always omits the properties keys from the `PUT` payload (`None` =
   unchanged in `GraphContextUpdate`). Property resync is exclusively the schema-diff review
   flow's job — otherwise a plain "rename this context" edit would silently resync properties
   as a side effect and bypass the rename-mapping/dangling-reference review entirely.
   The first pass over-applied that rule and hid the "Discover" button in edit mode too,
   conflating "must not recompute properties" with "must not read anything live". Corrected:
   discovery runs `SELECT DISTINCT` on the two *type* columns and writes only the
   `node_types`/`relationship_types` text fields — fields this form already lets you edit by
   hand. It touches no property column, so it bypasses no review; withholding it merely forced
   people to retype values a button one line away could fetch. `GraphContextFormModal.test.ts`
   pins both halves: discovery populates the payload's types in edit mode, *and* the payload
   still carries no `node_properties`/`edge_properties`.
9. **Access control follows the read/write split already in place, not a new tier.** Checking
   drift is read-only (`GET .../schema-drift` uses the existing `get_context_with_access`,
   which any share level satisfies) — the frontend originally gated the "Check schema" row
   action on `has_write_access` too, which was an inconsistency caught on review: the graph
   view's equivalent action was never gated at all, and there is no reason a read-only
   collaborator shouldn't be able to see whether a context they can't fix is stale. Fixed by
   dropping the write-access `v-if` from both call sites — checking is universal. **Editing**
   (`GraphContextFormModal`, the "Edit" row action) and **applying a fix** (`SchemaDriftModal`'s
   Apply, disabled — not hidden — without write access, so a read-only user can still walk
   through a review and see exactly what they'd be missing) both still require write access,
   matching every other mutating context action (share, delete).

**Severity taxonomy** (`services/schema_drift.py`): `error` = `TABLE_NOT_FOUND` /
`STRUCTURAL_COLUMN_MISSING` / `PROPERTY_COLUMN_MISSING` (query-breaking) · `warning` =
`STRUCTURAL_COLUMN_TYPE_CHANGED` (declared but never emitted — no prior type is stored for
structural columns, so there is nothing to diff against) / `PROPERTY_TYPE_CHANGED` /
`TYPE_VALUE_REMOVED` · `info` = `PROPERTY_COLUMN_ADDED` / `TYPE_VALUE_ADDED`. `status = max`
across findings; `ok` when empty.

**Implementation (phased, each independently shippable):**

- **Phase 0** — `services/schema_drift.py`: pure diff engine (`diff_table`, `diff_structure`,
  `diff_types`, `merge_properties` — this function *is* the resync semantics, `overall_status`,
  `compute_drift`). Zero I/O, fully unit-testable without a warehouse. `merge_column_config`
  moved here from `routers/graph.py` (re-imported under the same name so existing test patches/
  imports keep working) since the drift service needed it too.
- **Phase 1** — `GET /api/graph-contexts/{id}/schema-drift?check_types=false`: parses both
  table names, `get_table_schema` per table (caught independently — one bad table still yields
  a useful diff), optional `discover_schema`, then `compute_drift`. Always HTTP 200 — a drift
  *report* is never a failure, even when a table is unreachable.
- **Phase 2** — Guard rails, shippable before any UI exists:
  - `services/warehouse_errors.py`: `classify_query_error` recognizes `UNRESOLVED_COLUMN`/
    `TABLE_OR_VIEW_NOT_FOUND` substrings → new code `STALE_CONTEXT_SCHEMA` with a `hint` and
    (when present) the unresolved column name. `QueryExecutionError` gained a `code` attribute
    set at construction; the async-job path already read `getattr(e, "code", …)`, so `/query`
    and `/cypher` picked this up for free. All 8 hand-rolled 400-envelope blocks in
    `routers/graph.py` replaced by one `query_execution_http_error(exc, context_id, …)` builder.
  - The silent-empty-graph fix: `process_graph_query_result` now counts edge items where
    `src_col`/`dst_col` are **absent as keys** (not just falsy — present-but-`None` is
    legitimate data) and raises a classified `QueryExecutionError` when every item is missing
    them. The `_get_edge_id` bug fix (above) was required for this guard to ever be reached
    instead of crashing first.
  - `QueryErrorModal.vue`: a `STALE_CONTEXT_SCHEMA` error leads with the hint (and unresolved
    column name) above the raw Spark text, plus a "Check context schema" CTA.
  - `enrichNodeProperties`'s catch (`stores/graph.ts`) — previously a bare `console.warn`
    leaving nodes permanently property-less with no signal — now sets a visible
    `enrichmentError` and toasts; a `STALE_CONTEXT_SCHEMA` code also flags `schemaDriftSuspected`.
  - `validate_context_tables` in `schema_drift.py` (the one function in that module that does
    I/O, kept there because it shares `parse_qualified_table`), wired into both `POST` and
    `PUT` in `routers/graph_contexts.py`.
- **Phase 3 — reverted.** Originally added `schema_synced_at` (nullable `DateTime`, migration
  `010`, stamped on create and on a `PUT` touching the schema fields) to show "last synced".
  Pulled after review against a real Postgres instance: the field was never actually surfaced
  in any UI (a straight `grep` across every `.vue` file confirmed zero references), so it was a
  migration requirement — the exact friction that surfaced as a live `UndefinedColumnError`
  against a database that hadn't run it — bought for a display that didn't exist. It is also
  strictly less useful than what the app already has: now that drift-checking is user-initiated
  (see decision 5), "when was this last stamped" tells you less than the on-demand check's "is
  it stale *right now*". Reopening this later needs the migration back, the DB/memory-store
  field, the `GraphContextResponse` field, and the create/`PUT` stamping logic — all removed
  cleanly, no remnants.
- **Phase 4** — `ContextsView.vue` (1168 lines, create modal inlined) decomposed:
  `utils/contextForm.ts` (`parseTableName`/`fuzzyMatch`/`parseTag`, now actually exported and
  imported — `ContextsView.logic.test.ts` used to **re-declare copies** of these three
  functions because the SFC didn't export them, so it was testing copies, not the real logic)
  and `components/GraphContextFormModal.vue` (`mode: 'create' | 'edit'`). Edit mode shows table
  names as disabled text (immutable) and structural columns as plain text inputs — no
  per-column live-schema fetch and no property recomputation, per decision 8 above; type
  "Discover" is available in both modes.
- **Phase 5** — `composables/useSchemaDrift.ts` (module-level cache keyed by context id, so the
  row action, the review modal, and the query-error CTA all read the same result),
  `components/SchemaDriftBanner.vue`, `components/SchemaDriftModal.vue` (findings grouped by
  severity with a per-finding checkbox defaulting to "apply the fix"; unchecking reconstructs
  the stored value from `finding.stored` rather than a second round-trip; rename mapping;
  Apply hidden entirely for `TABLE_NOT_FOUND`, disabled without write access). Wired into
  `ContextsView` (row action) and, in `GraphVisualizationView`/`ContextInfoPanel`, opened
  **in place** rather than navigating to `/contexts?edit=<id>` as originally sketched mid-Phase-2
  — a strictly better outcome than the plan called for.
- **Phase 6** — `labelFormatter.ts` gained `extractTemplateProperties`, built on the existing
  private `parseTemplate` rather than a fresh regex, so it can never disagree with what the
  label actually renders. `utils/contextReferences.ts` (`collectPropertyReferences`,
  `findRawQueryReferences`, `findDanglingReferences`) wired into `SchemaDriftModal`: an
  expandable "N references across M explorations" panel plus the "I understand" checkbox gate.

**Files created:**
- `api/graphlagoon/services/schema_drift.py`, `api/graphlagoon/services/warehouse_errors.py`
- `frontend/src/utils/contextForm.ts`, `frontend/src/utils/contextReferences.ts`
- `frontend/src/composables/useSchemaDrift.ts`
- `frontend/src/components/GraphContextFormModal.vue`, `SchemaDriftBanner.vue`, `SchemaDriftModal.vue`
- `frontend/src/__tests__/fixtures/schemaDrift.ts`
- `frontend/e2e/tests/schema-drift.spec.ts`
- 6 new backend test files (`test_schema_drift.py`, `test_schema_drift_endpoint.py`,
  `test_warehouse_errors.py`, `test_edge_column_absent.py`, `test_context_table_validation.py`)
  plus additions to `test_graph_error_handling.py`

**Files modified (selected):** `api/graphlagoon/routers/graph.py` (new endpoint, 8-site error
handler consolidation, `merge_column_config` re-import), `routers/graph_contexts.py` (structural
validation on `POST`/`PUT`), `services/graph_operations.py` (`merge_column_config` relocated,
`_get_edge_id` fix, empty-graph guard), `db/models.py`, `db/memory_store.py`, `models/schemas.py`
— `frontend/src/stores/graph.ts` (`extractErrorDetails` hint/unresolvedName/contextId,
`enrichmentError`/`schemaDriftSuspected`), `components/QueryErrorModal.vue`,
`views/ContextsView.vue`, `views/GraphVisualizationView.vue`, `components/ContextInfoPanel.vue`
(manual "Check schema" action — both the row-level one in `ContextsView` and this one), `types/graph.ts`,
`services/api.ts`.

**Testing:** Backend suite ends at 415 passing / 1 skipped (the 5 `test_cypher_comments.py`/
`test_transpile_options.py` failures pre-date this work — confirmed via `git stash` before
starting, and unaffected by it throughout); 66 tests across the 5 new dedicated files
(`test_schema_drift.py`, `test_schema_drift_endpoint.py`, `test_warehouse_errors.py`,
`test_edge_column_absent.py`, `test_context_table_validation.py`) plus new cases added to
`test_graph_error_handling.py`. Frontend unit suite ends at 1363 passing, `vue-tsc --noEmit`
clean throughout. E2E ends at 109/109 passing — 7 dedicated cases in `schema-drift.spec.ts`
(including the read-only-can-check/cannot-apply case from decision 9 and the
`check_types=true`-by-default assertion from decision 5) plus 1 cross-page journey in
`user-journeys.spec.ts` ("user finds and fixes a stale context schema, then the graph loads");
all 7 pre-existing `contexts.spec.ts` cases passed **unchanged** throughout, the Phase 4
acceptance bar (`ContextsView.vue` decomposition must not require touching the existing e2e
spec). One `progressive-load.spec.ts` case failed on a loaded machine mid-session and passed
both in isolation and on a clean full re-run — timing flake, unrelated to this work (it
exercises the Behaviors panel, which this feature does not touch).

**Known limitations (accepted, per decisions 2 and 7):**
1. Table rename/move is still unrecoverable — delete-and-recreate remains the only path.
2. Query templates' and saved queries' raw Cypher/SQL is checked only by substring scan, never
   parsed; a column reference inside a string literal or comment would also (harmlessly) match.
3. `STRUCTURAL_COLUMN_TYPE_CHANGED` is declared in the severity taxonomy but never emitted — no
   prior type is stored for structural columns to diff against. Would need a schema/migration
   change to close.

## [2026-08-11 16:15] - Feature: CTE fallback para queries procedurais que falham

**Feature:** Quando uma query Cypher roda em modo procedural BFS e falha (seja no transpile,
seja na execução no warehouse), o app re-submete a query automaticamente UMA vez em modo CTE
(`WITH RECURSIVE`) e avisa o usuário via toast. A opção "CTE fallback on error" fica no modal
de transpile settings, visível quando Procedural BFS está ativo, e vem **ligada por default**.

**User Story:** Como usuário explorando grafos, quero que uma query procedural que falhe seja
automaticamente reexecutada em modo CTE, para não perder o resultado por causa de uma limitação
do renderer procedural (mais rápido, porém mais novo/menos maduro que o CTE).

**Design Decisions:**
1. **Fallback orquestrado no frontend, não no backend.** O backend transpila no submit do job
   (`/cypher/async`) e job falho vira HTTP 400 no poll — o frontend já recebe ambos os tipos de
   falha por `graphJob.onError` → `queryError`. Re-submeter do frontend com
   `vlp_rendering_mode: 'cte'` reaproveita toda a máquina de job (submit → poll → cancel →
   partials) sem tocar em nenhum endpoint. Zero mudança de API.
2. **Retry único, sem tocar nas opções salvas.** `vlpRenderingMode` continua `'procedural'`
   após o fallback — só a re-submissão daquela run usa `'cte'`. Se o CTE também falhar, o erro
   do CTE é o que aparece no QueryErrorModal (é o mais recente e o mais acionável).
3. **Cancelamento não dispara fallback.** `graphJob.canceled` é checado antes do retry — o
   usuário parou a query; reexecutar seria contrariá-lo.
4. **Aviso em dois momentos** (toasts warning): ao iniciar o retry ("Procedural query failed —
   retrying in CTE mode…") e, se o fallback der certo, um aviso de que o resultado veio do
   fallback — para o usuário saber que o modo procedural tem um problema com aquela query.
5. **Persistência na exploração** como `cte_fallback_enabled?: boolean`, restaurada com
   `?? true` (não `||`) para que explorações salvas com o fallback OFF continuem OFF, e
   explorações antigas (sem o campo) caiam no default ON. `resetTranspileOptions()` também
   restaura `true`.
6. **Escopo: caminho de graph query** (`executeCypherQuery`). O Query Console (tabela) não
   ganhou fallback nesta iteração — fica como possível extensão futura.

**Files created:**
- `frontend/src/stores/__tests__/graph.cteFallback.test.ts` (11 testes: retry com modo cte e
  sem procedural_optimizations, toggle off, modo já-cte, sucesso sem retry, falha dupla com
  retry único, falha no submit/transpile, cancelamento, defaults, persistência, reset)

**Files modified:**
- `frontend/src/stores/graph.ts` — `cteFallbackEnabled` ref (default true); `executeCypherQuery`
  refatorado com `submitWithMode(mode)` + bloco de retry pós-`graphJob.run()`;
  `resetTranspileOptions`; `getExplorationState`/`loadExploration`; export do store.
- `frontend/src/types/graph.ts` — `cte_fallback_enabled?: boolean` em `ExplorationState`.
- `frontend/src/components/TranspileSettingsModal.vue` — toggle "CTE fallback on error"
  (`data-testid="opt-cte-fallback"`) dentro da seção procedural.
- `frontend/src/components/__tests__/TranspileSettingsModal.test.ts` — 3 testes novos
  (default checked, oculto em modo cte, binding com o store).

**Testing:** 22 testes novos/atualizados passando; suite completa 1340/1340 verde;
`vue-tsc --noEmit` limpo. Sem E2E novo: feature contida em um painel/fluxo já coberto
(erro de query → retry transparente), sem fluxo cross-page novo.

**Known limitations:**
- O Query Console (modo tabela) usa as mesmas opções de transpile mas não faz fallback.
- O fallback re-executa a query inteira (não há cache do erro procedural para pular o retry
  em re-execuções subsequentes da mesma query — cada run procedural falha e refaz o fallback).

## [2026-08-11 16:20] - Fix/extensão: CTE fallback também no Query Console (tabela)

**Problema reportado:** query Cypher no console de tabela com procedural BFS ativo falhou com
`INVALID_SQL_QUERY` ("Unexpected token … BEGIN DECLARE bfs_depth_1 …") e o fallback não rodou.

**Causa raiz:** o fallback da entrada anterior cobria só o caminho de grafo
(`executeCypherQuery`). Pior: no endpoint de tabela (`POST .../query/table`) o modo procedural
**nunca** funciona — `validate_sql_query` (fronteira de segurança read-only SELECT, linha
~1066 de `routers/graph.py`) rejeita o script `BEGIN…END` que o procedural emite. O caminho de
grafo tem uma exceção explícita para script blocks; o de tabela, deliberadamente, não.

**Decisões:**
1. **Mesmo contrato do grafo, no frontend** — retry único em CTE + toasts, respeitando o mesmo
   toggle `cteFallbackEnabled`. Não mexer na validação do backend: afrouxar a fronteira
   read-only do endpoint de tabela para aceitar scripts seria uma mudança de segurança, e a
   tentativa procedural falha barato (a validação acontece ANTES do submit ao warehouse — o
   custo é só um transpile).
2. **Modo por-run, não por-store** — `submitRenderingMode` capturado em `runQuery()` e usado
   pelo submit callback no lugar de `graphStore.vlpRenderingMode`; o override para `'cte'`
   vale só para a re-submissão. Runs seguintes voltam a tentar procedural.
3. **Só em modo cypher** — falha de SQL cru não tem o que re-transpilar.

**Files modified:**
- `frontend/src/stores/queryConsole.ts` — `submitRenderingMode` + bloco de fallback em
  `runQuery()` espelhando o do graph store.

**Files created:**
- `frontend/src/stores/__tests__/queryConsole.cteFallback.test.ts` (8 testes: retry com modo
  cte sem procedural_optimizations, opção do store intocada, override é por-run, falha dupla
  com retry único, toggle off, modo já-cte, modo sql, sucesso sem retry).

**Testing:** 24 testes do console verdes (16 existentes intactos); suite completa 1348/1348;
`vue-tsc --noEmit` limpo.

**Limitação conhecida atualizada:** o console agora TEM fallback; permanece o fato de que o
modo procedural é estruturalmente incompatível com o endpoint de tabela — toda query cypher de
tabela com procedural ativo paga um round-trip de transpile antes de cair no CTE. Se isso
incomodar, a otimização futura é o console enviar `'cte'` direto (pulando a tentativa fadada a
falhar), mas isso esconderia do usuário que o procedural não se aplica ali.

## [2026-08-11 16:30] - Fix: CTE fallback no sidebar de graph query + opção "Silent fallback"

**Problema reportado:** o fallback funcionava no Query Console mas não no painel lateral de
query que renderiza o grafo (GraphQueryPanel).

**Causa raiz:** o GraphQueryPanel nunca chamava `executeCypherQuery` (que tem o fallback). O
fluxo era `transpileCypher()` → `executeGraphQuery(sql)` — o caminho SQL puro, que não sabe
nada de Cypher e portanto não pode refazer o transpile.

**Decisões:**
1. **Fluxo "In Messi We Trust" agora submete o Cypher direto** via
   `graphStore.executeCypherQuery()` — o backend transpila no submit e o store cobre o
   fallback para falha de transpile E de execução. De quebra elimina um round-trip (antes:
   transpile + execute-SQL; agora: um submit). O editor SQL é sincronizado com o SQL que
   de fato rodou (fallback incluso) via retorno da função.
2. **`transpileCypher` no store ganhou fallback próprio** (retry do transpile em CTE) para o
   fluxo de revisão "Transpile to SQL" e para o TemplateExecuteModal, que rodam o SQL
   retornado por conta própria. Ali o fallback cobre só o passo de transpile — de propósito:
   o usuário revisa/roda exatamente o SQL que viu, nunca SQL trocado silenciosamente depois
   da revisão.
3. **Bug latente corrigido de carona:** o painel checava `graphStore.error` (erro de load de
   contexto, sempre null nos caminhos de query) após executar — o toast de sucesso disparava
   mesmo com query falha. Agora checa `graphStore.queryError`.
4. **Opção "Silent fallback" (pedido do usuário), ativada por default:** novo
   `cteFallbackSilent` (default `true`) suprime os toasts de aviso do fallback em todos os
   caminhos (grafo, transpile, console) via helper `notifyCteFallback()` no graph store e
   guard no queryConsole. Sub-toggle no modal (`opt-cte-fallback-silent`), visível só com o
   fallback ligado; persiste na exploração como `cte_fallback_silent` (`?? true`);
   `resetTranspileOptions()` restaura. Com silent ON (default) o fallback é transparente; a
   notificação vira opt-in desligando o silent.

**Files modified:**
- `frontend/src/stores/graph.ts` — fallback em `transpileCypher`; `cteFallbackSilent` +
  `notifyCteFallback()`; reset/persistência/export.
- `frontend/src/components/GraphQueryPanel.vue` — fluxo messi usa `executeCypherQuery`;
  checks de erro corrigidos para `queryError`.
- `frontend/src/stores/queryConsole.ts` — toasts condicionados ao silent.
- `frontend/src/components/TranspileSettingsModal.vue` — sub-toggle "Silent fallback".
- `frontend/src/types/graph.ts` — `cte_fallback_silent?: boolean`.
- Testes: `graph.cteFallback.test.ts` (18), `queryConsole.cteFallback.test.ts` (9),
  `TranspileSettingsModal.test.ts` (13) — silent-por-default coberto nos três caminhos.

**Testing:** suite completa 1358/1358 verde; `vue-tsc --noEmit` limpo.

**Limitação conhecida:** no fluxo de revisão ("Transpile to SQL" com messi OFF) e no
TemplateExecuteModal, uma falha de EXECUÇÃO do SQL procedural revisado não faz fallback — só a
falha de transpile. Intencional (decisão 2): substituir SQL revisado pelo usuário seria
surpreendente.

## [2026-08-13] - Feature Implemented: Pluggable Datasources + Amazon Neptune (openCypher)

**Feature:** A graph context can now be backed by a native graph database instead of two warehouse tables. Amazon Neptune is the first such backend, queried with openCypher passthrough.

**Purpose:** Until now a context was hard-wired to "an edge table + a node table in a SQL warehouse", with Cypher transpiled to Spark SQL by gsql2rsql. Querying a native graph database was impossible, and every new backend would have meant another fork in `routers/graph.py`. Neptune in particular needs *no* table or column configuration at all — the database already knows its own shape.

**User Story:** As an analyst with a graph already in Neptune, I want to create a context by picking "Amazon Neptune" and typing a title, so that I can query and visualize it without defining a node table, an edge triple-store, or any column mapping.

**Design Decisions:**

1. **Adapter behind a `GraphDatasource` ABC, not `if datasource_type ==` in the routers.** Ten endpoints share the same shape (prepare → execute → normalize → 400-envelope). Branching per endpoint would duplicate the envelope and validation logic once per backend, and multiply with each new one. The ABC keeps routers to auth, request validation and error translation — all genuinely backend-agnostic. Pattern copied from `services/snapshot.py` (ABC + settings-driven lazy singleton factory), which is the repo's existing precedent for a pluggable backend.

2. **The seam is `GraphResponse{nodes, edges}`.** Everything above it — routers, async jobs, explorations, snapshots, sharing, and the whole frontend visualization stack — already speaks the normalized shape. That is why the 3D canvas, layouts, filters, metrics, community and cluster stores needed *zero* changes.

3. **SQL-only operations are deliberately NOT on the interface.** Raw SQL execution, transpile-to-SQL and schema drift are meaningless for a native graph database. Rather than force every backend to implement `raise NotImplementedError`, they live on the SQL implementation and are gated at the router with `require_capability(ds, flag, operation)` → 400 `DATASOURCE_UNSUPPORTED_OPERATION`.

4. **Capabilities are a matrix, not a type check.** Backend: `DatasourceCapabilities` frozen dataclass, all flags defaulting to `False` so a new backend opts in explicitly. Frontend: `useDatasourceCapabilities` composable with the same shape. Components ask "does this support SQL?", never "is this Neptune?" — adding a backend is one row, not a hunt through panels. The matrix is duplicated on purpose: the server decides what it *accepts*, the frontend decides what it *renders*, and each is versioned with its own deploy.

5. **`datasource_type` defaults to `sql_warehouse` everywhere.** Alembic `010` adds the column with `server_default='sql_warehouse'`, backfilling every existing row atomically — no data migration, no behavior change. The frontend type is optional and `resolveDatasourceType` treats absent/unknown as the warehouse. Existing contexts, API clients and test fixtures were untouched.

6. **Neptune context creation normalizes rather than rejects table fields.** A client reusing the warehouse form gets a valid context instead of a 422 it cannot act on. `GraphContextCreate`'s `model_validator` is the single choke point: warehouse requires both tables, everything else nulls them.

7. **`datasource_type` is immutable after creation** (absent from `GraphContextUpdate`). Changing it would silently orphan every exploration, template and cluster program saved against the context.

8. **The `RETURN r` rule is relaxed for native backends.** That requirement exists because the transpiler projects edges as a NAMED_STRUCT column literally named `r`. Neptune returns real nodes and relationships from any projection, so requiring the name would reject valid queries like `RETURN p`. Replaced with "starts with MATCH, has a RETURN", plus a read-only deny-list guard (the openCypher counterpart of `validate_sql_query`).

9. **Dangling-endpoint resolution.** `MATCH ()-[r]->() RETURN r` names two nodes it never returned. One follow-up `MATCH (n) WHERE id(n) IN $ids RETURN n` fills them in — the direct analogue of the warehouse path's second, node-fetching query. Without it that query renders an empty canvas.

10. **Local dev without AWS.** No official local Neptune exists (LocalStack emulates it only in its paid tier). Following `warehouse/`'s precedent of emulating the Databricks statements API, `neptune-emulator/` presents Neptune's HTTP contract over a Neo4j container. The production `NeptuneClient`/`NeptuneDatasource` run unchanged against it — only the network is local.

**Alternatives Considered:**
- *Router-level dispatch* — rejected: duplicates error handling per endpoint per backend.
- *Per-context connection config* — rejected by the user in favour of server-level settings, matching the existing warehouse model (no credential storage/encryption needed).
- *Gremlin support in v1* — deferred; openCypher reuses the existing editor and result mapping.
- *Discovery by sampling only* — rejected as the primary path: the cluster summary API is exact and free. Sampling is the fallback for clusters with DFE statistics disabled.
- *Mocking Neptune for local dev* — rejected: a mock would not exercise the real client, request building, or error translation.

**Implementation:**

**Backend — new:**
- `api/graphlagoon/services/datasource/base.py` — `GraphDatasource` ABC, `DatasourceCapabilities`, `PreparedGraphQuery`, `GraphExecutionFailure`, `require_capability`, `invalid_request`
- `.../datasource/factory.py` — `configure_datasources` / `get_datasource` / `get_datasource_for_context` / `available_datasource_types` / `close_datasources` / `reset_datasources`
- `.../datasource/sql_warehouse.py` — `SqlWarehouseDatasource` (moved code: `build_edge_named_struct`, `resolve_node_columns`, subgraph/expand SQL builders, `_prepare_graph_sql`, `_prepare_cypher_sql`, table-query flow, discovery)
- `.../datasource/neptune/{client,mapping,validation,datasource}.py` — httpx client (+optional SigV4), openCypher JSON → Node/Edge/tabular mapping, read-only guard, the datasource itself
- `api/graphlagoon/alembic/versions/010_add_datasource_type.py`

**Backend — modified:**
- `routers/graph.py` — every graph endpoint delegates to the datasource; `execution_failure_http_error` added; `_merge_transpilation_timing` extracted; capability guards on `/query`, `/cypher/transpile`, `/schema-drift`, SQL console mode
- `routers/graph_contexts.py` — `_validate_datasource_or_400`, table validation branched, `datasource_type` persisted and returned
- `routers/config.py`, `app.py` — `datasources` in `/api/config` and the SPA template; `configure_datasources`/`close_datasources` wired into startup/shutdown
- `models/schemas.py` — `DatasourceType`, `DEFAULT_DATASOURCE_TYPE`, create/response fields + validator, `SchemaDiscoveryRequest.datasource_type`, `CypherQueryResponse.transpiled_sql` now optional
- `db/models.py`, `db/memory_store.py` — `datasource_type` column/field, nullable table names
- `config.py` — nine `neptune_*` settings + `neptune_enabled` / `neptune_base_url`
- `services/async_job.py` — `cancel_job(job_id, canceler)` generalized from `warehouse`
- `services/cypher.py` — unchanged (Neptune has its own validation module)

**Frontend:**
- NEW `composables/useDatasourceCapabilities.ts` — the capability matrix, labels, `resolveDatasourceType`, `useAvailableDatasources`
- `types/graph.ts` — `DatasourceType`, optional `datasource_type`, nullable table names
- `components/GraphContextFormModal.vue` — datasource picker (create mode; disabled in edit), table/column half conditional, discovery dispatch, per-datasource submit payload
- `views/ContextsView.vue` — datasource badge, subtitle fallback, check-schema gated, searchable by datasource
- `components/ContextInfoPanel.vue` — Datasource row; Tables/Structure sections and drift affordance gated
- `components/GraphQueryPanel.vue` — SQL toggle / transpile gear / CTE pre-filter / "Trust transpiled SQL" gated; relaxed validation; `runsDirectly`
- `components/QueryConsolePanel.vue` + `stores/queryConsole.ts` — SQL mode and settings gated, per-datasource seeds, `~id` node bridge, transpile options and CTE fallback omitted
- `stores/graph.ts` — `contextTranspiles()`; transpile options and CTE-fallback retry skipped; `transpileCypher` guarded
- `components/QueryTemplatesPanel.vue`, `TemplateEditorModal.vue` — SQL templates filtered/hidden
- `utils/exampleQuery.ts` — seeds with `id(root)` where identity is not a property

**Dev infrastructure:**
- NEW `neptune-emulator/` (FastAPI + Neo4j driver, `src/main.py` + `src/seed.py`)
- `docker-compose.yml` — `neo4j` service (`db-up` narrowed to `postgres` so it is not dragged in)
- `Makefile` — `dev-neptune`, `dev-neptune-db`, `neptune-up`, `neptune-down`, `neptune-seed`; emulator hooked into `dev-stop`/`dev-logs`

**Testing:**
- [x] Phase 1 refactor verified with the existing suite unmodified except patch targets: `test_graph_error_handling.py`'s 4 router tests patch `execute_graph_query_with_nodes` / `validate_sql_query` / `merge_column_config`, which moved to `services.datasource.sql_warehouse`. Every assertion unchanged.
- [x] NEW `api/tests/test_neptune_mapping.py` (24) — entity detection incl. missing `~entityType`, multi-label, paths, `collect()` lists, map literals, dangling endpoints, tabular flattening, limit extraction.
- [x] NEW `api/tests/test_neptune_datasource.py` (32, `httpx.MockTransport`) — passthrough, dangling follow-up, generated openCypher for subgraph/expand (direction × depth matrix), label quoting incl. a backtick-injection attempt, write-query rejection, error translation (never `STALE_CONTEXT_SCHEMA`), summary-then-sampling discovery.
- [x] NEW `api/tests/test_neptune_endpoints.py` (17) — creation without tables, table fields normalized away, warehouse still requires tables, omitted type defaults to warehouse, 400 guards on `/query` `/cypher/transpile` `/schema-drift` `sql` console mode `cte_prefilter`, working cypher/subgraph/expand/nodes-batch/console/discovery, `DATASOURCE_NOT_CONFIGURED`, `/api/config` datasources.
- [x] Backend: **488 passed** (was 415), 1 skipped. The 5 failures (`test_cypher_comments` ×4, `test_transpile_options` ×1) are pre-existing on `main` — verified by stashing.
- [x] NEW `useDatasourceCapabilities.test.ts` (12), `GraphContextFormModal.datasource.test.ts` (9), `GraphQueryPanel.datasource.test.ts` (7). Frontend: **1391 passed**, `vue-tsc --noEmit` clean.
- [x] NEW `e2e/tests/neptune-context.spec.ts` (7) + `enableDatasources` / `mockNeptuneQueries` helpers, `MOCK_NEPTUNE_CONTEXT` fixture. E2E: **116 passed**.
- [x] **Live verification against a real graph database.** Ran the actual `NeptuneDatasource` against Neo4j via the emulator: discovery (sampling fallback), subgraph with and without type filter, `RETURN r`-only with dangling resolution, expand at depth 1/2 × directed/undirected × type-filtered, `fetch_nodes`, console table mode, and Neptune-side error translation. This surfaced a real defect the mocked tests could not: Neo4j's `id()` returns a legacy integer while Neptune's returns the string `~id`, so every id lookup silently returned nothing. Fixed in the emulator (`translate_query` rewrites `id(` → `elementId(`) — the production query is correct for Neptune as written.
- [x] Ruff check + format clean on all touched files (the one remaining `F401` in `services/schema_drift.py` is pre-existing).

**Performance Considerations:**
- Discovery prefers the cluster summary API (no scan) and falls back to a bounded `LIMIT`-capped sample.
- The dangling-endpoint follow-up is one extra round-trip and only when a query projects relationships without their endpoints — the same two-phase shape the warehouse path already has.
- Neptune returns whole property maps in one response, so progressive/deferred property loading is inapplicable and correctly reports as unsupported.

**Security Considerations:**
- `validate_readonly_opencypher` is the openCypher counterpart of the SQL SELECT-only boundary: a word-boundary deny-list on `CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD|CALL|FOREACH`, failing closed. A keyword inside a string literal is a deliberate false positive — the same trade the SQL validator makes.
- Generated queries parameterize everything they can (`$ids`, `$types`, `$node_id`). Relationship types cannot be parameters inside a pattern, so they are backtick-quoted with embedded backticks stripped; covered by an injection test.
- Neptune credentials are server-level; nothing is stored per context.
- SigV4 signs the exact serialized body (`json.dumps` once, sent as `content=`), so the signature matches the bytes on the wire.

**Known Limitations:**
- Cancellation is API-side only for Neptune (no query id at submit time) — documented in the config guide.
- Subgraph sampling is deterministic: openCypher has no `ORDER BY rand()` equivalent.
- The emulator's `id()` rewrite is a Neo4j-compat shim; real Neptune needs no translation.
- `botocore` (IAM auth) is an optional extra and is not exercised by CI.

**Future Enhancements:**
- Gremlin as a second query language for the same datasource.
- Cancellation by matching the running query via `/openCypher/status`.
- Redefine "drift" for a native graph database as label/property-key re-discovery.

**Related:**
- Supersedes the consequence noted in ADR-001 ("Spark SQL over Neo4j"): query syntax is no longer necessarily SQL — a context may now speak Cypher natively.

**Author:** Claude (AI Assistant)

---

## [2026-08-13] - Revision: datasource picker copy + expanded local Neptune seed

**Trigger:** Review of the shipped picker. The two cards described *how each backend is built* ("a graph stored as an edge table and a node table", "a native graph database queried with openCypher") — accurate, and useless at the moment of choosing. Storage layout is not something the person creating a context can act on.

**Decision 1 — copy describes the workload, not the implementation.** Each card is now four layers with distinct jobs:

| Layer | Job | Databricks | Amazon Neptune |
|---|---|---|---|
| label | the product, recognized instantly | Databricks | Amazon Neptune |
| kind | the generic category, secondary | SQL Warehouse | openCypher |
| tagline | **the line that decides the choice** | ANALYTICAL · EXPLORATORY | OPERATIONAL (OLTP) · LOW LATENCY |
| description | what you get | the complete graph, every property | tuned for serving, traversals come back fast |
| caveat | what you give up | higher latency, breadth over speed | may not carry the full analytical picture |

The caveat sits below a dashed rule rather than appended to the description: separated, it reads as a condition of the choice instead of more marketing. `caveat` is a required field on `DatasourceCopy` and a test asserts every type has one — a card without it sells the datasource rather than explaining the trade-off.

**Decision 2 — the product is the headline, the category is secondary.** First pass had "SQL Warehouse" bold with "Databricks" as small print. Inverted: people recognize *Databricks* and *Amazon Neptune* instantly where the generic category takes a beat to place. This also fixed a mislabeled field — `vendor: "openCypher"` was never a vendor, it is the query language; renamed to `kind`.

*Known imprecision:* `DATASOURCE_LABELS` now derives from `label`, so the listing badge reads "Databricks" even under `make dev`, where the warehouse is local PySpark. Accepted because the deployed case dominates; decoupling the badge from the card headline is the fix if it ever bites.

**Decision 3 — the same framing propagates.** The context listing shows the tagline where it used to show "openCypher · native graph" (implementation framing again), and the context info panel shows it under the datasource name. One vocabulary everywhere the datasource is mentioned, including `docs/guide/configuration.md`, which now opens with a completeness-vs-latency comparison table.

**Decision 4 — the local seed is shaped, not merely bigger.** The original 9 nodes / 14 relationships could not distinguish an expand at depth 1 from depth 2. Now 106 nodes / 349 relationships across 4 labels and 7 relationship types, generated deterministically (`random.Random(20260813)`), with each structure earning its place by making one control observable:

- 9-level `REPORTS_TO` chain — a pure chain, so out-expand at depth *k* reaches exactly *k* people; repeated expands walk it one rung at a time
- 24-employee hub (Graph Lagoon) — overflows any reasonable edge limit, so the cap is visible
- `KNOWS` ring + 30 chords — cycles and density, so undirected expansion grows fast and revisits
- layered `DEPENDS_ON` DAG — multi-hop paths of a *different* type through the same nodes, so the type filter produces a clean subgraph
- sink repositories — no outgoing edges, so out-expand returns empty while in-expand returns plenty
- disconnected component (Sandbox Co) — proves expand respects its boundary

Verified against the real `NeptuneDatasource` through the emulator, not mocks: REPORTS_TO from Alice gives 2 nodes at depth 1 and 3 at depth 2; the hub gives 27 nodes undirected and 3 directed-out; the sink gives 0 out and 9 undirected; `edge_limit` 50/150/1000 yields exactly 50/150/349 edges.

*Constraint discovered:* `ExpandRequest.depth` is capped at `le=2` (pre-existing, applies to both datasources), so the 9-level ladder is for *repeated* expands rather than a single deeper one.

**Files:** `frontend/src/composables/useDatasourceCapabilities.ts` (`DatasourceCopy` + `DATASOURCE_COPY`, `DATASOURCE_LABELS` derived), `GraphContextFormModal.vue` (four-layer card + styles), `ContextsView.vue`, `ContextInfoPanel.vue`, `neptune-emulator/src/seed.py` (rewritten as a deterministic generator), `docs/guide/configuration.md`, e2e + composable tests.

**Also corrected:** the original entry was appended to `docs/dev/decision-log.md`; the project's active log is `docs/dev/decision_log.md` (underscore — the one recent commits touch). Entry moved, hyphenated file restored.

## [2026-08-14] - Feature Implemented: REST Connections — named API-backed datasources

**Feature:** A third datasource kind, `rest`: the dev embedding graphlagoon registers one or more **named connections** to external graph-serving HTTP APIs; a context records `datasource_type="rest"` + `datasource_name`; the user's query is sent to the API as opaque text per the connection's spec and the JSON answer maps onto the normalized graph. First datasource type with multiple instances per server — the structural change the rest of the design falls out of.

**Design decisions:**

1. **Programmatic registration, not config DSL** (user decision). `create_mountable_app(rest_connections=[RestConnectionSpec(...)])`, mirroring the similarity-endpoints registry — the one in-repo precedent for N named things. Request building, auth and response mapping become declarative fields + optional Python callables instead of an invented YAML grammar. Specs validate at registration: a bad slug or duplicate name fails app construction, not the first query.
2. **Response contract + optional mapper** (user decision). Default contract `{nodes: [{id, label, properties}], edges: [{id, source, target, label, properties}]}`; a `response_mapper` callable adapts foreign shapes. Mapping strictness is asymmetric on purpose: identity fields strict (a dropped malformed item would render a graph that quietly lies), optional fields forgiving (label→"", properties→{}, ids string-coerced, edge ids synthesized). Dangling endpoints get placeholder nodes so edges stay drawable.
3. **Canned operations opt-in per connection** (user decision). `expand_builder` / `subgraph_builder` / `fetch_nodes_builder` / `discover_types_builder` — builders return a pure `RestRequest`; the datasource owns HTTP, auth, timeouts, error mapping. Capabilities are **derived from the declared builders**, never declared separately, so they cannot drift. Undeclared ⇒ UI hides the affordance AND the API answers the existing `DATASOURCE_UNSUPPORTED_OPERATION` envelope.
4. **Named-instance identity.** New nullable `datasource_name` column (migration 011, no backfill needed), `DatasourceType` grows `"rest"`, factory key becomes composite (`rest:{name}`) with one singleton (own AsyncClient) per connection. `GraphContextCreate` requires the name for rest and strips it elsewhere; registry existence is checked in the router (pydantic stays pure).
5. **Config payload split.** `datasources` (the frozen `{type: bool}` record) is untouched — the exact-equality test and legacy consumers survive. Named instances travel under a new `datasource_connections` list: **only the `ui` block + derived flags; base_url/headers/callables never serialize** (`ui_payload()` is rebuilt field-by-field precisely so `asdict` can never leak, and a test asserts secret absence).
6. **Frontend descriptor layer.** `DatasourceDescriptor {id, type, name, copy, capabilities, restOps, available}` unifies "what backend is this?" — static for warehouse/neptune, config-sourced for rest. `capabilitiesFor`/`resolveDatasourceType` signatures untouched (20+ call sites zero-churn; rest resolves to an all-false capability row, so every existing supportsSql/supportsTranspile gate degrades correctly for free). Orphaned contexts get a synthetic unavailable descriptor whose caveat says why.
7. **Per-instance gating where type-level gates don't reach:** `graphStore.supportsExpand`/`supportsSubgraph` guard the side-panel expand section, the canvas alt-click and context-menu action (hidden, not disabled — a permanently disabled action reads as a bug), `autoLoadOnOpen` and the exploration fallback subgraph.
8. **Error taxonomy:** timeout → `REST_TIMEOUT`, remote 4xx → `REST_REMOTE_ERROR` (+body snippet), non-JSON/contract violation → `REST_INVALID_RESPONSE` — all `QueryExecutionError` with explicit codes (never classified as `STALE_CONTEXT_SCHEMA`); connect errors/5xx/mapper crashes → `GraphExecutionFailure` with traceback. Limits passed to the remote AND enforced on the mapped result. Cancellation client-side only (documented).
9. **Trust model:** no read-only guard — the language is opaque, connections are dev-declared; safety is the remote API's job. Stated in the spec docstring and docs.
10. **Orphan path:** connection removed after contexts exist → factory raises `DatasourceNotConfiguredError` → new `resolve_datasource_or_400` helper in the graph router turns every query-endpoint resolution into `400 DATASOURCE_NOT_CONFIGURED` naming the connection.

**Bugs found and fixed during implementation:**
- **Live-testing the demo caught a response-validation 500:** `TableQueryResponse.rows` is `list[list[Optional[str]]]`; the tabular flattener emitted raw floats/ints/bools. Cells now string-coerced (regression test kept). Found only because the demo runs the real HTTP path, not mocks.
- **Exploration replay on non-transpiling backends** (`restoreExplorationData`): a saved MATCH query went transpile→null→silence on Neptune, and a non-MATCH REST query would have hit the raw-SQL path. Now runs `executeCypherQuery` directly when the context doesn't transpile — same class of bug as the template-execution fix (b964af3), same shape of fix.

**Local dev:** `graphlagoon/rest_demo.py` mounts `/dummy/rest/*` on the dev host (mirroring the dummy similarity endpoints) and registers two connections — `demo-accounts` (all operations, contract shape) and `demo-scores` (query-only, foreign shape via `response_mapper`) — with `base_url` pointing at the app itself, so `make dev` shows both cards with zero extra services. Verified live over real HTTP: query/filter/expand/subgraph/discovery/console on demo-accounts; mapper + 400-on-expand on demo-scores.

**Files:** backend — `services/datasource/rest/{spec,registry,mapping,datasource}.py` (new), `factory.py` (composite key + `available_datasource_connections`), `routers/{graph,graph_contexts,config}.py`, `models/schemas.py`, `db/{models,memory_store}.py`, `alembic/versions/011_add_datasource_name.py`, `app.py` (`rest_connections` param), `rest_demo.py` + `main.py`, `graphlagoon/__init__.py` exports. Frontend — `useDatasourceCapabilities.ts` (descriptor layer), `types/graph.ts`, `services/api.ts`, `GraphContextFormModal.vue` (descriptor picker), `GraphQueryPanel.vue`, `QueryConsolePanel.vue`, `ContextsView.vue`, `ContextInfoPanel.vue`, `SidePanel.vue`, `GraphCanvas3D.vue`, `GraphVisualizationView.vue`, `stores/graph.ts` (gates + replay fix), `TemplateEditorModal.vue`, `utils/exampleQuery.ts`, fixtures + e2e helpers. Docs — new `docs/guide/rest-connections.md`, `configuration.md` datasources intro.

**Testing:** backend +76 (spec validation, MockTransport matrix incl. error taxonomy, canned ops, registry, endpoints incl. orphan + secrets-absence + config shape; full suite 563 passing, 5 pre-existing failures unchanged); frontend +20 (descriptor layer, picker, query panel, gates, example query; 1422 passing, vue-tsc clean); e2e +5 (`rest-context.spec.ts`; 12/12 with neptune spec). Migration chain `010 → 011 (head)` loads.

**Known limitations:** one shared `response_mapper` for query and canned-op responses (per-op mappers are a v2 concern); discovery response shape is fixed (no mapper); table mode projects nodes only; demo `base_url` is dev-port-coupled (override `GRAPH_LAGOON_SELF_PORT`).

## [2026-08-14] - Addendum: REST demo backed by the real Neo4j

**Trigger:** review — the in-process demo connections serve canned data with a toy keyword filter, i.e. they demonstrate the plumbing but no real query engine. The local Neo4j (seeded, 106 nodes) already exists for the Neptune emulator; expose it through the REST path too.

**Decision:** the Neptune emulator gains a second face — `/rest/query`, `/rest/expand`, `/rest/subgraph`, `/rest/schema` — speaking the REST-connection contract (`{nodes, edges}`, plain `{"detail"}` errors, deliberately NOT Neptune's envelope: on this side it plays an ordinary graph service). `to_contract()` walks Neo4j driver values (nodes/relationships/paths/containers), dedupes by `element_id`, and rides relationship endpoints along so the placeholder-synthesis path stays a fallback. `main.py` registers the `neo4j-rest` connection only when `GRAPH_LAGOON_NEPTUNE_ENDPOINT` is set — i.e. exactly under `make dev-neptune`, when the emulator is actually up.

The payoff is comparability: the SAME graph reachable through the native Neptune datasource and through a REST connection, with real openCypher in both. Verified live end to end (API → RestDatasource → emulator → Neo4j): query 19 nodes/20 edges, expand-from-Alice 8 nodes/8 edges — matching the numbers the native path produced on the same seed — and discovery returning the 4 labels / 7 relationship types.

**Files:** `neptune-emulator/src/main.py` (+`/rest/*` routes, `to_contract`), `api/graphlagoon/rest_demo.py` (`neo4j_rest_connection`), `api/graphlagoon/main.py` (conditional registration), `docs/guide/rest-connections.md`, `docs/guide/configuration.md`.

## [2026-08-14] - Addendum 2: demo connections restructured for full feature coverage

**Trigger:** user feedback — the mapper demo was query-only, so `response_mapper` could never be tested together with expand/subgraph/discovery, and no demo exercised a custom `request_builder` at all. The degraded-UI role and the mapper role were needlessly tied to the same connection.

**Decision:** one role per connection. `demo-accounts` — all operations, contract shape (unchanged). `demo-scores` — now full-featured: the same operations through the foreign `items/relations` shape, proving the mapper applies to canned-op responses too (discovery answers the direct shape — the mapper deliberately does not apply there). New `demo-minimal` — query-only through a custom `request_builder` (GET + query param), inheriting the degraded-UI role with the caveat spelling out that it is a per-connection choice, not a product limitation. Plus `neo4j-rest` under `make dev-neptune`. Verified live: scores query/expand/subgraph/discovery all through the mapper; minimal GET query works and expand answers `DATASOURCE_UNSUPPORTED_OPERATION`.

**Files:** `api/graphlagoon/rest_demo.py` (foreign-shape expand/subgraph/schema routes, `/dummy/rest/minimal` GET route, restructured specs), `docs/guide/rest-connections.md`, `docs/guide/configuration.md`.

## [2026-08-14] - Addendum 3: demo REST connections now execute real openCypher

**Trigger:** user feedback — the canned demos accepted a fake "demo query" language over hardcoded data, so nothing about actual querying was testable through them. The requirement: the demos must hit the Neptune stack, through a shell implemented in the app.

**Decision:** `rest_demo.py` rewritten as a **REST facade over the configured Neptune endpoint**, mounted on the dev host. Routes reuse the production `NeptuneClient` + `neptune/mapping.map_graph_results` (including the dangling-endpoint follow-up), converting to the contract shape. The three demo roles survive, all over real data and real openCypher: `demo-full` (contract, all ops), `demo-mapper` (foreign `items/relations` shape on queries AND canned ops, remapped by `response_mapper`), `demo-minimal` (query-only via GET `request_builder`). Registered **only when `GRAPH_LAGOON_NEPTUNE_ENDPOINT` is set** — plain `make dev` shows no REST cards rather than cards that fail on first query.

Superseded and removed: the canned in-process graph, and the emulator's `/rest/*` routes + `neo4j-rest` connection from Addendum 1 — the app-side facade replaces both (one shell, one pattern; it doubles as the integrator's worked example).

**Verified live** (API → RestDatasource → facade → NeptuneClient → emulator → Neo4j): all three connections answer `MATCH (a:Person)-[r:KNOWS]->(b)` with 20/20; `demo-full` and `demo-mapper` produce byte-identical results (mapper round-trip lossless — expand Alice 8/8, subgraph 106/349, discovery 4 labels/7 types); `demo-minimal` runs the same Cypher over GET and answers `DATASOURCE_UNSUPPORTED_OPERATION` on expand; invalid Cypher surfaces the real Neo4j error as `REST_REMOTE_ERROR` — proof the query genuinely executes.

**Files:** `api/graphlagoon/rest_demo.py` (rewritten), `api/graphlagoon/main.py` (conditional registration), `neptune-emulator/src/main.py` (`/rest/*` removed), `docs/guide/rest-connections.md`, `docs/guide/configuration.md`.

## [2026-08-20] - Feature: named graph caches on a volume

**Trigger:** the only way to reopen a graph without re-running its query was an exploration — personal, UUID-addressed, carrying UI state. Missing was the opposite: a graph **named, scoped to a context, shared by URL**, that anyone with context access opens without touching the warehouse. First of several planned cache systems, so the semantics had to sit behind an interface a Redis/Postgres backend could implement later.

**Decision — gzip, not zstd.** The initial plan was zstd with a shared codec migrating `snapshot.py` along with it. Rejected on a finding: Starlette's `GZipMiddleware` forwards any body that already declares a `Content-Encoding` (`IdentityResponder.send_with_compression`, `gzip.py:55-57`), so the read endpoint can return the stored bytes **verbatim** — no server-side decompress, no re-serialize, browser unpacks natively. `Content-Encoding: zstd` is not safely assumable across proxies and clients, so zstd would have forced a full decompress + re-serialize on every load. Denser algorithm, slower hot path. The extension is the codec-agnostic `.jsonz` and `decompress` dispatches on magic bytes (with the zstd branch reserved), so changing codec later needs neither a file migration nor a two-key lookup ladder — which is what the original `.json.zst`-then-`.json.gz` fallback would have cost: two HTTP round trips, one a guaranteed 404, on every legacy load.

**Decision — `snapshot.py` untouched.** The plan also had it re-expressed over the new `BlobStore`. Dropped: it is on the critical path of every exploration open, has zero test coverage, and its error taxonomy is load-bearing (`_persist_snapshot` maps PermissionError/TimeoutError/OSError onto distinct HTTP codes; the frontend's `loadExploration` depends on the load path *throwing* to trigger query re-execution). A refactor that flattened one of those would silently turn "fall back to the query" into "exploration is broken", with no user-visible upside. `blob_storage.py` was nonetheless shaped so it can become an adapter later — root-level keys, `load()` returning `None` on 404. Logged as technical debt #24 with characterization tests as the precondition.

**Decision — `get_context_with_access`, not the explorations helpers.** The cache endpoints are graph-domain endpoints; `routers/graph.py:126` already had the helper that collapses the db/memory branch and raises the `{"error":{code,message,details}}` envelope the frontend parses. Moved to `utils/context_access.py` and re-exported from its historical home (`test_superuser.py` imports it from there). **Fixed a pre-existing bug while moving it:** the DB branch built its exploration-share conditions by hand as exact-match + `*@domain` and omitted the public sentinel `"*"`, while the memory branch used `user_has_share_access`, which honours it. In database mode a user whose only grant was a *public exploration share* could list explorations but got 403 from every graph query endpoint. Both branches now go through `share_match_emails`.

**Decision — the store does not reuse `applyGraphResponse`.** That function branches on `partialNodeIds`, and its `sameNodes` branch calls `patchNodeProperties` **without reassigning `edges`** (`graph.ts:1580`). Had a query job already drawn a partial when a cache loaded, the result would have been the cache's nodes with the previous graph's edges. `loadGraphCache` assigns explicitly, the way `loadSubgraph` does, and nulls `partialNodeIds` first. It also bumps `enrichmentToken` and clears `pendingPropertyNodeIds` as its first act — a stale enrichment patches by node id and would otherwise write the previous graph's properties onto same-named cached nodes.

**Decision — writes refuse a half-enriched graph.** `shouldLoadProgressively()` returns true whenever a context has no configured `node_properties` — the common case — so nodes arrive with `properties: null` and are filled in later by `/nodes/batch`. Caching mid-flight would persist the nulls and replay an empty-looking graph, defeating the feature. The panel disables saving while `enriching || pendingPropertyNodeIds.size > 0`, the API answers 400 `CACHE_INCOMPLETE`, and entries record `properties_complete`.

**Decision — no node positions.** A cache replays a query result; layout runs fresh. Positions and visual state are what explorations and their snapshots are for. Worth stating explicitly because the `Node` pydantic model has no `x`/`y` and would have *silently stripped* them — shipping a "position-preserving" cache that preserved nothing. Documented as a boundary in `configuration.md` alongside a cache-vs-exploration table.

**Other decisions:** writes are dev-gated (`graph_cache_writable()` reads the settings handed to `configure_graph_cache_service`, not `get_settings()`, because a mounted app can be built with a different Settings object); reads are never gated, which is the point of the feature. Context deletion purges the cache directory best-effort — a deliberate exception to dev-only writes, since it is owner-initiated cleanup and skipping it in production leaks storage forever. Listing metadata comes from the directory listing itself; a per-context `_index.json` manifest was rejected because it would desynchronize the moment an external job writes to the volume, which *is* the production write path. Oversized bodies are rejected on `Content-Length` in a dependency, before Starlette materializes the JSON — an in-handler check runs after the parse and cannot stop an OOM.

**Databricks Files API caution.** `/api/2.0/fs/directories` is not used anywhere else in this codebase, so `DatabricksBlobStore` never depends on its uncertain parts: it creates the parent directory explicitly rather than trusting implicit creation, reads 404-on-list as "empty", parses the listing tolerantly (`contents`|`files`, `file_size`|`size`, `last_modified`|`modification_time`), and treats directory-delete failure as harmless. Unverified against a live workspace — only the listing endpoint depends on it.

**Verified:** 707 API tests (+144: codec, blob store key safety and traversal, Databricks transport under `httpx.MockTransport`, endpoint authz/dev-gate/isolation/size-cap/corruption, the public-share regression) and 1465 frontend unit tests, both suites green apart from 5 pre-existing failures in `test_cypher_comments.py`/`test_transpile_options.py` that fail identically on a clean tree. 130 E2E green, including a cross-page journey: open a context → save the graph as a cache → reopen from its URL alone. One E2E asserts **zero** requests to `/query`, `/cypher` or `/subgraph` while a cache loads; one unit test asserts zero `getNodesBatch` calls; and a dedicated test mounts the real `GZipMiddleware` to prove the pass-through, since silently double-compressing every cached graph is the failure mode that would otherwise go unnoticed.

**Files:** `api/graphlagoon/services/graph_codec.py`, `services/blob_storage.py`, `services/graph_cache.py`, `routers/graph_cache.py`, `utils/context_access.py` (all new); `routers/graph.py`, `routers/graph_contexts.py`, `routers/config.py`, `models/schemas.py`, `config.py`, `app.py`; `frontend/src/components/GraphCachePanel.vue` (new), `stores/graph.ts`, `stores/toolbar.ts`, `services/api.ts`, `types/graph.ts`, `components/Toolbar.vue`, `views/GraphVisualizationView.vue`; tests `api/tests/test_graph_codec.py`, `test_blob_storage.py`, `test_graph_cache.py`, `test_context_access.py`, `frontend/src/stores/__tests__/graph.cache.test.ts`, `components/__tests__/GraphCachePanel.test.ts`, `e2e/tests/graph-cache.spec.ts`, `e2e/helpers/api-mocks.ts`, `e2e/tests/user-journeys.spec.ts`; docs `docs/guide/configuration.md`, `docs/dev/technical-debts.md`, `api/.env.example`.

## [2026-08-20] - Addendum: the graph cache has no listing endpoint

**Trigger:** user review, two findings. The panel had no `width` while every sibling sidebar pins itself to 250–300px, so it stretched and ate the canvas. And: "we could have millions of caches, this will break, right?"

**Measured before answering.** Local listing, one context: 1k entries → 16 ms / 0.1 MB; 10k → 134 ms / 1.0 MB; 50k → 806 ms / 4.9 MB. Linear, ~16 µs and ~100 bytes of JSON per entry. Extrapolated to a million in one context: ~16 s and ~100 MB in a single response, plus a million DOM rows. The axis that matters is entries **per context**, not the total — a million spread over a thousand contexts is a thousand each, which is the 16 ms row.

**Decision: remove listing entirely** (user's proposal, and the right one). Not paginate — *remove*. Paging only moves the cost, because the Databricks Files API has no server-side name filter to page toward, so finding a name among 100k would still mean walking every page. Every real use of a cache already knows the name it wants: the URL *is* the handle. Deleting the operation deletes the problem, and nothing has to lie about truncation.

Gone: `GET /api/graph-contexts/{id}/graph-cache`, `GraphCacheService.list`, `GraphCacheListResponse`, `api.listGraphCaches`, and the panel's list. The panel is now two fields — save under a name, delete by name — and shows the link immediately after a save, since nothing will list it later. `BlobStore.list` stays: purging a deleted context has to find the files, but that is internal and bounded to one context.

**Two bugs fixed on the way, wrong at any scale:**

1. **The Databricks page cap truncated silently.** `_MAX_LIST_PAGES = 50` logged a warning and then returned a *short list that looked complete* — a correctness bug, and a violation of the "no silent caps" rule written into this feature's own plan. Now raises `OSError`. Its only caller is `delete_prefix`, where a short list means files orphaned on the volume forever, so failing loudly is strictly better.

2. **Context-deletion purge was sequential and blocking.** One `DELETE` per blob, awaited in turn, inside the delete handler. At a thousand entries that is most of a minute holding the response — broken far below the millions the question was about. Now bounded concurrency (16), with a test asserting both that deletes overlap and that the bound holds.

**Panel sizing:** `width: clamp(230px, 22vw, 300px)` with `overflow-x: hidden`, `min-width: 0` on the flex rows and ellipsis on the name. Two E2E tests pin it — the panel measures 200–300px with zero horizontal overflow at 1280px wide, and holds at the floor on a 900px viewport — because "it looked fine when I built it" is exactly how this regressed.

**Verified:** 711 API tests, 1468 frontend, 133 E2E, all green apart from the same 5 pre-existing failures. Live against the running dev server before and after: save → link → replay → delete → context-delete cascade.

**Files:** `api/graphlagoon/routers/graph_cache.py`, `services/graph_cache.py`, `services/blob_storage.py`, `models/schemas.py`; `frontend/src/components/GraphCachePanel.vue`, `services/api.ts`, `types/graph.ts`; tests `api/tests/test_graph_cache.py`, `test_blob_storage.py`, `frontend/src/components/__tests__/GraphCachePanel.test.ts`, `services/__tests__/api.test.ts`, `e2e/helpers/api-mocks.ts`, `e2e/tests/graph-cache.spec.ts`, `e2e/tests/user-journeys.spec.ts`; `docs/guide/configuration.md`.

## [2026-08-20] - Feature: named style presets applied by URL

**Trigger:** the same shape as the graph cache, but for appearance — save style, labels and layout per context, name it, and have `/graph/{id}?style={name}` apply it to whatever graph is loaded or about to be.

**Decision — the format already existed, so extract rather than invent.** `ExplorationState` has carried every one of these fields for as long as explorations have: `aesthetics`/`nodeTypeColors`/`edgeTypeColors`/`nodeTypeIcons`/`edgeTypeIcons`/`nodePropertyIconConfigs` (style), `textFormat` (labels), `layout_algorithm`/`layout_mode_config`/`force3d_settings` (layout). A preset is that subset. So `buildStylePreset()` and `applyStylePreset()` were factored **out of** `getExplorationState()` and `loadExploration()`, and both now go through them — `getExplorationState` spreads the block, `loadExploration` calls the applier. Writing a second serialization would have guaranteed drift on the first field added. The refactor is covered by a test asserting every key `buildStylePreset()` produces appears identically in `getExplorationState()`.

**Decision — a preset never says which data is shown.** Filters were explicitly excluded, and behaviors with them. A preset that could hide nodes would make a styled graph look like it came back incomplete from the server, and a shared link would silently change someone's conclusions. `StylePresetSettings` on the backend is `extra="allow"` with no interpretation: the shapes belong to the frontend, and typing them twice would mean two definitions drifting.

**Decision — apply is a replace, not a merge.** A field the preset omits resets to its default, so applying one always produces the look that was saved rather than that look mixed with whatever was set before. Same semantics `loadExploration` already had.

**Decision — three permission levels, one more than anywhere else here.** Read needs context access; write needs context *write* access (`can_write`, the predicate `query_templates.py` uses); delete needs to be the preset's creator, or a superuser. Ownership is **per preset, not per context** — the context owner deliberately cannot delete someone else's. Two consequences follow and both are enforced: overwriting an existing name keeps its original author (otherwise write access would be a way to take over a preset and then delete it), and delete has to read the file before removing it, since ownership lives inside it. That read is also why the listing does **not** report owners — doing so would cost one request per preset. The 403 names the author instead, which is the only place it surfaces.

**Decision — unlike the graph cache, presets are listable and writable in production.** Both differences follow from what a preset is: a few kilobytes of hand-authored preference. There are a handful per context, and choosing one means seeing what exists. The scale lesson from the cache is applied differently rather than ignored: instead of paginating the read, the count is **bounded at write time** (`style_presets_max_per_context`, default 100), so the listing can stay complete and honest.

**Decision — a missing `?style=` changes nothing and does not break the page.** The graph loads and stays fully usable; the status bar reports that the styling was not applied. This is deliberately unlike a missing `?graph=`, which leaves nothing to look at and so fails loudly. A fully silent no-op was rejected: a broken link would look like a working one.

**A bug the tests caught.** The first attempt at resetting `currentStylePreset` landed inside `loadGraphCache` instead of `clear()`, because both start by nulling `currentGraphCache`. That would have made swapping the cached graph drop the applied style — exactly the behavior the feature exists to provide. Moved to `clear()`, and pinned by two tests asserting a style survives both an ordinary graph change and a cache swap.

**Shared plumbing.** `services/named_store.py` now owns what graph caches and style presets must agree on — the legal-name alphabet and the backend-selection factory — and `graph_cache.py` was refactored onto it with its public names kept as aliases (123 tests green through that change, before any preset code ran).

**Verified live** against the running dev server: save → list → read → another writer overwrites (author preserved, `updated_at` set) → that writer is refused the delete with a message naming the owner → the owner deletes it → file gone. Plus 750 API tests, 1507 frontend, 143 E2E, all green apart from the 5 pre-existing Cypher failures.

**Files:** `api/graphlagoon/services/named_store.py`, `services/style_presets.py`, `routers/style_presets.py` (new); `services/graph_cache.py`, `models/schemas.py`, `config.py`, `app.py`, `routers/config.py`, `routers/graph_contexts.py`; `frontend/src/components/StylePresetPanel.vue` (new), `stores/graph.ts`, `stores/toolbar.ts`, `services/api.ts`, `types/graph.ts`, `components/Toolbar.vue`, `views/GraphVisualizationView.vue`; tests `api/tests/test_style_presets.py`, `frontend/src/stores/__tests__/graph.stylePreset.test.ts`, `components/__tests__/StylePresetPanel.test.ts`, `e2e/tests/style-presets.spec.ts`, `e2e/helpers/api-mocks.ts`; docs `docs/guide/configuration.md`, `api/.env.example`.

## [2026-08-21] - Addendum: style presets moved into the Style panel

**Trigger:** user review — a second toolbar entry labeled "Style" made no sense next to the existing aesthetics one, and the preset list crowded a 250px sidebar of sliders.

**Decision:** presets moved off the toolbar entirely, into a single "Presets" button inside the existing Style (aesthetics) panel, opening one modal that holds naming, description, the list, apply and delete. No inline list, no second sidebar. `StylePresetModal.vue` replaces the standalone panel and its toolbar wiring; `toolbar.ts`'s `onToggleStylePresets`/`'stylePresets'` entries were removed along with it.

**A collision the E2E suite caught:** the new button's title ("Save or apply a named style preset") contained the substring "style", and Playwright's `getByTitle` matches substrings case-insensitively by default — so a pre-existing test's `getByTitle('Style')` started resolving to two elements. Reworded the title to drop the word entirely; the fix is choosing title text that does not echo a sibling control's name, not a testing workaround.

**Verified:** 1509 frontend unit tests, 144 E2E (full suite, zero failures — the collision above was the only casualty and is fixed), 750 API tests, same 5 pre-existing Cypher failures.

**Files:** `frontend/src/components/StylePresetModal.vue` (new, replaces the removed `StylePresetPanel.vue`), `AestheticsPanel.vue`, `Toolbar.vue`, `stores/toolbar.ts`; tests `frontend/src/components/__tests__/StylePresetModal.test.ts` (replaces the removed panel test), `e2e/tests/style-presets.spec.ts`.

## [2026-08-21] - Feature: "Ask AI" prompt for label templates

**Trigger:** the Cluster Programs panel already had an "Ask AI" button that hands the user a long,
graph-aware prompt to paste into an LLM. The Labels panel only had Help — a slide deck — even though
the label mini-language (placeholders, modifiers, date formats, conditionals, rule priority) is at
least as fiddly as writing a cluster program. Same affordance, same shape, for labels.

**Decision — mirror the cluster helper rather than invent a second pattern.** `labelTemplateSkill.ts`
is a pure builder with the same input (`nodeTypes`, `edgeTypes`, `nodeProperties`, `edgeProperties`)
and the same interview-style ending; `LabelTemplateSkillModal.vue` is structurally the cluster modal
with different copy and `label-skill-*` testids. One mental model for "Ask AI" across the app, and a
user who has used one already knows the other.

**Decision — share the rendering helpers, don't copy them.** `bulletList`, `propertyList` and the
`SkillProperty` interface were promoted to exports on `clusterProgramSkill.ts` and imported by the new
builder. Duplicating them would have guaranteed the two prompts' metadata sections drifted apart on
the first formatting tweak.

**Decision — copy-to-clipboard only, no "Open in Gemini" button.** The user's ask named Gemini, but a
deep link cannot carry a prompt this long in a URL: the button would open a blank chat and the user
would still paste. So the intro names Gemini/ChatGPT/Claude and the single action stays Copy, exactly
as in the cluster modal.

**The prompt is written against the parser, not against the Help modal.** Reading
`utils/labelFormatter.ts` turned up three things the existing help slides get wrong or omit, all of
which the new prompt states correctly:

- Conditional operators are parsed **inline with no separator** —
  `/^prop:([^=!<>]+)(==|!=|>=|<=|>|<|contains|startsWith|endsWith)(.+)$/` — so the real syntax is
  `{if:prop:namecontainsjohn|Match|No}`. `TextFormatHelpModal.vue`'s slide shows
  `{if:prop:name|contains:john|...}`, which `parseConditionExpression` returns `null` for and which
  therefore renders as an empty string. **Left unfixed here (pre-existing, outside this change) —
  worth a follow-up.**
- Modifiers do **not** chain: `parseTokenContent` reads only `parts[1]`, so `{prop:x|upper|truncate:5}`
  silently applies `upper` alone.
- A `prop:` placeholder that resolves to nothing renders the visible fallback `[<column>]`, not an
  empty string — a typo in a column name shows up on the canvas.

The prompt also states the `TextFormatRule` shape (target / types / template / priority / enabled) and
the selection rule from `findMatchingRule` (highest priority wins; on a tie, explicit `types` beats an
empty list), and asks for output in a form that can be typed straight into the rule form.

**Icon:** the cluster "Ask AI" button used `HelpCircle`, indistinguishable from actual help. Both
buttons now use lucide's `Bot`, so "ask a robot" and "read the docs" are visually separate — the
Labels panel shows them side by side.

**Verified:** 1524 frontend unit tests across 87 files, all green (up from 1509 — 15 new); `vue-tsc
--noEmit` clean.

**Files:** `frontend/src/utils/labelTemplateSkill.ts`, `components/LabelTemplateSkillModal.vue` (new);
`utils/clusterProgramSkill.ts` (helpers exported), `components/TextFormatPanel.vue`,
`components/ClusterProgramPanel.vue`; tests `frontend/src/utils/__tests__/labelTemplateSkill.test.ts`,
`components/__tests__/LabelTemplateSkillModal.test.ts`, `components/__tests__/TextFormatPanel.test.ts`
(new).

## [2026-08-21] - Addendum: graph cache creation restricted to superusers

**Trigger:** user directive — creating a graph cache should be a superuser-only action, not a dev-mode one; style presets keep their existing rule (anyone with context write access can create, only the creator can delete). Clarified via a follow-up question: delete follows create — superuser-only too, not owner-or-superuser as `can_manage` would have given it.

**Decision:** the `_require_writable()` gate (`graph_cache_enabled and dev_mode`) is gone from `routers/graph_cache.py`, replaced by `_require_superuser(user_email)` (`is_superuser`, from `utils/authz.py`) on both PUT and DELETE. Context ownership now grants **no** special power over a cache — the previous DELETE rule (`can_manage`: owner or superuser) is dropped in favor of superuser-only, matching create. `graph_cache_writable()` is deleted from `services/graph_cache.py` entirely rather than left as dead code. This is the asymmetry that now separates the two features sharing this storage pattern: a graph cache is a published, administered artifact nobody but a superuser authors or removes; a style preset is personal preference anyone with write access can save, deletable only by whoever made it.

**Frontend:** the toolbar's Cache button and the panel's save/delete fields switched from `usePersistence().devMode` to `usePersistence().isSuperuser` (already exposed via `window.__GRAPH_LAGOON_CONFIG__.is_superuser`, no new plumbing needed). A non-superuser no longer sees the button at all; reading a cache by URL is unaffected — it never depended on either flag.

**Test rewrite:** `api/tests/test_graph_cache.py` needed a near-total rewrite — nearly every "arrange" write in the file switches from `OWNER` to a `SUPERUSER` actor, and the old `TestDevGate` class (four dev-mode-on/off cases) is replaced by `TestSuperuserGate`, parametrized over OWNER/WRITER/READER/STRANGER all getting 403 on write and delete, including an explicit "owning the context grants no special power" case. On the frontend, `graph.cache.test.ts`/`GraphCachePanel.test.ts` swap their `dev_mode` mock for `is_superuser`, and `e2e/tests/graph-cache.spec.ts` splits into a `test` block (read-only, ordinary `authenticatedPage`) and a new `superuserTest` block — extracted into the shared `fixtures/test-fixtures.ts` alongside the existing `authenticatedPage`/`unauthenticatedPage`, since `sharing-ui.spec.ts` already had its own local copy of the same shape and a third near-duplicate wasn't worth it. The cross-page journey in `user-journeys.spec.ts` moved into its own `superuserTest.describe` block — Playwright requires every test inside one `describe` to share the same fixture object, so it could no longer sit alongside the plain-`test` journeys.

**Verified:** 757 API tests (63 in the rewritten `test_graph_cache.py` alone), 1524 frontend unit tests, 145 E2E, all green apart from the same 5 pre-existing Cypher failures. Live-equivalent coverage: `TestSuperuserGate` exercises owner/write-share/read-share/stranger all getting 403 on both verbs, superuser getting 200/204, and reads working for everyone regardless of superuser status.

**Files:** `api/graphlagoon/routers/graph_cache.py`, `services/graph_cache.py`, `tests/test_graph_cache.py` (rewritten); `frontend/src/components/GraphCachePanel.vue`, `Toolbar.vue`, `components/__tests__/GraphCachePanel.test.ts`; `frontend/e2e/fixtures/test-fixtures.ts` (new `superuserTest` export), `e2e/tests/graph-cache.spec.ts` (rewritten), `e2e/tests/user-journeys.spec.ts`; `docs/guide/configuration.md`, `api/.env.example`.

## [2026-08-21] - Bug Fix: flaky `progressive-load.spec.ts` E2E test (CI-only failure)

**Trigger:** CI run reported `progressive-load.spec.ts:117 › the Behaviors panel switches property loading for the current session` failing on both the initial attempt and its retry with `TypeError: Cannot read properties of undefined (reading 'nodes_mode')` at `bodies[0].nodes_mode`.

**Root cause:** the test attaches `page.on('request', ...)` before `page.goto()`, then asserts on `bodies[0]` synchronously right after `await expect(graph-status-bar).toBeVisible()` resolves. The status bar becomes visible as soon as the app renders the (immediately-fulfilled) types-only subgraph response, but Playwright's `'request'` event listener callback runs on a separate microtask/IPC turn from the page's own rendering — there is no guarantee the callback has fired and pushed into `bodies` by the time the visibility assertion settles. Under a loaded CI runner (this suite already logs "Slow test file" warnings and a 5-minute total run) that race can lose, leaving `bodies` empty when the array is indexed. The identical pattern already existed one test above (`requests types-only nodes, then enriches in a second call`, line 89) using `?.` to avoid the hard crash, which just masks the same race as an assertion-value mismatch instead of a `TypeError`.

**Fix:** replace the synchronous `bodies[0]` index with `await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(0)` before reading `bodies[0]`, in both the failing test and the earlier `subgraphBodies` case that had the same latent race. This makes the assertion wait for the actual network event instead of assuming it already happened, without changing what's being verified (types-only mode on the first `/subgraph` call).

**Verified:** ran `npx playwright test --config e2e/playwright.config.ts e2e/tests/progressive-load.spec.ts` locally — all 9 tests in the file pass; `npx vue-tsc --noEmit` clean. No backend or store change was needed — this was purely an E2E test-timing bug, not an application regression.

**Files:** `frontend/e2e/tests/progressive-load.spec.ts`.

## [2026-08-21 09:02] - Security Review: graph cache (`?graph=`) and style presets (`?style=`)

**Trigger:** user request to review the two named-artifact-by-URL features (graph cache, style presets) for security flaws.

**Method:** dispatched a read-only exploration agent to audit both features end-to-end — routers, services, DB/blob-storage layer, and the frontend URL-param handling — against authorization/IDOR, path traversal/injection, stored-XSS, mass assignment, rate limiting, and CSRF. Verified the agent's specific claims by reading the actual router/service files and re-diffing commit `7508843` (the prior superuser-restriction fix) myself before acting on any finding.

**Findings:**

1. **Medium — style-preset PUT had no early body-size guard (memory-exhaustion DoS), unlike graph-cache PUT.** `graph_cache.py`'s PUT rejects an oversized body via a `Content-Length` pre-check (`enforce_body_limit` dependency) *before* Starlette/Pydantic buffers and parses it. `style_presets.py`'s PUT had no equivalent — its only size check (`MAX_PRESET_BYTES`, 1 MB) ran *after* the full JSON body was already parsed into memory by `StylePresetWriteRequest` (whose nested `StylePresetSettings` uses `extra="allow"`, so it happily materializes arbitrarily large/deeply-nested JSON). Since preset writes require only context *write* access (not superuser — reachable via a domain-wildcard share), any such user could send a multi-GB body to exhaust worker memory before the size limit ever triggered. **Fixed** by adding the same `Content-Length`-based `enforce_body_limit` dependency (mirroring `graph_cache.py`, generous ×10 headroom since the check is pre-compression) to `put_style_preset`, sourcing the limit dynamically from `style_presets_service.MAX_PRESET_BYTES` so it stays in sync with the service's real (test-overridable) constant.

2. **Low — stale config docstring.** `Settings.graph_cache_enabled`'s field description still said writing "requires dev_mode", left over from before `7508843` (which switched the gate to superuser-only). Not exploitable, but could mislead an operator locking down a deployment. **Fixed**: description now points at `GRAPH_LAGOON_SUPERUSER_EMAILS`.

**Confirmed non-findings (verified directly, not just accepted from the agent):**
- **Superuser-restriction completeness (`7508843`):** re-diffed against current `graph_cache.py` — the superuser gate is applied to *both* PUT and DELETE; no mutating endpoint was missed, and there's deliberately no list endpoint to worry about.
- **Path traversal / injection:** cache/preset names (`graph=`/`style=` values) are validated against a strict allow-list, `ARTIFACT_NAME_RE = ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` (`services/named_store.py:28`), applied both at the router and again inside the service before touching storage — blocks `/`, `\`, `..`, null bytes, unicode, and any shell/SQL metacharacters outright. A second, independent barrier lives in `blob_storage.py` (`normalize_key` + `LocalBlobStore._resolve()`'s `is_relative_to(base)` check), so even a hypothetical regex bypass can't escape the storage root. Neither name is ever interpolated into a Cypher/SQL query.
- **Stored XSS via preset settings:** no `v-html`/`innerHTML` sink anywhere in the frontend; preset fields feed typed Vue/Three.js state, not raw HTML.
- **Mass assignment:** `owner_email`/`created_by`/`context_id` are never accepted from the request body on either feature — always set server-side from the authenticated identity or the URL path.
- **IDOR:** by design, read access to *any* named cache/preset requires only read access to the parent context (not per-artifact ownership) — this is the documented intent (a cache/preset is a per-context artifact), not a bug. Flagged as a design point worth confirming against org data-sensitivity expectations if a context is ever shared with a public (`*`) or wide-domain share, since that would expose all of its caches/presets to that whole audience.
- **CSRF:** auth is header-based (`X-Forwarded-Email` via a trusted reverse proxy), no cookies used by `axios` — classic same-site-cookie CSRF doesn't apply here.

**Verified:** `uv run pytest tests/test_style_presets.py tests/test_graph_cache.py` — 103 passed (102 existing + 1 new regression test for the body-size guard, `test_oversized_body_is_rejected_before_parsing`, mirroring the graph-cache test of the same name). Full API suite: 758 passed / 5 pre-existing unrelated failures (confirmed pre-existing by re-running against the unmodified branch via `git stash`) / 1 skipped — none touch these two features.

**Files:** `api/graphlagoon/routers/style_presets.py` (added `enforce_body_limit` dependency on PUT), `api/graphlagoon/config.py` (docstring fix), `api/tests/test_style_presets.py` (new regression test).
