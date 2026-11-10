---
name: skill_feature_creation
description: Builds or improves a feature in graphlagoon end to end (FastAPI backend in api/, Vue 3 frontend in frontend/, or both) - scoping, reusing the nearest existing feature, tests, the permission / admin-area / public-docs gates, verification loops, optional subagent coordination, and the decision-log entry. Use when adding or extending user-visible functionality (endpoint, table, setting, panel, modal, 3D canvas behavior), when improving or redesigning an existing feature, and for UX or visual-design passes on existing screens. Not for isolated bug fixes (skill_frontend_debugging) or performance work (skill_perf_profiling).
---

# Feature creation in graphlagoon

Generic engineering practice is assumed. This file holds only what the repo
cannot tell you: the order of work, the checks that prove it, and the gates
that are easy to forget. Open a `reference/` file only when its row applies.

**Improving something that already exists** (a feature, a screen, its UX)?
Same seven steps, but start from `reference/ux.md`: look at the real screen
before reading code, and work in look → fix → look-again rounds.

## Progress checklist

Copy into your first reply and tick as you go:

```
- [ ] 1 Scope: acceptance criteria + what is out of scope
- [ ] 2 Explore: nearest sibling feature found and read
- [ ] 3 Plan: files to touch, one check per criterion
- [ ] 4 Build: vertical slice, test next to each piece, targeted checks green
- [ ] 5 Gates: 2.4b permission · 4.2 public docs · 4.2b admin area
- [ ] 6 Verify: verify.sh green, UI seen working
- [ ] 7 Record: one decision-log entry, commit
```

## 1. Scope

Write the acceptance criteria as observable behavior ("right-click a node →
'Show only this community' hides the rest; survives reload"). Each one must
map to a check you can run in step 6. Build the smallest version that
satisfies them; list in one line the options nobody asked for that you are
skipping. Ask the user only when two readings lead to different data models
or different UX; otherwise pick one and state it.

## 2. Explore before designing

The codebase is the pattern library. Find the feature closest to yours and
read **its** router/service/store/component/test instead of inventing a
shape. Good starting points:

| You are adding | Read first |
|---|---|
| CRUD owned by a context | `routers/query_templates.py` (DB + memory branches), `stores/queryTemplates.ts` |
| Named artifact per context, audited | `routers/style_presets.py` + `services/style_presets.py` |
| Right-click action | use `skill_context_menu_action` |
| Community / cluster behavior | use `skill_community_detection` |
| 3D canvas visual or interaction | `reference/frontend.md` (Canvas3D section) |
| Investigation / case / MCP tool | `docs/dev/admin-area.md` rows for `/api/investigations` |

Also check what already happened: `git log --oneline -15` and
`grep -n '^## \[' docs/dev/decision_log.md | tail -15`, then read only the
entries that touch your area. `docs/dev/technical-debts.md` and
`potential-bugs.md`: grep for your area's keywords, do not read whole.

For a wide search (many files, unknown names) delegate to an Explore
subagent and keep only its conclusion.

## 3. Plan

For anything beyond a one-file change, state before editing: files to create
or modify per layer, the data shape crossing the API, and the check for each
acceptance criterion. Skip the plan when you could describe the diff in one
sentence.

If backend and frontend can proceed in parallel, or the diff will need an
independent review, plan the split now: `reference/orchestration.md`
(contract first, disjoint file ownership, briefing template).

Decisions this repo forces on you — settle them here, not mid-build:

- **Persistence has two modes.** With a database the router gets an
  `AsyncSession`; without one it uses `db/memory_store.py`. A new entity
  needs both branches, plus an Alembic migration (`reference/backend.md`).
- **Where state lives in the frontend.** Pure logic → `utils/` (testable
  without Vue). Reactive wiring → a composable. Cross-view state → a Pinia
  store. Do not grow `stores/graph.ts` (3.4k lines) or `GraphCanvas3D.vue`
  (2.9k lines) when a util or composable can hold the logic.
- **Saved state.** If the feature must survive reload or sharing, decide
  whether it goes in the exploration state, the context, or a case view,
  and add the field to `models/schemas.py` (some models are `extra="forbid"`).

## 4. Build in a vertical slice

Get one thin path working end to end (schema → route → api.ts → store/util →
component) before widening. Write the test for a piece of non-trivial logic
when you write the piece, and run only that test:

```bash
cd api && uv run pytest tests/test_<area>.py -q -p no:cacheprovider
cd frontend && npx vitest run src/<path>/__tests__/<name>.test.ts
cd frontend && npx playwright test -c e2e/playwright.config.ts tests/<spec>.spec.ts --reporter=line --trace off
```

Rules that have bitten before:

- Use what exists the way the surrounding code uses it: `useToast` for
  feedback (never `alert`), `useConfirm`, `usePermissions`, the `_error(...)`
  structured-detail helper in routers, factory fixtures in tests.
- Smallest diff that works. No wrapper, option or config "for later".
  Finish everything the change breaks: callers, fixtures, mocks, types.
- Loop: edit → run the one relevant test → fix, until it passes. A failing
  check is fixed at its cause; never skip, loosen or delete a test to get
  green. After three different failed attempts, stop and report the output.
- Comment only the why the code cannot show, in one line.

Layer detail: `reference/backend.md`, `reference/frontend.md`,
`reference/testing.md`.

## 5. Gates (mandatory, each needs an explicit answer)

Details and tables for all three: `reference/gates.md`.

- **Step 2.4b — Permission.** New user-facing *action* (not a read) that an
  admin might restrict per group? → catalog entry + `require_permission`
  gate + hidden affordance + allow/deny test. Never one without the other.
- **Step 4.2 — Public docs.** Anything a user can see or configure (UI, env
  var, URL parameter, endpoint, Python API)? → update `docs/guide/<page>.md`,
  regenerate screenshots if the UI changed, `make docs-build` passes.
  Otherwise the log entry says **"No public docs impact"**.
- **Step 4.2b — Admin area.** New setting, table, in-memory collection,
  mutating route, router module, audit action or user-owned entity? → update
  the registries (full table: `docs/dev/admin-area.md`, "When to update").
  Otherwise the log entry says **"No admin-area impact"**.

Silence is not an answer for 4.2 and 4.2b.

## 6. Verify

Run from the repo root:

```bash
.claude/skills/skill_feature_creation/verify.sh
```

It looks at what changed against `origin/main` and runs only the matching
checks (the registry/doc-freshness tests, changed pytest files, `vue-tsc`,
the vitest files of changed sources, changed e2e specs, `make docs-build`,
the decision-log gate; ruff as a warning), printing one PASS/FAIL line each
and the ends of any failing log. Loop: fix the first FAIL, rerun, until it
exits 0. If a FAIL is environmental (no browser, missing deps), report it
as such with the log line instead of working around it. Add `--full` once
before a PR to run the whole pytest and vitest suites; CI does **not** run
pytest, so the backend suite is only ever checked locally.

Then prove the behavior, not just the tests:

- UI change → run the app (`make dev`, frontend on :3000) or the e2e spec,
  and look at a screenshot of the feature working. Check the empty, error
  and no-permission states, not only the happy path.
- Cross-page flow → add or update a case in `e2e/tests/user-journeys.spec.ts`.
- Report evidence: the commands you ran and their result lines.

Independent eyes, when the change warrants it (`reference/orchestration.md`
has the prompts and the stop conditions):

- Large or risky diff (auth, permissions, saved state, both persistence
  modes) → a fresh reviewer subagent or `/code-review`, given the diff and
  the acceptance criteria, told to report correctness gaps and skip style.
- UI changed → the `ux-reviewer` agent, which looks at screenshots and
  reports ranked findings.

Confirm each finding yourself before fixing it, rerun `verify.sh` after
fixes, and stop after two review rounds.

## 7. Record and commit

Append **one** entry to `docs/dev/decision_log.md` (template in
`reference/gates.md`). The file is ~14k lines: append to the end, never read
it whole. Update `docs/dev/architecture.md` or `code-patterns.md` only if
you introduced a new major component or a pattern others should copy.

Commit with conventional-commit subjects in English
(`feat(clusters): …`; the commit-msg hook enforces the type). Stage explicit
paths, not `git add -A`. Submodules under `frontend/ext-3d-force/` are
separate repos — see `reference/frontend.md` before touching them.

## Reference files

| File | Open when |
|---|---|
| `reference/backend.md` | adding a schema, table, migration, service, router, setting |
| `reference/frontend.md` | adding types, api.ts methods, stores, components, 3D canvas features, submodule changes |
| `reference/testing.md` | writing vitest / Playwright / pytest tests; a test fails in a way that looks like tooling |
| `reference/gates.md` | steps 2.4b, 4.2, 4.2b and the decision-log entry |
| `reference/ux.md` | improving an existing feature, a UX or visual pass, any change to a screen users already know |
| `reference/orchestration.md` | splitting work across subagents, briefing them, review and verify loops |
