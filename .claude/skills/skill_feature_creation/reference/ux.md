# Improving an existing feature or its UX

Use this when the task is "make X better / clearer / nicer", a UX or visual
pass, or any change to a screen users already know. The seven steps of
SKILL.md still apply; this file replaces how steps 1, 2 and 6 are done.

## Contents
- The loop
- Look first
- What to look for
- Fixing
- House rules for UI
- Recording findings

## The loop

```
look at the real screen → list findings → pick by impact → fix one cluster
        ↑                                                        │
        └──────── look again at the same screens ◄───────────────┘
```

Stop when a fresh look finds nothing that blocks or confuses a task, or
after three rounds — then list what remains as backlog instead of polishing
further. A finding you cannot reproduce on screen is not a finding.

## Look first

Reading components is not reviewing UX: every finding in
`docs/dev/ux-review.md` that mattered was found by opening the screen.
Capture before changing anything, so "after" has something to be compared to.

A throwaway Playwright probe is the cheapest way (API mocks, no backend).
Create `frontend/e2e/tests/_ux-probe.spec.ts`, do not commit it:

```typescript
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts } from '../helpers/api-mocks';

for (const [w, h] of [[1440, 900], [1024, 700], [390, 844]] as const) {
  test(`probe ${w}`, async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);
    await expect(page.getByTestId('graph-status-bar')).toBeVisible({ timeout: 15_000 });
    // open the panel / modal / state under review here
    await page.screenshot({ path: `test-results/ux/${w}-before.png` });
  });
}
```

```bash
cd frontend && npx playwright test -c e2e/playwright.config.ts tests/_ux-probe.spec.ts --reporter=line --trace off
```

Then Read the PNGs. `test-results/` is git-ignored. For a richer graph use
`e2e/fixtures/screenshot-graph.ts`; for overflow measurement copy
`assertNoHorizontalOverflow` from `e2e/tests/responsive-layout.spec.ts`.
When a click seems to do nothing, measure the element's rect before
concluding the UI is broken — a mis-aimed click looks the same.

Capture every state of the surface, not only the populated one: empty,
loading, error, no permission, long names, many items, narrow width.

## What to look for

In order of how much they cost the user:

1. **Can the task be completed, and is the next step obvious?** Dead ends,
   actions with no feedback, results that appear somewhere unexpected.
2. **Does the screen say what it is and what state it is in?** One name per
   concept across button, heading, tooltip and docs; modified/unsaved,
   running, filtered ("Showing only: …") states visible and clearable.
3. **Errors and empties.** The message names what failed and what to do; an
   empty state is an instruction, not a blank; a hidden (no-permission)
   action leaves an explanation behind.
4. **Friction.** Confirmation where undo would do; steps forced into a
   sequence the task does not have; controls that hide the shape of the
   whole form; options nobody needs.
5. **Layout.** Nothing past the viewport, nothing overlapping or clipped,
   canvas not squeezed by panels, consistent panel chrome (title, help,
   close).
6. **Keyboard and assistive basics.** Focus moves into a modal and back,
   Escape closes, toggles carry `aria-pressed`, controls have accessible
   names, color is not the only signal.
7. **Visual consistency.** Spacing, type scale, color through `--color-*`
   tokens, hover/active/disabled states that stay legible.

Prefer removing or merging over adding. A redesign that adds a third way to
do something is a regression.

## Fixing

- Fix the cause once, at the shared place (a composable, `main.css`, a base
  component), when the same defect shows on several screens.
- Keep behavior unless changing it is the point; a UX pass that silently
  changes what a saved exploration or URL parameter does is a bug.
- Every fix that was a real defect gets a test that would have caught it
  (overflow assertion, focus assertion, a computed-style check, an e2e step).
- Structural changes (navigation, panel model, a new surface) are a design
  decision: propose with a before screenshot and a sketch, get agreement,
  then build. §4 of `docs/dev/ux-review.md` holds the standing proposal.
- After fixing, rerun the probe with `-after.png` names and compare with
  the before set. Then follow gate 4.2: user-visible change → guide text
  and `make docs-screenshots`.

## House rules for UI

- Colors only through tokens in `frontend/src/assets/main.css`
  (`--color-primary`, `--color-surface`, `--color-text-muted`, …). No new hex
  literals, no `var(--x, #abc)` fallbacks.
- `useToast` for feedback; `useConfirm` only for destructive actions the
  app cannot undo — client-side deletes delete immediately and offer Undo.
- Modals: `useModalFocus`, Escape via `useEscapeToCloseModals`; width
  `min(…, 100%)`, never a bare `min-width`.
- One panel open at a time in the dock; a new panel needs a close button
  and a title that matches its toolbar label.
- Long text: `overflow-wrap: anywhere`, not `word-break: break-all`.
- Must hold at 1440, 1024 and 390 px wide.

## Recording findings

Add findings to `docs/dev/ux-review.md` in its table format, continuing the
numbering, with status **fixed** (what and where) or backlog. Rejected
designs go there too with the reason — it saves the next person from
trying them again. The decision-log entry summarizes and points to the
numbers.

For an independent look, spawn the `ux-reviewer` agent (see
`orchestration.md`): it only reports, the main session decides and fixes.
