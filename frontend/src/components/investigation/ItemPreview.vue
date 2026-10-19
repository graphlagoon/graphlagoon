<script setup lang="ts">
/**
 * Shows any item version the browser can render (table, text, image, PDF, HTML)
 * and downloads the rest. Case data never runs in the app's origin: HTML goes
 * into a sandboxed iframe, markdown is shown as text, images and PDFs as blobs.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { api } from '@/services/api';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { downloadBlob } from '@/utils/portableExport';
import { buildPreview, itemFileName, PREVIEW_MAX_BYTES, type ItemPreview } from '@/utils/itemPreview';
import type { CaseItem } from '@/types/investigation';

const props = defineProps<{ item: CaseItem; investigationId: string }>();

const toast = useToast();
const busy = ref(false);
const preview = ref<ItemPreview | null>(null);
const blobUrl = ref<string | null>(null);
let bytes: ArrayBuffer | null = null;

const contentType = computed(() => props.item.latest?.content_type ?? '');
const tooBig = computed(() => (props.item.latest?.size_bytes ?? 0) > PREVIEW_MAX_BYTES);

async function load(): Promise<ArrayBuffer> {
  bytes ??= await api.getInvestigationItemContent(props.investigationId, props.item.id);
  return bytes;
}

async function open() {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await load();
    preview.value = buildPreview(data, contentType.value);
    if (preview.value.kind === 'image' || preview.value.kind === 'pdf') {
      blobUrl.value = URL.createObjectURL(new Blob([data], { type: contentType.value }));
    }
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha ao ler o item'));
  } finally {
    busy.value = false;
  }
}

async function download() {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await load();
    downloadBlob(itemFileName(props.item), new Blob([data], { type: contentType.value || 'application/octet-stream' }));
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha ao baixar o item'));
  } finally {
    busy.value = false;
  }
}

onBeforeUnmount(() => {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
});
</script>

<template>
  <div class="item-preview">
    <div class="row-actions">
      <button v-if="!preview && !tooBig" class="btn btn-outline btn-sm" :disabled="busy" data-testid="item-preview-open" @click="open">
        {{ busy ? 'Carregando…' : 'Visualizar' }}
      </button>
      <button v-else-if="preview" class="btn btn-outline btn-sm" data-testid="item-preview-close" @click="preview = null">Fechar visualização</button>
      <button class="btn btn-outline btn-sm" :disabled="busy" data-testid="item-download" @click="download">Baixar</button>
    </div>
    <p v-if="tooBig && !preview" class="muted">Arquivo grande demais para visualizar aqui; baixe para abrir.</p>

    <div v-if="preview" class="body" data-testid="item-preview" :data-kind="preview.kind">
      <template v-if="preview.kind === 'table'">
        <p class="muted">
          {{ preview.total }} {{ preview.total === 1 ? 'linha' : 'linhas' }}<template v-if="preview.total > preview.rows.length"> · mostrando as primeiras {{ preview.rows.length }}</template>
        </p>
        <div v-if="preview.columns.length" class="scroll">
          <table>
            <thead><tr><th v-for="c in preview.columns" :key="c">{{ c }}</th></tr></thead>
            <tbody><tr v-for="(r, i) in preview.rows" :key="i"><td v-for="(_, j) in preview.columns" :key="j">{{ r[j] }}</td></tr></tbody>
          </table>
        </div>
      </template>
      <template v-else-if="preview.kind === 'text'">
        <pre class="scroll text">{{ preview.text }}</pre>
        <p v-if="preview.truncated" class="muted">Texto cortado; baixe o arquivo para ver tudo.</p>
      </template>
      <img v-else-if="preview.kind === 'image' && blobUrl" :src="blobUrl" :alt="item.title" class="media" />
      <iframe v-else-if="preview.kind === 'pdf' && blobUrl" :src="blobUrl" :title="item.title" class="frame" />
      <iframe v-else-if="preview.kind === 'html'" :srcdoc="preview.html" sandbox="" :title="item.title" class="frame" />
      <p v-else class="muted">Sem visualização para {{ contentType || 'este formato' }}; use Baixar.</p>
    </div>
  </div>
</template>

<style scoped>
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.body {
  margin-top: 6px;
}

.scroll {
  max-height: 320px;
  overflow: auto;
}

.scroll table {
  border-collapse: collapse;
  font-size: 12px;
}

.scroll th,
.scroll td {
  padding: 2px 6px;
  border-bottom: 1px solid var(--color-border-subtle);
  text-align: left;
  white-space: nowrap;
}

.scroll th {
  position: sticky;
  top: 0;
  background: var(--color-surface);
}

.text {
  margin: 0;
  padding: 8px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--color-surface-sunken, var(--color-surface));
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
}

.media {
  max-width: 100%;
  border: 1px solid var(--color-border-subtle);
}

.frame {
  width: 100%;
  height: 360px;
  border: 1px solid var(--color-border-subtle);
  background: #fff;
}
</style>
