<script setup lang="ts">
/**
 * One case. shortcut: a source list only; F1.6 turns this into the workspace (T2)
 * with tabs per exploration and the unified view.
 */
import { ref, watch } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { Lock } from 'lucide-vue-next';
import { STATUS_LABELS } from '@/utils/investigationStatus';
import AddToInvestigationModal from '@/components/investigation/AddToInvestigationModal.vue';

const props = defineProps<{ id: string }>();

const store = useInvestigationStore();
const showAdd = ref(false);

watch(() => props.id, (id) => store.openInvestigation(id), { immediate: true });
</script>

<template>
  <div class="container">
    <div v-if="store.loading && !store.current" class="loading"></div>
    <div v-else-if="store.error" class="error-message">{{ store.error }}</div>
    <template v-else-if="store.current">
      <div class="page-header">
        <div>
          <RouterLink to="/investigations" class="back">← Investigations</RouterLink>
          <h1 data-testid="investigation-title">{{ store.current.title }}</h1>
          <span class="muted">
            {{ STATUS_LABELS[store.current.status] ?? store.current.status }}
            <template v-if="store.current.typology"> · {{ store.current.typology }}</template>
          </span>
        </div>
        <button
          v-if="store.current.has_write_access && store.current.status !== 'decidido'"
          class="btn btn-primary"
          data-testid="investigation-add-sources"
          @click="showAdd = true"
        >
          + Add explorations
        </button>
      </div>

      <div class="card">
        <h3 class="section-title">Sources</h3>
        <p v-if="store.sources.length === 0" class="muted empty">
          No sources yet. Add explorations from any context you can read.
        </p>
        <div
          v-for="s in store.sources"
          :key="s.id"
          class="list-item"
          :data-testid="`investigation-source-${s.id}`"
        >
          <div class="list-item-content">
            <div class="list-item-title">
              <template v-if="!s.accessible"><Lock :size="12" /> Restricted exploration · </template>{{ s.title_snapshot }}
            </div>
            <div class="list-item-subtitle">
              <template v-if="s.accessible">
                {{ s.mode === 'frozen' ? 'Frozen copy' : 'Live reference' }} · added by {{ s.added_by }}
              </template>
              <template v-else>
                Context “{{ s.context_title }}” · owner {{ s.owner_email }} — you don't have access
              </template>
            </div>
          </div>
          <div v-if="s.accessible && s.exploration_id && s.context_id" class="list-item-actions">
            <RouterLink
              class="btn btn-outline btn-sm"
              :to="{ path: `/graph/${s.context_id}`, query: { exploration: s.exploration_id } }"
            >
              Open
            </RouterLink>
          </div>
        </div>
      </div>
    </template>

    <AddToInvestigationModal
      :open="showAdd"
      :investigation-id="id"
      @close="showAdd = false"
    />
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.back,
.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.section-title {
  margin: 0;
  padding: 12px 16px;
  font-size: 14px;
  border-bottom: 1px solid var(--border-color);
}

.empty {
  padding: 12px 16px;
}
</style>
