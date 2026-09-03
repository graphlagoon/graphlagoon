# Labels & Text Formatting

::: tip TL;DR
A small template language that decides **what text** each node and edge
shows — extract the readable part out of messy columns, per type, with
live preview.

- **Use it when** ids are unreadable (`12321_CNPJ_RAIZ`), the useful text
  is buried inside a property, or different node types need different
  labels.
- **Not the tool for** colors, sizes or icons (that's the
  [Style panel](./style-presets.md)); rich text or emoji (the canvas font
  is ASCII-only); or long descriptions — labels over ~30 characters get
  culled when the graph is crowded.
:::

Raw node ids make terrible labels. A graph of `12321_CNPJ_RAIZ`-style
identifiers is unreadable, and a graph that shows a 60-character description
on every node is worse. The **Labels** panel solves both with a small
template language: you decide what text each node and edge shows, extract
the readable part out of messy values, and preview the result on your real
data before it hits the canvas.

Open it from the toolbar **Labels** button. It has two layers:

- **Default templates** — one for all nodes, one for all edges.
- **Custom rules** — templates that apply only to some target (node/edge)
  and, optionally, only to some types, with a priority to break ties.

![Labels panel](/screenshots/labels-panel.png)

Out of the box the defaults are `{node_id|truncate:10:...}` for nodes and
`{relationship_type}` for edges.

## Placeholders

Everything outside `{...}` is literal text; everything inside is resolved
per node or edge.

| Placeholder | Meaning |
|---|---|
| `{node_id}` / `{node_type}` | The configured id / type columns (nodes) |
| `{edge_id}` / `{relationship_type}` | The configured id / type columns (edges) |
| `{src}` / `{dst}` | Source / destination node id (edges) |
| `{prop:<column>}` | Any property column, e.g. `{prop:name}` |
| `{metric:<name>}` | A metric value — computed (`{metric:Degree}`) or [custom](./communities-metrics.md#custom-metrics) (`{metric:Email domain}`), by name or id |
| `{br}` | Line break — makes the label multi-line |

`{prop:...}` reads the item's properties first and only then falls back to
the built-ins. That distinction matters when a table literally has a column
named `node_id` that differs from the configured id column: `{node_id}` is
the configured id, `{prop:node_id}` is the raw column.

A missing property renders as a visible sentinel — `{prop:nickname}` on a
node without that column shows `[nickname]` — so a typo is caught on the
canvas instead of silently disappearing. Chain `|default:` to replace the
sentinel with a fallback of your choice.

`{metric:...}` works the same way: it renders the metric's value for the
node or edge (numbers, text or booleans — `{metric:Ratio|number}`,
`{metric:Email domain|upper}`), shows `[metric:name]` when no such metric
has a value for that item, and never reads a property of the same name.
Labels re-render when a metric is (re)computed. Custom metrics are only
visible to users with write access to the context, so a shared label
template that uses one renders the sentinel for read-only viewers.

## Modifiers

Append modifiers with `|`, arguments with `:`. Modifiers **chain
left-to-right**: `{prop:url|split:/:2|upper}` splits first, then
uppercases. Escape a literal `:`, `|`, `{` or `}` inside arguments with a
backslash (`\:`).

**Text**

| Modifier | Example | `John Doe` becomes |
|---|---|---|
| `upper` | `{prop:name\|upper}` | `JOHN DOE` |
| `lower` | `{prop:name\|lower}` | `john doe` |
| `capitalize` | `{prop:name\|capitalize}` | `John doe` |
| `truncate:max:suffix` | `{prop:name\|truncate:6:..}` | `John..` |

`truncate` produces a result of exactly `max` characters (suffix included);
defaults are 20 and `...`.

**Numbers**

| Modifier | Example | Result |
|---|---|---|
| `number` | `{prop:count\|number}` | `1,234,567` |
| `currency:code` | `{prop:price\|currency:BRL}` | `R$ 1.234,56` |
| `percent` | `{prop:rate\|percent}` on `0.855` | `85.5%` |

`percent` expects a fraction, not an already-multiplied value. Non-numeric
input passes through unchanged.

**Extraction**

| Modifier | Example | Result |
|---|---|---|
| `split:delim:index` | `{node_id\|split:_:0}` on `12321_CNPJ_RAIZ` | `12321` |
| `slice:start:end` | `{prop:code\|slice:-5}` on `BR-SP-00123` | `00123` |
| `trim` | `{prop:name\|trim}` on `  alice  ` | `alice` |
| `default:fallback` | `{prop:nickname\|default:anon}` | `anon` |

`split` accepts negative indexes counted from the end —
`{prop:path|split:/:-1}` on `a/b/c/file.txt` gives `file.txt`.

**Regex** — patterns are slash-delimited, compiled once, and capped at 200
characters; the only allowed flag is `i`.

| Modifier | Example | Result |
|---|---|---|
| `match:/pattern/:group` | `{prop:email\|match:/@(.+)$/:1}` | `empresa.com` |
| `replace:/pattern/:repl` | `{node_id\|replace:/_CNPJ_RAIZ/:}` | `12321` |

`match` with no match yields an empty string — chain `|default:` after it:
`{prop:email|match:/@(.+)$/:1|default:no domain}`. `replace` replaces every
occurrence and supports `$1` backreferences. Alternation is safe inside the
slashes: `{prop:code|match:/^(BR|US)/:1}`.

## Dates

`{date:prop:<column>|<format>}` formats ISO strings, unix timestamps
(seconds or milliseconds — detected automatically), or anything a browser
date parses. Tokens: `YYYY YY MM M DD D HH H mm m ss s`; the default format
is `YYYY-MM-DD`.

```
{date:prop:created|DD/MM/YYYY}   →  25/01/2024
{date:prop:created|DD/MM HH:mm}  →  25/01 14:30
```

::: warning
`date:` placeholders do not accept a modifier chain — the format string
consumes the pipes. Keep formats to tokens and separators only.
:::

## Conditionals

`{if:<condition>|<true>|<false>}` — the false branch is optional, and both
branches are themselves templates, so nesting works:

```
{if:prop:active==true|Active|Inactive}
{if:prop:score>80|High|Low}
{if:prop:verified==true|{prop:name|upper}|anonymous}
```

Conditions address a property with the `prop:` prefix, or a
session-computed metric with the `metric:` prefix:

```
{if:metric:PageRank>0.5|hub|leaf}
{if:metric:Email domain==gmail.com|consumer|corporate}
```

A metric condition resolves through the same lookup as `{metric:...}` (by
name or id, never a property of the same name). A metric that is not
computed, or has no value for the item, compares as an empty string — the
false branch renders. Two forms exist; the pipe form is required for date
and regex operators:

```
{if:prop:name|contains:john|Match|No match}
{if:prop:created|daysAgo:<7|Recent|Old}
{if:prop:created|dateBetween:2024-01-01:2024-12-31|In range|Out}
{if:prop:code|matches:/^BR/i|Brasil|Outro}
```

Operators: `==` `!=` `>` `<` `>=` `<=` (numeric when both sides are
numbers, string otherwise), `contains` / `startsWith` / `endsWith`
(case-insensitive), `matches` (regex), `daysAgo`, `dateAfter`,
`dateBefore`, `dateBetween`.

Two gotchas worth knowing:

- **You cannot compare against an empty string** — `{if:prop:x==|a|b}` is
  a parse error, enforced rather than silently misread. Use
  `{prop:x|default:...}` instead.
- **A missing property compares as an empty string**, so
  `{if:prop:x!=hello|yes|no}` on a node without `x` renders `yes`.

## Custom rules and priority

A rule has a name, a target (node or edge), an optional list of types, a
template, and a priority (0–100, default 10). At render time the
highest-priority enabled rule whose target and types match wins; on a tie,
a rule with explicit types beats a catch-all. No match → the default
template. Type-restricted rules are how you give `Person` nodes a
`{prop:name}` label while `Transaction` nodes show
`{prop:amount|currency}`.

Every template input has autocomplete (type `{` to see placeholders for
your context's real columns, and `|` modifiers) and a **live preview** that
renders up to three real items from the loaded graph. Validation errors
block saving a rule and show inline in red; warnings (like an unknown
modifier) show in amber but don't block. The **?** button opens a 10-slide
in-app reference with worked examples.

## Asking an AI to write templates

The **robot** button opens "Ask an AI to write label templates": a
copy-paste prompt that bundles the full template syntax with *this graph's*
actual node types, edge types, and property columns. Paste it into any
assistant, describe the labels you want, and the answer comes back in a
format you can type straight into the panel — default templates plus rules
with names, targets, and priorities. The same pattern exists for
[context-menu actions](./context-menu-actions.md) and cluster programs.

## When something is wrong

Rendering never throws — the failure modes are designed to be visible or
harmless:

| Situation | What renders |
|---|---|
| Missing `{prop:x}` | `[x]` sentinel (or the `default:` value) |
| Unknown modifier | Skipped; rest of the chain still applies |
| `match` without a match, `split` index out of range | Empty string |
| Invalid regex | Value passes through unchanged; in a `matches` condition, the false branch |
| Built-in that doesn't apply (`{node_id}` on an edge) | Empty string |
| Unbalanced `{` | Treated as literal text |

Errors that block saving a rule: unbalanced braces, missing or non-integer
required arguments, malformed / too-long / wrong-flag regexes, and invalid
condition syntax. Validation recurses into conditional branches.

## Labels on the canvas

Templates decide *what* text; a few other places decide *whether and how*
it is drawn:

- **Nothing is drawn until the initial layout finishes** — if you see no
  labels right after loading, wait for the layout to settle before
  suspecting your template.
- The label font covers **basic ASCII only**. Accents are stripped
  (`José` → `Jose`); anything else — emoji, `…`, `→` — draws as `?`. Use
  `...` and `->`. Keep labels around 20–30 characters and at most 2–3
  lines: the overlap filter hides crowded labels, and taller labels get
  hidden first.
- **Style panel → Labels**: show/hide node and edge labels, size, position
  and offset.
- **Behaviors panel**: *Hide labels on camera move* and *Label density
  culling* (size threshold, density per screen cell, overlap tolerance).
  Selected and hovered nodes always keep their labels.

## Saved with presets and explorations

The whole Labels state — defaults, rules, and syntax version — travels
inside [style presets](./style-presets.md) and saved explorations. Applying
`?style=<name>` **replaces** your current label setup with the preset's
(including resetting to the stock defaults if the preset carried no label
config); it never touches which nodes are shown. Rules referencing
`{prop:...}` columns also hint the loader to fetch those columns first, so
labels resolve early even on wide tables.
