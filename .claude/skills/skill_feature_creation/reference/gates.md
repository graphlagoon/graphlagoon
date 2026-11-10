# Gates and the decision log

## Contents
- Step 2.4b — Permission gating
- Step 4.2 — Public documentation
- Step 4.2b — Admin-area impact
- Decision-log entry

## Step 2.4b — Permission gating

Ask for every new user-facing **action** (not a read or view): should an
admin be able to restrict it per group? If yes, all four pieces, together:

1. **Catalog** — `api/graphlagoon/services/permission_catalog.py`:
   ```python
   Permission(id="<resource>.<verb>", label="...", description="..."),
   ```
   Exactly one dot, AuditAction style. Default posture is `everyone`, so
   shipping the entry changes nothing until an admin writes a rule.
2. **Route** — on the handler that *is* the action:
   ```python
   user_email: str = Depends(require_permission("<resource>.<verb>")),
   ```
   It replaces the handler's `get_current_user(request)`; ownership and
   share checks stay as separate AND-gates.
3. **UI** — `v-if="can('<resource>.<verb>')"` from `usePermissions()`.
   Hide, do not disable; keep read paths visible; the empty state says
   what to do.
4. **Tests** — one allow and one deny case in
   `api/tests/test_permission_routes.py`; a hidden-affordance case in the
   feature's component test or e2e spec.

The admin matrix, inspector, rule storage and `/api/config` payload pick the
entry up by themselves. A catalog entry without its gate is a matrix row
that does nothing; a gate with an uncataloged id fails
`test_admin_registry::test_permission_gates_reference_catalog`.

Not this system: per-resource access ("this user on this context") is
ownership + shares. Scoped or conditional rules (per catalog, time-based)
are deliberately unsupported — raise a design discussion first.
User-facing explanation: `docs/guide/permissions.md`.

## Step 4.2 — Public documentation

The VitePress site (`docs/` → GitHub Pages) ships with the feature.

**Trigger** — the change touches anything a user can see or configure:
UI (panel, modal, button, badge, banner), an env var / config key /
default, a URL parameter (`?style=`, `?layout=`, `?template=`, …), or an
endpoint / Python API that end users or embedding apps call.

No trigger → write "No public docs impact" in the log entry. Otherwise:

1. **Page** — update the matching `docs/guide/<slug>.md` (`ls docs/guide/`;
   names follow features, env vars go in `configuration.md`, embedding in
   `python-api.md` / `integration.md` / `rest-api.md`).
   `agents-mcp-tools.md` and `docs/public/openapi.json` are generated:
   never hand-edit, run `make docs-api`.
2. **House style** (model: `docs/guide/labels.md`) — open with a
   `::: tip TL;DR` block: one sentence on what it is, then "**Use it
   when** …" and "**Not the tool for** …" (honest limits, linking the
   feature that is the right tool). Then the problem it solves, why the
   rules exist, short tables for fields and permissions, real code / URL
   examples, and a "what happens when something is wrong" section.
3. **New page** — register it in the `sidebar` of
   `docs/.vitepress/config.ts`.
4. **UI appearance changed** — add or update a scene in `SCENES` in
   `frontend/e2e/screenshots/generate.ts` (output
   `docs/public/screenshots/<guide>-<scene>.png`), run
   `make docs-screenshots`, commit the PNGs. It runs on API mocks.
5. **Verify** — `make docs-build` passes (generated API docs are current;
   VitePress dead-link check over sidebar, cross-links and images).

## Step 4.2b — Admin-area impact

The superuser area (`/admin`) lists the environment and audits mutations.
Most of this is enforced by `api/tests/test_admin_registry.py`: a red test
there names what to update. The complete table with the enforcing test per
row is the "When to update the admin area" section of
`docs/dev/admin-area.md`. The common rows:

| Did you add… | Then… |
|---|---|
| a `Settings` field / env var | classify it in `routers/admin_registry.CONFIG_FIELD_KINDS` (`public` / `secret` / `hidden`; URLs that can carry credentials are `secret`) |
| a table or in-memory collection | `CLEARABLE_TABLES` (FK-safe order) or `PRESERVED_TABLES` with a reason; `InMemoryStore.clear_all`; a count in `AdminCounts` if user-owned; extend `graphlagoon.dev.seed` |
| a `POST` / `PUT` / `DELETE` route | `AUDITED_ROUTES` + `audit.record(...)` + an `AuditAction`, or `AUDIT_EXEMPT_ROUTES` with a reason |
| a router module | `tests/test_admin_registry.ROUTER_MODULES` |
| an audit action | `describeAudit` in `frontend/src/utils/adminView.ts` |
| a user-owned entity | a tab or column in `AdminView.vue` so a superuser can see who owns it |
| an action admins may want to restrict | Step 2.4b |
| a route under `/api/investigations` or `/api/org`, or an MCP tool | docstring + `tags`, the MCP mirror or exemption in `mcp/registry.py`, `make docs-api` |

Nothing applies → the log entry says "No admin-area impact".

## Decision-log entry

One entry per feature, appended to the end of `docs/dev/decision_log.md`
(newest last). Write it for the next person who touches this area: the
decisions and their reasons, not a diary. Match the density of recent
entries (`tail -40 docs/dev/decision_log.md`).

```markdown
## [YYYY-MM-DD HH:MM] - Feature Implemented: <name>

**Feature:** <what the user can now do, 1-3 lines>
**Decisions:**
1. **<decision>:** <why; what it replaces or constrains>
**Rejected:** <alternative — why>
**Files:** new `<paths>`; changed `<paths>`; removed `<paths>`
**Tests:** vitest `<names>`; e2e `<specs>`; pytest `<files>`
**Public docs:** <pages and screenshots updated> | No public docs impact
**Admin-area impact:** <registries updated> | No admin-area impact
**Known limitations:** <real limits, or omit>
```

Append without loading the file:

```bash
cat >> docs/dev/decision_log.md <<'EOF'

## [2026-01-31 14:00] - Feature Implemented: ...
EOF
```

If the feature resolves or adds an item in `docs/dev/technical-debts.md` or
`potential-bugs.md`, update that item in the same commit.
