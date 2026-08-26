# Layout URL Overrides

::: tip TL;DR
Set layout parameters field by field in the URL —
`?layout=ego&layout.ego.focusNodeId=acct-9931` — on top of whatever a
style preset restored.

- **Use it when** a link should open centred on a *specific* node or with
  one layout knob changed, without creating a preset per target — the
  pattern [context-menu actions](./context-menu-actions.md) use for
  "re-open from here" deep links.
- **Not the tool for** appearance (colors/labels stay a
  [preset](./style-presets.md)'s job — only semantic fields are
  settable); choosing which data loads; or layouts beyond `force`, `ego`,
  `hive`, `hierarchical`.
:::

A [style preset](./style-presets.md) is all-or-nothing: applying one replaces
the whole layout block. That makes "the investigation look, but centred on
*this* account" cost a new preset per account. Layout parameters can instead
be set in the URL, field by field, on top of whatever the preset restored:

```
/graph/{context_id}?style=investigacao&layout=ego&layout.ego.focusNodeId=acct-9931
```

The URL wins field by field; everything it does not name keeps the preset's
value.

![An ego layout centred on the node named by the URL](/screenshots/layout-url-overrides-ego.png)

## Grammar

Two forms:

- `?layout=<algorithm>` — switches the layout algorithm itself.
- `?layout.<mode>.<field>=<value>` — sets one parameter of one mode, without
  necessarily switching to it. `?layout.ego.focusNodeId=x` alone configures
  ego's focus for whenever ego is turned on; add `?layout=ego` to actually
  switch.

`<algorithm>` must be one of `force`, `ego`, `hive`, `hierarchical` —
deliberately narrower than the full set of layout algorithms the app knows
about internally (`circular` and `grid` exist as values elsewhere but have no
implementation behind them, so a link naming one would render nothing and
look like a bug).

## Settable fields, by mode

Only **semantic** parameters can be set from a link — the ones that change
what you are looking at, not how it is drawn. Appearance stays a style
preset's job.

| Mode | Field | Type | Notes |
|---|---|---|---|
| `ego` | `focusNodeId` | string, or empty for none | Which node the rings radiate from. |
| `ego` | `direction` | `both` \| `out` \| `in` | Which edge direction traversal follows outward from the focus. |
| `ego` | `maxHops` | whole number 0–64, or empty for none | Hides nodes farther than N hops. The Layout panel's slider stops at 6, but the cutoff is semantic, so a link may ask for more — past the graph's actual diameter it is simply a no-op. |
| `ego` | `edgeTypes` | comma-separated list, or empty for all | Restricts which edge types ego traversal follows. |
| `hierarchical` | `traversal` | `both` \| `out` \| `in` | Edge direction used to build the hierarchy. |
| `hierarchical` | `direction` | `td` \| `lr` | Layout direction: top-down or left-right. |
| `hierarchical` | `edgeTypes` | comma-separated list, or empty for all | Restricts which edge types shape the hierarchy. |
| `hive` | *(none)* | — | Nothing about the hive layout is settable from a link — see below. |

### Value conventions

- An **empty value** means "none" for a field that allows it:
  `?layout.ego.maxHops=` removes the hop cutoff.
- **Lists are comma-separated**, and empty means all:
  `?layout.ego.edgeTypes=KNOWS,WORKS_AT` restricts ego traversal to those two
  types.
- Numbers must be plain decimals. `1e5`, `0x10`, a leading `+`, and padding
  whitespace are all rejected rather than silently coerced — a value that
  parses one way here and another way in a spreadsheet or script is worse
  than an error.

## What is refused, and why

Everything not in the table above is refused, and the reason differs by
field:

- **Appearance settings** — spacings, radii, ring ordering, arc routing —
  are refused with a message pointing at style presets. That is what a
  preset is for, and a URL that could set them would be a worse copy of one.
- **`ringOrderingKey`, `hive.axisKey`, `hive.positionKey`** are refused for a
  different reason: they name dataset *properties* as free strings. A typo in
  one cannot be told apart from a real property name, so a wrong value would
  silently degrade the layout instead of being reported — exactly the
  failure this feature exists to prevent.
- **`crossingHeuristic`** (the `hive` mode's sifting algorithm) is refused
  because it is expensive — on the order of hundreds of milliseconds on a
  dense ring — and turning it on is a decision the recipient of a link
  should make deliberately, not one a sender should spend on their behalf.
- **An unknown layout algorithm** (`?layout=circular`, or any typo) is
  refused even when the name exists elsewhere in the app's type system —
  only algorithms with a real implementation are accepted.

## Precedence and composition

Overrides apply **after** the style preset, and that order matters: applying
a preset replaces the entire `layoutModeConfig`, so an override applied
first would be silently erased the moment the preset lands. A preset is the
saved default; the URL is the specific instruction in the link someone was
sent.

The full load order for one page open is:

1. Whichever data-choosing parameter wins — `?exploration=`, then
   `?precomputed=`, then `?template=`, then the context's default auto-load
   (see [Query Templates](./query-templates.md#preset-precomputed-template-or-exploration)
   for the full precedence table).
2. `?style=` — the saved look, including its own layout block.
3. `?layout=` / `?layout.<mode>.<field>=` — field-by-field overrides on top
   of whatever step 2 restored.

## What happens when something is wrong

A malformed or unsettable parameter **changes nothing else and does not
break the page** — the same doctrine as a missing `?style=`. The graph loads
and stays fully usable; the status bar shows one chip —
`layout setting not applied`, or `N layout settings not applied` for
several — with every problem explained in its tooltip. One chip rather than
one per issue: a row of terse qualifiers with N chips for N typos would push
the node count off the bar and imply N different kinds of problem.

The **focus node** gets one extra check, once the graph has actually loaded:
if `?layout.ego.focusNodeId=` names a node that is not in the graph on
screen, the layout has nothing to centre on, and that is reported once — via
the same status chip plus a toast — rather than the ego layout sitting
inertly with no explanation. This check is skipped entirely on a graph with
zero nodes: an empty canvas is not an answer to "is this node here", and
blaming the link would blame it for the user not having run a query yet.

## Examples

Each of these runs against the project's own end-to-end suite
(`frontend/e2e/tests/layout-url-overrides.spec.ts`):

Center the ego layout on a node, with no preset involved:
```
/graph/{context_id}?layout=ego&layout.ego.focusNodeId=n1
```

A URL parameter overriding one field of a preset's layout, while a field the
URL does not name keeps the preset's value (here, `direction` stays whatever
the preset set):
```
/graph/{context_id}?style=ego-investigacao&layout.ego.focusNodeId=n3&layout.ego.maxHops=3
```

One bad value does not take down the rest of the link — `maxHops=abc` is
dropped and reported, while `focusNodeId=n1` still applies:
```
/graph/{context_id}?layout=ego&layout.ego.focusNodeId=n1&layout.ego.maxHops=abc
```

A field override with no `?layout=` at all — the preset supplies the
algorithm, the URL only adjusts one field of it:
```
/graph/{context_id}?style=ego-investigacao&layout.ego.focusNodeId=n1
```
