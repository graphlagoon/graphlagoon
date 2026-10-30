/**
 * The bytes of one item version, read once, and what the browser can show of
 * them (utils/itemPreview). Shared by the inspector's preview and the
 * full-screen viewer; each read is audited by the server
 * (`investigation.item_read`), so nothing is fetched until `open` or `download`.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '@/services/api';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { downloadBlob } from '@/utils/portableExport';
import { buildPreview, itemFileName, type ItemPreview } from '@/utils/itemPreview';
import type { CaseItem, CaseItemVersion } from '@/types/investigation';

export function useItemContent(source: {
  item: () => CaseItem;
  investigationId: () => string;
  /** An older version; null or undefined is the latest. */
  version: () => CaseItemVersion | null | undefined;
  maxRows?: number;
}) {
  const toast = useToast();
  const busy = ref(false);
  const preview = ref<ItemPreview | null>(null);
  const blobUrl = ref<string | null>(null);
  let cached: { key: string; data: ArrayBuffer } | null = null;
  let loadingKey: string | null = null;

  const shown = computed(() => source.version() ?? source.item().latest ?? null);
  const contentType = computed(() => shown.value?.content_type ?? '');
  const sizeBytes = computed(() => shown.value?.size_bytes ?? 0);
  /** What the bytes are the bytes of: another item or version starts over. */
  const key = computed(() => `${source.investigationId()}:${source.item().id}:${source.version()?.version ?? `latest-${source.item().current_version}`}`);
  watch(key, close);

  async function load(): Promise<ArrayBuffer> {
    const at = key.value;
    if (cached?.key === at) return cached.data;
    const data = await api.getInvestigationItemContent(source.investigationId(), source.item().id, source.version()?.version);
    cached = { key: at, data };
    return data;
  }

  async function open() {
    const at = key.value;
    if (busy.value && loadingKey === at) return;
    busy.value = true;
    loadingKey = at;
    try {
      const data = await load();
      if (at !== key.value) return; // moved on to another item while it loaded
      preview.value = buildPreview(data, contentType.value, source.maxRows);
      if (preview.value.kind === 'image' || preview.value.kind === 'pdf') {
        revokeBlob();
        blobUrl.value = URL.createObjectURL(new Blob([data], { type: contentType.value }));
      }
    } catch (e) {
      if (at === key.value) toast.error(getErrorMessage(e, 'Failed to read the item'));
    } finally {
      if (loadingKey === at) {
        busy.value = false;
        loadingKey = null;
      }
    }
  }

  async function download() {
    if (busy.value) return;
    busy.value = true;
    try {
      const data = await load();
      downloadBlob(itemFileName(source.item()), new Blob([data], { type: contentType.value || 'application/octet-stream' }));
    } catch (e) {
      toast.error(getErrorMessage(e, 'Failed to download the item'));
    } finally {
      busy.value = false;
    }
  }

  function revokeBlob() {
    if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
    blobUrl.value = null;
  }

  function close() {
    preview.value = null;
    revokeBlob();
  }

  onBeforeUnmount(revokeBlob);

  return { busy, preview, blobUrl, contentType, sizeBytes, open, download, close };
}
