<script setup lang="ts">
import { onMounted, computed, ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useAuthStore } from '@/stores/auth';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';
import { usePersistence } from '@/composables/usePersistence';
import { useDatasourceCapabilities } from '@/composables/useDatasourceCapabilities';
import { X } from 'lucide-vue-next';
import type { QueryTemplate } from '@/types/graph';
import TemplateEditorModal from './TemplateEditorModal.vue';
import TemplateExecuteModal from './TemplateExecuteModal.vue';

const emit = defineEmits<{ (e: 'close'): void }>();

const graphStore = useGraphStore();
const capabilities = useDatasourceCapabilities(computed(() => graphStore.currentContext));
const authStore = useAuthStore();
const templatesStore = useQueryTemplatesStore();
const { isSuperuser } = usePersistence();

const canWrite = computed(
  () => graphStore.currentContext?.has_write_access ?? false,
);

function isTemplateOwner(template: QueryTemplate): boolean {
  return template.owner_email === authStore.email;
}

// Private templates: only the creator can edit/delete.
// Shared templates: anyone with context write access can.
// Superusers can mutate any template.
function canMutate(template: QueryTemplate): boolean {
  if (isSuperuser.value) return true;
  return template.visibility === 'private'
    ? isTemplateOwner(template)
    : canWrite.value;
}

// A SQL template cannot run against a native graph database, so it is hidden
// rather than offered and rejected.
const runnableTemplates = computed(() =>
  templatesStore.templates.filter(
    (t) => capabilities.value.supportsSql || t.query_type !== 'sql',
  ),
);

const myTemplates = computed(() =>
  runnableTemplates.value.filter((t) => t.visibility === 'private'),
);
const sharedTemplates = computed(() =>
  runnableTemplates.value.filter((t) => t.visibility !== 'private'),
);

const templateGroups = computed(() =>
  [
    { label: 'My templates', items: myTemplates.value },
    { label: 'Shared templates', items: sharedTemplates.value },
  ].filter((g) => g.items.length > 0),
);

const showEditor = ref(false);
const editingTemplate = ref<QueryTemplate | null>(null);
const executingTemplate = ref<QueryTemplate | null>(null);
const deleteConfirmId = ref<string | null>(null);

onMounted(async () => {
  if (graphStore.currentContext) {
    await templatesStore.loadTemplates(graphStore.currentContext.id);
  }
});

function openCreate() {
  editingTemplate.value = null;
  showEditor.value = true;
}

function openEdit(template: QueryTemplate) {
  editingTemplate.value = template;
  showEditor.value = true;
}

function openExecute(template: QueryTemplate) {
  executingTemplate.value = template;
}

async function handleDelete(template: QueryTemplate) {
  if (deleteConfirmId.value !== template.id) {
    deleteConfirmId.value = template.id;
    return;
  }
  deleteConfirmId.value = null;
  if (!graphStore.currentContext) return;
  try {
    await templatesStore.deleteTemplate(graphStore.currentContext.id, template.id);
  } catch (e) {
    console.error('Failed to delete template:', e);
  }
}

function cancelDelete() {
  deleteConfirmId.value = null;
}
</script>

<template>
  <div class="templates-panel">
    <div class="panel-header">
      <h3>Query Templates</h3>
      <div class="header-actions">
        <button
          class="btn btn-primary btn-sm"
          @click="openCreate"
          title="New Template"
        >
          + New
        </button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <div v-if="templatesStore.loading" class="loading-state">
      Loading templates...
    </div>

    <div v-else-if="runnableTemplates.length === 0" class="empty-state">
      <p>No templates yet.</p>
      <p class="empty-hint">Create one with the <strong>+ New</strong> button above.</p>
    </div>

    <div v-else class="template-list">
      <section v-for="group in templateGroups" :key="group.label" class="template-group">
        <h4 class="group-title">{{ group.label }}</h4>
        <div
          v-for="template in group.items"
          :key="template.id"
          class="template-card"
        >
          <div class="template-info">
            <div class="template-name">{{ template.name }}</div>
            <div v-if="template.description" class="template-desc">{{ template.description }}</div>
            <div class="template-meta">
              <span class="badge" :class="template.query_type">{{ template.query_type.toUpperCase() }}</span>
              <span v-if="template.visibility === 'private'" class="badge private">PRIVATE</span>
              <span v-if="template.parameters.length > 0" class="param-count">
                {{ template.parameters.length }} param{{ template.parameters.length !== 1 ? 's' : '' }}
              </span>
            </div>
          </div>

          <div class="template-actions">
            <button
              class="btn btn-primary btn-sm"
              @click="openExecute(template)"
              title="Use this template"
            >
              Use
            </button>

            <template v-if="canMutate(template)">
              <button
                class="btn btn-outline btn-sm"
                @click="openEdit(template)"
                title="Edit template"
              >
                Edit
              </button>

              <template v-if="deleteConfirmId === template.id">
                <button class="btn btn-danger btn-sm" @click="handleDelete(template)">
                  Confirm
                </button>
                <button class="btn btn-outline btn-sm" @click="cancelDelete">
                  Cancel
                </button>
              </template>
              <button
                v-else
                class="btn-icon-only btn-delete"
                @click="handleDelete(template)"
                title="Delete template"
              >
                <X :size="14" />
              </button>
            </template>
          </div>
        </div>
      </section>
    </div>

    <TemplateEditorModal
      v-if="showEditor"
      :template="editingTemplate"
      @close="showEditor = false"
    />

    <TemplateExecuteModal
      v-if="executingTemplate"
      :template="executingTemplate"
      @close="executingTemplate = null"
    />
  </div>
</template>

<style scoped>
.templates-panel {
  width: 300px;
  background: var(--card-background);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.close-btn {
  font-size: 16px;
  padding: 2px 8px;
}

.loading-state,
.empty-state {
  color: var(--text-muted, #666);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}

.empty-state p {
  margin: 4px 0;
}

.empty-hint {
  font-size: 12px;
  color: var(--text-muted, #888);
}

.template-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.template-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
  margin: 0;
}

.template-card {
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--bg-secondary, #f9f9f9);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.template-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.template-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-color, #333);
}

.template-desc {
  font-size: 11px;
  color: var(--text-muted, #666);
  line-height: 1.4;
}

.template-meta {
  display: flex;
  gap: 6px;
  align-items: center;
}

.badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}

.badge.cypher {
  background: #e8f5e9;
  color: #2e7d32;
}

.badge.sql {
  background: #e3f2fd;
  color: #1565c0;
}

.badge.private {
  background: #fff3e0;
  color: #e65100;
}

.param-count {
  font-size: 10px;
  color: var(--text-muted, #888);
}

.template-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.btn {
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border-color, #ddd);
  padding: 4px 10px;
  transition: all 0.15s;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-sm {
  padding: 3px 8px;
  font-size: 12px;
}

.btn-outline {
  background: transparent;
  color: var(--text-color, #333);
}

.btn-outline:hover:not(:disabled) {
  background: var(--bg-secondary, #f5f5f5);
}

.btn-primary {
  background: var(--primary-color, #42b883);
  border-color: var(--primary-color, #42b883);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover, #3aa876);
}

.btn-danger {
  background: var(--error-color, #e74c3c);
  border-color: var(--error-color, #e74c3c);
  color: white;
}

.btn-danger:hover:not(:disabled) {
  opacity: 0.85;
}

.btn-delete {
  color: var(--error-color, #e74c3c);
  border-color: transparent;
  padding: 3px 6px;
}

.btn-delete:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.1);
  border-color: var(--error-color, #e74c3c);
}
</style>
