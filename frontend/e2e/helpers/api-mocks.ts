import type { Page } from '@playwright/test';
import {
  MOCK_CONFIG,
  MOCK_GRAPH_RESPONSE,
  MOCK_DATASETS,
  MOCK_DEV_RANDOM_GRAPH,
} from '../fixtures/mock-data';

/**
 * Sets up API route interception for all backend endpoints.
 * Contexts/explorations CRUD is mocked with empty defaults.
 * Individual tests can override specific routes (later routes take precedence).
 */
export async function setupAPIMocks(page: Page) {
  // Config endpoint
  await page.route('**/graphlagoon/api/config', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_CONFIG),
    });
  });

  // --- Graph Context CRUD (default: empty) ---
  await page.route('**/graphlagoon/api/graph-contexts', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    } else if (route.request().method() === 'POST') {
      // Create context — echo back with an ID
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'ctx-new', ...JSON.parse(route.request().postData() || '{}') }),
      });
    } else {
      route.continue();
    }
  });

  // Individual context GET/PUT/DELETE
  await page.route('**/graphlagoon/api/graph-contexts/*/share/**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Subgraph endpoint (POST)
  await page.route('**/graphlagoon/api/graph-contexts/*/subgraph', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_GRAPH_RESPONSE),
    });
  });

  // Expand endpoint (POST)
  await page.route('**/graphlagoon/api/graph-contexts/*/expand', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_GRAPH_RESPONSE),
    });
  });

  // Query endpoint (POST)
  await page.route('**/graphlagoon/api/graph-contexts/*/query', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_GRAPH_RESPONSE),
    });
  });

  // Cypher endpoint (POST)
  await page.route('**/graphlagoon/api/graph-contexts/*/cypher', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...MOCK_GRAPH_RESPONSE,
        transpiled_sql: 'SELECT * FROM edges',
      }),
    });
  });

  // Generic tabular query endpoint (POST) — Query Console
  await page.route('**/graphlagoon/api/graph-contexts/*/query/table', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: ['node_id', 'name'],
        rows: [
          ['n1', 'Alice'],
          ['n2', 'Bob'],
        ],
        row_count: 2,
        truncated: false,
        transpiled_sql: 'SELECT node_id, name FROM nodes',
      }),
    });
  });

  // Context-specific explorations
  await page.route('**/graphlagoon/api/graph-contexts/*/explorations', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  // Datasets endpoint
  await page.route('**/graphlagoon/api/datasets', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_DATASETS),
    });
  });

  // Dev random graph (POST)
  await page.route('**/graphlagoon/api/dev/random-graph', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_DEV_RANDOM_GRAPH),
    });
  });

  // Dev clear all (DELETE)
  await page.route('**/graphlagoon/api/dev/clear-all', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    });
  });

  // Catalog refresh
  await page.route('**/graphlagoon/api/catalog/refresh', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    });
  });

  // All explorations list
  await page.route('**/graphlagoon/api/explorations', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    } else {
      route.continue();
    }
  });

  // Individual exploration operations (GET/PUT/DELETE)
  await page.route('**/graphlagoon/api/explorations/*', (route) => {
    if (route.request().method() === 'DELETE') {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } else {
      route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"Not found"}' });
    }
  });

  // Schema discovery
  await page.route('**/graphlagoon/api/schema-discovery', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ node_types: ['Person', 'Company'], relationship_types: ['KNOWS', 'WORKS_AT'] }),
    });
  });
}

/**
 * Seed contexts via API mock. Call AFTER setupAPIMocks (later routes take precedence).
 */
export async function seedContexts(page: Page, contexts: any[]) {
  // Override GET /api/graph-contexts to return the seeded list
  await page.route('**/graphlagoon/api/graph-contexts', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(contexts),
      });
    } else {
      route.continue();
    }
  });

  // Mock individual context GET and DELETE for each context
  for (const ctx of contexts) {
    const pattern = `**/graphlagoon/api/graph-contexts/${ctx.id}`;
    await page.route(pattern, (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(ctx),
        });
      } else if (method === 'DELETE') {
        route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      } else if (method === 'PUT') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...ctx, ...JSON.parse(route.request().postData() || '{}') }),
        });
      } else {
        route.continue();
      }
    });
  }
}

/**
 * Seed explorations via API mock. Call AFTER setupAPIMocks (later routes take precedence).
 */
export async function seedExplorations(page: Page, explorations: any[]) {
  // Override GET /api/explorations to return all explorations
  await page.route('**/graphlagoon/api/explorations', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(explorations),
      });
    } else {
      route.continue();
    }
  });

  // Override context-specific explorations
  const byContext = new Map<string, any[]>();
  for (const exp of explorations) {
    const ctxId = exp.graph_context_id;
    if (!byContext.has(ctxId)) byContext.set(ctxId, []);
    byContext.get(ctxId)!.push(exp);
  }

  for (const [ctxId, exps] of byContext) {
    await page.route(`**/graphlagoon/api/graph-contexts/${ctxId}/explorations`, (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(exps),
        });
      } else {
        route.continue();
      }
    });
  }

  // Individual exploration GET/DELETE
  for (const exp of explorations) {
    await page.route(`**/graphlagoon/api/explorations/${exp.id}`, (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(exp),
        });
      } else if (method === 'DELETE') {
        route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      } else {
        route.continue();
      }
    });
  }
}

/**
 * Override the tabular query endpoint (Query Console). Call AFTER setupAPIMocks.
 * Pass `{ status, body }` to simulate an error response.
 */
export async function mockTableQuery(
  page: Page,
  response: { columns?: string[]; rows?: (string | null)[][]; row_count?: number; truncated?: boolean; transpiled_sql?: string } | { status: number; body: any },
) {
  await page.route('**/graphlagoon/api/graph-contexts/*/query/table', (route) => {
    if ('status' in response) {
      route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
      return;
    }
    const rows = response.rows ?? [];
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: response.columns ?? [],
        rows,
        row_count: response.row_count ?? rows.length,
        truncated: response.truncated ?? false,
        transpiled_sql: response.transpiled_sql,
      }),
    });
  });
}

/**
 * Sets up API mocks that simulate errors.
 */
export async function setupAPIErrorMocks(page: Page) {
  await page.route('**/graphlagoon/api/config', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_CONFIG),
    });
  });

  await page.route('**/graphlagoon/api/graph-contexts/*/subgraph', (route) => {
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'Internal server error' }),
    });
  });
}
