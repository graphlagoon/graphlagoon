<script setup lang="ts">
/** Files of the case (T2 left column, F2.3): list with role and hash, and the upload. */
import { onMounted, ref } from 'vue';
import { api } from '@/services/api';
import { usePermissions } from '@/composables/usePermissions';
import { getErrorMessage } from '@/utils/errorMessage';
import type { FileRole, InvestigationFile } from '@/types/investigation';

const props = defineProps<{ investigationId: string; canEdit: boolean }>();

const { can } = usePermissions();
const files = ref<InvestigationFile[]>([]);
const role = ref<FileRole>('graph');
const busy = ref(false);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

async function load() {
  try {
    files.value = await api.getInvestigationFiles(props.investigationId);
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to load the case files');
  }
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  busy.value = true;
  error.value = null;
  try {
    files.value.unshift(await api.uploadInvestigationFile(props.investigationId, file, role.value));
  } catch (e) {
    error.value = getErrorMessage(e, 'Upload failed');
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="case-files" data-testid="case-files">
    <p v-if="!files.length" class="muted">No files yet.</p>
    <div v-for="f in files" :key="f.id" class="file" :data-testid="`case-file-${f.id}`">
      <span class="name">{{ f.filename }}</span>
      <span class="muted">{{ f.role }} · {{ size(f.size_bytes) }} · sha256 {{ f.sha256.slice(0, 12) }}…</span>
    </div>
    <div v-if="canEdit && can('investigation.upload')" class="upload">
      <select v-model="role" data-testid="case-file-role" aria-label="File role">
        <option value="graph">Graph</option>
        <option value="enrichment">Enrichment</option>
        <option value="attachment">Attachment</option>
      </select>
      <button class="btn btn-outline" :disabled="busy" data-testid="case-file-upload" @click="fileInput?.click()">
        {{ busy ? 'Uploading…' : 'Upload file' }}
      </button>
      <input ref="fileInput" type="file" hidden data-testid="case-file-input" @change="onFile" />
    </div>
    <p v-if="error" class="warn">{{ error }}</p>
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
