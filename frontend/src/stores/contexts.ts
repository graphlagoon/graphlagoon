import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { GraphContext, DatasetsResponse, CreateGraphContextRequest } from '@/types/graph';
import { api } from '@/services/api';

export const useContextsStore = defineStore('contexts', () => {
  const contexts = ref<GraphContext[]>([]);
  const datasets = ref<DatasetsResponse>({ edge_tables: [], node_tables: [] });
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchContexts() {
    loading.value = true;
    error.value = null;

    try {
      contexts.value = await api.getGraphContexts();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to fetch contexts';
      error.value = errorMessage;
    } finally {
      loading.value = false;
    }
  }

  async function fetchDatasets() {
    loading.value = true;
    error.value = null;

    try {
      const result = await api.getDatasets();
      datasets.value = result;
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to fetch datasets';
      error.value = errorMessage;
      console.error('=== fetchDatasets ERROR ===', e);
    } finally {
      loading.value = false;
    }
  }

  async function createContext(data: CreateGraphContextRequest) {
    loading.value = true;
    error.value = null;

    try {
      const newContext = await api.createGraphContext(data);
      contexts.value.unshift(newContext);
      return newContext;
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to create context';
      error.value = errorMessage;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function updateContext(id: string, data: Partial<CreateGraphContextRequest>) {
    loading.value = true;
    error.value = null;

    try {
      const updatedContext = await api.updateGraphContext(id, data);
      const index = contexts.value.findIndex((c) => c.id === id);
      if (index !== -1) {
        contexts.value[index] = updatedContext;
      }
      return updatedContext;
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to update context';
      error.value = errorMessage;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function deleteContext(id: string) {
    loading.value = true;
    error.value = null;

    try {
      await api.deleteGraphContext(id);
      contexts.value = contexts.value.filter((c) => c.id !== id);
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to delete context';
      error.value = errorMessage;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function shareContext(id: string, email: string, permission: 'read' | 'write') {
    loading.value = true;
    error.value = null;

    try {
      await api.shareGraphContext(id, { email, permission });
      // Refresh contexts to get updated shared_with list
      await fetchContexts();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to share context';
      error.value = errorMessage;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function generateRandomGraph(options: {
    name?: string;
    node_types?: string[];
    edge_types?: string[];
    num_nodes?: number;
    num_edges?: number;
  }) {
    loading.value = true;
    error.value = null;

    try {
      const tableName = options.name || `graph_${Date.now()}`;
      const request = {
        catalog: 'dev_catalog',
        schema_name: 'graphs',
        table_name: tableName,
        model: 'barabasi_albert' as const,
        num_nodes: options.num_nodes || 100,
        avg_degree: 6,
        node_types: options.node_types || ['Person', 'Company', 'Product'],
        edge_types: options.edge_types || ['KNOWS', 'WORKS_AT', 'BOUGHT'],
      };
      const result = await api.createRandomGraph(request);
      // Refresh datasets to include new tables
      await fetchDatasets();
      return result;
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to generate random graph';
      error.value = errorMessage;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  return {
    contexts,
    datasets,
    loading,
    error,
    fetchContexts,
    fetchDatasets,
    createContext,
    updateContext,
    deleteContext,
    shareContext,
    generateRandomGraph,
  };
});
