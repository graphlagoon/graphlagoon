<script setup lang="ts">
/**
 * An item version in the inspector: Preview (ItemPreviewBody, compact),
 * Expand (the full-screen viewer, ItemViewer) and Download, for any item the
 * browser can render or not. A link document opens its URL. `version`
 * previews an older version (default: latest).
 */
import { computed } from 'vue';
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

function expand() {
  viewer.open(props.item.id, props.version && props.version.version !== props.item.current_version ? props.version.version : null);
}
</script>

<template>
  <div class="item-preview">
    <div class="row-actions">
      <a v-if="linkUrl" :href="linkUrl" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" data-testid="item-open-link">Open link ↗</a>
      <button v-if="!preview && !tooBig" class="btn btn-outline btn-sm" :disabled="busy" data-testid="item-preview-open" @click="content.open()">
        {{ busy ? 'Loading…' : 'Preview' }}
      </button>
      <button v-else-if="preview" class="btn btn-outline btn-sm" data-testid="item-preview-close" @click="content.close()">Close preview</button>
      <button class="btn btn-outline btn-sm" title="Open in a large viewer (double-click the item in the material list)" data-testid="item-expand" @click="expand">⤢ Expand</button>
      <button class="btn btn-outline btn-sm" :disabled="busy" data-testid="item-download" @click="content.download()">Download</button>
    </div>
    <p v-if="tooBig && !preview" class="muted">File too large to preview here; expand it or download it.</p>
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
