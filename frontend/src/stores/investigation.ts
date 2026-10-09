import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import type {
  CreateInvestigationRequest,
  Investigation,
  InvestigationSource,
  SourceMode,
} from '@/types/investigation';

export const useInvestigationStore = defineStore('investigation', () => {
  /** The queue (T1). */
  const investigations = ref<Investigation[]>([]);
  /** The open case and its sources. */
  const current = ref<Investigation | null>(null);
  const sources = ref<InvestigationSource[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchInvestigations() {
    loading.value = true;
    error.value = null;
    try {
      investigations.value = await api.getInvestigations();
    } catch (e) {
      error.value = getErrorMessage(e, 'Failed to load investigations');
    } finally {
      loading.value = false;
    }
  }

  async function createInvestigation(data: CreateInvestigationRequest) {
    const created = await api.createInvestigation(data);
    investigations.value.unshift({ ...created, source_count: 0 });
    return created;
  }

  async function openInvestigation(id: string) {
    loading.value = true;
    error.value = null;
    try {
      const [inv, srcs] = await Promise.all([
        api.getInvestigation(id),
        api.getInvestigationSources(id),
      ]);
      current.value = inv;
      sources.value = srcs;
    } catch (e) {
      current.value = null;
      sources.value = [];
      error.value = getErrorMessage(e, 'Failed to load investigation');
    } finally {
      loading.value = false;
    }
  }

  /**
   * Adds explorations one by one (the API takes one per call). Stops at the first
   * failure and reports how many made it, so a partial add is never silent.
   */
  async function addExplorations(
    investigationId: string,
    explorationIds: string[],
    mode: SourceMode,
  ): Promise<{ added: number; error: string | null }> {
    let added = 0;
    try {
      for (const id of explorationIds) {
        const source = await api.addInvestigationSource(investigationId, id, mode);
        if (current.value?.id === investigationId) sources.value.push(source);
        added++;
      }
      return { added, error: null };
    } catch (e) {
      return { added, error: getErrorMessage(e, 'Failed to add exploration') };
    } finally {
      const row = investigations.value.find((i) => i.id === investigationId);
      if (row) row.source_count = (row.source_count ?? 0) + added;
    }
  }

  return {
    investigations,
    current,
    sources,
    loading,
    error,
    fetchInvestigations,
    createInvestigation,
    openInvestigation,
    addExplorations,
  };
});
