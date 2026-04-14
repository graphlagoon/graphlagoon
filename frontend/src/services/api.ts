import axios, { type AxiosInstance } from 'axios';
import type {
  DatasetsResponse,
  GraphContext,
  GraphResponse,
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
  GraphQueryRequest,
  CypherQueryRequest,
  CypherQueryResponse,
  CypherTranspileRequest,
  CypherTranspileResponse,
  CatalogListResponse,
  DatabaseListResponse,
  TableListResponse,
  TableSchema,
  TablePreviewResponse,
  SchemaDiscoveryRequest,
  SchemaDiscoveryResponse,
  QueryTemplate,
  CreateQueryTemplateRequest,
  UpdateQueryTemplateRequest,
} from '@/types/graph';
import type {
  SimilarityEndpointInfo,
  SimilarityResponse,
} from '@/types/similarity';

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
      databricks_user_email?: string;
      router_base?: string;
      allowed_share_domains?: string[];
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

  async deleteGraphContext(id: string): Promise<void> {
    await this.client.delete(`/api/graph-contexts/${id}`);
  }

  async shareGraphContext(id: string, data: ShareRequest): Promise<void> {
    await this.client.post(`/api/graph-contexts/${id}/share`, data);
  }

  async unshareGraphContext(id: string, email: string): Promise<void> {
    await this.client.delete(`/api/graph-contexts/${id}/share/${email}`);
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

  async deleteExploration(id: string): Promise<void> {
    await this.client.delete(`/api/explorations/${id}`);
  }

  async shareExploration(id: string, data: ShareRequest): Promise<void> {
    await this.client.post(`/api/explorations/${id}/share`, data);
  }

  async unshareExploration(id: string, email: string): Promise<void> {
    await this.client.delete(`/api/explorations/${id}/share/${email}`);
  }

  // Graph Data
  async getSubgraph(contextId: string, request: SubgraphRequest): Promise<GraphResponse> {
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/subgraph`,
      request
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

  async transpileCypher(contextId: string, request: CypherTranspileRequest): Promise<CypherTranspileResponse> {
    const response = await this.client.post(
      `/api/graph-contexts/${contextId}/cypher/transpile`,
      request
    );
    return response.data;
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
