import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { QueryTemplate, CreateQueryTemplateRequest, UpdateQueryTemplateRequest } from '@/types/graph';
import { api } from '@/services/api';

export const useQueryTemplatesStore = defineStore('queryTemplates', () => {
  const templates = ref<QueryTemplate[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function loadTemplates(contextId: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      templates.value = await api.getQueryTemplates(contextId);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load templates';
    } finally {
      loading.value = false;
    }
  }

  async function createTemplate(contextId: string, data: CreateQueryTemplateRequest): Promise<QueryTemplate> {
    const template = await api.createQueryTemplate(contextId, data);
    templates.value.push(template);
    return template;
  }

  async function updateTemplate(
    contextId: string,
    templateId: string,
    data: UpdateQueryTemplateRequest,
  ): Promise<QueryTemplate> {
    const updated = await api.updateQueryTemplate(contextId, templateId, data);
    const idx = templates.value.findIndex((t) => t.id === templateId);
    if (idx !== -1) {
      templates.value[idx] = updated;
    }
    return updated;
  }

  async function deleteTemplate(contextId: string, templateId: string): Promise<void> {
    await api.deleteQueryTemplate(contextId, templateId);
    templates.value = templates.value.filter((t) => t.id !== templateId);
  }

  function clear(): void {
    templates.value = [];
    error.value = null;
  }

  return {
    templates,
    loading,
    error,
    loadTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    clear,
  };
});
