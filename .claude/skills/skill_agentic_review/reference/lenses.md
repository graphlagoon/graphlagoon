# Lenses

Each lens is a UX or engineering theory translated to a user that is a
model. Use the questions as prompts for looking, not as a checklist to fill:
a lens with nothing observed reports "nothing found" in one line.

Where things are: tools and their docstrings in `api/graphlagoon/mcp/server.py`
(the docstring is the description the agent reads); tool↔route twins and
exemptions in `mcp/registry.py`; token scope and the path allowlist in
`middleware/auth.py`; `forbid_agents` in `utils/authz.py`; authorship and
`suggested` in `services/cases.py`; the generated tool reference in
`docs/guide/agents-mcp-tools.md`; the REST spec in `docs/public/openapi.json`.

## A. Discoverability — the gulf of execution

*Norman: the gap between what the user wants and what the system lets them
see they can do. Information foraging (Pirolli and Card): people follow
"scent"; for an agent the scent is the tool name, the first line of its
description, and the server instructions. Hick's law: choice time grows with
the number of options; for a model, selection errors grow with near-duplicate
tools.*

- From `tools/list` alone, is there one obvious first call for each job? Did
  the trials make it, or did they explore first?
- Which tools overlap (several ways to add material, to read a graph, to run
  a query)? Does each description say when to use it *instead of* its
  neighbour? In the trials, did agents pick the general one or the specific
  one, and did it matter?
- Does the name predict the effect? Same verb for the same kind of act
  (`list_`/`get_`/`read_`, `add_`/`create_`), same parameter name for the
  same thing across tools?
- Are prerequisites stated where the agent stands ("needs an id from X")?
  A dependency explained only in a guide page does not exist for the agent.
- Parameters with no description (`mcp_probe.py surface` lists them): is the
  meaning in the docstring instead, and did trials still guess wrong values
  (enums, id formats, date formats)?
- Server instructions: do they orient (what this is, the two or three entry
  paths, the limits) or enumerate? Is anything there that no trial used?

## B. Feedback and recovery — the gulf of evaluation

*Norman: the gap between the system's state and what the user can perceive
of it. Cognitive walkthrough, fourth question: "after the action, will the
user see that progress was made?" Nielsen: visibility of system status;
help users recognize, diagnose and recover from errors; recognition rather
than recall.*

- Does each result carry what the next call needs (ids, revision, counts,
  what was truncated), so the agent recognizes instead of recalling?
- Does a write say what changed and in which state it landed (`suggested`
  versus confirmed)? Did any trial agent report something as done that a
  person still has to confirm?
- Read every error line in the trial logs. Does it name the cause in the
  product's terms and the next step, or leak a framework message (a raw
  validation dump, a stack type)? Did the agent recover in one call, loop, or
  give up?
- Empty results: is "nothing matched" distinguishable from "you cannot see
  it" and from "wrong id"? Where they are deliberately merged (not leaking
  existence), is that the documented decision?
- Partial success in batch tools: is it reported per item?
- Retries: is repeating a write safe (idempotency key, `external_ref`,
  `expected_revision`)? Which writes duplicate on retry?
- Long operations: does the agent learn it is waiting, and for what?

## C. Context economy

*Cognitive load theory: working memory is the scarce resource. For an agent
it is the context window, and it is paid in money and in accuracy: every
definition and every result stays in view for the rest of the task.
Progressive disclosure: show the summary, let the user ask for detail.*

- Size of `tools/list` (`surface`). Which definitions are largest, and do
  they earn it? What is repeated across descriptions that could be said once
  in the instructions?
- Largest results in the trial logs (`report`). Do list tools default to a
  page and a summary shape, with detail on request? Is there a way to ask
  for fewer fields?
- Is anything returned that no agent can use (internal ids, layout
  coordinates, style blobs, base64)?
- Does a result say it was truncated and how to get the rest?
- Calls per job in the trials against the minimum you can find by hand: the
  difference is navigation the surface forced.

## D. Task fit

*Jobs-to-be-done and hierarchical task analysis: design from the job down,
not from the data model up. A tool that wraps one endpoint makes the agent
do the orchestration a UI does for a person in one click.*

- For each trial job, write the shortest call sequence. Where does one human
  gesture cost the agent several calls with ids threaded between them?
- The registry makes every tool the twin of human routes. That buys audit
  parity and coverage by construction. What does it cost here: a job with no
  single twin, or a twin that is a poor unit of work for an agent? This is a
  decision for step 5, not a defect.
- The other direction: which things a person does in the product have no
  agent path at all because their router is outside the registry rule
  (styling, layout, clusters, presets, templates, context authoring)? Which
  of those does an agent need to deliver a finished result to a person?
- Agents that write code prefer an API to tools. Is the REST surface usable
  with only `openapi.json` and an agent token: descriptions, error shapes,
  the same limits as MCP? What does the token's path allowlist exclude, and
  does the 4xx say so?
- Prompts and playbooks: did trials find and use them? Are they a better
  entry than the tool list for the job they describe?

## E. Safety, authority and oversight

*Levels of automation (Sheridan; Parasuraman): for each function, who
decides and who acts is a design choice, not a default. Mixed-initiative
interfaces (Horvitz) and the human-AI interaction guidelines (Amershi et
al.): make clear what the system can do, support efficient correction, scope
autonomy to the stakes. Automation bias and alert fatigue: a person asked to
confirm everything confirms without looking. Threat modelling: an agent that
reads untrusted content, holds private data and can send data out is
exploitable by the content.*

- Is each limit legible *to the agent* at the moment it hits it? In the
  "hit a limit" trial, did it find the permitted alternative
  (`propose_decision`) and tell the person what remains theirs?
- Suggestions: what is the review cost for the person per agent session?
  Count what one trial left to confirm. Are suggestions batched, explained
  and tied to evidence, or a queue that trains people to accept all?
- For each direct write: is it reversible by a person, attributed, and
  visible in the journal? For each human-only act: is the reason still true,
  and is there a propose-style path so the agent is not simply stuck?
- Untrusted data: is everything from case data and from query results
  inside the `untrusted_data` envelope, including error messages that echo
  input and names of things other users created?
- Exfiltration paths: which tools make an outbound request or write
  somewhere another party reads (enrichment providers, REST connections,
  report rendering, URLs in notes)? Can content read in one call steer
  another?
- Token scope: does a case-scoped token reach anything beyond its cases
  through catalog, context or exploration tools? Read
  `tests/test_agent_route_scoping.py` before claiming a gap.
- Resource limits: can one tool call run an unbounded query or return an
  unbounded result?

## F. Person–agent shared workspace

*Common ground (Clark): collaborators need a shared, visible record of what
each knows and did. Workspace awareness (CSCW): who changed what, when, and
is it still current.*

- After a trial, open the case in the UI (`make dev`, :3000) as the owner.
  Can the person tell what the agent did, in what order and why, without
  reading a log? Take a screenshot as evidence.
- Hand-off into the agent: can a person give work to the agent from the UI
  (a task assigned to its name) and can the agent find it? The "resume"
  trial measures the other direction: does `changes_since` plus the journal
  let a fresh agent continue?
- Can the agent point the person at a place (a link to the case, item,
  exploration) and is that in the tool results?
- Concurrent edits: the "stale write" trial. Does the agent learn that a
  person changed the thing, and what changed?
- Does what the agent builds look finished to the person (labels, style,
  layout), or does the person have to redo the presentation by hand?
