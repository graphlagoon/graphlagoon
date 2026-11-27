# Organising the agents

## Contents
- Why several agents, and why not a vote
- Job archetypes
- Briefing: trial agent
- Briefing: lens reviewer
- Briefing: refuter
- Decision record and judges
- Stop conditions

## Why several agents, and why not a vote

Several agents help when each one adds something the others cannot:

| Role | What it adds | Why it must be separate |
|---|---|---|
| Trial agent | behaviour of a real first-time user | you have read the code; you can no longer not know how the tools work |
| Lens reviewer | attention on one kind of problem | a reviewer holding six lenses reports the two it thought of first |
| Refuter | a reason the finding is wrong | whoever found it is anchored on it being right |
| Judge with a stance | the cost to one stakeholder, argued fully | a single scorer averages the stakeholders before weighing them |

A vote among agents on "which argument is better" adds little. They run on
the same model, so their errors are correlated: five agreeing is closer to
one opinion sampled five times than to five opinions. Letting them read each
other and debate makes it worse — positions converge on the most fluent
argument, not the most supported one. So:

- Prefer a **measurement** to a judgment: if a trial can settle it, run the
  trial.
- Get diversity from **inputs and roles** (different job, lens, stance,
  model size), not from asking the same question again.
- Keep agents **blind to each other** until you merge.
- Where judgment is all there is (step 5), fix the criteria first, score
  independently, and report the split instead of forcing agreement. This is
  the Delphi and nominal-group idea without the convergence round.
- Agreement of independent finders is a useful *filter* (a problem three
  reviewers reached separately is likelier real), never a *proof*; a single
  observed failure outranks it.

## Job archetypes

Pick jobs from real seeded data and write the done-condition before the
trial. One per shape:

| Shape | Example (fill with real names) | Done when | Mostly tests |
|---|---|---|---|
| Orient | "What data is available about <domain>, and which <entity> has the most <relation>?" | the right number, from a query, not a guess | A, C |
| Work a case | "Case <id>: say what is established and what is open, and record one new finding with its evidence pinned." | a note exists, linked to evidence that supports it | A, B, D |
| Build a graph | "Make an exploration showing <entity> and what is within two hops, with <enrichment> applied, ready for a person to open." | the exploration exists with those nodes and the enrichment columns | D, F |
| Hit a limit | "Close case <id> as <outcome>." | the agent proposed the decision and told the person what is theirs to do; it did not claim the case is closed | E |
| Resume | "Another agent worked on case <id> and stopped. Continue it." (run after a "work a case" trial) | it continued the same thread without redoing or contradicting it | F, B |
| Stale write | "Add <node> to exploration <id>." (you change the exploration between its read and its write) | it noticed, re-read, and applied the edit on the new state | B, F |

## Briefing: trial agent

`subagent_type: general-purpose`. Replace the angle-bracket parts.

```
You are testing a product by using it as a first-time user. You are an agent
connected to an MCP server called graphlagoon. Do the job below using only
that server.

Job: <the job, as a person would ask it>

Your only access is this command, run from <repo>/api (the shell keeps no
variables between calls: put the export in front of every command):
  export GL_AGENT_TOKEN=<token> GL_PROBE_LOG=<absolute log path>
  uv run python ../.claude/skills/skill_agentic_review/mcp_probe.py tools            # list tools
  uv run python ../.claude/skills/skill_agentic_review/mcp_probe.py tools NAME ...   # full definition
  uv run python ../.claude/skills/skill_agentic_review/mcp_probe.py call TOOL '<json>'

Rules: do not read any file in the repository, any documentation, or the
probe's source; do not call the REST API directly unless a tool result tells
you to. What the tools tell you is all you know. Do not work around a
refusal. Stop after 40 calls or when the job is done.

Report back (max 250 words):
1. Outcome: done / partly / not done, and what exists now (ids).
2. The points where you hesitated between tools, guessed a parameter value,
   misread a result, or were surprised — one line each, naming the tool.
3. Anything you needed and could not find.
4. What you would tell the person you work for about what is left for them.
Do not suggest fixes; describe what happened.
```

## Briefing: lens reviewer

```
Review the graphlagoon MCP surface as a product whose user is an AI agent.
Report findings only; change no file.

Your lenses: <two letters and names>. Read their sections in
.claude/skills/skill_agentic_review/reference/lenses.md and stay inside them.

Evidence you have:
- probe output: <path to saved `surface` and `tools` output>
- trial logs and debriefs: <paths>   (jobs and done-conditions: <list>)
- code: api/graphlagoon/mcp/, and the files lenses.md names
Already decided (do not re-report as a defect; you may argue the decision is
worth reopening, with the cost it has now):
  docs/dev/plans/investigation/agent-capabilities.md, <decision-log entries>

For each finding (max 8, most costly first):
  Tool / flow · lens
  Evidence: a trial log line, probe output, or file:line. If you have none,
    write "unobserved" and say which trial would show it.
  Cost to the agent: what it does wrong or pays, concretely.
  Smallest change.
Then: what you checked and found sound (one line each), and any trade-off
that is a decision rather than a defect (name the alternatives, do not pick).
No matters of taste. Three observed findings beat ten plausible ones.
```

## Briefing: refuter

```
Below is a finding from a review of graphlagoon's agent surface. Your job is
to show it should be dropped. Try, in order:
1. It is false: reproduce the claim (the probe is at
   .claude/skills/skill_agentic_review/mcp_probe.py; token and log path:
   <...>) or read the code, and show what actually happens.
2. It is already handled elsewhere, or covered by a test.
3. It is deliberate: find the reason in docs/dev/decision_log.md,
   agent-capabilities.md or mcp/registry.py, and say whether the reason
   still holds.
4. The fix costs more than the problem: what it would break or bloat.
Finding: <verbatim, with its evidence>
Answer: REFUTED / WEAKENED / STANDS, the evidence in at most 120 words, and
if it stands, the strongest version of it.
```

## Decision record and judges

For a trade-off, write this before anyone scores:

```
Decision: <question>
Alternatives: A leave as is · B <...> · C <...>
Criteria and weight (sum 10), fixed now:
  job success for a first-time agent · context cost · safety and reversibility ·
  cost to the person reviewing the agent's work · parity and audit ·
  maintenance (tests, registry, docs that must follow)
Evidence available: <trial results, sizes, existing decisions>
Would change the answer: <the observation, and the trial that produces it>
```

Judge briefing (`deep` only; three judges, one stance each — the agent doing
the job, the person who reviews and answers for the agent's work, the
maintainer of the surface):

```
Score each alternative 1–5 on each criterion in the record below. You argue
from this stance: <stance>; weigh its concerns fully, others will cover the
rest. For every score give the reason in one line, citing the evidence in
the record. Then: your pick, your confidence (low / medium / high), and the
one fact that would change your pick.
<the decision record>
```

Compute weighted totals yourself. Report the table, the picks, and each
dissent with its reason. If the picks split, the recommendation is the
missing fact and how to get it, not the majority.

## Stop conditions

| Loop | Done when | Give up when |
|---|---|---|
| Trials | each job ran once (twice for the two-model jobs) | the server is down or a job cannot be set up: report it, do not replace the trial with a code reading |
| Lens review | three reports in | never rerun a lens to get more findings |
| Refute | every finding has a verdict | one round; a `WEAKENED` finding is reported as weakened |
| Judges | one round of scores | no second round |
