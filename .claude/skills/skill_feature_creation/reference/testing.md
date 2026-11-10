# Testing

What to test: every acceptance criterion, and every piece of non-trivial
logic (branch, loop, parser, permission, saved-state round trip). Trivial
glue gets no test of its own. Prefer one test that would have caught a real
mistake over five that restate the implementation.

## Which layer

| Changed | Test with | Location |
|---|---|---|
| util / service | vitest | `src/<area>/__tests__/<name>.test.ts` |
| store | vitest, real Pinia | `src/stores/__tests__/<store>.test.ts` |
| composable | vitest | `src/composables/__tests__/<name>.test.ts` |
| component / view | vitest + `@testing-library/vue` | `src/components/__tests__/<Name>.test.ts` |
| user workflow on one page | Playwright against API mocks | `e2e/tests/<feature>.spec.ts` |
| flow across 2+ pages | Playwright | `e2e/tests/user-journeys.spec.ts` |
| route, service, schema | pytest | `api/tests/test_<area>.py` |
| permission gate | pytest allow + deny case | `api/tests/test_permission_routes.py` |

## Vitest (happy-dom, globals on)

- Real Pinia: `setActivePinia(createPinia())` in `beforeEach`. Not
  `createTestingPinia` — computed getters must really compute.
- Data from factories in `src/__tests__/fixtures/` (`createNode`,
  `createEdge`, `createGraphContext`, …), not hand-built literals.
- `d3-force-3d` is aliased to a mock; `ext-3d-force/` is excluded.
- Objects held in a `ref` are proxies: `toBe` on them fails, compare fields
  or use `toEqual`.
- `<Teleport to="body">` content is not in `container`: query
  `document.body` and clean up in `afterEach`.
- Same text in two elements makes `getByText` throw: use a `data-testid` or
  `container.querySelector`.
- Time-dependent logic: `vi.useFakeTimers()`.

## Playwright (no backend; routes are intercepted)

```typescript
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts } from '../helpers/api-mocks';

test('user can do the thing', async ({ authenticatedPage: page }) => {
  await seedContexts(page, [MOCK_CONTEXT]);   // later routes override setupAPIMocks defaults
  await page.goto('/my-route');
  await expect(page.getByTestId('my-thing')).toBeVisible();
});
```

- Fixtures: `authenticatedPage`, `superuserPage` (`superuserTest`),
  `unauthenticatedPage` (`unauthenticatedTest`).
- A new endpoint needs a route in `e2e/helpers/api-mocks.ts` and data in
  `e2e/fixtures/mock-data.ts`, or the page hangs on an unmocked request.
- Canvas assertions go through `e2e/helpers/graph-hooks.ts`, not pixels.
- Prefer `getByTestId` / `getByRole`; `getByRole('heading', { name })`
  avoids matching `<option>` text; `{ exact: true }` on ambiguous titles.
- No fixed sleeps: wait on a locator or a response.

## Pytest

- `client` fixtures build the app on the memory store; a conftest autouse
  fixture blocks any live warehouse call.
- Test the DB branch too when you add one (see `backend.md`); the default
  run will not exercise it.
- `tests/test_admin_registry.py`, `test_api_docs.py`, `test_app_docs.py`
  and `test_agent_registry.py` are structural guards. When one goes red,
  it is telling you which registry or generated doc to update (`gates.md`);
  do not edit the test.

## Running

While iterating, run only the file you are working on:

```bash
cd frontend && npx vitest run src/<path>/__tests__/<name>.test.ts
cd frontend && npx playwright test -c e2e/playwright.config.ts tests/<spec>.spec.ts --reporter=line --trace off
cd api && uv run pytest tests/test_<area>.py -q -p no:cacheprovider
```

Before finishing: `verify.sh` (changed-file checks), and
`verify.sh --full` before a PR. Whole suites, when you need them
directly: `make test-unit` (vitest + pytest), `make test-e2e`,
`make test-all`. The pre-commit hook runs `vitest related` on staged
`frontend/src/**/*.ts`, ruff on `api/`, and gitleaks.

`npx vitest related <file>` fails with a Rollup parse error for any file
whose import graph reaches a `.vue` component; run the test file directly
with `npx vitest run <test file>` instead.
