# Coordinating agents and loops

Default is one session doing the work. Agents cost a briefing, a lossy
summary back, and tokens in parallel; use them where that buys something.

## Contents
- When to use an agent
- Splitting a feature
- Briefing template
- Loops and their stop conditions
- Merging results

## When to use an agent

| Situation | Agent | Why |
|---|---|---|
| "Where is X handled / what already exists for Y" across many files | `Explore`, read-only | keeps file dumps out of the main context; you keep the conclusion |
| Feature spans backend and frontend with a settled API contract | one implementer per layer, in parallel | the layers do not share files |
| Several independent screens or panels in a UX pass | one implementer per surface | same |
| Diff is large, touches auth / permissions / saved state, or you are unsure | fresh reviewer given the diff and the acceptance criteria | not anchored on your reasoning |
| UI changed | `ux-reviewer` | looks at screenshots, reports findings only |
| A check you can run yourself, a lookup with a known target, a one-file change | none | delegation costs more than doing it |

Do not run two agents on the same files, and do not redo yourself what you
delegated — wait for the result.

## Splitting a feature

Parallel work needs the seam fixed first. Before spawning:

1. Write the contract in the main session: route paths and methods,
   request/response JSON with field names, error codes, the permission id,
   and the saved-state fields. Put it in the briefing verbatim.
2. Give each agent a disjoint file set. Shared files
   (`models/schemas.py`, `services/api.ts`, `types/graph.ts`, `app.py`,
   `admin_registry.py`, `e2e/helpers/api-mocks.ts`, `decision_log.md`) have
   exactly one owner; others report what they need added.
3. Use `isolation: "worktree"` when agents edit in parallel, and merge in
   the main session.
4. Keep gates, e2e, the decision log and the commit in the main session.

Sequential is better than parallel when the contract is still moving:
backend first with its tests, then frontend against the real shape.

## Briefing template

An agent knows only what the prompt says.

```
Goal: <one sentence, user-visible outcome>
Your part: <layer / surface>. Files you own: <paths>. Do not edit anything else;
  report needed changes to other files instead.
Contract: <routes, JSON shapes, ids — verbatim>
Read first: <the sibling feature files to copy the shape from>
Acceptance criteria for your part:
  - <observable behavior> → check: <exact command>
Rules: smallest diff that works; reuse existing helpers the way nearby code does;
  one small test per piece of non-trivial logic; run only your own test files
  (commands in .claude/skills/skill_feature_creation/reference/testing.md);
  never skip or loosen a test; do not commit.
Stop and report if: a check still fails after three different attempts, or the
  contract turns out to be wrong.
Report back (max 150 words): files changed, commands run with their result lines,
  assumptions made, anything left open.
```

For a reviewer, give the diff range and the criteria, not your conclusions:

```
Review `git diff <base>...HEAD -- <paths>` against these acceptance criteria: <list>.
Report only correctness gaps: unmet criteria, both persistence modes
(DB and memory store), missing permission/ownership checks, saved-state fields
missing from the backend schema, untested branches that can fail. Skip style.
For each: file:line, the concrete failing scenario, and how sure you are.
```

## Loops and their stop conditions

Every loop needs a check that returns pass/fail and a limit.

| Loop | Each round | Done when | Give up when |
|---|---|---|---|
| Build | edit → run the one relevant test file | it passes | three different fixes failed: stop, report the output |
| Verify | `verify.sh` → fix the first FAIL → rerun | exits 0 | a FAIL is environmental (missing browser, no DB): say so with the log line, do not mask it |
| Review | reviewer reports → fix confirmed correctness gaps → rerun `verify.sh` | a round returns no correctness gap | two rounds; remaining items go to the report, not into more code |
| UX | screenshots → findings → fix a cluster → screenshots | a fresh look finds nothing blocking or confusing | three rounds; rest becomes backlog in `ux-review.md` |

Rules for all of them:

- Confirm a reviewer's finding yourself (read the code or reproduce it)
  before fixing. Reviewers asked to find problems always find something;
  fixing everything adds abstraction and tests for cases that cannot happen.
- A round that changes code reruns the checks of the earlier loops.
- Never end a loop by weakening its check.
- For long unattended work on one condition, `/goal <condition>` or `/loop`
  keeps the session going; state the condition as a command result
  ("verify.sh exits 0"), not as a feeling.

## Merging results

Read each agent's diff, not only its summary. Run `verify.sh` on the
merged tree — two parts that pass alone can fail together at the seam
(field names, mock routes, type exports). Then finish steps 5–7 of SKILL.md
once, for the whole feature.
