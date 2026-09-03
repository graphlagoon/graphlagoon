# Admin area — how it is built and when to update it

The admin area (`/admin`, `api/graphlagoon/routers/admin.py`) is the
superuser's view of the environment. This page is for maintainers: what
protects it, and **what you must update when the environment grows** — most
of which is enforced by tests, so read the failing message first.

The area is deliberately absent from the public docs site (operator-only surface); this page is the reference.

## Security model

| Layer | Mechanism | Test |
|---|---|---|
| API gate | `APIRouter(prefix="/api/admin", dependencies=[Depends(require_superuser)])` — every handler inherits it | `test_admin.py::TestGate::test_every_route_rejects_non_superuser` (walks `admin.router.routes`) |
| Identity | `get_current_user` → `request.state` → `configure_auth` provider → `X-Forwarded-Email` → dev default. The provider step exists so a host app that mounted graphlagoon without `AuthMiddleware` cannot be bypassed by a forged header | `test_user_provider_wins_over_forged_header`, `test_async_provider_without_middleware_is_a_500` |
| Secrets | `GET /api/admin/config` is an **allowlist**: every `Settings` field is classified in `admin_registry.CONFIG_FIELD_KINDS`; `secret` → `set`/`not set`, `hidden` → omitted | `test_admin_registry::test_every_setting_is_classified`, `test_config_never_leaks_secrets` |
| Destructive | `POST /api/admin/environment/clear` (and the `DELETE /api/dev/clear-all` alias) need dev mode **and** superuser **and** the literal `CLEAR ALL`; `usage_logs` is never truncated | `TestDangerZone` |
| Audit | `services/audit.record` writes `usage_logs` (DB) or `InMemoryStore.usage_logs` (memory, bounded 10k); metadata capped at 4 KB; never raises | `test_audit.py` |
| Frontend | `meta.superuserOnly` in the router guard + `v-if="isSuperuser"` link. UX only. Config is re-fetched after dev login/logout so the flag matches the identity | `router/__tests__/guards.test.ts`, `e2e/tests/admin.spec.ts` |

Deliberately **not** in scope: editing settings / datasources / superusers at
runtime (`get_settings()` is `lru_cache`d and connections are registered in
`create_app`), enumerating presets or precomputed graphs across contexts
(name-keyed stores without listing), impersonation.

## When to update the admin area

| If you… | Then update… | Enforced by |
|---|---|---|
| add a field to `Settings` (new env var) | classify it in `routers/admin_registry.CONFIG_FIELD_KINDS` (`public` / `secret` / `hidden`). URLs that can embed credentials are `secret` | `test_admin_registry::test_every_setting_is_classified` |
| add a table / persisted entity (DB **and** `InMemoryStore`) | add it to `CLEARABLE_TABLES` (FK-safe order) or `PRESERVED_TABLES` (with reason); clear it in `InMemoryStore.clear_all`; add a count to `AdminCounts` if it is user-owned; extend `graphlagoon.dev.seed` so the tab has data | `test_every_table_is_clearable_or_preserved`, `test_memory_store_clear_all_empties_every_collection` |
| add a `POST` / `PUT` / `DELETE` route anywhere under `/api` | decide: `AUDITED_ROUTES` + `audit.record(...)` in the handler + a new `AuditAction`, or `AUDIT_EXEMPT_ROUTES` with the reason | `test_every_mutating_route_is_audited_or_exempt`, `test_audited_routes_reference_audit_module` |
| add a router module to `create_api_router` | list it in `tests/test_admin_registry.ROUTER_MODULES` | `test_router_module_list_is_complete` |
| add a route under `/api/admin` | nothing for the gate (inherited). Give the parametrised 403 test a valid body in `_valid_request_for` if it has one, and update the expected-routes snapshot | `test_expected_routes` |
| add a flag to `/api/config` | nothing — `build_public_config` is shared, the Overview shows every boolean | by construction |
| add a datasource type / REST connection kind | nothing for the listing (it comes from `build_public_config`); consider a probe in `services/environment.py` if it has a cheap health endpoint | review |
| add an Alembic migration | nothing — the overview reads `alembic_version` | — |
| add a new frontend-facing audit action | `describeAudit` in `utils/adminView.ts` for a readable line (falls back to `key=value`) | `AdminView.logic.test.ts` |
| add a permission to the catalog (`services/permission_catalog.py`) | put `Depends(require_permission("<id>"))` on the route it protects and hide the matching frontend affordance behind `usePermissions().can('<id>')`; the admin matrix/inspector render it automatically | `test_admin_registry::test_permission_gates_reference_catalog` |
| add a route under `/api/admin` for groups/permissions | it goes in `routers/admin_groups.py` — a SIBLING of `admin.router` (FastAPI 0.139's lazy nested includes hide routes from introspection) with its own `require_superuser` router dependency; update `test_admin_groups.py`'s gate walk body builder if it has one | `test_admin_groups::TestGate` |

The skill [`skill_feature_creation`](../../.claude/skills/skill_feature_creation/SKILL.md)
has a mandatory **Step 4.2b — Admin-area impact** that asks these questions
and requires the decision-log entry to state either what was updated or
"No admin-area impact".

## Dev seed

`api/graphlagoon/dev/seed.py` (CLI: `python -m graphlagoon.dev.seed`) is the
generator behind `make dev-seed`. It runs over HTTP against the live stack
with one `X-Forwarded-Email` per generated user, so it goes through the same
auth, sharing, ownership and audit code as real traffic and works for both
persistence modes. Deterministic per `--seed`, idempotent via a `seed:<hash>`
tag on the contexts, `--reset` clears through the admin API first,
`--no-graphs` skips the warehouse (used by `tests/test_dev_seed.py`, which
runs the generator in-process through `httpx.ASGITransport`).

When a new user-owned entity appears, add it to the generator so the admin
tabs (and screenshots) are not empty for it.
