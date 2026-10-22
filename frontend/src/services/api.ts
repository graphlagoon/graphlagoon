import axios, { type AxiosInstance } from 'axios';
import type { GraphOverlay } from '@/utils/graphOverlay';
import type {
  CaseAnnotation,
  CaseBrief,
  CaseItem,
  CaseItemVersion,
  CreateAnnotationRequest,
  CreateInvestigationRequest,
  CreateItemRequest,
  Investigation,
  InvestigationPage,
  QueueParams,
  CaseType,
  CaseTypeSpec,
  InvestigationEvent,
  InvestigationExportFormat,
  DecisionRequest,
  CaseTaskRow,
  EntityCase,
  TaskState,
  ItemSearchHit,
  TableDiff,
  ItemSnapshotPayload,
  ShareRole,
  UpdateInvestigationRequest,
  UpdateItemRequest,
} from '@/types/investigation';
import type {
  AdminConfigEntry,
  AdminGroup,
  AdminGroupPayload,
  AdminGroupsResponse,
  AdminHealth,
  AdminOverview,
  AdminPermission,
  AdminPermissionsResponse,
  AdminPermissionUpdate,
  AdminUserPage,
  AgentToken,
  AuditPage,
  ClearEnvironmentResponse,
  OrgLibraryDoc,
  OrgAuthoring,
  PermissionInspection,
  ResolverStatus,
  TransferOwnershipResponse,
} from '@/types/admin';
import type {
  DatasetsResponse,
  EnrichmentLookupResult,
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
      /**
       * Whether a hand-written BEGIN…END script may run on the raw-SQL path
       * (GRAPH_LAGOON_ALLOW_RAW_SQL_SCRIPTS). Off by default: a script body is
       * opaque to both the SELECT-only validator and the table-scope check.
       */
      allow_raw_sql_scripts?: boolean;
      /** Personal agent tokens (GRAPH_LAGOON_AGENTS_ENABLED). */
      agents_enabled?: boolean;
      /** Upload ceiling for case files, in bytes (413 above it). */
      investigation_file_max_bytes?: number;
      /** Ceiling of edges in a case's working graph (G4, Q5). */
      investigation_max_working_edges?: number;
      /** Largest user layer of an exploration (BYOD-2), as JSON bytes. */
      exploration_overlay_max_bytes?: number;
      /** Years a closed case is retained when its type sets none (06 §1). */
      investigation_retention_years?: number;
      databricks_user_email?: string;
      /**
       * True when the current user is in GRAPH_LAGOON_SUPERUSER_EMAILS.
       * Backend-computed per user; the superuser list itself is never exposed.
       */
      is_superuser?: boolean;
      /**
       * Effective permission ids for THIS user (e.g. "context.create"),
       * computed by the backend from groups + rules. UX mirror only — every
       * gated route enforces server-side. Absent ⇒ the backend predates the
       * permission system ⇒ treat as allowed (see usePermissions).
       */
      permissions?: string[];
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

  /** Declared columns of a context's enrichment table for a batch of node keys. */
  async lookupEnrichment(contextId: string, name: string, keys: string[]): Promise<EnrichmentLookupResult> {
    const response = await this.client.post(`/api/graph-contexts/${contextId}/enrichment/${name}/lookup`, { keys });
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
  async getAllExplorations(
    params: { q?: string; mine?: boolean; limit?: number; offset?: number } = {},
  ): Promise<Exploration[]> {
    const response = await this.client.get('/api/explorations', { params });
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

  /** The user's layer of an exploration (BYOD-2): its own nodes, edges and enrichment files. */
  async getExplorationOverlay(id: string): Promise<GraphOverlay> {
    const response = await this.client.get(`/api/explorations/${id}/overlay`);
    return response.data;
  }

  /** Replaces the layer; an empty one removes it. Returns the exploration (its `state.has_overlay`). */
  async putExplorationOverlay(id: string, overlay: GraphOverlay): Promise<Exploration> {
    const response = await this.client.put(`/api/explorations/${id}/overlay`, overlay);
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

  // Investigations (05 §1): one case, items with versions, annotations, a journal.
  /** One page of the queue (06 §2b): server filters, sort and counters;
   * `exploration_id`: only the cases that have that exploration as a graph item. */
  async getInvestigationPage(params: QueueParams = {}): Promise<InvestigationPage> {
    const { fields, ...rest } = params;
    const query: Record<string, unknown> = { ...rest };
    for (const [id, expr] of Object.entries(fields ?? {})) if (expr) query[`field.${id}`] = expr;
    const response = await this.client.get('/api/investigations', { params: query });
    return response.data;
  }

  /** Every case the caller reads, page by page (pickers and the admin area). */
  async getInvestigations(params: Omit<QueueParams, 'limit' | 'offset'> = {}): Promise<Investigation[]> {
    const out: Investigation[] = [];
    for (;;) {
      const page = await this.getInvestigationPage({ ...params, limit: 500, offset: out.length });
      out.push(...page.items);
      if (!page.items.length || out.length >= page.total) return out;
    }
  }

  async getCaseTypes(): Promise<CaseType[]> {
    const response = await this.client.get('/api/org/case-types');
    return response.data;
  }

  async getInvestigation(id: string): Promise<Investigation> {
    const response = await this.client.get(`/api/investigations/${id}`);
    return response.data;
  }

  async createInvestigation(data: CreateInvestigationRequest): Promise<Investigation> {
    const response = await this.client.post('/api/investigations', data);
    return response.data;
  }

  async updateInvestigation(id: string, data: UpdateInvestigationRequest): Promise<Investigation> {
    const response = await this.client.patch(`/api/investigations/${id}`, data);
    return response.data;
  }

  /** `reason`: a superuser deleting a case under retention (otherwise 409 INVESTIGATION_RETAINED). */
  async deleteInvestigation(id: string, reason?: string): Promise<void> {
    await this.client.delete(`/api/investigations/${id}`, { params: reason ? { reason } : {} });
  }

  async shareInvestigation(id: string, email: string, role: ShareRole): Promise<void> {
    await this.client.post(`/api/investigations/${id}/share`, { email, role });
  }

  async unshareInvestigation(id: string, email: string): Promise<void> {
    await this.client.delete(`/api/investigations/${id}/share/${encodeURIComponent(email)}`);
  }

  async reopenInvestigation(id: string): Promise<Investigation> {
    const response = await this.client.post(`/api/investigations/${id}/reopen`);
    return response.data;
  }

  /** Human only: appends a decision (06 §1); a closing one freezes the case. */
  async recordInvestigationDecision(id: string, body: DecisionRequest): Promise<Investigation> {
    const response = await this.client.post(`/api/investigations/${id}/decisions`, body);
    return response.data;
  }

  /** Four eyes: another person approves or rejects a pending decision. */
  async reviewInvestigationDecision(id: string, decisionId: string, body: { approve: boolean; note?: string }): Promise<Investigation> {
    const response = await this.client.post(`/api/investigations/${id}/decisions/${decisionId}/review`, body);
    return response.data;
  }

  /** Renders an org report template over the case into a markdown item (06 P5). */
  async renderInvestigationReport(id: string, template: string, title?: string): Promise<CaseItem> {
    const response = await this.client.post(`/api/investigations/${id}/reports`, { template, ...(title ? { title } : {}) });
    return response.data;
  }

  /** Export (human-only, audited): the file and its server-given name. */
  async exportInvestigation(id: string, format: InvestigationExportFormat): Promise<{ blob: Blob; filename: string }> {
    const response = await this.client.get(`/api/investigations/${id}/export`, {
      params: { format },
      responseType: 'blob',
    });
    const match = /filename\*=UTF-8''([^;]+)/.exec(response.headers['content-disposition'] ?? '');
    return { blob: response.data, filename: match ? decodeURIComponent(match[1]) : `investigation-${id.slice(0, 8)}.${format}` };
  }

  // Items
  async getInvestigationItems(id: string, params: { kind?: string; status?: string; include_deleted?: boolean } = {}): Promise<CaseItem[]> {
    const response = await this.client.get(`/api/investigations/${id}/items`, { params });
    return response.data;
  }

  async createInvestigationItem(id: string, data: CreateItemRequest): Promise<CaseItem> {
    const response = await this.client.post(`/api/investigations/${id}/items`, data);
    return response.data;
  }

  /** Raw-body upload (the server hashes while streaming); needs investigation.upload. */
  async uploadInvestigationItem(
    id: string,
    file: File,
    params: { kind: 'table' | 'document'; subkind: 'csv' | 'upload'; title?: string },
  ): Promise<CaseItem> {
    const response = await this.client.post(`/api/investigations/${id}/items`, file, {
      params: { ...params, filename: file.name },
      // Never application/json: the server reads that as a JSON item.
      headers: { 'Content-Type': file.type && file.type !== 'application/json' ? file.type : 'application/octet-stream' },
    });
    return response.data;
  }

  async updateInvestigationItem(id: string, itemId: string, data: UpdateItemRequest): Promise<CaseItem> {
    const response = await this.client.patch(`/api/investigations/${id}/items/${itemId}`, data);
    return response.data;
  }

  async deleteInvestigationItem(id: string, itemId: string): Promise<void> {
    await this.client.delete(`/api/investigations/${id}/items/${itemId}`);
  }

  async getInvestigationItemVersions(id: string, itemId: string): Promise<CaseItemVersion[]> {
    const response = await this.client.get(`/api/investigations/${id}/items/${itemId}/versions`);
    return response.data;
  }

  async addInvestigationItemVersion(id: string, itemId: string, body: { content?: string; content_json?: unknown }): Promise<CaseItem> {
    const response = await this.client.post(`/api/investigations/${id}/items/${itemId}/versions`, body);
    return response.data;
  }

  async getInvestigationItemContent(id: string, itemId: string, version?: number): Promise<ArrayBuffer> {
    const response = await this.client.get(`/api/investigations/${id}/items/${itemId}/content`, {
      params: { version },
      responseType: 'arraybuffer',
    });
    return response.data;
  }

  async getInvestigationItemText(id: string, itemId: string, version?: number): Promise<{ text: string | null; version: CaseItemVersion }> {
    const response = await this.client.get(`/api/investigations/${id}/items/${itemId}/text`, { params: { version } });
    return response.data;
  }

  /** What one graph item puts on the canvas (snapshot, identity keys, edge semantics). */
  async getInvestigationItemSnapshot(id: string, itemId: string): Promise<ItemSnapshotPayload> {
    const response = await this.client.get(`/api/investigations/${id}/items/${itemId}/snapshot`);
    return response.data;
  }

  async pinInvestigationItem(id: string, itemId: string, body: { version?: number; label?: string } = {}): Promise<CaseItemVersion> {
    const response = await this.client.post(`/api/investigations/${id}/items/${itemId}/pin`, body);
    return response.data;
  }

  async setInvestigationItemStatus(id: string, itemId: string, status: 'confirmed' | 'rejected'): Promise<CaseItem> {
    const response = await this.client.post(`/api/investigations/${id}/items/${itemId}/${status === 'confirmed' ? 'confirm' : 'reject'}`);
    return response.data;
  }

  async runInvestigationQuery(id: string, itemId: string, parameters: Record<string, unknown> = {}, rowLimit = 1000): Promise<CaseItem> {
    const response = await this.client.post(`/api/investigations/${id}/items/${itemId}/run`, { parameters, row_limit: rowLimit });
    return response.data;
  }

  // Table operations (05 §3): join by key, diff by key, promote in bulk.
  async joinInvestigationTables(id: string, body: { item_ids: string[]; key_column?: string; title?: string }): Promise<CaseItem> {
    const response = await this.client.post(`/api/investigations/${id}/items/join`, body);
    return response.data;
  }

  async compareInvestigationTables(
    id: string,
    body: { left: { item_id: string; version?: number }; right: { item_id: string; version?: number }; key_column?: string },
  ): Promise<TableDiff> {
    const response = await this.client.post(`/api/investigations/${id}/items/compare`, body);
    return response.data;
  }

  async promoteInvestigationTables(
    id: string,
    body: { item_ids: string[]; as: 'graph' | 'enrichment'; options?: Record<string, unknown> },
  ): Promise<CaseItem[]> {
    const response = await this.client.post(`/api/investigations/${id}/items/promote`, body);
    return response.data;
  }

  async searchInvestigation(id: string, q: string): Promise<ItemSearchHit[]> {
    const response = await this.client.get(`/api/investigations/${id}/search`, { params: { q } });
    return response.data;
  }

  // Annotations
  async getInvestigationAnnotations(id: string, params: { kind?: string; status?: string; target?: string } = {}): Promise<CaseAnnotation[]> {
    const response = await this.client.get(`/api/investigations/${id}/annotations`, { params });
    return response.data;
  }

  async createInvestigationAnnotation(id: string, data: CreateAnnotationRequest): Promise<CaseAnnotation> {
    const response = await this.client.post(`/api/investigations/${id}/annotations`, data);
    return response.data;
  }

  async updateInvestigationAnnotation(
    id: string,
    annotationId: string,
    data: { targets?: string[]; value?: Record<string, unknown>; reason?: string },
  ): Promise<CaseAnnotation> {
    const response = await this.client.patch(`/api/investigations/${id}/annotations/${annotationId}`, data);
    return response.data;
  }

  /** The cases the person reads where the entity is present or of interest (06 P7). */
  async getEntityCases(uid: string): Promise<EntityCase[]> {
    const response = await this.client.get('/api/investigations/entities/cases', { params: { uid } });
    return response.data;
  }

  /** Tasks across the cases the person reads (06 §1); `mine` = assigned to them. */
  async getTasks(params: { mine?: boolean; state?: TaskState; overdue?: boolean } = {}): Promise<CaseTaskRow[]> {
    const response = await this.client.get('/api/investigations/tasks', { params });
    return response.data;
  }

  async deleteInvestigationAnnotation(id: string, annotationId: string): Promise<void> {
    await this.client.delete(`/api/investigations/${id}/annotations/${annotationId}`);
  }

  async setInvestigationAnnotationStatus(id: string, annotationId: string, status: 'confirmed' | 'rejected'): Promise<CaseAnnotation> {
    const response = await this.client.post(
      `/api/investigations/${id}/annotations/${annotationId}/${status === 'confirmed' ? 'confirm' : 'reject'}`,
    );
    return response.data;
  }

  /** Entity resolution on the server: new pairs become suggested same_as annotations. */
  async runInvestigationEntityResolution(id: string): Promise<CaseAnnotation[]> {
    const response = await this.client.post(`/api/investigations/${id}/analysis/er`);
    return response.data;
  }

  // Journal, brief
  async getInvestigationEvents(id: string, limit = 500): Promise<InvestigationEvent[]> {
    const response = await this.client.get(`/api/investigations/${id}/events`, { params: { limit } });
    return response.data;
  }

  async postInvestigationEvent(id: string, kind: string, payload: Record<string, unknown>): Promise<InvestigationEvent> {
    const response = await this.client.post(`/api/investigations/${id}/events`, { kind, payload });
    return response.data;
  }

  async getInvestigationBrief(id: string): Promise<CaseBrief> {
    const response = await this.client.get(`/api/investigations/${id}/brief`);
    return response.data;
  }

  async putInvestigationBrief(id: string, text: string): Promise<CaseBrief> {
    const response = await this.client.put(`/api/investigations/${id}/brief`, { text });
    return response.data;
  }

  // The caller's own agent tokens (05 §6); the secret comes back once, on create.
  async getAgentTokens(): Promise<AgentToken[]> {
    const response = await this.client.get('/api/agent-tokens');
    return response.data;
  }

  async createAgentToken(data: {
    name: string;
    expires_in_days: number;
    scope?: 'user' | 'case';
    investigation_ids?: string[];
  }): Promise<AgentToken & { token: string }> {
    const response = await this.client.post('/api/agent-tokens', data);
    return response.data;
  }

  async revokeAgentToken(tokenId: string): Promise<void> {
    await this.client.delete(`/api/agent-tokens/${tokenId}`);
  }

  // Org library and case types (05 §6, 06 §1): read by everyone, written in the admin area.
  /** What writing case types and library docs needs (schema, placeholders, operators, tools). */
  async getOrgAuthoring(): Promise<OrgAuthoring> {
    const response = await this.client.get('/api/org/authoring');
    return response.data;
  }

  async getOrgLibrary(kind?: OrgLibraryDoc['kind']): Promise<OrgLibraryDoc[]> {
    const response = await this.client.get('/api/org/library', { params: kind ? { kind } : {} });
    return response.data;
  }

  async putAdminLibraryDoc(slug: string, data: { title: string; kind: OrgLibraryDoc['kind']; body: string }): Promise<OrgLibraryDoc> {
    const response = await this.client.put(`/api/admin/library/${encodeURIComponent(slug)}`, data);
    return response.data;
  }

  async createAdminLibraryDoc(data: { slug: string; title: string; kind: OrgLibraryDoc['kind']; body: string }): Promise<OrgLibraryDoc> {
    const response = await this.client.post('/api/admin/library', data);
    return response.data;
  }

  async deleteAdminLibraryDoc(slug: string): Promise<void> {
    await this.client.delete(`/api/admin/library/${encodeURIComponent(slug)}`);
  }

  async putAdminCaseType(slug: string, spec: CaseTypeSpec): Promise<CaseType> {
    const response = await this.client.put(`/api/admin/case-types/${encodeURIComponent(slug)}`, spec);
    return response.data;
  }

  async deleteAdminCaseType(slug: string): Promise<void> {
    await this.client.delete(`/api/admin/case-types/${encodeURIComponent(slug)}`);
  }

  // Admin area (superuser only; every route 403s for anyone else)
  async getAdminOverview(): Promise<AdminOverview> {
    const response = await this.client.get('/api/admin/overview');
    return response.data;
  }

  async probeWarehouse(): Promise<AdminHealth> {
    const response = await this.client.post('/api/admin/health/warehouse');
    return response.data;
  }

  async getAdminConfig(): Promise<AdminConfigEntry[]> {
    const response = await this.client.get('/api/admin/config');
    return response.data;
  }

  async getAdminUsers(params: { q?: string; page?: number; page_size?: number } = {}): Promise<AdminUserPage> {
    const response = await this.client.get('/api/admin/users', { params });
    return response.data;
  }

  async transferContextOwnership(contextId: string, newOwnerEmail: string): Promise<TransferOwnershipResponse> {
    const response = await this.client.post(`/api/admin/contexts/${contextId}/transfer`, {
      new_owner_email: newOwnerEmail,
    });
    return response.data;
  }

  async transferExplorationOwnership(
    explorationId: string,
    newOwnerEmail: string,
  ): Promise<TransferOwnershipResponse> {
    const response = await this.client.post(`/api/admin/explorations/${explorationId}/transfer`, {
      new_owner_email: newOwnerEmail,
    });
    return response.data;
  }

  async transferInvestigationOwnership(
    investigationId: string,
    newOwnerEmail: string,
  ): Promise<TransferOwnershipResponse> {
    const response = await this.client.post(`/api/admin/investigations/${investigationId}/transfer`, {
      new_owner_email: newOwnerEmail,
    });
    return response.data;
  }

  async getAdminAgentTokens(): Promise<AgentToken[]> {
    const response = await this.client.get('/api/admin/agent-tokens');
    return response.data;
  }

  async revokeAgentTokenAsAdmin(tokenId: string): Promise<void> {
    await this.client.delete(`/api/admin/agent-tokens/${tokenId}`);
  }

  async getAuditLog(
    params: { page?: number; page_size?: number; user?: string; action?: string } = {},
  ): Promise<AuditPage> {
    const response = await this.client.get('/api/admin/audit', { params });
    return response.data;
  }

  async clearEnvironment(confirm: string): Promise<ClearEnvironmentResponse> {
    const response = await this.client.post('/api/admin/environment/clear', { confirm });
    return response.data;
  }

  // Groups & permissions (superuser only)
  async getAdminGroups(): Promise<AdminGroupsResponse> {
    const response = await this.client.get('/api/admin/groups');
    return response.data;
  }

  async createAdminGroup(payload: AdminGroupPayload): Promise<AdminGroup> {
    const response = await this.client.post('/api/admin/groups', payload);
    return response.data;
  }

  async updateAdminGroup(groupId: string, payload: AdminGroupPayload): Promise<AdminGroup> {
    const response = await this.client.put(`/api/admin/groups/${groupId}`, payload);
    return response.data;
  }

  async deleteAdminGroup(groupId: string): Promise<void> {
    await this.client.delete(`/api/admin/groups/${groupId}`);
  }

  async getAdminPermissions(): Promise<AdminPermissionsResponse> {
    const response = await this.client.get('/api/admin/permissions');
    return response.data;
  }

  async putAdminPermission(permissionId: string, payload: AdminPermissionUpdate): Promise<AdminPermission> {
    const response = await this.client.put(`/api/admin/permissions/${permissionId}`, payload);
    return response.data;
  }

  async inspectAdminPermissions(email: string): Promise<PermissionInspection> {
    const response = await this.client.get('/api/admin/permissions/inspect', { params: { email } });
    return response.data;
  }

  async refreshAdminGroupCache(email?: string): Promise<ResolverStatus> {
    const response = await this.client.post('/api/admin/groups/resolution/refresh', { email: email ?? null });
    return response.data;
  }
}

export const api = new ApiService();
