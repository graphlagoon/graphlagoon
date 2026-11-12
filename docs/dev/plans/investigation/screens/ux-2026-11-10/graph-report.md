# UX review · `/graph/<contextId>` side panels (2026-11-10)

Captured by the `ux-reviewer` agent at 1440×900 and 1024×700, API-mocked. PNG names are the
`graph-*.png` files in this folder (the full set of 123 PNGs lived in the session scratchpad; the
numbers are in `graph-measurements.jsonl`). Items already fixed or rejected in
`docs/dev/ux-review.md` (#1–#30) are not repeated.

## Findings, ranked by cost

1. **[blocks task] Filters panel forgets what it hid** — untick *Company* → status `34 nodes 38 edges`
   (`graph-1440-filters-task-company-hidden.png`); close: toggle unpressed, no chip; reopen: all 7 boxes
   `checked=true`, status still 34/38 (`graph-1440-filters-task-reopened.png`). Only *Reset* restores,
   and it also clears search and edge filters. H1/H6, severity 3. Fix: keep the hidden sets in the graph
   store (the panel unmounts with the dock) and show a "Filtered: 1 type hidden ✕" chip in the status bar.
2. **[blocks task] Graph loads at 12 % of the canvas and never fits** — 46 nodes span 172×160 px of
   1440×816 (`fracW 0.12`), unchanged 3 s later; *Fit* → 598×555 (`graph-1440-fit-run0-before.png` /
   `-after.png`). Drawers shrink the canvas without refit: Console at 1024 leaves 208 px
   (`graph-1024-console-populated.png`). H1/H7, severity 3. Fix: `zoomToFit()` on layout done for a
   fresh load and debounced on container resize.
3. **[layout] Top bar at 1024: *Unsaved* is 8 px wide and the toggles paint over the context title** —
   `toolbar-exploration-unsaved` rect 8×20; `elementFromPoint` at the title centre returns the Filters
   icon (`graph-1024-topbar-with-case.png`). H8/H4, severity 3. Fix: `.toolbar-left { flex: 0 1 auto;
   min-width: 0 }`, `.exploration-state { flex-shrink: 0 }`, badge → icon under ~1100 px.
4. **[blocks task] Layout and Context Info float on the same corner; Info covers Layout's close
   button** — Layout `16,70 240×750`, Info `16,68 300×728`; `elementFromPoint(layout-panel-close)` is the
   Info header (`graph-1440-layout+info-populated.png`, `graph-1024-layout+info-populated.png`). H4/H1,
   severity 3. Fix: make the two floaters exclusive with the existing `setDocked` pattern or anchor Info
   on the right.
5. **[confuses] "Add selection to case" vanishes without a case; the side panel never offers it** —
   no-case menu is `Copy ID · Add a linked node… · Expand neighbors · Ego layout · BFS`
   (`graph-1440-case-step2-menu-no-case.png`); with a case the item appears and works
   (`graph-1440-case-step6-menu-with-case.png`, toast `Added to case Golpe Pix · falsa central`,
   `graph-1440-case-step7-toast-single.png`) but the toast has no "view" action. H6/H10, severity 2.
6. **[confuses] No visible selection count; the second add took 2 of 3 nodes silently** — side panel
   still "Node Details" for the last node, status bar unchanged (`graph-1440-case-step8-multi-selected.png`);
   same toast text for 1 or N nodes. H1, severity 2.
7. **[confuses] Type filter and "Show only" don't know about each other** — isolation chip says
   "24 of 46 nodes shown" while the counters stay `46 nodes 77 edges`; Filters → Reset leaves the isolation.
   H4/H1, severity 2.
8. **[layout] Clusters dock width jumps 360 → 177 px on the Similarity tab** and the panel is 720 of
   848 px tall (two-tone dock) (`graph-1440-clusters-results-populated.png`,
   `graph-1440-clusters-similarity-populated.png`). H4/H8, severity 2.
9. **[friction] Bottom drawers take 52–68 % of a 700 px viewport; sizes reset on reload** — Console 440 px →
   canvas 208 px at 1024; resize works (8 px handle, mouse only) but nothing is persisted. H7/H3, severity 2.
10. **[a11y] Escape never closes a docked panel; 9 Tabs to reach the Look tabs; arrows don't switch
    tabs.** H3/H4, severity 2.
11. **[polish] Same query error twice** — modal plus toast `Query failed: Query failed: …`
    (`graph-1440-query-error-modal.png`); one click POSTed twice. Severity 1.
12. **[confuses] Load errors are raw HTTP strings with no way out** — `Failed to load graph — Request
    failed with status code 500`, no button (`graph-1440-no-panel-context-error.png`). Severity 1.
13. **[layout] Long node-type label clipped; Filters panel scrolls sideways** (`graph-1440-filters-long-type.png`). Severity 1.
14. **[polish] Node Details heading wraps to two lines** (`graph-1440-node-details-populated.png`). Severity 1.
15. **[a11y] Sub-24 px targets and low-contrast captions** — checkboxes 13×13, range tracks 4 px,
    `layout-panel-close` 20×20, Templates buttons 22 px tall, `group-eye-*` 19×19, isolation ✕ 18×19;
    Clusters `.help-text` `#999/#f9f9f9 = 2.71`, Look › Labels `.section-hint` 3.54, Behaviors `.hint` 4.11. Severity 1.

## Task walks

**T2 · add an entity to a case** (1440; 1024 identical): fresh page → chip "No current case" (nothing links
it to the graph) → right-click: no case item, no hint → chip menu: search, RECENT, "New case: title", "With a
type…" → pick → chip turns green, localStorage set → right-click: "Add selection to case" 187×29 → toast
"Added to case …", no view link; POST 1 node + style → Ctrl-click ×2, add: same toast, 2 nodes posted →
top-bar "Add to case" not rendered on this page → "No current case" clears. Read-only case: the mock accepted
the POST, so the no-permission path could not be verified.

**T4 · filter and go back** (1440): 46/77 → untick Company 34/38, no chip → close: toggle unpressed, no
badge → reopen: all ticked, still 34/38 → untick KNOWS + search "person": 46/45 → Reset: 46/77, no toast,
no Undo → cluster, right-click "Show only this community" → chip "Showing only: Person Cluster ✕", counters
unchanged → Filters Reset: isolation stays → chip ✕ (18×19): back to 46/77. No generic "Show only this type".

## Measurements

Canvas rect: 1440 none `1440×848`; details `1140×848`; Filters `1190×848`; Look/Query/Templates `1140×848`;
Metrics `1160×848`; Clusters `1080×848` / Similarity `1263×848`; Layout floating `240×750`; Table canvas
`1440×568`, Console `1440×408`. 1024: none `1024×648`; details/Filters/Look `724/774/724×648`, canvas
toolbar wraps to 692×77; Clusters `717×648` / `847×648`; Table `1024×368`, Console `1024×208`.
Horizontal overflow: false in every state. No panel taller than the viewport. Overlaps: Layout×Info,
Layout×canvas toolbar 5 px; legend clipped by a shrunken canvas.
Keyboard order with Filters open: Query→Templates→Look→Metrics→Clusters→Load→chip→Export→About→user→Reset→
Close→search→7 checkboxes→Info→Layout→Table→Fit→3D. `aria-pressed` on all toggles of both toolbars.
Direct manipulation: docked panels no resize/drag; floaters × only; drawers resize yes (Table 280→540,
Console 440→594), persist no (`localStorage` holds only `userEmail`), closed after reload.

## Checked and found correct

Empty state text and counters; loading overlay + top-bar `Loading…`; query-error modal (names the failure,
copy, Escape closes); long names in details/templates/table/title (ellipsis + title); 20 templates / 12
presets / 30 types scroll; case chip menu and reload persistence; context menu and `Showing only` chip ✕;
Table `Add to case (n)`; no horizontal page overflow.

## Could not check

Real 403 for a read-only case or `permissions: []` (mock accepts the POST); 390 px (dropped); fullscreen
floating SidePanel; Precomputed panel (superuser); why the second Ctrl-click in T2 step 8 missed.
