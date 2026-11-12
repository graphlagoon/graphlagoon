# UX review · Investigations area (queue, case workspace, dossier, decision panel, exports)

Date 2026-11-10 · widths 1440×900 and 1024×700 (390 skipped on request) · everything API-mocked.
Evidence: every PNG and JSON named below lives in
`/tmp/claude-0/-root-graphlagoon/ac2c0ae9-0e80-40c2-a3b1-79ed559aa5da/scratchpad/ux/case/`
(109 PNGs, one `<width>-<surface>.json` per probe test with the raw numbers).
Nothing in `docs/dev/ux-review.md` (#1–#30) covers this area, so nothing below is a re-report.

Method: Playwright probe (`_ux-probe-case.spec.ts`, deleted) seeded with the shapes from
`investigation-ux.spec.ts` / `investigation-workspace.spec.ts` / `investigations.spec.ts`
(populated case: 2 exploration_ref graphs with 10 and 8 named nodes, 2 notes, 2 documents, 1 table,
1 query, 2 tasks, 2 suggested annotations, 1 recorded decision, roles vocabulary). Every number was read
with `page.evaluate` (`getBoundingClientRect`, computed styles, `scrollWidth`) and is cited next to the PNG.

## Findings, ranked by cost to the user

### 1. [blocks task] Layout panel @ 1024 (and 1440) — the panel opens above the viewport and over the header
What happens: `workspace-layout-btn` opens `LayoutPanel`, whose root is `position:absolute; top:-626px; left:12px` at
1024 (`-795px` at 1440), giving a rect of **x 314, y −82, 240×550** at 1024 and **y −20, 240×750** at 1440
(`1024-layout-panel.json`, `1440-layout-panel.json`). At 1024 the title bar, the ✕ and the "Force" option are above
the screen; the panel covers the top-nav "Investigations" link (`elementFromPoint(308,25)` = `A.nav-link`), the
deadline badge, and its own toolbar row (Table/Layout buttons) — the probe could not click `workspace-table-btn`
while it was open (`1024-interactions.json` → `panel-table: locator.click timeout`). PNGs
`1024-workspace-panel-layout-measured.png`, `1440-workspace-panel-layout-measured.png`, `1024-workspace-strip-tasks.png`
(still open, covering the toolbar).
Why it costs: at 1024 the only visible way out is the toolbar toggle it covers; at both widths it hides the case
header instead of docking next to the canvas like Filters/Look/Clusters do.
Heuristic: H8 Aesthetic and minimalist design / H3 User control and freedom. Severity **4** at 1024, 3 at 1440.
Smallest fix: in `InvestigationView.vue` the `.layout-panel` wrapper should position the panel like `panel-filters`
(inside the canvas, `top: 12px; left: 12px; max-height: calc(100% - …)`), or reuse the shared dock the other three
panels use. One place, fixes both widths.

### 2. [confuses] Filter chips @ both widths — a filter with no match leaves a blank canvas and a status bar that still says "10 nodes"
What happens: role ▾ → "mule" (the role exists only as a *suggested* annotation, so no confirmed node has it). The
canvas is empty, no "no match" message; `workspace-status` keeps "10 nodes · 9 edges · 1 source"
(`1440-interactions.json` → T4 `statusFiltered`), and the only sign of a filter is the chip `role: mule ▾` plus a
clear button whose visible label is **"✕ 1"** (`chips-clear`, text "1", meaning only in its `title`).
PNGs `1440-workspace-T4-filtered.png`, `1024-workspace-T4-filtered.png`.
Why it costs: the user cannot tell "nothing matches" from "the graph is gone"; the status bar contradicts the screen;
"1" does not read as "clear".
Heuristic: H1 Visibility of system status. Severity **3**.
Smallest fix: when the filtered set is empty render a `canvas-empty`-style overlay ("No node matches role: mule ·
Clear filters"); make the status bar count the shown set ("0 of 10 nodes"); label the chip "Clear (1)".
Filtering done via `useCaseFilters` and `CaseFilterChips.vue`; the status text is in the view.

### 3. [confuses] Record decision @ both widths — no feedback at all after the primary action of the case
What happens: Decide → fill outcome + rationale → **Record decision**: no toast, no confirm (the decision does not close
the case), the panel vanishes and the inspector falls back to whatever was selected before (here an edge's Notes tab,
`1440-workspace-decide-recorded.png`); the only trace is "Journal · 2 → 3" in the collapsed strip
(`1440-interactions.json` → T5 `toast: []`, `inspectorAfter: "TRANSFER · e1 …"`). The new decision is only visible in
"Decisions so far" when *nothing* is selected, or in the dossier.
Why it costs: the user does not know whether D2 was recorded, numbered, hashed, or whether it closed the case.
Heuristic: H1 Visibility of system status. Severity **3**.
Smallest fix: `useToast().success('Recorded D2 · Close as a false positive')` with a "Dossier" action, and after
recording clear the selection so "Decisions so far" shows the new entry. Also Escape does not cancel the panel
(`escape.decisionPanel: false`) while it does close the settings drawer and the Add popover — wire `decision-cancel` to
the existing Escape handler.

### 4. [layout] Case workspace @ 1024×700 — fixed 290 + 320 px columns leave a 414×349 canvas, 216 px tall with 8 graphs, 177 px with a long title
What happens: `grid-template-columns: 290px 1fr 320px` with no `@media` rule (`InvestigationView.vue:928`).
Measured `graph-container`: 1440 populated **830×580**; 1024 populated **414×349** (20 % of the viewport area);
1024 with 8 graph chips **414×216** (chip strip 160 px tall + "One at a time" row + wrapped toolbar); 1024 with a
140-char title **414×177** (header 213 px tall); 1024 with the Tasks strip open **414×191**, of which the 2-row
analysis bar (390×56) covers the bottom (`1024-workspace-states.json`, `1024-interactions.json`).
PNGs `1024-workspace-populated.png`, `1024-workspace-many-all.png`, `1024-workspace-long-names.png`,
`1024-workspace-strip-tasks.png`.
Why it costs: at the width of a laptop with a side-by-side window the graph — the reason the page exists — is a
postage stamp; the toolbar and analysis bar each wrap to two rows and eat more of it.
Heuristic: H8 Aesthetic and minimalist design. Severity **3**.
Smallest fix: below ~1200 px collapse the material list to a 48 px rail (its own title already truncates at 78 px:
"Bank A tra…") or make the inspector an overlay like the panels; `min-width:0` on the toolbar so it scrolls instead
of wrapping. The chip strip should become one scrolling row over ~4 chips.

### 5. [confuses] Graph whose snapshot fails @ both widths — blank canvas, "0 nodes", a 12 px ⚠ with no explanation
What happens: `GET …/items/g-b/snapshot` → 500 after picking Bank B: canvas empty, no `canvas-error`
(`canvasError: "none"`), status "0 nodes · 0 edges · 1 source"; the legend chip's ⚠ is **12×12 px with no `title`**
(`legendErrorTitle: null`); the material-list ⚠ (also 12×12) carries the raw server text `"boom"` as a tooltip only.
PNGs `1440-workspace-error-snapshot.png`, `1024-workspace-error-snapshot.png`.
Why it costs: the user sees an empty graph and no reason; the one signal is below the 24 px target size and silent.
Heuristic: H9 Help users recognize, diagnose and recover from errors. Severity **3**.
Smallest fix: reuse the existing `canvas-error` overlay ("Bank B transfers could not be loaded: <message> · Retry ·
Open exploration") and give the legend ⚠ the same `title`.

### 6. [friction] Evidence note (T3) @ both widths — "pin" is the word for "make it evidence", and nothing says so
What happens: after `note-add` the note appears in the entity's Notes list (no toast; acceptable), but turning it
into evidence requires finding it in the material list, opening its details, and pressing **Pin** (38×25, no
`title`); the feedback is the toast "Pinned · hash eeeeeeee" and "📌 Pinned". The dossier then calls it "E1 ·
Evidence · pinned versions, immutable", the decision form "pinned evidence", the summary "Evidence pinned with sha256".
PNGs `1440-workspace-T3-note-item-selected.png`, `1440-workspace-T3-pinned.png`, `1440-dossier-top.png`.
Why it costs: three names for one concept and a hash as confirmation; a first-time user does not connect "Pin" with
"this becomes E1 that the decision can cite".
Heuristic: H2 Match between system and the real world / H4 Consistency. Severity **2**.
Smallest fix: label the button "Pin as evidence", toast "Pinned as E1 (v1)", and offer the same button in the entity
Notes tab row so the anchored note can be pinned where it was written.

### 7. [friction] Suggestions strip @ both widths — "Confirm all" without showing what is being confirmed
What happens: the Suggestions tab shows only `role · agent 1 ✓ Confirm all ✕ Reject all` / `tag · agent 1 …`
(`1440-workspace-strip-suggestions.png`); the entity, value and the agent's reason are visible only after selecting
the node (`1440-workspace-node-selected.png` shows "role: mule · suggested by agent — Receives from 6 accounts…").
Why it costs: bulk-confirming agent output blind is the opposite of the four-eyes intent of the feature.
Heuristic: H6 Recognition rather than recall / H5 Error prevention. Severity **2**.
Smallest fix: list the suggestions (entity · value · reason, one line each) under the group header; keep "Confirm all".

### 8. [layout] Queue @ both widths — a long title collapses the CASE column to one word per line (row 495 px tall)
What happens: 140-char title + 30-char tag: the first column shrinks to ~70 px, the title wraps one word per line
and the id/tag line breaks mid-token; `investigation-row-q-long` height **495 px** at both widths while the
ASSIGNEE column keeps a 60-char e-mail on two lines (`1440-queue.json`, `1024-queue.json` → `long.rowH`).
PNGs `1440-queue-long-names.png`, `1024-queue-long-names.png`.
Heuristic: H8. Severity **2**.
Smallest fix: `th.case { width: 32%; min-width: 220px }` and `overflow-wrap: anywhere` on the id/tag line; let the
e-mail truncate with a `title`.

### 9. [a11y] Material list @ both widths — 24 click targets under 24×24 px per screen
What happens: per row remove **11×19**, pin **16×19**, canvas checkbox **13×13**, open-exploration **26×14**, query
expand **10×19**, run **13×19**; plus `chips-clear`, task checkboxes 13×13, the ⚠ chips 12×12, settings-drawer
checkboxes 13×13 (34 small targets in the populated workspace, `1440-workspace-states.json` → `populated.small`).
Heuristic: H7 Flexibility and efficiency of use (motor accessibility). Severity **2**.
Smallest fix: one rule in `CaseItemsPanel.vue` (`.row .actions button { min-width:24px; min-height:24px }`) and
`input[type=checkbox] { width:16px; height:16px }` in `main.css` for the case surfaces.

### 10. [confuses] Error messages are the raw server string
What happens: queue 500 → "boom Retry" under counters that read 0/0/0 (`1440-queue-error.png`); case 500 → a bare page
"boom · Retry · ← Queue" (`1440-workspace-error-case.png`); title save 500 → toast "boom" and the title silently
reverts (`1440-workspace-error-save-title.png`); note save 500 → the word "boom" appears in small red text under
*Tags*, 260 px above the "Add note" button that was pressed, no toast (`1440-workspace-error-save-note.png`,
`error-save-note.toast: []`).
Heuristic: H9. Severity **2**.
Smallest fix: one `describeError(e)` helper ("Could not load the queue (HTTP 500). Retry") used by the four sites, and
put the note error next to `note-add`. The counters should show "—" while the list has failed.

### 11. [friction] Bottom strip and panels — nothing is resizable or persistent
What happens: dragging the material-list border, the inspector border, the Filters panel edge or title, and the strip
edge changes nothing (`1440-keyboard-contrast-drag.json` → `drag`: every before/after rect identical, cursor `pointer`
or `auto`, no element with `resize` ≠ none). The strip's expanded state does not survive a reload
(`strip-collapse-persist.afterReloadFromExpanded: "strip collapsed"`; `timelineCollapsed = ref(true)` in the view with
no storage). The Tasks strip takes 207 px (of 580 px canvas at 1440, of 349 px at 1024).
Heuristic: H7. Severity **1** (2 at 1024).
Smallest fix: persist `timelineCollapsed` and `timelineTab` in `localStorage` per case like `CaseItemsPanel` already
does for its groups; a drag handle on the strip is a later step.

### 12. [a11y] Muted 12 px text on the page background is 4.3:1
What happens: `.muted` 12 px `#6c757d` on `#f5f5f5` = **4.30** (header "Type / Assignee / Tags" labels); the same
colour on white is 4.69 and the status bar 4.69 (`1440-keyboard-contrast-drag.json` → `contrast.text`). Tooltips are
the only explanation for ⚙ (`title` "Case settings") and "…" ("More actions"), which is fine since both have
`aria-label`.
Heuristic: H8 / WCAG 1.4.3. Severity **1**.
Smallest fix: `--color-text-muted: #5f6b76` in `main.css` (5.0:1 on `#f5f5f5`).

### 13. [polish] Node hover tooltip stays painted on top of the settings drawer and the Add dialog
What happens: the WebGL hover card "a1@ctx-a · Person" remains visible over the modal in
`1024-workspace-settings-drawer.png`, `1024-workspace-add-popover.png` and `1440-workspace-decide-filled.png`.
Heuristic: H8. Severity **1**. Smallest fix: hide the tooltip on `mouseleave` of the canvas / when any overlay opens.

## Measurements

### Canvas, columns, strips (populated case unless noted)

| width | state | graph-container (x,y,w×h) | material list | inspector | chip strip | legend strip | analysis bar | strip (collapsed) | PNG |
|---|---|---|---|---|---|---|---|---|---|
| 1440 | no panel | 290,240 · **830×580** | 0,126 · 290×694 | 1120,126 · 320×694 | 290,199 · 830×40 | 302,132 · 361×27 | 302,783 · 806×25 | 0,820 · 1440×48 | 1440-workspace-populated.png |
| 1440 | Filters open | 830×580 (overlay 302,252 · 320×519, bottom 771) | | | | | bar top 783 → no overlap | | 1440-workspace-panel-filters.png |
| 1440 | Look open | 830×580 (overlay 788,252 · 320×519) | | | | | no overlap | | 1440-workspace-panel-look.png |
| 1440 | Layout open | 830×580 (panel 314,−20 · 240×750, absolute) | | | | | covers nav + header | | 1440-workspace-panel-layout-measured.png |
| 1440 | Table drawer | 290,240 · 830×303 (drawer 830×277) | | | | | 302,505 | | 1440-workspace-panel-table.png |
| 1440 | 8 graphs, all | 290,298 · 830×522 | scrollH 1705 / 694 | | 290,258 · 830×40 | 302,132 · 806×**86** (2 rows) | | | 1440-workspace-many-all.png |
| 1440 | 140-char title | 290,279 · 830×540 | | | | | header 114 px (vs 74) | | 1440-workspace-long-names.png |
| 1440 | Tasks strip open | 830×422 | | | | | | 0,661 · 1440×207 | 1440-workspace-strip-tasks.png |
| 1024 | no panel | 290,271 · **414×349** | 0,126 · 290×494 | 704,126 · 320×494 | 290,231 · 414×40 | 2 rows | 302,552 · 390×**56** (2 rows) | 0,620 · 1024×48 | 1024-workspace-populated.png |
| 1024 | Filters open | 414×349 (overlay 302,283 · 320×257, bottom 540) | | | | | bar top 552 → no overlap, 12 px gap | | 1024-workspace-many-filters.png |
| 1024 | Look open | 414×349 (overlay 372,283 · 320×257) | | | | | no overlap | | 1024-workspace-panel-look.png |
| 1024 | Layout open | 414×349 (panel 314,**−82** · 240×550) | | | | | covers nav, header, toolbar | | 1024-workspace-panel-layout-measured.png |
| 1024 | 8 graphs, all | 290,403 · **414×216** | scrollH 1705 / 494 | | 290,363 · 414×40 | 302,132 · 390×**160** (4 rows) | | | 1024-workspace-many-all.png |
| 1024 | 140-char title | 290,443 · **414×177** | | | | | header **213 px** | | 1024-workspace-long-names.png |
| 1024 | Tasks strip open | 414×**191** (bar 390×56 inside it) | | | | | | 0,461 · 1024×207 | 1024-workspace-strip-tasks.png |

Horizontal overflow (`documentElement.scrollWidth > clientWidth`): **false** on every captured state at both widths
(queue empty/populated/many/long/error; workspace empty/populated/many/long; dossier) — offenders list empty.

Clipping inside the 290/320 columns (`scrollWidth > clientWidth`): only `span.title` in the material list, with
`text-overflow: ellipsis` and a `title` attribute — "Bank A transfers" 96→78 px, "Source graph 1 · bank A" 136→78 px,
100-char titles 646→78 px. Nothing clipped in the inspector (`clipped: []` with a node selected, with a 100-char note
title the inspector heading wraps with `overflow-wrap`). The header title is never truncated: it wraps the whole
header (114 px at 1440, 213 px at 1024).

Overlay panel bottom vs analysis bar: Filters/Look/Clusters bottom = 771 (bar top 783) at 1440, 540 (bar top 552) at
1024 → no overlap at either width.

### Click targets under 24×24 px (populated case, 1440; identical at 1024)

| area | control | size |
|---|---|---|
| header | `← Queue` link | 49×19 |
| header | `case-status` select, `case-type` select | 97×23, 80×21 |
| header | `case-decide` | 61×23 |
| material | `items-add`, `brief-edit` | 59×23, 34×19 |
| material | `item-canvas-*` checkbox | **13×13** |
| material | `item-open-exploration-*` | 26×**14** |
| material | `item-pin-*` | **16×19** |
| material | `item-remove-*` | **11×19** |
| material | `item-expand-q-1`, `item-run-q-1` | **10×19**, **13×19** |
| material | `item-select-t-1` checkbox | 13×19 |
| material | `compose-note`, `compose-markdown` | 46×19, 76×19 |
| material / legend | `item-error-*`, `legend-error-*` ⚠ | **12×12** |
| inspector | `inspector-decisions-dossier` link | 205×13 |
| inspector (node) | `inspector-role` select 259×19, `inspector-tag-input` 90×18, `suggestion-confirm/reject` 55×19 / 47×19, `inspector-trace`, `inspector-path-from`, `inspector-open-entity`, `inspector-open-details`, `inspector-default-focus` | all 19 px tall |
| inspector (edge) | trace forward/back, open details 109/76/68×19; src/dst buttons 207×21 | |
| chips | `chips-clear` ("✕ 1") | ~40×22 |
| strip Tasks | `task-done-*` checkbox 13×13, `task-cancel-*` 34×19, `task-for` 100×23, `task-add` 41×23 | |
| strip Suggestions | `suggestions-confirm-*` 70×19, `suggestions-reject-*` 62×19 | |
| status bar | `journal-toggle` 41×19, `graph-status-shortcuts` 70×19 | |
| panels | Filters checkboxes 13×13; Look checkboxes 13×13, colour swatches 28×22, sliders 286×4; Table drawer Clear/CSV/Add/Close 48/41/85/34×23 | |
| settings drawer | 13 `settings-suggest-*` checkboxes 13×13 | |
| queue | `sort-*` header buttons 28–62×18; case title links ×14 tall | |
| dossier | export buttons 156×23 | |

### Keyboard (1440, populated)

- Tab ×15 from the page start: brand → Contexts → Explorations → Investigations → current-case chip → ⓘ → user menu →
  ← Queue → title (h1, `outline: solid 2px`) → status select → Dossier → Decide → ⚙ → Share → "…"
  (`1440-workspace-keyboard-tab15.png`). Every one of 40 stops had a visible ring: either `outline: auto 1px` (UA) or
  `box-shadow 0 0 0 3px rgba(20,184,166,.3)` (16 `:focus-visible` rules in the stylesheets).
- Inspector tabs: not reached in 40 Tabs from the top (the material list has ~6 stops per row) nor in 25 Tabs starting
  at the inspector title (focus goes to the header/material first — the inspector is after the canvas in DOM order and
  the walk never got there). The tab buttons have **no `role="tab"` / `aria-selected`**.
- Escape: closes the settings drawer **yes**, the Add popover **yes**, the decision panel **no**.
- Focus on open: settings drawer and Add popover move focus into the dialog (`add-tab-recent`), per `useModalFocus`.

### Contrast (1440, populated + node selected + Decide open)

| text | fg | bg | ratio | size | result |
|---|---|---|---|---|---|
| `.muted` header labels ("Type") | #6c757d | #f5f5f5 (page) | **4.30** | 12 px | fail AA (normal text) |
| `.muted` on cards ("No brief yet.", decision effect) | #6c757d | #ffffff | 4.69 | 13 px | pass |
| status bar "10 nodes 9 edges…" | #6c757d | #ffffff | 4.69 | 12 px | pass |
| deadline badge | #ffffff | #9a3412 | 7.31 | 12 px 600 | pass |
| "● 2 suggestions" badge | #b45309 | #fffbeb | 4.84 | 12 px 600 | pass |
| strip tabs, group heads, `.meta` | #2c3e50 | white/#f5f5f5 | 10–11 | | pass |
| "you" chip | #2c3e50 | #dee2e6 | 8.43 | 11 px | pass |
| placeholders ("Search titles…", "+ tag", "New task") | #2c3e50 / #000 | #fff | ≥10 | | pass (placeholders are as dark as values, so they read as values) |

### Direct manipulation (1440)

| tried | cursor at the edge | result |
|---|---|---|
| drag material-list right border (x 290) +80 px | `pointer` (canvas) | no change (290×535 before/after) |
| drag inspector left border (x 1120) −80 px | `auto` | no change (320 px) |
| drag Filters panel right edge +80 px | `pointer` (canvas) | no change (320×361) |
| drag Filters panel title | `auto` | no change (not movable) |
| drag strip top edge −120 px | `pointer` (canvas) | no change (207 px) |
| elements with `resize` ≠ none or `draggable` | — | none (only anchors report `draggable`) |
| strip collapse → reload | — | collapsed (default) |
| strip expand (Tasks) → reload | — | **collapsed again** — state not kept |
| material-list group collapse | — | kept (`localStorage`, `CaseItemsPanel.vue:28`) |
| canvas pick (one graph / all) | — | kept (`state.canvas_items`, verified by the existing UX-1 test) |

### Queue

| state | 1440 | 1024 | note |
|---|---|---|---|
| empty | `1440-queue-empty.png` | `1024-queue-empty.png` | "No cases — Create a case and add…" with no button in the card; `+ New case` is top-right; counters 0 |
| populated (8 active) | `1440-queue-populated.png` | `1024-queue-populated.png` | columns CASE/TYPE/MATERIAL/SUGGESTIONS/STATUS/ASSIGNEE/DEADLINE/UPDATED/CREATED; 1024 drops nothing but the DEADLINE bar is cut by the card edge |
| many (60 → 50 + 10) | `1440-queue-many.png`, `-many-pager.png`, `-many-page2.png` | same | pager at y 3686 (below 50 rows), "1–50 of 60" → Next → "51–60 of 60", URL `?page=2`, scroll reset to 272 |
| long names | `1440-queue-long-names.png` | `1024-queue-long-names.png` | row 495 px (finding 8) |
| error | `1440-queue-error.png` | `1024-queue-error.png` | "boom Retry"; counters show 0 (finding 10) |

## Task walks (populated case, 1440; 1024 noted where different)

### T1 · open the case and read its state in 10 s (`1440-workspace-populated.png`)
| what | visible without scrolling | label | note |
|---|---|---|---|
| status | yes — `case-status` select "In analysis" | clear | editable select, 97×23 |
| deadline | yes — badge "⏱ analysis · 6 d", title "Due 16/11/2026 (2160 h of SLA since the alert)" | clear | urgency only by colour (dark red) + tooltip |
| who | "Assignee ana@test.com" chip; owner not shown on the first screen (only in ⚙ → Members) | ok | |
| pending | "● 2 suggestions" badge + MATERIAL "2 suggested" + strip "● 2 suggestions" + status bar "● 2 suggestions" | **four copies** of the same count | Tasks · 2 only in the collapsed strip |
| on canvas | legend "Bank A transfers / Bank B transfers / All graphs (2)", status "10 nodes 9 edges 1 source" | clear | |
| decisions | "DECISIONS SO FAR — D1 · Keep monitoring" in the inspector (only while nothing is selected) | clear | |
| brief | "★ Brief — No brief yet. Write" | clear | |
Verdict: the first screen answers status/deadline/who/pending/canvas. Costs: the suggestion count repeated four
times, "Open" sitting inside the status select as an option looks like a second status word (header text
"In analysis\nOpen"), and at 1024 the same information takes 5 rows before the canvas.

### T3 · write an evidence note on a selected entity, pin it (`1440-workspace-notes-add-form.png` → `-T3-note-added.png` → `-T3-note-item-selected.png` → `-T3-pinned.png`)
1. Click node "Ana Souza" → inspector shows Person · a1, Role select, Tags, the agent's suggestion card, tabs
   Data / Items (2) / Enrichment / Notes (1) / Origin. Visible, clear.
2. Notes tab → textarea "Add a note…" + **Add note** (disabled until text). Visible (y 552 of 900; at 1024 y 552 of 700,
   inside the scrolling inspector). Feedback after Add: the note appears in the list, "Notes (2)", Journal · 1, the
   material list gains "N3". No toast — acceptable, the list is right there.
3. Pin: not offered in the Notes tab. Path: material list → N3 → details → **Pin** (no tooltip) → toast
   "Pinned · hash eeeeeeee", button becomes "📌 Pinned", row shows "v1". The dossier then lists it as E1.
4. Link to an item: no control for it on a note ("Items (3)" tab on the entity lists citing items automatically).
Verdict: completes, but step 3 is a detour with the wrong vocabulary (finding 6).

### T4 · filter the canvas and come back (`1440-workspace-T4-role-menu.png` → `-T4-filtered.png` → `-T4-cleared.png`)
1. role ▾ → menu mule / victim / beneficiary (checkboxes). Visible, clear.
2. Check "mule" → chip "role: mule ▾", "✕ 1" appears, **canvas empty, status still 10 nodes** (finding 2).
3. Return: "✕ 1" (title "Clear every filter") restores 10 nodes; or uncheck in the menu. No undo, no "Showing only"
   text. `views ▾` can save/apply a named view (seen in the existing F4 test), not a "previous state".
4. "Show only this graph" (`item-only-*`, 25×19, hover-only) is the per-graph variant; it is a canvas pick, cleared
   by "All graphs (2)".
Verdict: completes; the empty-result state is the problem.

### T5 · record a decision and export (`1440-workspace-decide-mode.png` → `-decide-filled.png` → `-decide-recorded.png` → `1440-dossier-decisions-exports.png`)
1. **Decide** (61×23, primary) → inspector becomes "Decision · Record the decision": 1 · Outcome (free text +
   "Closes the case"), 2 · About (checked entity, only when a node is selected), Rationale (pre-filled with the pinned
   evidence when E1 exists — seen at 1024), Reviewer optional, Cancel / **Record decision** (disabled until outcome +
   rationale). Record button at y 606/900 and 606/700 → visible at both widths; the hint "The case stays open. The
   decision is hashed…" sits below it. Labels clear. Escape does not cancel.
2. Record → nothing (finding 3). The dossier shows D2 with "0 pinned version(s) · hash ffff…beef" (the mock does not
   attach evidence; not counted).
3. Dossier → Decisions card: **JSON package**, **CSV**, **Print report** (156×23 each) → downloads
   `investigation-inv-p.json` / `.csv`, `window.print()` called; no toast for any of the three. "Draft report" and the
   template select are absent for the General type (only case types with templates show them) — nothing explains that.
Verdict: completes; feedback missing after Record and after the exports (a download is its own feedback; print is not).

## Checked and found correct
- No horizontal overflow on any state at 1440 or 1024; overlay panels never overlap the analysis bar.
- Read-only states: closed case shows "Closed by a decision: read only. Reopen it from the … menu to change it."
  and hides Decide/Add/remove/pin; viewer share shows "Read only: shared with you as a viewer.", hides
  Decide/Add/Share, disables the Role select and hides the note form (`*-workspace-readonly-*.png`). ⚙ stays visible
  for a viewer (opens the settings drawer; its Save is at y 1137 — not checked whether it is disabled).
- Empty case: both the material list and the canvas say what to do and offer "+ Add exploration"
  (`1440-workspace-empty.png`).
- Case load error offers Retry and ← Queue; queue error offers Retry.
- Escape closes the settings drawer and the Add popover; focus moves into both; Add popover tabs
  My recent / New exploration / Query / File / Paste · link; "Add 0" disabled until a pick.
- Remove → Undo toast and "Removed" restore (existing UX-1 test), pin → "📌 Pinned", versions row.
- Keyboard focus ring visible on all 40 stops; `aria-label` on ⚙ and "…"; `aria-pressed` on the toolbar toggles.
- Dossier sections (Summary, Hypotheses, Evidence, Notes and documents, Findings, Tasks, Journal, Material,
  Decisions) and the Canvas/Dossier toggle in the header; exports download with the case id in the filename.
- Queue paging writes `?page=2` and keeps filters; the long title and e-mail do not overflow the document.
- Contrast of every badge, chip, tab and placeholder measured ≥ 4.69 except the one case in finding 12.

## Could not check, and why
- 390 px width: excluded from scope by the coordinator.
- Loading state (`case-loading`, `investigations-loading`): the mock answers instantly; never on screen long enough
  to capture.
- Inspector tabs by keyboard: the 40-Tab walk never left the header/material list, so whether the tabs are focusable
  at all was not observed (they are plain `<button>`s, so presumably yes; they lack `role="tab"`).
- Table drawer at 1024: the click on `workspace-table-btn` timed out because the Layout panel covered it (finding 1);
  the drawer was captured at 1440 only (`1440-workspace-panel-table.png`).
- "Draft report" / template select: absent for the General case type in this seed; the flow with a typed case is
  covered by the existing `investigations.spec.ts` but was not captured here.
- Whether the viewer's settings drawer Save is disabled: the button sits at y 1137 inside the drawer; not scrolled to.
- Four-eyes review (Approve/Reject in the dossier) and the decision-proposal badge: not seeded.
