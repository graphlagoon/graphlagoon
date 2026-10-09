<script setup lang="ts">
/**
 * Files of the case (T2 left column, F2.3): list with role and hash. "Add file"
 * opens the assistant (T4, F2.5); a graph file comes back as a new source.
 */
import { onMounted, ref } from 'vue';
import { usePermissions } from '@/composables/usePermissions';
import { useInvestigationStore } from '@/stores/investigation';
import { getErrorMessage } from '@/utils/errorMessage';
import FileImportWizard from '@/components/investigation/FileImportWizard.vue';
import type { FileContextResult, InvestigationFile } from '@/types/investigation';

const props = defineProps<{ investigationId: string; canEdit: boolean }>();
const emit = defineEmits<{ 'source-added': [sourceId: string] }>();

const { can } = usePermissions();
const store = useInvestigationStore();
const wizardOpen = ref(false);
const error = ref<string | null>(null);

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

function onDone(files: InvestigationFile[], result: FileContextResult | null) {
  wizardOpen.value = false;
  store.addFiles(files, result?.source ?? null);
  if (result) emit('source-added', result.source.id);
}

onMounted(() =>
  store.fetchFiles().catch((e) => (error.value = getErrorMessage(e, 'Failed to load the case files'))),
);
</script>

<template>
  <div class="case-files" data-testid="case-files">
    <p v-if="!store.files.length" class="muted">No files yet.</p>
    <div v-for="f in store.files" :key="f.id" class="file" :data-testid="`case-file-${f.id}`">
      <span class="name">{{ f.filename }}</span>
      <span class="muted">
        {{ f.role }} · {{ size(f.size_bytes) }} · sha256 {{ f.sha256.slice(0, 12) }}…
        <template v-if="f.mapping?.name"> · {{ f.mapping.name }}</template>
      </span>
    </div>
    <div v-if="canEdit && can('investigation.upload')" class="upload">
      <button class="btn btn-outline" data-testid="case-file-upload" @click="wizardOpen = true">Add file…</button>
    </div>
    <p v-if="error" class="warn">{{ error }}</p>
    <FileImportWizard
      v-if="wizardOpen"
      :investigation-id="props.investigationId"
      @close="wizardOpen = false"
      @done="onDone"
    />
  </div>
</template>

<style scoped>
.file {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
  font-size: 12px;
}

.name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.upload {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.warn {
  font-size: 11px;
  color: var(--color-warning);
}
</style>
