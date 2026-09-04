# Groups & Permissions

::: tip TL;DR
Superuser-managed **groups** (members: emails and/or Databricks workspace
groups) plus **allow/deny rules** that decide who may perform app actions —
today: creating graph contexts (which also governs catalog browsing and how
wide a query may reach) and saving explorations.

- **Use it when** only some people should author contexts and query across
  the warehouse, a team's Databricks group should map straight onto app
  capabilities, or a set of users must be blocked from an action without
  enumerating everyone else.
- **Not the tool for** per-resource access — who can *open or edit a
  specific* context or exploration is decided by ownership and
  [sharing](./explorations.md), which stays email-based; or for managing
  superusers, who come from
  [`GRAPH_LAGOON_SUPERUSER_EMAILS`](./configuration.md) and bypass every
  rule here.
:::

Out of the box Graph Lagoon is open: anyone who can log in can create
contexts, save explorations and query. That is right for a team of five and
wrong for a workspace of five hundred — you may want graph modeling and
warehouse-wide SQL in the hands of a data team while everyone else explores
what they publish. Groups & permissions adds that boundary without touching
the default: **until an admin writes a rule, nothing changes for anyone.**

## The permission catalog

| Permission | Gates |
|---|---|
| `context.create` | Creating graph contexts; browsing the warehouse catalog (listing catalogs/schemas/tables, table schema and preview, type discovery); and the **wide** query tier — see [Query scope](#query-scope) below. |
| `exploration.save` | Saving or updating explorations. Exploring and querying stay open — this only gates persisting the result. |

## Query scope

Querying itself is never denied — what changes is **which tables a query may
read**. The tier is decided by `context.create`, because a holder can already
point a new context at any table in the allowlist; letting them query those
tables directly is not an escalation.

| Tier | May read |
|---|---|
| **Holds `context.create`** | Any table inside the configured `catalog.schema` allowlist (`GRAPH_LAGOON_CATALOG_SCHEMAS`, plus the open context's own schemas). |
| **Everyone else** | Only the tables of the context they have open (its edge and node tables). |

Enforcement parses the statement, so a table smuggled in through a `JOIN`, a
subquery or a `UNION` is caught the same as one in the `FROM` clause; CTE
names are not mistaken for tables. The **CTE pre-filter** is checked too, on
every mode — it is client SQL spliced into the query, so it is the one place
a foreign table could otherwise ride along. A blocked query returns **403**
with code `QUERY_SCOPE_DENIED` naming the offending tables.

Plain Cypher needs no statement check — the transpiler renders against the
open context's schema, so it can only ever name that context's tables. Native
graph datasources (Neptune, REST) are not scoped here at all: they have no
tables to name, and their own system owns access control.

::: warning BEGIN…END scripts
A Databricks compound statement cannot be scoped: its body is opaque to the
parser and `EXECUTE IMMEDIATE` builds SQL at runtime. Hand-written scripts on
the raw-SQL path are therefore refused unless an administrator sets
`GRAPH_LAGOON_ALLOW_RAW_SQL_SCRIPTS=true` — and with that flag on, scripts
bypass both the read-only validator and the scope check, leaving read-only
Unity Catalog grants as the only enforcing layer. Procedural Cypher is
unaffected either way: its script is generated server-side and stays bound to
the context.
:::

## The model in one table

| Concept | What it is |
|---|---|
| **Group** | A named set of members. Two member kinds: an exact **email**, or a **Databricks group** name (workspace membership grants app membership). |
| **Permission** | A fixed catalog entry naming an app action (see the table above). The catalog grows with the product — rules for it are data. |
| **Mode** | Per permission: `everyone` (default — behaves like today) or `restricted` (only allow-rule groups). |
| **Rule** | `allow` or `deny` of one permission for one group. |

Evaluation order, per request:

| Step | Outcome |
|---|---|
| 1. Superuser? | **Allowed** — lockout-proof by construction |
| 2. Member of a group with a **deny** rule? | **Denied** — deny always wins, even in `everyone` mode |
| 3. Mode `restricted`? | Allowed only via a group with an **allow** rule |
| 4. Otherwise (`everyone`) | **Allowed** |

The two governance postures both fit:

- **Allow-list** ("only the data team creates contexts"): set
  `context.create` to `restricted`, add an allow rule for `data-team`.
- **Deny-list** ("contractors cannot save explorations"): leave
  `exploration.save` on `everyone`, add a deny rule for `contractors`.

## Managing it

Everything lives in **Admin → Groups & permissions** (superusers only):

![Groups & permissions tab](/screenshots/permissions-admin-groups.png)

- **Groups** — create/edit/delete; a member row is either an email or a
  Databricks group name.
- **Permissions matrix** — one row per catalog entry: the mode toggle and
  one chip per group cycling **— → allow → deny**. Each row saves as a full
  replacement. Setting `restricted` with no allow rule warns you: only
  superusers would keep the permission.
- **Inspector** — type an email and see, per permission, allowed/denied,
  *why* (which rule and group matched), and which Databricks groups
  resolved for that user. This is the answer to "why can't they?" before it
  becomes a support ticket.

Every mutation lands in the [audit trail](./configuration.md) as
`group.create/update/delete` and `permission.update`.

## What a blocked user sees

The UI hides what you cannot do: no **Create New** button on Contexts, no
**Save** affordance in the toolbar, no table **Discover** button without
`context.create`. The Contexts page itself never disappears — viewing is not
gated. An empty contexts list tells a blocked user to ask an administrator
instead of dead-ending. The backend enforces regardless of the UI: a direct
API call gets **403** with code `PERMISSION_DENIED` naming the permission,
and an out-of-scope query gets **403 `QUERY_SCOPE_DENIED`** listing the
tables it may not read.

## Databricks groups

A `databricks_group` member ties app capability to workspace governance:
join the `data-analysts` group in Databricks, inherit whatever its Graph
Lagoon groups grant — no app-side change needed.

How it resolves:

- The app looks a user's workspace groups up via **SCIM** using its own
  service principal (or PAT) — there is no per-user token. Grant the app's
  principal permission to read workspace SCIM Users, or lookups 403 (see
  [Deploy as a Databricks App](./databricks-apps.md)).
- Results are cached per user for `GRAPH_LAGOON_GROUP_CACHE_TTL_SECONDS`
  (default 600 s).
- **Direct membership only**: nested Databricks groups are not expanded.
- In local dev (`databricks_mode=false`) there is no SCIM — only email
  members resolve.

## When something is wrong

| Symptom | What is happening | What to do |
|---|---|---|
| "User X should be allowed but gets 403" | Membership didn't resolve, or a deny rule matches somewhere. | Admin → Inspector: it names the matched rule and shows the resolved Databricks groups (and any SCIM error). |
| Banner: *Databricks membership lookups are failing* | SCIM is unreachable or the principal lacks the read grant. Rules keep using each user's **last-known-good** membership; users never resolved simply don't match Databricks-kind members. | Fix the grant/connectivity; **Refresh cache** re-resolves on the next check. Critical **deny** rules should use email members — they never depend on SCIM. |
| Someone kept access after leaving a Databricks group | The per-user cache (default 10 min) hasn't expired. | Wait out the TTL or hit **Refresh cache**. |
| Everyone (but superusers) lost an action | Its mode is `restricted` with no allow rule — the matrix warns about exactly this. | Add an allow rule or set the mode back to `everyone`. |
| A query returns `QUERY_SCOPE_DENIED` | It reads a table outside the caller's tier: outside the open context (no `context.create`) or outside the configured allowlist. | Widen `GRAPH_LAGOON_CATALOG_SCHEMAS`, grant `context.create`, or query the context's own tables. |
| `SCRIPT_NOT_ALLOWED` on a hand-written `BEGIN…END` | Raw scripts are off by default — they cannot be validated or scoped. | Run the Cypher it came from, or enable `GRAPH_LAGOON_ALLOW_RAW_SQL_SCRIPTS` with read-only warehouse grants. |
| Admin locked themselves out? | Impossible via rules: superusers bypass all of them, and the superuser list is an env var, not data. | — |
