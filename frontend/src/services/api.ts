import axios, { type AxiosInstance } from 'axios';
import type {
  DatasetsResponse,
  GraphContext,
  GraphResponse,
  NodeBatchResponse,
  Exploration,
  SubgraphRequest,
  ExpandRequest,
  RandomGraphRequest,
  RandomGraphResponse,
  CreateGraphContextRequest,
  CreateExplorationRequest,
  ShareRequest,
  ExplorationState,
  GraphSnapshot,
  PrecomputedGraphCapabilities,
  PrecomputedGraphData,
  PrecomputedGraphEntry,
  PrecomputedGraphPayload,
  PrecomputedGraphSource,
  StylePreset,
  StylePresetEntry,
  StylePresetSettings,
  GraphQueryRequest,
  CypherQueryRequest,
  CypherQueryResponse,
  CypherTranspileRequest,
  CypherTranspileResponse,
  TableQueryRequest,
  TableQueryResponse,
  TableQueryStatusResponse,
  GraphJobSubmitResponse,
  GraphJobStatusResponse,
  CatalogListResponse,
  DatabaseListResponse,
  TableListResponse,
  TableSchema,
  TablePreviewResponse,
  SchemaDiscoveryRequest,
  SchemaDiscoveryResponse,
  SchemaDriftResponse,
  QueryTemplate,
  CreateQueryTemplateRequest,
  UpdateQueryTemplateRequest,
} from '@/types/graph';
import type {
  SimilarityEndpointInfo,
  SimilarityResponse,
} from '@/types/similarity';
import { substituteHashCalls } from '@/utils/queryHash';

// API URL priority:
// 1. Window global injected by server (production/embedded mode)
// 2. Vite environment variable (development mode)
// 3. Empty string (same-origin requests)
declare global {
  interface Window {
    __GRAPH_LAGOON_API_URL__?: string;
    __GRAPH_LAGOON_CONFIG__?: {
      dev_mode?: boolean;
      database_enabled?: boolean;
      databricks_mode?: boolean;
      /**
       * Whether the server serves precomputed graphs at all. Reading one only
       * needs context access; writing additionally needs superuser status *and*
       * a resolving provider that declares the capability, which the panel
       * learns from the capabilities endpoint rather than inferring here.
       */
      precomputed_graphs_enabled?: boolean;
      /** Whether this server serves named style presets. */
      style_presets_enabled?: boolean;
      /** Custom (writer-authored) metrics feature — GRAPH_LAGOON_CUSTOM_METRICS_ENABLED. */
      custom_metrics_enabled?: boolean;
      /** Whether `auto_run` custom metrics may evaluate on graph load. */
      custom_metrics_auto_run_enabled?: boolean;
      databricks_user_email?: string;
      /**
       * True when the current user is in GRAPH_LAGOON_SUPERUSER_EMAILS.
       * Backend-computed per user; the superuser list itself is never exposed.
       */
      is_superuser?: boolean;
      /**
       * Which datasource types this server can serve, e.g.
       * `{ sql_warehouse: true, neptune: false }`. Drives whether the context
       * creation form offers a backend beyond the SQL warehouse; what each
       * backend can *do* is the frontend's own matrix
       * (see `useDatasourceCapabilities`).
       */
      datasources?: Record<string, boolean>;
      /**
       * Named REST connections registered on the server: UI copy plus
       * per-connection operation flags. See `DatasourceConnectionConfig`.
       */
      datasource_connections?: import("@/types/graph").DatasourceConnectionConfig[];
      router_base?: string;
      allowed_share_domains?: string[];
      /**
       * Server-provided seed for the graph store's `behaviors`. Merged over the
       * frontend's own defaults, so unknown/absent keys simply fall back. Deliberately
       * loose: the backend passes it through opaquely and never needs to know the shape.
       */
      default_behaviors?: Record<string, unknown>;
      version?: string;
    };
  }
}

const API_URL = window.__GRAPH_LAGOON_API_URL__ || import.meta.env.VITE_API_URL || '';

class ApiService {
  private client: AxiosInstance;
  /** Client for parent-app endpoints (same origin, no baseURL prefix). */
  private parentClient: AxiosInstance;

  constructor() {
    // Auth interceptor shared by both clients
    const authInterceptor = (config: import('axios').InternalAxiosRequestConfig) => {
      if (this.devMode) {
        const email = localStorage.getItem('userEmail');
        if (email) {
          config.headers['X-Forwarded-Email'] = email;
        }
      }
      return config;
    };

    this.client = axios.create({
      baseURL: API_URL,
      headers: { 'Content-Type': 'application/json' },
    });
    this.client.interceptors.request.use(authInterceptor);

    // Parent client: same origin but no graphlagoon baseURL prefix.
    // In dev, VITE_BACKEND_ORIGIN points to the backend (http://localhost:8000).
    // In prod, empty string = same origin.
    const parentOrigin = import.meta.env.VITE_BACKEND_ORIGIN || '';
    this.parentClient = axios.create({
      baseURL: parentOrigin,
      headers: { 'Content-Type': 'application/json' },
    });
    this.parentClient.interceptors.request.use(authInterceptor);
  }

  /**
   * Check if dev mode is enabled (from backend config or Vite env)
   */
  get devMode(): boolean {
    // Priority: backend config > Vite env
    if (window.__GRAPH_LAGOON_CONFIG__?.dev_mode !== undefined) {
      return window.__GRAPH_LAGOON_CONFIG__.dev_mode;
    }
    // Fallback to Vite env for standalone frontend dev
    return import.meta.env.DEV || import.meta.env.VITE_DEV_MODE === 'true';
  }

  get appVersion(): string {
    return window.__GRAPH_LAGOON_CONFIG__?.version || 'dev';
  }

  // Datasets
  async getDatasets(): Promise<DatasetsResponse> {
    const response = await this.client.get('/api/datasets');
    return response.data;
  }

  // Graph Contexts
  async getGraphContexts(): Promise<GraphContext[]> {
    const response = await this.client.get('/api/graph-contexts');
    return response.data;
  }

  async getGraphContext(id: string): Promise<GraphContext> {
    const response = await this.client.get(`/api/graph-contexts/${id}`);
    return response.data;
  }

  async createGraphContext(data: CreateGraphContextRequest): Promise<GraphContext> {
    const response = await this.client.post('/api/graph-contexts', data);
    return response.data;
  }

  async updateGraphContext(
    id: string,
    data: Partial<CreateGraphContextRequest>
  ): Promise<GraphContext> {
    const response = await this.client.put(`/api/graph-contexts/${id}`, data);
    return response.data;
  }

  async getSchemaDrift(
    contextId: string,
    opts?: { checkTypes?: boolean }
  ): Promise<SchemaDriftResponse> {
    const response = await this.client.get(`/api/graph-contexts/${contextId}/schema-drift`, {
      params: opts?.checkTypes ? { check_types: true } : undefined,
    });
    return response.data;
  }

  async deleteGraphContext(id: string): Promise<void> {
    await this.client.delete(`/api/graph-contexts/${id}`);
  }

  async shareGraphContext(id: string, data: ShareRequest): Promise<void> {
    await this.client.post(`/api/graph-contexts/${id}/share`, data);
  }

  async unshareGraphContext(id: string, email: string): Promise<void> {
    await this.client.delete(
      `/api/graph-contexts/${id}/share/${encodeURIComponent(email)}`
    );
  }

  // Explorations
  async getAllExplorations(): Promise<Exploration[]> {
    const response = await this.client.get('/api/explorations');
    return response.data;
  }

  async getExplorations(contextId: string): Promise<Exploration[]> {
    const response = await this.client.get(
      `/api/graph-contexts/${contextId}/explorations`
    );
    return response.data;
  }

  async getExploration(id: string): Promise<Exploration> {
    const response = await this.client.get(`/api/explorations/${id}`);
    return response.data;
  }

  async createExploration(
    contextId: string,
    data: CreateExplorationRequest
  ): Promise<Exploration> {
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/explorations`,
      data
    );
    return response.data;
  }

  async updateExploration(
    id: string,
    data: { title?: string; state?: ExplorationState; snapshot?: GraphSnapshot }
  ): Promise<Exploration> {
    const response = await this.client.put(`/api/explorations/${id}`, data);
    return response.data;
  }

  async getExplorationSnapshot(id: string): Promise<GraphSnapshot> {
    const response = await this.client.get(`/api/explorations/${id}/snapshot`);
    return response.data;
  }

  // Precomputed graphs — named graphs resolved by a provider (see types/graph.ts)

  // There is no listPrecomputedGraphs: the API has no listing endpoint, because
  // enumerating entries is O(entries) and is the one operation that stops
  // working as the store grows. Graphs are addressed by name. The collection URL
  // answers with capabilities — what this context can do — never an inventory.

  async getPrecomputedGraphCapabilities(
    contextId: string
  ): Promise<PrecomputedGraphCapabilities> {
    const response = await this.client.get(
      `/api/graph-contexts/${contextId}/precomputed-graphs`
    );
    return response.data;
  }

  /**
   * Resolve a precomputed graph by name.
   *
   * `params` are the provider's declared arguments, taken from the URL. They go
   * through axios' `params` rather than into the path string: a value holding
   * `&` or `#` would otherwise silently corrupt the request.
   */
  async getPrecomputedGraph(
    contextId: string,
    name: string,
    params: Record<string, string> = {}
  ): Promise<PrecomputedGraphPayload> {
    const response = await this.client.get(
      `/api/graph-contexts/${contextId}/precomputed-graphs/${encodeURIComponent(name)}`,
      Object.keys(params).length > 0 ? { params } : undefined
    );
    return response.data;
  }

  async putPrecomputedGraph(
    contextId: string,
    name: string,
    data: { graph: PrecomputedGraphData; source: PrecomputedGraphSource }
  ): Promise<PrecomputedGraphEntry> {
    const response = await this.client.put(
      `/api/graph-contexts/${contextId}/precomputed-graphs/${encodeURIComponent(name)}`,
      data
    );
    return response.data;
  }

  async deletePrecomputedGraph(contextId: string, name: string): Promise<void> {
    await this.client.delete(
      `/api/graph-contexts/${contextId}/precomputed-graphs/${encodeURIComponent(name)}`
    );
  }

  // Style presets — named style + label + layout settings (see types/graph.ts).
  // Unlike precomputed graphs these are listable: they are hand-authored, so a
  // context holds a handful, and the count is capped server-side rather than
  // paginated.

  async listStylePresets(contextId: string): Promise<StylePresetEntry[]> {
    const response = await this.client.get(
      `/api/graph-contexts/${contextId}/style-presets`
    );
    return response.data.presets;
  }

  async getStylePreset(contextId: string, name: string): Promise<StylePreset> {
    const response = await this.client.get(
      `/api/graph-contexts/${contextId}/style-presets/${encodeURIComponent(name)}`
    );
    return response.data;
  }

  async putStylePreset(
    contextId: string,
    name: string,
    data: { settings: StylePresetSettings; description?: string | null }
  ): Promise<StylePreset> {
    const response = await this.client.put(
      `/api/graph-contexts/${contextId}/style-presets/${encodeURIComponent(name)}`,
      data
    );
    return response.data;
  }

  async deleteStylePreset(contextId: string, name: string): Promise<void> {
    await this.client.delete(
      `/api/graph-contexts/${contextId}/style-presets/${encodeURIComponent(name)}`
    );
  }

  async deleteExploration(id: string): Promise<void> {
    await this.client.delete(`/api/explorations/${id}`);
  }

  async shareExploration(id: string, data: ShareRequest): Promise<void> {
    await this.client.post(`/api/explorations/${id}/share`, data);
  }

  async unshareExploration(id: string, email: string): Promise<void> {
    await this.client.delete(
      `/api/explorations/${id}/share/${encodeURIComponent(email)}`
    );
  }

  // Graph Data
  async getSubgraph(contextId: string, request: SubgraphRequest): Promise<GraphResponse> {
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/subgraph`,
      request
    );
    return response.data;
  }

  /**
   * Fetch properties for a known set of node ids (progressive load).
   *
   * `columns` may only NARROW the context's configured projection — the
   * backend intersects it with what the context exposes. Used to fetch the
   * few label/icon columns first on wide node tables.
   */
  async getNodesBatch(
    contextId: string,
    nodeIds: string[],
    columns?: string[],
  ): Promise<NodeBatchResponse> {
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/nodes/batch`,
      { node_ids: nodeIds, ...(columns ? { columns } : {}) }
    );
    return response.data;
  }

  async expandFromNode(contextId: string, request: ExpandRequest): Promise<GraphResponse> {
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/expand`,
      request
    );
    return response.data;
  }

  async executeGraphQuery(contextId: string, request: GraphQueryRequest): Promise<GraphResponse> {
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/query`,
      request
    );
    return response.data;
  }

  async executeCypherQuery(contextId: string, request: CypherQueryRequest): Promise<CypherQueryResponse> {
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/cypher`,
      request
    );
    return response.data;
  }

  /** Submit a SQL graph query as a cancellable, progress-reporting job. */
  async submitGraphQueryJob(
    contextId: string,
    request: GraphQueryRequest,
  ): Promise<GraphJobSubmitResponse> {
    const req = { ...request, query: await substituteHashCalls(request.query) };
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/query/async`,
      req,
    );
    return response.data;
  }

  /** Submit an OpenCypher graph query as a cancellable, progress job. */
  async submitCypherQueryJob(
    contextId: string,
    request: CypherQueryRequest,
  ): Promise<GraphJobSubmitResponse> {
    const req = { ...request, query: await substituteHashCalls(request.query) };
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/cypher/async`,
      req,
    );
    return response.data;
  }

  /** Poll a graph query job (running + chunk progress, or succeeded + graph). */
  async getGraphQueryJob(
    contextId: string,
    jobId: string,
  ): Promise<GraphJobStatusResponse> {
    const response = await this.client.get(
      `/api/graph-contexts/${contextId}/query/job/${jobId}`,
    );
    return response.data;
  }

  /** Cancel an in-flight graph query job. */
  async cancelGraphQueryJob(contextId: string, jobId: string): Promise<void> {
    await this.client.post(
      `/api/graph-contexts/${contextId}/query/job/${jobId}/cancel`,
    );
  }

  async transpileCypher(contextId: string, request: CypherTranspileRequest): Promise<CypherTranspileResponse> {
    const req = { ...request, query: await substituteHashCalls(request.query) };
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/cypher/transpile`,
      req
    );
    return response.data;
  }

  async executeTableQuery(contextId: string, request: TableQueryRequest): Promise<TableQueryResponse> {
    const req = { ...request, query: await substituteHashCalls(request.query) };
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/query/table`,
      req
    );
    return response.data;
  }

  /** Poll an in-flight table query (submitted via executeTableQuery). */
  async getTableQueryStatus(
    contextId: string,
    statementId: string,
    rowLimit?: number,
  ): Promise<TableQueryStatusResponse> {
    const response = await this.client.get(
      `/api/graph-contexts/${contextId}/query/table/${statementId}`,
      { params: rowLimit != null ? { row_limit: rowLimit } : undefined },
    );
    return response.data;
  }

  /** Cancel an in-flight table query, releasing warehouse compute. */
  async cancelTableQuery(contextId: string, statementId: string): Promise<void> {
    await this.client.post(
      `/api/graph-contexts/${contextId}/query/table/${statementId}/cancel`,
    );
  }

  // Dev Mode
  async createRandomGraph(request: RandomGraphRequest): Promise<RandomGraphResponse> {
    const response = await this.client.post('/api/dev/random-graph', request);
    return response.data;
  }

  async clearAllData(): Promise<{ status: string; message: string }> {
    const response = await this.client.delete('/api/dev/clear-all');
    return response.data;
  }

  // Catalog Operations
  async listCatalogs(): Promise<CatalogListResponse> {
    const response = await this.client.get('/api/catalog/catalogs');
    return response.data;
  }

  async listDatabases(catalog: string = 'spark_catalog'): Promise<DatabaseListResponse> {
    const response = await this.client.get('/api/catalog/databases', {
      params: { catalog },
    });
    return response.data;
  }

  async listTables(database: string, catalog: string = 'spark_catalog'): Promise<TableListResponse> {
    const response = await this.client.get('/api/catalog/tables', {
      params: { database, catalog },
    });
    return response.data;
  }

  async getTableSchema(
    table: string,
    database: string,
    catalog: string = 'spark_catalog'
  ): Promise<TableSchema> {
    const response = await this.client.get('/api/catalog/schema', {
      params: { table, database, catalog },
    });
    return response.data;
  }

  async previewTable(
    table: string,
    database: string,
    catalog: string = 'spark_catalog',
    limit: number = 100
  ): Promise<TablePreviewResponse> {
    const response = await this.client.get('/api/catalog/preview', {
      params: { table, database, catalog, limit },
    });
    return response.data;
  }

  async refreshCatalog(): Promise<{ status: string; registered: number; skipped: number; errors: string[] }> {
    const response = await this.client.post('/api/catalog/refresh');
    return response.data;
  }

  // Schema Discovery
  async discoverSchema(request: SchemaDiscoveryRequest): Promise<SchemaDiscoveryResponse> {
    const response = await this.client.post('/api/schema-discovery', request);
    return response.data;
  }

  // Query Template methods
  async getQueryTemplates(contextId: string): Promise<QueryTemplate[]> {
    const response = await this.client.get(`/api/graph-contexts/${contextId}/query-templates`);
    return response.data;
  }

  async createQueryTemplate(contextId: string, data: CreateQueryTemplateRequest): Promise<QueryTemplate> {
    const response = await this.client.post(`/api/graph-contexts/${contextId}/query-templates`, data);
    return response.data;
  }

  async updateQueryTemplate(
    contextId: string,
    templateId: string,
    data: UpdateQueryTemplateRequest,
  ): Promise<QueryTemplate> {
    const response = await this.client.put(
      `/api/graph-contexts/${contextId}/query-templates/${templateId}`,
      data,
    );
    return response.data;
  }

  async deleteQueryTemplate(contextId: string, templateId: string): Promise<void> {
    await this.client.delete(`/api/graph-contexts/${contextId}/query-templates/${templateId}`);
  }

  // Similarity
  async getSimilarityEndpoints(): Promise<SimilarityEndpointInfo[]> {
    const response = await this.client.get('/api/similarity/endpoints');
    return response.data;
  }

  async computeSimilarity(
    endpoint: string,
    body: { node_keys: string[]; params: Record<string, unknown> },
  ): Promise<SimilarityResponse> {
    // Uses parentClient: same origin in prod, VITE_BACKEND_ORIGIN in dev.
    // Shares auth interceptors with the main client.
    const response = await this.parentClient.post(endpoint, body);
    return response.data;
  }
}

export const api = new ApiService();
