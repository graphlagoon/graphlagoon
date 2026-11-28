---
name: Agentic-first review

description: Reviews graphlagoon as a product whose user is an AI agent - the MCP server, the REST API an agent scripts against, and the decisions behind them (what has a tool, what is suggested, what is human-only, how a person and an agent share a case). Runs blind agent trials against the local MCP server, lens reviews grounded in UX theory, adversarial verification of each finding, and a criteria-scored panel for decisions no test can settle. Also has a rethink mode that turns domains (acquiring, credit, incidents, ...) and reference tools (OpenCTI and others) into a plan of the few generic primitives worth building, after trying each gap with what exists. Use when asked to review, audit or rethink the agent experience, the MCP tools, the API from an agent's point of view, an AI-first / agentic-first design decision, or to compare the platform with other investigation tools and plan what to build. Reports and plans; does not change product code.
---

# Agentic-first review

The user of this surface is a model. It reads `tools/list` instead of a
screen, pays for every character in context, cannot ask a colleague, and
retries. The review asks one question: **can an agent that has never seen
this repo finish a real job here, cheaply, safely, and in a way the person
it acts for can follow?**

Three rules shape everything below.

1. **Evidence before opinion.** A transcript of an agent failing beats five
   reviewers agreeing it might. Run the trials first; reviewers read
   transcripts, not only code.
2. **Independence, not consensus.** Agents share a model and its priors, so
   agreement among them is weak evidence and open debate converges on the
   most persuasive text. Give each agent a different input or a different
   job, keep them from seeing each other's output, and settle disagreements
   by evidence. Voting is used in one place only (step 5).
3. **Report, do not fix.** Output is ranked findings and decision records.
   Implementing an accepted one is a separate task under
   `skill_feature_creation`.

## Arguments and size

`/skill_agentic_review [quick|standard|deep] [focus]`

`focus` narrows the surface: a tool family (`explorations`, `catalog`,
`enrichment`, `tasks`), a job, or a decision ("should styles have tools?").
Without one, review the whole MCP surface.

| Size | What runs | Agents |
|---|---|---|
| `quick` | steps 1, 3 (one session, all lenses), 6. No trials. Say so in the report: findings are unverified by use. | 0 |
| `standard` (default) | steps 1–4 and 6 | 3 trials + 3 lenses + up to 3 refuters |
| `deep` | all steps, 5 trials (two models), judges for each contested decision | ask the user first: 12–20 agents |
| `rethink <domains> [vs <tools>]` | a different procedure, forward-looking, ending in a plan: `reference/rethink.md` | about 10 for two domains and two tools |

## Progress checklist

```
- [ ] 1 Surface: probe output + policy docs read; jobs chosen
- [ ] 2 Trials: blind agents ran the jobs; logs and debriefs collected
- [ ] 3 Lenses: independent reviews, each finding tied to evidence
- [ ] 4 Refute: each finding attacked; survivors ranked
- [ ] 5 Decisions: alternatives scored against criteria; dissent recorded
- [ ] 6 Report: findings, decision records, what each should become
```

## 1. Surface and jobs

Needs the local dev server (`make dev`; agents are on by default). Never
point this at a deployed URL: trials write cases as the token's owner, and
the probe refuses non-local hosts.

```bash
cd api
P=../.claude/skills/skill_agentic_review/mcp_probe.py
export GL_AGENT_TOKEN=$(uv run python $P token)
uv run python $P surface        # instructions, tool count, tools/list size, undescribed params
uv run python $P tools          # one line per tool
```

Read what is already decided, so the review argues with the reasons and not
with a guess at them:

- `docs/dev/plans/investigation/agent-capabilities.md` — the policy in force
  (direct / suggested / never) and where it lives in code.
- `api/graphlagoon/mcp/registry.py` — every tool is the twin of human routes;
  every route without a tool has a reason. Note which routers the registry
  covers: the rest of the product is outside the rule and may have no agent
  path at all.
- `docs/guide/agents-mcp.md` — what users are told.
- `grep -n -i 'agent\|mcp' docs/dev/decision_log.md | tail -40`, then read
  only the entries in your focus. `docs/dev/agentic-review.md` if it exists:
  do not re-report what is listed there as fixed or rejected.

Then choose **jobs**, not endpoints: 3 (standard) or 5 (deep), written as an
outcome a person would ask for, using data that exists in the seed
(`list_cases`, `list_contexts` to pick real ids and names). Cover different
shapes — `reference/panel.md` has the archetypes (orient, work a case, build
a graph, hit a limit, resume someone's work, stale write). Write for each
job what "done" looks like, so a trial can be scored without judgment.

## 2. Blind trials

One fresh agent per job, briefed with the job and the probe commands and
**nothing about the repo** (briefing in `reference/panel.md`). It may not
read source or docs: its only knowledge is what a connected agent gets. Each
trial has its own `GL_PROBE_LOG`. In `deep`, run two of the jobs a second
time on a smaller model (`model: "haiku"`): a weaker reader exposes
affordances that only work when the agent is clever.

Launch them in one message. When they return:

```bash
uv run python $P report <log> <log> ...
```

Per trial you now have: done or not (against your definition, checked by
reading the server state yourself, not by the agent's claim), calls, errors,
exact repeats, characters returned, the call sequence, and the agent's
debrief (where it hesitated, guessed, or gave up). Several trials of one job
are a measurement of variance, not a vote: one failure in three is a
finding.

## 3. Lens reviews

Three reviewers in parallel, each with one lens pair, the probe output, the
trial logs and debriefs, and read access to the code. They do not see each
other. Questions and where to look for each lens: `reference/lenses.md`.

| Reviewer | Lenses | Theory it borrows |
|---|---|---|
| Gulfs | A discoverability · B feedback and recovery | Norman's gulfs of execution and evaluation; cognitive walkthrough; information scent; Nielsen's heuristics |
| Economy and fit | C context economy · D task fit | cognitive load as context budget; progressive disclosure; jobs-to-be-done and task analysis; tools shaped as workflows |
| Authority and shared work | E safety and oversight · F person–agent workspace | levels of automation; mixed-initiative and human-AI guidelines; automation bias; threat modelling; common ground |

Every finding must cite evidence: a line of a trial log, probe output, or
`file:line`. A finding with only an argument behind it is marked
`unobserved` and ranks below any observed one.

## 4. Refute

Merge duplicates, then give each finding (or cluster) to a fresh agent whose
only job is to show it is wrong, already handled, deliberate (find the
decision-log entry), or not worth its cost. Briefing in
`reference/panel.md`. Confirm the survivors yourself: reproduce with the
probe or read the code. Reviewers asked for problems always return some.

Rank survivors by **cost to the agent's job × how often the job hits it**:

```
blocks job > wrong result believed > recoverable error > wasted context/turns > inconsistency > polish
```

## 5. Decisions (only for what no trial can settle)

Some questions are trade-offs, not defects: one tool per route or one per
job; a suggestion or a direct write; more tools or fewer with modes. For
each, write a decision record (`reference/panel.md`): the alternatives
including "leave as is", the criteria and their weights **fixed before
scoring**, what each alternative costs each criterion, and what observation
would change the answer.

`standard`: you score it, and state your confidence. `deep`: three judges
score independently, each given a different stance to argue from (the
agent's cost, the person who reviews the agent's work, the maintainer),
blind to each other. Report the scores and every dissent with its reason.
A split panel is a result — it means the answer depends on a fact you do
not have; name the fact and the trial that would get it. Do not run a
second round to manufacture agreement.

## 6. Report

In the reply, and appended to `docs/dev/agentic-review.md` (create it on the
first run; a table of id, finding, evidence, status `open|fixed|rejected`,
so the next run starts from it):

```
Scope and size: <what was reviewed; what ran; what did not>
Trials: <job → done?, calls, errors, chars returned>   (one line each)

Findings (ranked)
<n>. [blocks job | wrong result | recoverable | wasted context | inconsistency | polish] <tool / flow>
   Evidence: <log line / probe output / file:line>  (observed | unobserved)
   Cost to the agent: <what it does wrong or pays>
   Smallest change: <and what makes it stay fixed: registry rule, test, trial job>

Decisions
<title>: recommended <alternative> (confidence, dissent). Would change if: <observation>.

Checked and fine: <one line each>
Could not check: <one line each, with the reason>
```

A finding is only closed when something enforces it. Prefer, in order: a
rule in `tests/test_agent_registry.py` or `test_app_docs` (the surface
cannot regress), a test in `tests/test_mcp_*.py`, the job kept as a trial to
rerun and compare numbers. Prose advice in a doc is the last resort.

If the dev server cannot be reached, say so with the error line and run
`quick` instead, labelled as such. Do not present a code reading as a trial.

## Reference files

| File | Open when |
|---|---|
| `reference/lenses.md` | step 3, or reviewing one tool by hand: the questions per lens, the theory behind each, where to look |
| `reference/panel.md` | steps 1, 2, 4, 5: job archetypes, the briefings for trial / lens / refuter / judge agents, the decision record, why not a vote |
| `reference/rethink.md` | asked what the platform should become, to compare with other tools, or to plan what to build and what to leave to agents and artifacts |
| `mcp_probe.py` | the shell window on the local MCP server used by you and the trial agents |
