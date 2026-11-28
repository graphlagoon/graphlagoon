# Rethink mode: what the platform should be, and what it should not build

`/skill_agentic_review rethink <domains> [vs <tools>]`

The review modes ask whether the surface that exists works for an agent.
This mode asks what the surface should be so that one platform serves many
kinds of investigation (card acquiring, credit, log and incident analysis,
…) with an agent doing most of the work, and it ends in a plan. Its main
risk is the opposite of a review's: producing a feature list copied from
other products. The method below exists to prevent that.

## Contents
- The premise to test
- Steps
- The ladder: where a capability belongs
- When an artifact is not enough
- Agents
- The plan

## The premise to test

A case accepts any file, and HTML or SVG renders in a sandboxed frame
(`frontend/src/utils/htmlSandbox.ts`; scripts only when
`GRAPH_LAGOON_INVESTIGATION_HTML_SCRIPTS` is `inline` or `cdn`, never with
network access). So an agent can compute anything it can query and hand the
person a finished visualization without the product having that chart,
timeline or report built in. Much of what other tools ship as features is,
here, something the agent makes on demand.

That holds for **presentation** and fails for **state**. The mode's job is to
find which is which, by trying.

## Steps

1. **Read what is decided.** `docs/dev/plans/investigation/06-plataforma-generica.md`
   (the generic core, the stress tests per domain, "extension by data"),
   `07-ai-first-runtime.md` (open questions on agent autonomy),
   `00-pesquisa-mercado.md` (the capability checklist that already exists),
   `agent-capabilities.md`. A rethink that ignores these repeats them.
2. **Jobs per domain.** For each domain, two investigations written from the
   alert to the decision: what arrives, what data is needed and where it
   lives, what the analyst must establish, what leaves (decision, report,
   action). Use the stress tests in 06 where they exist; ask the user for a
   real example where they do not. A domain with no concrete job is dropped,
   not imagined.
3. **Reference tools.** One research agent per tool, reading its public
   documentation. It returns what an analyst *does* there, step by step, for
   a comparable job, and what the tool's data model forces (fixed schema or
   free, how data gets in, what is shared across cases). Not a feature list.
4. **Capability list.** Merge 2 and 3 into capabilities stated as "the
   investigator can …", each with the domains that need it and the job step
   it serves. Drop any that no job in step 2 uses, however common in other
   tools.
5. **Place each on the ladder** (below), starting at the top.
6. **Try before building.** For every capability placed at "build", an
   agent attempts the job step today, blind, with the probe and an artifact
   (`reference/panel.md`, trial briefing). If it gets there, the capability
   moves up the ladder and what remains is whatever made the attempt slow or
   fragile. This is the step that keeps the plan small.
7. **Plan** (below).

## The ladder: where a capability belongs

Take the first rung that holds.

| Rung | Meaning | What it costs |
|---|---|---|
| 1. Already possible | the agent does it with tools that exist: a query, a table, a note, an uploaded artifact | nothing; at most a playbook so agents do it the same way |
| 2. Org data | a case type, playbook, report template, file mapping, declared source, menu action, style preset | authoring, no code; ask whether an agent can author it (today an agent token cannot write contexts, case types or the library) |
| 3. Missing primitive | a general mechanism that several capabilities in **two or more domains** need | code, once; this is what the plan is made of |
| 4. Domain feature | code that knows about one domain | rejected by default; needs a reason no primitive can meet |

A proposed primitive that serves one domain is a rung-4 feature with a
general name. Name the second domain's job or drop it.

## When an artifact is not enough

An uploaded visualization is a picture of an analysis. It is the right
answer unless the result must be one of these, in which case the gap is a
primitive, not a chart:

- **Found again**: searched, filtered or joined later by a person or another
  agent. An HTML file is opaque to `search_case` and to the graph.
- **Connected**: clicking a point should select the entity, open the
  evidence, or pin it. A sandboxed frame cannot talk to the app.
- **Current**: it should change when the data does. An artifact is a
  snapshot of the day it was made.
- **Confirmed**: a person must accept or reject parts of it as structured
  suggestions, with attribution.
- **Decided on**: it is an input a decision must cite and an audit must
  replay; then the data and the query behind it matter more than the image.
- **Shared across cases**: the same entity or indicator seen in another case
  should surface there.

So the questions for each capability are: is this something to *look at*, or
something the case must *know*? and, if the agent makes the artifact, can it
also record what the case must know with tools that exist (a table item, a
note with pinned evidence, annotations)?

## Agents

| Role | How many | Input | Kept apart because |
|---|---|---|---|
| Tool researcher | one per reference tool | the tool's docs (web), one comparable job | each tool's model should be described in its own terms before comparison |
| Domain analyst | one per domain | 06's stress test or the user's example | someone arguing only for that domain's jobs, so the generic core is tested, not assumed |
| Attempt | one per "build" capability | probe + trial briefing | step 6: evidence that it cannot be done today |
| Refuter | one per surviving primitive | the proposal and the ladder | argues it is rung 1, 2 or 4 |

Placement on the ladder and the plan are yours: one synthesizer, with the
attempts as evidence. No vote. Size: two domains and two tools is about ten
agents; state the count and ask before going beyond that.

## The plan

Written to `docs/dev/plans/investigation/NN-agentic-first.md` (next number),
in the language of the plans beside it:

```
Jobs: per domain, the two investigations, one paragraph each
Reference tools: per tool, what its model makes easy and what it forces (5 lines)
Capability table: capability · domains · rung · evidence (attempt log, doc section)
Not building, and what covers it: capability → rung 1 or 2 answer (playbook, template, artifact)
Primitives, in order: each with the jobs it unlocks in which domains,
  the trial job that will show it works, what it changes in agent policy
  (agent-capabilities.md) and the open question of 07 it answers or raises
Decisions needed from a person: one line each, with the alternatives
```

The plan is a proposal: it is not approved by being written, and nothing is
implemented from this mode.
