# Query Templates

A **query template** is a saved, parameterized query that lives with a graph
context. Instead of pasting the same Cypher into the query panel and hand-editing
an id each time, you save it once with placeholders:

```cypher
MATCH (n {node_id: "$node_id"})-[r*..$depth]-() RETURN r
```

and anyone with access to the context runs it by filling two fields — or by
following a link:

```
/graph/{context_id}?template=Neighbors&template.node_id=acct-9931&template.depth=2
                    └───────┬────────┘ └──────────────┬─────────────────────────┘
                    template name       parameter values
```

Templates are the middle ground between the two other ways a link can choose
data. A [precomputed graph](./precomputed-graphs.md) serves a result the server
already has; an exploration replays one person's saved session. A template runs
a **live query, shaped by whoever follows the link** — same question, different
subject, fresh answer.

## Creating a template

Open the **Templates** panel from the toolbar and hit **+ New**. A template is:

- **A name** — also its address in links, so pick something you would not mind
  reading in a URL. Names need not be unique, but a duplicated name makes links
  ambiguous (see below).
- **A query**, Cypher or SQL, with `$param_id` placeholders wherever a value
  should be filled in. Placeholders work anywhere in the text — ids, limits,
  property values.
- **Parameters**, one per placeholder. Each has an id (what goes after the `$`),
  an optional description and placeholder text, a **default**, a **required**
  flag, and a widget type: a free **input** or a **select** with a fixed list of
  options.
- **Execution options** (warehouse contexts only): procedural BFS, large
  results mode, and an optional CTE pre-filter — the same knobs as the query
  panel, frozen into the template so every run behaves the same. Parameter
  placeholders are substituted into the CTE pre-filter too.
- **Visibility** — `shared` (everyone with context access sees and runs it;
  anyone with context *write* access can edit it) or `private` (only you see
  it, only you can edit it).
- **Can be run from a link** — on by default. Unchecking it blocks the
  `?template=` URL grammar for this template: existing links do not vanish,
  they fail with the explaining status chip, and the execute modal's Copy link
  button disables itself. The template itself stays runnable from the panel.

You can also save the query you just ran: the Query Console offers **Save as
template** with the current text pre-filled.

SQL templates only appear on contexts whose datasource runs SQL. On a
native-Cypher backend (Neptune) or a REST connection they are hidden from the
panel — and a link to one reports the mismatch instead of running.

## Running a template

The **Use** button opens the execute modal: fill the parameters, watch the live
query preview, and choose how to run it —

- **Graph** (default): the result loads into the visualization. The query must
  return edges (`RETURN r`).
- **Table**: the result opens as rows in the Query Console — any projection is
  allowed.

Required parameters must be filled before Execute enables. Substitution is
literal text replacement of each `$param_id`, longest id first, in a single
pass — a value is never itself re-scanned for placeholders, so a value that
happens to contain `$something` is inert text.

## Running a template from a link

`?template=<name>` names the template; each `?template.<param>=<value>` fills
one declared parameter. Parameters the link does not set fall back to their
defaults. Opening such a link resolves the template, validates everything, and
executes — no clicks.

The easiest way to build one is the **Copy link** button in the execute modal:
fill the parameters as if you were about to run it, and copy a URL that will do
exactly that for whoever receives it.

### Addressing is by name, and visibility is per viewer

The link matches by exact name among the templates *the viewer can see* in that
context: shared templates plus their own private ones. Two consequences:

- If two visible templates share the name, the link **refuses to guess** and
  reports the ambiguity. Rename one.
- A link to your *private* template runs for you and reports "not found" to
  everyone else. Share the template to share the link.

### Every rule, or nothing runs

A template link is **all or nothing** — unlike a `?layout.*` override, where a
bad field is dropped and the rest still applies. Parameter values are
substituted into a query the warehouse executes, so a link that is only mostly
right must not run a query that is only mostly the one its author meant. Any of
the following stops the run, with a status-bar chip explaining every problem at
once:

- a template whose author unchecked **Can be run from a link**;
- a parameter the template does not declare;
- a required parameter with neither a URL value nor a default;
- a `select` value that is not among the declared options (a stale default that
  fell out of the options also refuses to run);
- a value containing characters outside the allow-list: letters, digits, space,
  `_ . , : @ / -`.

The charset rule is the security boundary of the feature. A substituted value
lands inside the query text verbatim, and quotes, backslashes, backticks, `$`,
parentheses and `;` are precisely the characters that could escape a quoted
literal or smuggle in a macro call. The server's read-only query validation
still applies afterwards; this is defense in depth at the one boundary where
values arrive from a link rather than from someone at the keyboard. A value
that legitimately needs a rejected character can still be typed and run in the
execute modal — it just cannot travel by URL, and Copy link says so rather than
minting a link that would fail at the other end.

Nothing falls back to another load either: a broken template link opens an
empty graph with an explanation, for the same reason a broken `?precomputed=`
link does — a mistyped link must surface as an error, not silently launch an
expensive query the user never asked for.

### Links are live

Editing a `template.<param>=` value in the address bar re-resolves and
re-executes — the same contract as editing a provider argument on a
`?precomputed=` link. And a template link composes with the appearance
parameters:

```
/graph/{context_id}?template=Neighbors&template.node_id=acct-9931&style=investigacao&layout=ego&layout.ego.focusNodeId=acct-9931
```

runs the query, applies the saved look, and centres the ego layout — one link,
the whole picture.

### Precedence

When a URL carries more than one data-choosing parameter: `?exploration=` wins
over `?precomputed=`, which wins over `?template=`, which wins over the
context's default auto-load. A shadowed parameter is ignored entirely — two
loads must not race for one canvas.

### Preset, precomputed, template, or exploration?

| | Style preset | Precomputed graph | Query template | Exploration |
|---|---|---|---|---|
| **Stores** | how it looks | which nodes and edges | a parameterized query | graph, look and positions |
| **Scope** | the context | the context | the context | one user, plus shares |
| **Addressed by** | `?style=name`, overridden per field by `?layout…` | `?precomputed=name`, plus provider arguments | `?template=name`, plus `template.<param>=` values | `?exploration=uuid` |
| **Combines with** | any graph | any style | any style | — |

A style preset and a precomputed graph are orthogonal on purpose: the same
look applies to any data, and the same data can be viewed in any look. A
template link composes with `?style=` and `?layout.*` the same way a
precomputed one does — see [Style Presets](./style-presets.md) and
[Layout URL Overrides](./layout-url-overrides.md).

## Permissions

| Action | Who |
|---|---|
| See / run a `shared` template | anyone with access to the context |
| See / run a `private` template | its creator only |
| Create | `shared` needs context write access; `private` needs only context access |
| Edit / delete a `shared` template | anyone with context write access |
| Edit / delete a `private` template | its creator only |
| Change visibility | the creator only (and `private → shared` additionally needs context write access) |

A private template of someone else answers 404, not 403 — its existence is not
leaked. Running a template grants nothing extra: execution flows through the
same query endpoints, read-only validation and context access checks as a
hand-typed query, so a template is a convenience, never an escalation.
