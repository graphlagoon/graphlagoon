<script setup lang="ts">
/**
 * An item version in the inspector: its content (ItemPreviewBody, compact),
 * shown as soon as the item is picked, with Open in the reader (ItemViewer, where the
 * canvas is) and Download. While the reader shows the item, the content is there. A link document opens its URL. `version` shows an
 * older version (default: latest).
 */
import { computed, onMounted, watch } from 'vue';
import { useItemContent } from '@/composables/useItemContent';
import { useItemViewerStore } from '@/stores/itemViewer';
import { PREVIEW_MAX_BYTES } from '@/utils/itemPreview';
import ItemPreviewBody from '@/components/investigation/ItemPreviewBody.vue';
import type { CaseItem, CaseItemVersion } from '@/types/investigation';

const props = defineProps<{ item: CaseItem; investigationId: string; version?: CaseItemVersion | null }>();

const content = useItemContent({ item: () => props.item, investigationId: () => props.investigationId, version: () => props.version });
const { busy, preview, blobUrl, contentType } = content;
const viewer = useItemViewerStore();

const tooBig = computed(() => content.sizeBytes.value > PREVIEW_MAX_BYTES);
/** A link document's URL (the content is the URL; provenance keeps it too). */
const linkUrl = computed(() => {
  if (props.item.subkind !== 'link') return null;
  const url = String(props.item.provenance?.url ?? '');
  return /^https?:\/\//i.test(url) ? url : null;
});

/** The version this card is about, as the reader names it (null: the latest). */
const wanted = computed(() => (props.version && props.version.version !== props.item.current_version ? props.version.version : null));
/** The reader is already showing it: one read, not two. */
const inViewer = computed(() => viewer.target?.itemId === props.item.id && (viewer.target.version ?? null) === wanted.value);
/** A graph is read on the canvas; its stored data (JSON) is shown only when asked for. */
const onRequest = computed(() => props.item.kind === 'graph');
function show() {
  if (!onRequest.value && !tooBig.value && !inViewer.value && !preview.value) void content.open();
}
onMounted(show);
watch(inViewer, show);

function expand() {
  viewer.open(props.item.id, wanted.value);
}
</script>

<template>
  <div class="item-preview">
    <div class="row-actions">
      <a v-if="linkUrl" :href="linkUrl" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" data-testid="item-open-link">Open link ↗</a>
      <button v-if="onRequest && !preview" class="btn btn-outline btn-sm" :disabled="busy || tooBig" data-testid="item-preview-open" @click="content.open()">{{ busy ? 'Loading…' : 'Show the data' }}</button>
      <button v-else-if="!onRequest && !inViewer" class="btn btn-outline btn-sm" title="Read it where the canvas is" data-testid="item-expand" @click="expand">⤢ Open in the reader</button>
      <button class="btn btn-outline btn-sm" :disabled="busy" data-testid="item-download" @click="content.download()">Download</button>
    </div>
    <p v-if="tooBig && !preview" class="muted">File too large to show here; open it large or download it.</p>
    <p v-else-if="busy && !preview" class="muted" data-testid="item-preview-loading">Loading…</p>
    <ItemPreviewBody v-if="preview" :preview="preview" :item="item" :content-type="contentType" :blob-url="blobUrl" size="compact" />
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
</style>
