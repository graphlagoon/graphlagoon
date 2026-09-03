# Groups & Permissions

::: tip TL;DR
Superuser-managed **groups** (members: emails and/or Databricks workspace
groups) plus **allow/deny rules** that decide who may perform app actions —
today: creating graph contexts and saving explorations.

- **Use it when** only some people should create contexts, a team's
  Databricks group should map straight onto app capabilities, or a set of
  users must be blocked from an action without enumerating everyone else.
- **Not the tool for** per-resource access — who can *open or edit a
  specific* context or exploration is decided by ownership and
  [sharing](./explorations.md), which stays email-based; or for managing
  superusers, who come from
  [`GRAPH_LAGOON_SUPERUSER_EMAILS`](./configuration.md) and bypass every
  rule here.
:::

Out of the box Graph Lagoon is open: anyone who can log in can create
contexts and save explorations. That is right for a team of five and wrong
for a workspace of five hundred — you may want graph modeling in the hands
of a data team while everyone else explores what they publish. Groups &
permissions adds that boundary without touching the default: **until an
admin writes a rule, nothing changes for anyone.**

## The model in one table

| Concept | What it is |
|---|---|
| **Group** | A named set of members. Two member kinds: an exact **email**, or a **Databricks group** name (workspace membership grants app membership). |
| **Permission** | A fixed catalog entry naming an app action (`context.create`, `exploration.save`). The catalog grows with the product — rules for it are data. |
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
**Save** affordance in the toolbar. The Contexts page itself never
disappears — viewing is not gated. An empty contexts list tells a blocked
user to ask an administrator instead of dead-ending. The backend enforces
regardless of the UI: a direct API call gets **403** with code
`PERMISSION_DENIED` naming the permission.

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
| Admin locked themselves out? | Impossible via rules: superusers bypass all of them, and the superuser list is an env var, not data. | — |
