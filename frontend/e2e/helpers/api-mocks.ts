import type { Page } from '@playwright/test';
import {
  MOCK_CONFIG,
  MOCK_GRAPH_RESPONSE,
  MOCK_DATASETS,
  MOCK_DEV_RANDOM_GRAPH,
  MOCK_ADMIN_AUDIT,
  MOCK_ADMIN_CONFIG,
  MOCK_ADMIN_CONTEXTS,
  MOCK_ADMIN_EXPLORATIONS,
  MOCK_ADMIN_GROUPS,
  MOCK_ADMIN_OVERVIEW,
  MOCK_ADMIN_PERMISSIONS,
  MOCK_PERMISSION_INSPECTION,
  MOCK_RESOLVER_STATUS,
  MOCK_ADMIN_USERS,
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
 * Override every graph-returning endpoint with a custom response. Call AFTER
 * setupAPIMocks (later routes take precedence). Used by the docs screenshot
 * generator to serve a denser, curated graph than MOCK_GRAPH_RESPONSE.
 */
export async function seedGraphResponse(page: Page, graph: any) {
  const body = JSON.stringify(graph);
  for (const endpoint of ['subgraph', 'expand', 'query']) {
    await page.route(`**/graphlagoon/api/graph-contexts/*/${endpoint}`, (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body });
    });
  }
  await page.route('**/graphlagoon/api/graph-contexts/*/cypher', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...graph, transpiled_sql: 'SELECT * FROM edges' }),
    });
  });
  await page.route('**/graphlagoon/api/graph-contexts/*/query/job/*', (route) => {
    if (route.request().url().endsWith('/cancel')) return route.continue();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'succeeded',
        job_id: 'e2e-graph-job',
        result: { ...graph, transpiled_sql: 'SELECT * FROM edges' },
        transpiled_sql: 'SELECT * FROM edges',
      }),
    });
  });
  await page.route('**/graphlagoon/api/graph-contexts/*/nodes/batch', (route) => {
    const requested: string[] = route.request().postDataJSON()?.node_ids ?? [];
    const wanted = new Set(requested);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        nodes: graph.nodes.filter((n: any) => wanted.has(n.node_id)),
      }),
    });
  });
}

/**
 * Advertise extra datasource types to the app.
 *
 * The config is injected as a window global before any script runs (see
 * test-fixtures), so a route mock alone would never be read — this merges into
 * that global as well. Call BEFORE `page.goto`.
 */
export async function enableDatasources(
  page: Page,
  datasources: Record<string, boolean>,
  datasourceConnections: any[] = [],
) {
  await page.addInitScript(
    (cfg) => {
      const w = window as any;
      w.__GRAPH_LAGOON_CONFIG__ = {
        ...(w.__GRAPH_LAGOON_CONFIG__ || {}),
        datasources: cfg.datasources,
        datasource_connections: cfg.datasourceConnections,
      };
    },
    { datasources, datasourceConnections },
  );

  await page.route('**/graphlagoon/api/config', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        dev_mode: true,
        database_enabled: false,
        datasources,
        datasource_connections: datasourceConnections,
      }),
    });
  });
}

/**
 * Advertise similarity endpoints to the app (the catalog the Clusters →
 * Similarity tab fetches on mount). Call AFTER setupAPIMocks — later routes
 * take precedence. The compute endpoints themselves live on the parent app;
 * mock those separately per test if a computation should actually run.
 */
export async function seedSimilarityEndpoints(page: Page, endpoints: any[]) {
  await page.route('**/graphlagoon/api/similarity/endpoints', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(endpoints),
    });
  });
}

/**
 * Mock the query endpoints for a native-graph context: openCypher runs as-is,
 * so `transpiled_sql` comes back null and the console returns rows inline with
 * no statement id.
 */
export async function mockNeptuneQueries(page: Page, graph: any) {
  await page.route('**/graphlagoon/api/graph-contexts/*/cypher', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...graph, transpiled_sql: null }),
    });
  });

  await page.route('**/graphlagoon/api/graph-contexts/*/cypher/async', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'running', job_id: 'job-neptune-1' }),
    });
  });

  await page.route('**/graphlagoon/api/graph-contexts/*/query/job/*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'succeeded',
        job_id: 'job-neptune-1',
        result: graph,
        transpiled_sql: null,
      }),
    });
  });

  await page.route('**/graphlagoon/api/graph-contexts/*/query/table', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'succeeded',
        statement_id: null,
        columns: ['name'],
        rows: [['Alice'], ['Bob']],
        row_count: 2,
        truncated: false,
        transpiled_sql: null,
      }),
    });
  });
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
  // Override GET /api/explorations (with the F1 `mine`/`q` params) to return the seeded explorations
  await page.route(/\/graphlagoon\/api\/explorations(\?.*)?$/, (route) => {
    if (route.request().method() === 'GET') {
      const params = new URL(route.request().url()).searchParams;
      const q = (params.get('q') ?? '').toLowerCase();
      const mine = params.get('mine') === 'true';
      const rows = explorations.filter(
        (e) => (!mine || e.owner_email === 'e2e@test.com') && (!q || String(e.title).toLowerCase().includes(q)),
      );
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(rows),
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
      } else if (method === 'PUT') {
        // Rename / state update: echo the patch back over the seeded entity,
        // the way the API does.
        const patch = route.request().postDataJSON?.() ?? {};
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...exp, ...patch, updated_at: new Date().toISOString() }),
        });
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

/**
 * Serve precomputed graphs for one context. Call AFTER setupAPIMocks — later
 * routes take precedence.
 *
 * `entries` maps a key to the graph it resolves to. A key is either a bare name
 * (`'fraude-2024'`) or a name plus its provider arguments in sorted order
 * (`'vizinhanca?hops=3&seed=99872'`), which is what lets a spec prove that
 * changing `?seed=` resolves to a different graph rather than replaying the
 * same one.
 *
 * There is no listing route because the API has none. The collection URL serves
 * capabilities instead — and it must be mocked, or the panel's on-mount fetch
 * escapes to the dev server in every spec that opens it.
 *
 * Writes and deletes mutate the same map, so a spec can walk the whole round
 * trip without a backend.
 */
export async function seedPrecomputedGraphs(
  page: Page,
  contextId: string,
  entries: Record<string, { nodes: any[]; edges: any[]; truncated?: boolean }>,
  capabilities: { can_write?: boolean; can_delete?: boolean } = {},
) {
  const store: Record<string, any> = {};

  /** Name plus sorted arguments — the identity of one resolution. */
  const keyFor = (name: string, search: string) => {
    const params = new URLSearchParams(search);
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (sorted.length === 0) return name;
    return `${name}?${sorted.map(([k, v]) => `${k}=${v}`).join('&')}`;
  };

  const wrap = (name: string, graph: any, source?: any, params: any = {}) => ({
    payload_version: 1,
    name,
    context_id: contextId,
    provider: 'volume',
    params,
    created_at: '2026-08-20T12:00:00.000Z',
    created_by: 'e2e@test.com',
    node_count: graph?.nodes?.length ?? 0,
    edge_count: graph?.edges?.length ?? 0,
    properties_complete: true,
    source: source ?? { kind: 'cypher', query: 'MATCH (n) RETURN n' },
    graph: {
      nodes: graph.nodes,
      edges: graph.edges,
      truncated: graph.truncated ?? false,
      properties_deferred: false,
    },
  });

  for (const [key, graph] of Object.entries(entries)) {
    const [name, search = ''] = key.split('?');
    store[key] = wrap(name, graph, undefined, Object.fromEntries(new URLSearchParams(search)));
  }

  // The collection URL: capabilities, never an inventory.
  await page.route(
    `**/graphlagoon/api/graph-contexts/${contextId}/precomputed-graphs`,
    (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: true,
          can_write: capabilities.can_write ?? true,
          can_delete: capabilities.can_delete ?? capabilities.can_write ?? true,
          providers: [
            {
              name: 'volume',
              label: 'Volume',
              description: '',
              caveat: '',
              capabilities: {
                write: capabilities.can_write ?? true,
                delete: capabilities.can_delete ?? capabilities.can_write ?? true,
              },
              params: [],
            },
          ],
        }),
      });
    },
  );

  await page.route(
    `**/graphlagoon/api/graph-contexts/${contextId}/precomputed-graphs/*`,
    (route) => {
      const method = route.request().method();
      const tail = route.request().url().split('/precomputed-graphs/')[1];
      const [rawName, search = ''] = tail.split('?');
      const name = decodeURIComponent(rawName);
      const key = keyFor(name, search);

      if (method === 'GET') {
        if (!store[key]) {
          route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({
              detail: {
                error: {
                  code: 'PRECOMPUTED_GRAPH_NOT_FOUND',
                  message: `No precomputed graph named '${name}' for this context.`,
                  details: { name },
                },
              },
            }),
          });
          return;
        }
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(store[key]),
        });
        return;
      }

      if (method === 'PUT') {
        const body = JSON.parse(route.request().postData() || '{}');
        store[key] = wrap(name, body.graph, body.source);
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            name,
            size_bytes: JSON.stringify(store[key]).length,
            modified_at: store[key].created_at,
          }),
        });
        return;
      }

      if (method === 'DELETE') {
        // Idempotent, like the API: without a listing there is no way to check
        // first, so a delete of something absent must still succeed.
        delete store[key];
        route.fulfill({ status: 204, body: '' });
        return;
      }

      route.continue();
    },
  );
}

/**
 * Serve named style presets for one context. Call AFTER setupAPIMocks.
 *
 * Unlike graph caches these do have a listing route, because presets are
 * hand-authored and bounded. `owners` optionally maps a preset name to the
 * email that created it, so a spec can exercise the creator-only delete rule.
 */
export async function seedStylePresets(
  page: Page,
  contextId: string,
  entries: Record<string, Record<string, any>>,
  owners: Record<string, string> = {},
) {
  const store: Record<string, any> = {};
  const ME = 'e2e@test.com';

  const wrap = (name: string, settings: any, description?: string | null) => ({
    preset_version: 1,
    name,
    context_id: contextId,
    created_at: '2026-08-20T12:00:00.000Z',
    created_by: owners[name] ?? store[name]?.created_by ?? ME,
    updated_at: null,
    description: description ?? null,
    settings,
  });

  for (const [name, settings] of Object.entries(entries)) {
    store[name] = wrap(name, settings);
  }

  await page.route(
    `**/graphlagoon/api/graph-contexts/${contextId}/style-presets`,
    (route) => {
      if (route.request().method() !== 'GET') {
        route.continue();
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          presets: Object.values(store).map((p: any) => ({
            name: p.name,
            size_bytes: JSON.stringify(p).length,
            modified_at: p.created_at,
          })),
        }),
      });
    },
  );

  await page.route(
    `**/graphlagoon/api/graph-contexts/${contextId}/style-presets/*`,
    (route) => {
      const method = route.request().method();
      const name = decodeURIComponent(
        route.request().url().split('/style-presets/')[1].split('?')[0],
      );

      const notFound = () =>
        route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: {
              error: {
                code: 'STYLE_PRESET_NOT_FOUND',
                message: `No style preset named '${name}' for this context.`,
                details: {},
              },
            },
          }),
        });

      if (method === 'GET') {
        if (!store[name]) return notFound();
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(store[name]),
        });
        return;
      }

      if (method === 'PUT') {
        const body = JSON.parse(route.request().postData() || '{}');
        store[name] = wrap(name, body.settings, body.description);
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(store[name]),
        });
        return;
      }

      if (method === 'DELETE') {
        const owner = store[name]?.created_by;
        // Mirrors the real rule: only the creator may remove a preset.
        if (owner && owner !== ME) {
          route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({
              detail: {
                error: {
                  code: 'FORBIDDEN',
                  message: `Style preset '${name}' was created by ${owner}. Only its creator can delete it.`,
                  details: { created_by: owner },
                },
              },
            }),
          });
          return;
        }
        delete store[name];
        route.fulfill({ status: 204, body: '' });
        return;
      }

      route.continue();
    },
  );
}

/**
 * Admin area (superuser only). Mocks every /api/admin/* route plus the
 * contexts/explorations listings the Contexts and Explorations tabs reuse.
 * Call AFTER setupAPIMocks. Transfer requests are recorded on the returned
 * object so a test can assert what the UI sent; `forbidden: true` makes every
 * admin route answer 403 (what a non-superuser gets from the backend).
 */
export async function seedAdmin(
  page: Page,
  overrides: {
    overview?: any;
    config?: any[];
    users?: any;
    contexts?: any[];
    explorations?: any[];
    audit?: any;
    groups?: any;
    permissions?: any;
    inspection?: any;
    forbidden?: boolean;
  } = {},
) {
  const calls: {
    transfers: Array<{ url: string; body: any }>;
    clears: any[];
    groupSaves: Array<{ method: string; url: string; body: any }>;
    permissionPuts: Array<{ url: string; body: any }>;
  } = {
    transfers: [],
    clears: [],
    groupSaves: [],
    permissionPuts: [],
  };
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  const forbidden = json(
    { detail: { error: { code: 'FORBIDDEN', message: 'This action is restricted to superusers.', details: {} } } },
    403,
  );
  const overview = overrides.overview ?? MOCK_ADMIN_OVERVIEW;
  const users = overrides.users ?? MOCK_ADMIN_USERS;
  const audit = overrides.audit ?? MOCK_ADMIN_AUDIT;
  const contexts = overrides.contexts ?? MOCK_ADMIN_CONTEXTS;
  const explorations = overrides.explorations ?? MOCK_ADMIN_EXPLORATIONS;

  await page.route('**/graphlagoon/api/admin/**', (route) => {
    if (overrides.forbidden) return route.fulfill(forbidden);
    const url = route.request().url();
    const method = route.request().method();
    // Most specific paths first — '/admin/groups' would swallow the refresh
    // endpoint, '/admin/permissions' the inspector.
    if (url.includes('/admin/groups/resolution/refresh') && method === 'POST')
      return route.fulfill(json(MOCK_RESOLVER_STATUS));
    if (url.includes('/admin/permissions/inspect'))
      return route.fulfill(json(overrides.inspection ?? MOCK_PERMISSION_INSPECTION));
    if (url.includes('/admin/groups')) {
      const groups = overrides.groups ?? MOCK_ADMIN_GROUPS;
      if (method === 'GET') return route.fulfill(json(groups));
      const body = JSON.parse(route.request().postData() || '{}');
      calls.groupSaves.push({ method, url, body });
      if (method === 'DELETE') return route.fulfill(json({ status: 'deleted' }));
      const id = method === 'PUT' ? url.split('/').pop() : 'grp-new';
      return route.fulfill(
        json(
          {
            id,
            name: body.name,
            description: body.description ?? null,
            members: (body.members ?? []).map((m: any, i: number) => ({ id: `m${i}`, ...m })),
          },
          method === 'POST' ? 201 : 200,
        ),
      );
    }
    if (url.includes('/admin/permissions')) {
      const permissions = overrides.permissions ?? MOCK_ADMIN_PERMISSIONS;
      if (method === 'GET') return route.fulfill(json(permissions));
      const body = JSON.parse(route.request().postData() || '{}');
      calls.permissionPuts.push({ url, body });
      const permissionId = url.split('/').pop();
      const row = permissions.items.find((p: any) => p.id === permissionId) ?? permissions.items[0];
      return route.fulfill(
        json({
          ...row,
          mode: body.mode,
          rules: (body.rules ?? []).map((r: any) => ({
            ...r,
            group_name:
              (overrides.groups ?? MOCK_ADMIN_GROUPS).items.find((g: any) => g.id === r.group_id)?.name ?? '?',
          })),
        }),
      );
    }
    if (url.includes('/admin/overview')) return route.fulfill(json(overview));
    if (url.includes('/admin/health/warehouse'))
      return route.fulfill(json({ status: 'ok', latency_ms: 12.5, detail: null }));
    if (url.includes('/admin/config')) return route.fulfill(json(overrides.config ?? MOCK_ADMIN_CONFIG));
    if (url.includes('/admin/users')) return route.fulfill(json(users));
    if (url.includes('/admin/audit')) return route.fulfill(json(audit));
    if (url.includes('/transfer') && method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.transfers.push({ url, body });
      const id = url.split('/').slice(-2)[0];
      return route.fulfill(json({ id, previous_owner_email: 'previous@example.com', owner_email: body.new_owner_email }));
    }
    if (url.includes('/environment/clear') && method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.clears.push(body);
      if (body.confirm !== 'CLEAR ALL')
        return route.fulfill(json({ detail: { error: { code: 'CONFIRMATION_REQUIRED', message: 'Type "CLEAR ALL" to confirm.', details: {} } } }, 400));
      return route.fulfill(json({ status: 'cleared', cleared: ['memory'], warehouse: null }));
    }
    return route.fulfill(json({ detail: 'unmocked admin route' }, 404));
  });

  await seedContexts(page, contexts);
  await page.route('**/graphlagoon/api/explorations', (route) => {
    if (route.request().method() === 'GET') route.fulfill(json(explorations));
    else route.continue();
  });
  for (const exp of explorations) {
    await page.route(`**/graphlagoon/api/explorations/${exp.id}`, (route) => {
      if (route.request().method() === 'DELETE') route.fulfill(json({ status: 'deleted' }));
      else route.fulfill(json(exp));
    });
  }
  return calls;
}

/**
 * Seed investigations (cases) and their material (05 §1). Call AFTER setupAPIMocks.
 * `POST /investigations` creates a case the other routes then serve; `POST .../items`
 * records the request in `added` and keeps the item (an exploration reference gets its
 * title and context from `explorations` when the id is there). Items, annotations,
 * the brief and the journal are kept in memory so the case round-trips.
 * `snapshots` answers `GET …/items/{id}/snapshot` by item id.
 */
export async function seedInvestigations(
  page: Page,
  investigations: any[],
  items: Record<string, any[]> = {},
  explorations: any[] = [],
  snapshots: Record<string, any> = {},
) {
  const added: any[] = [];
  const cases = new Map<string, any>(investigations.map((i) => [i.id, i]));
  const material = new Map<string, any[]>(investigations.map((i) => [i.id, [...(items[i.id] ?? [])]]));
  const annotations = new Map<string, any[]>();
  const events = new Map<string, any[]>();
  const briefs = new Map<string, string>();
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const now = () => new Date().toISOString();
  // The server recomputes the deadline on every status change (Pix/MED: 45 + 45 days).
  const deadline = (inv: any) => {
    const phased = inv.kind_preset === 'pix_med' || inv.deadline_days;
    inv.deadline = phased && (inv.status === 'open' || inv.status === 'analysis')
      ? { phase: inv.status, due_at: new Date(Date.now() + 45 * 864e5).toISOString(), days_left: inv.status === 'analysis' ? 90 : 45 }
      : null;
  };
  const journal = (id: string, kind: string, payload: Record<string, unknown>) => {
    const list = events.get(id) ?? [];
    list.push({ id: `ev-${list.length + 1}`, at: now(), actor_email: 'e2e@test.com', actor_kind: 'human', kind, payload });
    events.set(id, list);
  };
  const base = (id: string, body: any) => ({
    id, tags: [], status: 'confirmed', author_kind: 'human', author_email: 'e2e@test.com', provenance: {},
    current_version: 0, position: 0, accessible: true, pinned: [], created_at: now(), ...body,
  });
  // Table content (`_content` = {columns, rows}) backs GET …/content and the F3 table operations.
  const tableOf = (item: any) => {
    const c = item?._content ?? {};
    return { columns: (c.columns ?? []) as string[], rows: (c.rows ?? []) as any[][] };
  };
  const sharedKey = (tables: { columns: string[] }[]) =>
    tables[0]?.columns.find((c) => tables.every((t) => t.columns.some((o) => o.toLowerCase() === c.toLowerCase()))) ?? null;
  const joinTables = (items: any[], key: string) => {
    const tables = items.map(tableOf);
    const cols = [key, ...tables.flatMap((t) => t.columns.filter((c) => c !== key))];
    const byKey = new Map<string, any[]>();
    tables.forEach((t, ti) => {
      const ki = t.columns.indexOf(key);
      for (const r of t.rows) {
        const k = String(r[ki]);
        const row = byKey.get(k) ?? [k, ...tables.flatMap((x) => x.columns.filter((c) => c !== key).map(() => null))];
        let offset = 1 + tables.slice(0, ti).reduce((n, x) => n + x.columns.filter((c) => c !== key).length, 0);
        t.columns.forEach((c, i) => { if (c !== key) row[offset++] = r[i]; });
        byKey.set(k, row);
      }
    });
    return { columns: cols, rows: [...byKey.values()] };
  };
  const version = (item: any, run?: any) => ({
    id: `v-${item.id}-${item.current_version + 1}`, item_id: item.id, version: item.current_version + 1,
    sha256: `${item.current_version + 1}`.padStart(64, 'e'), size_bytes: 1, content_type: 'application/json', has_text: true,
    run: run ?? null, created_by: 'e2e@test.com', author_kind: 'human', created_at: now(),
  });
  const counts = (i: any) => {
    const list = material.get(i.id) ?? [];
    const notes = annotations.get(i.id) ?? [];
    const suggested = [...list, ...notes].filter((x) => x.status === 'suggested').length;
    return { item_count: i.item_count ?? list.length, suggested_count: suggested || (i.suggested_count ?? 0) };
  };

  // Saving a new exploration (F3 "Nova exploração" from the case) creates one the case can reference.
  await page.route(/\/graphlagoon\/api\/graph-contexts\/([^/?]+)\/explorations(\?.*)?$/, (route) => {
    const req = route.request();
    const ctxId = req.url().match(/graph-contexts\/([^/?]+)\/explorations/)![1];
    if (req.method() !== 'POST') return route.fulfill(json(explorations.filter((e) => e.graph_context_id === ctxId)));
    const body = req.postDataJSON();
    const exp = { id: `exp-new-${explorations.length + 1}`, graph_context_id: ctxId, owner_email: 'e2e@test.com', shared_with: [], has_write_access: true, created_at: now(), updated_at: now(), node_count: body.snapshot?.nodes?.length ?? null, ...body };
    explorations.push(exp);
    return route.fulfill(json(exp, 201));
  });

  await page.route('**/graphlagoon/api/investigations', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      const inv = {
        id: cases.has('inv-new') ? `inv-new-${cases.size}` : 'inv-new',
        status: 'open',
        kind_preset: 'livre',
        owner_email: 'e2e@test.com',
        tags: [],
        settings: {},
        state: {},
        shared_with: [],
        has_write_access: true,
        can_manage: true,
        created_at: now(),
        ...body,
      };
      deadline(inv);
      cases.set(inv.id, inv);
      material.set(inv.id, []);
      journal(inv.id, 'case.created', { title: inv.title });
      route.fulfill(json(inv, 201));
    } else {
      route.fulfill(json([...cases.values()].map((i) => ({ ...i, ...counts(i) }))));
    }
  });

  const CASE_RE = /\/graphlagoon\/api\/investigations\/([^/?]+)(?:\/([^/?]+))?(?:\/([^/?]+))?(?:\/([^/?]+))?(?:\/([^/?]+))?(?:\?.*)?$/;
  await page.route(/\/graphlagoon\/api\/investigations\/[^/?]+(\/.*)?(\?.*)?$/, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const [, id, sub, a, b] = url.pathname.match(CASE_RE)!;
    const inv = cases.get(id);
    if (!inv) return route.fulfill(json({ detail: { error: { code: 'INVESTIGATION_NOT_FOUND' } } }, 404));
    const method = req.method();
    const list = material.get(id)!;
    const notes = () => {
      const l = annotations.get(id) ?? [];
      annotations.set(id, l);
      return l;
    };

    if (!sub) {
      if (method === 'PATCH') {
        // Explicit transitions; the server answers 409 to anything else.
        const body = req.postDataJSON();
        const allowed: Record<string, string[]> = { open: ['analysis', 'archived'], analysis: ['open', 'archived'], decided: ['archived'], archived: ['analysis'] };
        if (body.status && body.status !== inv.status && !allowed[inv.status]?.includes(body.status)) {
          return route.fulfill(json({ detail: { error: { code: 'INVALID_STATUS_TRANSITION', message: 'invalid transition' } } }, 409));
        }
        Object.assign(inv, body, { updated_at: now() });
        deadline(inv);
        journal(id, 'case.updated', body);
        return route.fulfill(json(inv));
      }
      if (method === 'DELETE') {
        cases.delete(id);
        return route.fulfill(json({ status: 'deleted' }));
      }
      return route.fulfill(json(inv));
    }
    if (sub === 'share') {
      if (method === 'POST') {
        const body = req.postDataJSON();
        inv.shared_with = [...(inv.shared_with ?? []).filter((s: any) => s.email !== body.email), body];
        journal(id, 'case.shared', { with: body.email, role: body.role });
        return route.fulfill(json({ status: 'shared' }));
      }
      const email = decodeURIComponent(a ?? '');
      inv.shared_with = (inv.shared_with ?? []).filter((s: any) => s.email !== email);
      journal(id, 'case.unshared', { with: email });
      return route.fulfill(json({ status: 'removed' }));
    }
    if (sub === 'reopen') {
      if (inv.status !== 'decided') return route.fulfill(json({ detail: { error: { code: 'INVALID_STATUS_TRANSITION' } } }, 409));
      journal(id, 'case.reopened', { previous_frozen_hash: inv.frozen_hash, previous_decision: inv.decision, to: 'analysis' });
      Object.assign(inv, { status: 'analysis', decision: null, frozen_hash: null, frozen_at: null });
      deadline(inv);
      return route.fulfill(json(inv));
    }
    if (sub === 'decision') {
      const decided_at = now();
      inv.decision = { ...req.postDataJSON(), decided_by: 'e2e@test.com', decided_at };
      Object.assign(inv, { status: 'decided', frozen_hash: 'f'.repeat(60) + 'beef', frozen_at: decided_at, has_write_access: true });
      deadline(inv);
      journal(id, 'decision.recorded', inv.decision);
      return route.fulfill(json(inv));
    }
    if (sub === 'export') {
      const format = url.searchParams.get('format');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'content-disposition': `attachment; filename*=UTF-8''investigation-${id}-${format}.json` },
        body: JSON.stringify({ format }),
      });
    }
    if (sub === 'brief') {
      if (method === 'PUT') {
        const text = req.postDataJSON().text;
        briefs.set(id, text);
        let item = list.find((i) => i.subkind === 'brief');
        if (!item) {
          item = base(`brief-${id}`, { kind: 'document', subkind: 'brief', title: 'Brief' });
          list.push(item);
        }
        item.latest = version(item);
        item.current_version += 1;
        journal(id, 'item.version_added', { item_id: item.id, title: 'Brief', version: item.current_version });
        return route.fulfill(json({ item, text }));
      }
      return route.fulfill(json({ item: list.find((i) => i.subkind === 'brief') ?? null, text: briefs.get(id) ?? '' }));
    }
    if (sub === 'graph') return route.fulfill(json({ nodes: [], edges: [], restricted_sources: 0 }));
    if (sub === 'search') return route.fulfill(json([]));
    if (sub === 'analysis') {
      if (a === 'er') return route.fulfill(json([]));
      return route.fulfill(json({ paths: [], typologies: [], method: {} }));
    }

    if (sub === 'items' && (a === 'join' || a === 'compare' || a === 'promote')) {
      const body = req.postDataJSON();
      if (a === 'join') {
        const parents = body.item_ids.map((i: string) => list.find((x) => x.id === i));
        const key = body.key_column ?? sharedKey(parents.map(tableOf)) ?? 'id';
        const item = base(`item-${added.length + 1}`, {
          kind: 'table', subkind: 'result', title: body.title ?? `${parents.map((p: any) => p.title).join(' + ')} por ${key}`,
          provenance: { tool: 'join', parent_item_ids: body.item_ids, key_column: key }, position: list.length, _content: joinTables(parents, key),
        });
        item.latest = version(item);
        item.current_version = 1;
        added.push({ investigation_id: id, op: 'join', ...body });
        list.push(item);
        journal(id, 'item.created', { item_id: item.id, kind: 'table', subkind: 'result', title: item.title });
        return route.fulfill(json(item, 201));
      }
      if (a === 'compare') {
        const l = list.find((x) => x.id === body.left.item_id);
        const r = list.find((x) => x.id === body.right.item_id);
        const [lt, rt] = [tableOf(l), tableOf(r)];
        const key = body.key_column ?? sharedKey([lt, rt]) ?? lt.columns[0];
        const [li, ri] = [lt.columns.indexOf(key), rt.columns.indexOf(key)];
        const lm = new Map(lt.rows.map((x) => [String(x[li]), x]));
        const rm = new Map(rt.rows.map((x) => [String(x[ri]), x]));
        const shared = lt.columns.filter((c) => c !== key && rt.columns.includes(c));
        const changed = [...lm].filter(([k]) => rm.has(k)).flatMap(([k, x]) => {
          const fields: Record<string, any> = {};
          for (const c of shared) {
            const [lv, rv] = [x[lt.columns.indexOf(c)], rm.get(k)![rt.columns.indexOf(c)]];
            if (String(lv ?? '') !== String(rv ?? '')) fields[c] = { left: lv, right: rv };
          }
          return Object.keys(fields).length ? [{ key: k, fields }] : [];
        });
        const only_left = [...lm].filter(([k]) => !rm.has(k)).map(([, x]) => x);
        const only_right = [...rm].filter(([k]) => !lm.has(k)).map(([, x]) => x);
        added.push({ investigation_id: id, op: 'compare', ...body });
        return route.fulfill(json({
          key_column: key, columns: { left: lt.columns, right: rt.columns, shared },
          counts: { left: lt.rows.length, right: rt.rows.length, only_left: only_left.length, only_right: only_right.length, changed: changed.length, same: lm.size - only_left.length - changed.length },
          only_left, only_right, changed, truncated: false,
          left: { item_id: l.id, title: l.title, version: body.left.version ?? l.current_version },
          right: { item_id: r.id, title: r.title, version: body.right.version ?? r.current_version },
        }));
      }
      const out = body.item_ids.map((i: string) => {
        const item = list.find((x) => x.id === i)!;
        const columns = tableOf(item).columns;
        item.mapping = body.as === 'enrichment'
          ? { as: 'enrichment', spec: { name: item.title, key_column: body.options?.key_column ?? columns[0], columns: columns.filter((c) => c !== (body.options?.key_column ?? columns[0])), match_node_types: body.options?.match_node_types ?? ['*'], match_source: 'node_id', input: { delimiter: '\t', header: true } } }
          : { as: 'graph', spec: { version: 1, inputs: { t: { match: '*' } }, nodes: [], ...body.options } };
        journal(id, 'item.updated', { item_id: item.id, title: item.title, fields: ['mapping'] });
        return item;
      });
      added.push({ investigation_id: id, op: 'promote', ...body });
      return route.fulfill(json(out));
    }

    if (sub === 'items') {
      if (!a) {
        if (method !== 'POST') {
          const kind = url.searchParams.get('kind');
          return route.fulfill(json(list.filter((i) => !i.deleted_at && (!kind || i.kind === kind))));
        }
        const isJson = (req.headers()['content-type'] ?? '').startsWith('application/json');
        const body = isJson ? req.postDataJSON() : { kind: url.searchParams.get('kind'), subkind: url.searchParams.get('subkind'), title: url.searchParams.get('filename'), provenance: { filename: url.searchParams.get('filename') } };
        const exp = body.exploration_id ? explorations.find((e) => e.id === body.exploration_id) : null;
        const item = base(`item-${added.length + 1}`, {
          ...body,
          title: body.title ?? exp?.title ?? body.exploration_id ?? `${body.kind}/${body.subkind}`,
          context_id: body.context_id ?? exp?.graph_context_id ?? null,
          description: body.description ?? null,
          position: list.length,
        });
        if (body.content_json && typeof body.content_json === 'object' && 'columns' in body.content_json) item._content = body.content_json;
        delete item.content;
        delete item.content_json;
        if (body.content !== undefined || body.content_json !== undefined || !isJson) {
          item.latest = version(item);
          item.current_version = 1;
        }
        added.push({ investigation_id: id, ...body });
        list.push(item);
        journal(id, 'item.created', { item_id: item.id, kind: item.kind, subkind: item.subkind, title: item.title, status: item.status });
        return route.fulfill(json(item, 201));
      }
      const item = list.find((i) => i.id === a);
      if (!item) return route.fulfill(json({ detail: { error: { code: 'ITEM_NOT_FOUND' } } }, 404));
      if (!b) {
        if (method === 'PATCH') {
          Object.assign(item, req.postDataJSON());
          journal(id, 'item.updated', { item_id: item.id, title: item.title, fields: Object.keys(req.postDataJSON()) });
          return route.fulfill(json(item));
        }
        if (method === 'DELETE') {
          item.deleted_at = now();
          journal(id, 'item.deleted', { item_id: item.id, kind: item.kind, title: item.title });
          return route.fulfill(json({ status: 'deleted' }));
        }
        return route.fulfill(json(item));
      }
      if (b === 'snapshot') {
        const payload = snapshots[item.id] ?? snapshots[item.exploration_id] ?? { snapshot: null };
        return route.fulfill(json({ item_id: item.id, title: item.title, context_id: item.context_id, identity_keys: [], edge_semantics: null, ...payload }));
      }
      if (b === 'versions') {
        if (method === 'POST') {
          item.latest = version(item);
          item.current_version += 1;
          return route.fulfill(json(item, 201));
        }
        return route.fulfill(json(item.latest ? [item.latest] : []));
      }
      if (b === 'pin') {
        if (!item.latest) {
          item.latest = version(item);
          item.current_version = 1;
        }
        const pinned = { ...item.latest, pinned_at: now(), pinned_by: 'e2e@test.com', pin_label: req.postDataJSON()?.label ?? null };
        item.pinned = [...item.pinned, pinned];
        journal(id, 'item.pinned', { item_id: item.id, title: item.title, version: pinned.version, sha256: pinned.sha256, label: pinned.pin_label });
        return route.fulfill(json(pinned));
      }
      if (b === 'confirm' || b === 'reject') {
        item.status = b === 'confirm' ? 'confirmed' : 'rejected';
        journal(id, `item.${item.status}`, { item_id: item.id, title: item.title });
        return route.fulfill(json(item));
      }
      if (b === 'run') {
        item.latest = version(item, { statement_id: 'stmt-1', row_count: 12, duration_ms: 310, params: req.postDataJSON()?.parameters ?? {}, run_by: 'e2e@test.com', author_kind: 'human', output: 'table' });
        item.current_version += 1;
        journal(id, 'item.version_added', { item_id: item.id, title: item.title, version: item.current_version, run: item.latest.run });
        return route.fulfill(json(item));
      }
      if (b === 'text') return route.fulfill(json({ text: '', version: item.latest }));
      if (b === 'content') return route.fulfill(json(item._content ?? {}));
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }

    if (sub === 'annotations') {
      const l = notes();
      if (!a) {
        if (method !== 'POST') {
          const kind = url.searchParams.get('kind');
          const status = url.searchParams.get('status');
          return route.fulfill(json(l.filter((x) => (!kind || x.kind === kind) && (!status || x.status === status))));
        }
        const body = req.postDataJSON();
        const row = { id: `ann-${l.length + 1}`, targets: [], value: {}, reason: null, status: 'confirmed', author_kind: 'human', author_email: 'e2e@test.com', created_at: now(), ...body };
        if (row.kind === 'hypothesis') row.value = { status: 'open', ...row.value };
        if (row.kind === 'role') {
          for (const old of l.filter((x) => x.kind === 'role' && x.status === 'confirmed' && x.targets[0] === row.targets[0])) l.splice(l.indexOf(old), 1);
        }
        if (row.kind === 'hypothesis_status') {
          const h = l.find((x) => x.id === row.targets[0]);
          if (h) h.value = { ...h.value, status: row.value.status };
        }
        l.push(row);
        journal(id, `${row.kind}.set`, { annotation_id: row.id, targets: row.targets, value: row.value });
        return route.fulfill(json(row, 201));
      }
      const row = l.find((x) => x.id === a);
      if (!row) return route.fulfill(json({ detail: { error: { code: 'ANNOTATION_NOT_FOUND' } } }, 404));
      if (b === 'confirm' || b === 'reject') {
        row.status = b === 'confirm' ? 'confirmed' : 'rejected';
        row.confirmed_by = 'e2e@test.com';
        if (row.status === 'confirmed' && row.kind === 'role') {
          for (const old of l.filter((x) => x.kind === 'role' && x.status === 'confirmed' && x.id !== row.id && x.targets[0] === row.targets[0])) l.splice(l.indexOf(old), 1);
        }
        journal(id, `${row.kind}.${row.status}`, { annotation_id: row.id, targets: row.targets, value: row.value });
        return route.fulfill(json(row));
      }
      if (method === 'PATCH') {
        const body = req.postDataJSON();
        if (body.value) row.value = { ...row.value, ...body.value };
        if (body.targets) row.targets = body.targets;
        return route.fulfill(json(row));
      }
      if (method === 'DELETE') {
        l.splice(l.indexOf(row), 1);
        journal(id, `${row.kind}.removed`, { annotation_id: row.id });
        return route.fulfill(json({ status: 'deleted' }));
      }
      return route.fulfill(json(row));
    }

    if (sub === 'events' && method === 'POST') {
      const body = req.postDataJSON();
      journal(id, body.kind, body.payload);
      return route.fulfill(json(events.get(id)!.at(-1), 201));
    }
    return route.fulfill(json(events.get(id) ?? []));
  });
  return { added, material, annotations };
}
