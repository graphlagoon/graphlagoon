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

  // Node property batch endpoint (POST) — progressive load enrichment.
  // Answers from MOCK_GRAPH_RESPONSE so enriched properties match what the
  // non-progressive path would have returned in one shot.
  await page.route('**/graphlagoon/api/graph-contexts/*/nodes/batch', (route) => {
    const requested: string[] = route.request().postDataJSON()?.node_ids ?? [];
    const wanted = new Set(requested);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        nodes: MOCK_GRAPH_RESPONSE.nodes.filter((n) => wanted.has(n.node_id)),
      }),
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

  // Async graph query job flow (the frontend uses these now): submit → job_id,
  // then poll returns succeeded with the graph. Cancel returns 204.
  await page.route('**/graphlagoon/api/graph-contexts/*/query/async', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'running', job_id: 'e2e-graph-job' }),
    }),
  );
  await page.route('**/graphlagoon/api/graph-contexts/*/cypher/async', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'running',
        job_id: 'e2e-graph-job',
        transpiled_sql: 'SELECT * FROM edges',
      }),
    }),
  );
  await page.route(
    '**/graphlagoon/api/graph-contexts/*/query/job/*/cancel',
    (route) => route.fulfill({ status: 204, body: '' }),
  );
  await page.route(
    '**/graphlagoon/api/graph-contexts/*/query/job/*',
    (route) => {
      if (route.request().url().endsWith('/cancel')) return route.continue();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'succeeded',
          job_id: 'e2e-graph-job',
          result: { ...MOCK_GRAPH_RESPONSE, transpiled_sql: 'SELECT * FROM edges' },
          transpiled_sql: 'SELECT * FROM edges',
        }),
      });
    },
  );

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
        metadata: { total_ms: 42.5, transpilation_ms: 8.1 },
      }),
    });
  });

  // Query templates (default: empty list; POST echoes back with an id)
  await page.route('**/graphlagoon/api/graph-contexts/*/query-templates', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    } else if (route.request().method() === 'POST') {
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'tpl-new',
          visibility: 'shared',
          ...JSON.parse(route.request().postData() || '{}'),
        }),
      });
    } else {
      route.continue();
    }
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
 * Mock GET .../graph-contexts/{id}/schema-drift. Call AFTER seedContexts —
 * seedContexts' per-context route pattern has no trailing wildcard, so it
 * never matches this path and the two coexist without needing precedence.
 */
export async function mockSchemaDrift(page: Page, contextId: string, drift: any) {
  await page.route(
    `**/graphlagoon/api/graph-contexts/${contextId}/schema-drift**`,
    (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(drift) });
    },
  );
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
  response:
    | { columns?: string[]; rows?: (string | null)[][]; row_count?: number; truncated?: boolean; transpiled_sql?: string; metadata?: Record<string, number> }
    | { status: number; body: any },
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
        metadata: response.metadata ?? { total_ms: 12.3, transpilation_ms: 3.4 },
      }),
    });
  });
}

/**
 * Simulate a long-running (cancellable) table query. The submit returns
 * status="running" + a statement_id; polling keeps returning "running" so the
 * Cancel button stays visible; the cancel endpoint returns 204. Call AFTER
 * setupAPIMocks. Returns the statement_id used, for asserting the cancel URL.
 */
export async function mockCancellableTableQuery(
  page: Page,
  statementId = 'stmt-e2e',
) {
  // Cancel (most specific first is irrelevant — globs don't overlap, but the
  // 204 route must exist before the poll route by glob specificity).
  await page.route(
    `**/graphlagoon/api/graph-contexts/*/query/table/*/cancel`,
    (route) => route.fulfill({ status: 204, body: '' }),
  );
  // Poll status — always still running.
  await page.route(
    `**/graphlagoon/api/graph-contexts/*/query/table/*`,
    (route) => {
      if (route.request().url().endsWith('/cancel')) {
        route.continue();
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'running', statement_id: statementId }),
      });
    },
  );
  // Submit — comes back running.
  await page.route(
    `**/graphlagoon/api/graph-contexts/*/query/table`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'running',
          statement_id: statementId,
          transpiled_sql: 'SELECT node_id FROM nodes',
          metadata: { transpilation_ms: 3.4 },
        }),
      }),
  );
  return statementId;
}

/**
 * Simulate a long-running graph query job: submit → running, then polls report
 * increasing chunk-download progress and never complete (so the overlay's
 * Cancel button + chunk bar stay visible). Cancel returns 204. Call AFTER
 * setupAPIMocks. Returns the job_id used, for asserting the cancel URL.
 */
export async function mockCancellableGraphJob(page: Page, jobId = 'graph-job-e2e') {
  await page.route(
    `**/graphlagoon/api/graph-contexts/*/query/job/*/cancel`,
    (route) => route.fulfill({ status: 204, body: '' }),
  );
  let poll = 0;
  await page.route(
    `**/graphlagoon/api/graph-contexts/*/query/job/*`,
    (route) => {
      if (route.request().url().endsWith('/cancel')) return route.continue();
      poll += 1;
      const done = Math.min(poll, 3);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'running',
          job_id: jobId,
          progress: { phase: 'edges', chunks_done: done, chunks_total: 4 },
        }),
      });
    },
  );
  await page.route(
    `**/graphlagoon/api/graph-contexts/*/query/async`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'running', job_id: jobId }),
      }),
  );
  return jobId;
}

/**
 * Seed query templates for a context (GET list). Call AFTER setupAPIMocks.
 */
export async function seedQueryTemplates(page: Page, contextId: string, templates: any[]) {
  // Templates default to "shared" visibility, matching the backend's server default.
  const seeded = templates.map((t) => ({ visibility: 'shared', ...t }));
  await page.route(`**/graphlagoon/api/graph-contexts/${contextId}/query-templates`, (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(seeded) });
    } else {
      route.continue();
    }
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
