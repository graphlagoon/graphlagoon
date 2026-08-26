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
