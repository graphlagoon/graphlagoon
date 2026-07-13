# Decision Log

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
