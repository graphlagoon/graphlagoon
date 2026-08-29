# UX & Information-Architecture Review (2026-08-28)

A read-through of the Vue frontend (`Toolbar.vue`, `GraphVisualizationView.vue`,
the 14 side panels, 23 modals, the router) plus the generated docs screenshots,
looking for what makes the interface harder to use or harder to reason about
than it needs to be. Findings are numbered so the decision log and future PRs
can point at them. **Quick wins** were implemented in the same change as this
document; the rest is a backlog with a recommended order.

## 1. Organization / information architecture

| # | Finding | Status |
|---|---------|--------|
| 1 | **Two toolbars with mixed roles.** Top bar: 11 panel toggles in four groups (Explore / Visualize / Config / File) + Export / About / user. A second toolbar floats over the canvas: Info, Layout, Clusters (n), 3D/2D, Fullscreen, Table, Console. *Info* and *Layout* are panels like the top-bar ones; *Table* and *Console* are bottom drawers. Nothing tells the user why a feature lives where it does. | backlog (structural) |
| 2 | **"Query" meant three things at once**: top `Query` (graph query, Cypher/SQL), bottom `Query` (tabular Query Console), and `Templates`. The empty canvas said "Run a query" without saying which. | **fixed**: bottom button is now `Console`; empty state names the top-bar *Query* and *Template* buttons and mentions right-click |
| 3 | **"Clusters" has two entry points**: top → `ClusterProgramPanel` (tabs Communities / Programs / Similarity), bottom → `ClusterListPanel` (the generated clusters). The Similarity tab has no header of its own. | backlog: fold the list into a *Results* tab of the Clusters panel |
| 4 | **Panels were not exclusive.** The nine top-bar panels were independent booleans; all could be open at once, docked side by side on the left, squeezing the canvas (Filters + Style + Labels = 780 px). | **fixed**: the nine share one dock — opening one closes the other (`setDocked`/`toggleDocked` in the view). Floating panels (Info, Layout, cluster list) and the bottom drawers are unaffected |
| 5 | **Names drift between button, heading and component**: Style / "Style" / `AestheticsPanel`; Labels / "Labels" / `TextFormatPanel`; Query / "Graph Query"; Metrics / "Graph Metrics"; `LayoutPanel` used `<h4>` where every other panel uses `<h3>`. | **fixed** for headings (Query, Metrics, Layout `<h3>`); component file names left alone (rename is churn without user value) |
| 6 | **Saving an exploration** lived only in the top-bar File group; the italic `Unsaved` in the breadcrumb was inert text; there was no *modified since save* state at all; and the Explorations page could open / share / delete but not rename. | **fixed**: the save state *is* the control — `Unsaved` and the exploration name are buttons that open the Save dialog, and an open exploration turns amber with a dot once the view no longer matches what was saved (`graphStore.isExplorationDirty`). The list gained **Rename**. Creating stays on the graph page by design (an exploration captures a view) |
| 7 | Below 1600 px the top bar drops every label: 11 icon-only buttons whose meaning is tooltip-only. | mitigated by the responsive pass; disappears with a left rail (see §4) |
| 8 | While a query ran, the whole centre of the top bar was replaced by a spinner — every panel toggle vanished mid-query. | **fixed**: toggles stay; the spinner sits in the right group next to Export |

## 2. Interaction / feedback

| # | Finding | Status |
|---|---------|--------|
| 9 | **`window.confirm()` for every destructive action** (11 call sites: presets, metrics, label rules, cluster programs, precomputed graphs, clusters, explorations, contexts, admin). It blocks the event loop, cannot be styled, and drops the user out of native fullscreen. | **fixed**: `ConfirmDialog.vue` + `useConfirm()` (`confirmAction()` returns a promise); every site now states what is lost, focuses *Cancel* for destructive questions, and closes on Escape / backdrop |
| 10 | **Keyboard shortcuts were invisible**: Escape, Space+L, Space+C, Shift (blower), Ctrl (vacuum), Alt+scroll (clipping plane), axis rotation — partially in the canvas hint strip, listed nowhere. | **fixed**: single source `src/utils/shortcuts.ts`; canvas strip + About → *Graph shortcuts*; the strip collapses to a `? Shortcuts` chip (tooltip = full list) under 1400 px instead of disappearing |
| 11 | **Right-click is never advertised** on the canvas; hints were buried in Behaviors, Layout and a post-failure toast. | **fixed**: first item of the hint strip and of the empty-state text |
| 12 | Status-bar chips (`truncated`, `style not applied`, `template not run`, `layout setting not applied`) explained themselves only via `title`. | **fixed**: they are buttons that open the panel that can fix them (Behaviors / Style / Templates / Layout) |
| 13 | `aria-pressed` on the top-bar toggles but not on the canvas toolbar; the 3D/2D segmented control had no group label. | **fixed** |
| 14 | ~1200 hard-coded hex literals despite a token system (`--color-*`), `var(--x, #ddd)` fallbacks everywhere, `.dev-link { color: #f59e0b !important }`. | `.dev-link` tokenised; rest backlog (stylelint `color-no-hex` + gradual removal of fallbacks) |

## 2b. Responsiveness of the rest of the app

Measured with a probe over `/contexts`, `/explorations`, `/admin` and the
create-context modal at 1440 / 1024 / 768 / 390 px. Desktop widths were clean;
the phone width was not:

| # | Finding | Status |
|---|---------|--------|
| 15 | `.list-item` rows put their actions (Open / Check schema / Edit / Share / Delete) in a non-wrapping flex row: at 390 px they ran to 626 px, so the whole document scrolled sideways. | **fixed**: `.list-item` and `.list-item-actions` wrap; the content column has `flex: 1 1 240px; min-width: 0` |
| 16 | `.modal { min-width: 400px; max-width: 90vw }` — `min-width` beats `max-width` in CSS, so every modal was wider than any viewport below ~445 px. | **fixed**: `min-width: min(400px, 100%)` and the overlay gained padding so dialogs never touch the edges |
| 17 | Under 768 px the toolbar's left group kept its content width and slid *under* the right group (About / user menu unreachable, "Admin" printed under the ⓘ button). | **fixed**: the left group gets `min-width: 0` and scrolls; below 520 px the decorative separators go and the nav padding tightens |

## 2c. Visual audit of the panels (screenshots at 1280×800)

Every panel was opened and looked at, not just tested:

| # | Finding | Status |
|---|---------|--------|
| 18 | The dev FPS overlay (`useDevPerf`) sat at `top:4px; left:4px` with `z-index: 9999; pointer-events: auto` — on top of the floating panels that open in that very corner. It silently ate clicks: the Layout panel's close button could not be pressed in `make dev`. | **fixed**: `pointer-events: none` and `z-index: 15` (above the canvas, below the panels). `horizontal: true` already shows every stats panel, so click-to-cycle was not needed |
| 19 | `LayoutPanel` was the only panel in the app with no close button — you had to find the toolbar button that opened it. | **fixed**: an X next to the help icon, wired to the same state |
| 20 | Context Info broke ordinary words mid-token (`word-break: break-all` rendered "the produc / ts that connect them"). | **fixed**: `word-break: normal; overflow-wrap: anywhere` — long ids still break, prose does not |
| 21 | The Metrics panel's "Visual Mapping" tab wrapped to two lines, making that tab taller than its two neighbours. | **fixed**: `white-space: nowrap` with tighter padding; the row fits |

## 2d. Interaction states (selection, context menu, table, node details)

| # | Finding | Status |
|---|---------|--------|
| 22 | The Query panel's transpiler option rendered as `Trust transpiled SQL(trust the experimental gsql2rsql )` — two spans glued together inside a flex label, and the hint only repeated the label instead of saying what the box does. | **fixed**: the explanation is a paragraph under the checkbox and says what happens when it is on and when to turn it off |
| 23 | In Node Details, `border-bottom: 1px dotted` on a `flex: 1` value stretched the dotted line across the whole row, so every metric read like an empty form field. | **fixed**: `text-decoration: underline dotted`, which hugs the text |

Checked and found correct (no change): the right-click menu, the Data Table
and its filter popover, and node selection — clicking a node *does* open Node
Details; an earlier screenshot that seemed to show otherwise was a mis-aimed
click, confirmed by measuring the panel's rect.

## 3. Remaining backlog, in order

1. **Clusters results tab** (#3) — fold `ClusterListPanel` into a *Results* tab of the Clusters panel so "Clusters" is one place.
3. **Colour lint** (#14) — stylelint `color-no-hex` over `src/**/*.vue`, then remove the `var(--x, #ddd)` fallbacks file by file.
4. **Undo for deletes** — now that confirmations are in-app, a toast with *Undo* is a better trade than a dialog for the cheap ones (a label rule, a cluster).

Done since this review was written: #9 (confirm dialog), #4 (panel exclusivity),
#15–#17 (phone-width responsiveness of the list pages, modals and toolbar),
#6 (save state as a control, rename in the list), #18–#21 (panel chrome found
by looking at every panel), #22–#23 (interaction states).

## 4. Structural proposal (bigger change, needs a design pass)

Replace the two toolbars with **one vertical rail on the left** (icon + label,
never icon-only), grouped:

- **Explore** — Filters, Query, Templates
- **Visualize** — Style, Labels, Metrics, Clusters (with the results tab)
- **Layout** — Layout, Behaviors, Info
- **Data** — Table, Console
- (superuser) Precomputed

The rail opens one panel at a time in a single dock next to it; the canvas
keeps only 3D/2D, Fullscreen and the status bar. Findings #1, #4, #7 and most
of #5 disappear together, and the responsive rules become trivial (the rail
collapses to icons only under ~900 px and gains a label tooltip there).

## 5. Out of scope here

Admin area (operator-only; see [admin-area.md](./admin-area.md)), the login
page, and the dev generator.
