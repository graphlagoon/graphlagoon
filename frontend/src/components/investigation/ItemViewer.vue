<script setup lang="ts">
/**
 * The reader: one item of the case where the canvas is (`docked`, the case page), with the
 * material list and the inspector still at hand, or in a dialog over the whole window. An
 * agent's HTML report or slides, an image, a PDF, a table, a note. Opened by picking the
 * item in the material list or a version in its details; InvestigationView keeps it in
 * the URL (`?view=<item>&v=<n>`), so a link opens it and Back closes it. ◀ ▶ (or ← →)
 * step through the material in its order, Esc goes back to the graph, ⤢ asks the browser
 * for full screen. Reviewing is done here: a suggestion is confirmed or rejected, a
 * version pinned as evidence, and "Next to review" moves on.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronLeft, ChevronRight, Download, Maximize2, Minimize2, Pin, X } from 'lucide-vue-next';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { markOpened } from '@/utils/caseVisit';
import { api } from '@/services/api';
import { useInvestigationStore } from '@/stores/investigation';
import { useItemViewerStore } from '@/stores/itemViewer';
import { useItemContent } from '@/composables/useItemContent';
import { PREVIEW_MAX_BYTES_FULL, PREVIEW_MAX_ROWS_FULL, viewerItems } from '@/utils/itemPreview';
import { AUTHOR_KIND_LABELS, itemKindLabel } from '@/utils/investigationStatus';
import { formatDate } from '@/utils/format';
import ItemPreviewBody from '@/components/investigation/ItemPreviewBody.vue';
import type { CaseItem, CaseItemVersion } from '@/types/investigation';

defineProps<{ docked?: boolean; canEdit?: boolean }>();
const store = useInvestigationStore();
const viewer = useItemViewerStore();
const toast = useToast();

const item = computed<CaseItem | null>(() => {
  const id = viewer.target?.itemId;
  return (id && [...store.items, ...store.removedItems].find((i) => i.id === id)) || null;
});
const investigationId = computed(() => store.current?.id ?? '');

// --- versions: the selector, and the version shown -----------------------------------
const versions = ref<CaseItemVersion[]>([]);
const versionsFor = ref<string | null>(null);
watch(
  () => [item.value?.id, item.value?.current_version, investigationId.value] as const,
  async ([id, current, caseId]) => {
    versions.value = [];
    versionsFor.value = null;
    if (!id || !caseId || !current || current < 2) return;
    try {
      const list = await api.getInvestigationItemVersions(caseId, id);
      if (item.value?.id === id) {
        versions.value = list.slice().sort((a, b) => b.version - a.version);
        versionsFor.value = id;
      }
    } catch {
      versionsFor.value = id; // the latest still shows
    }
  },
  { immediate: true },
);
/** An older version asked for (null: the latest). */
const olderVersion = computed(() => {
  const v = viewer.target?.version;
  return v && item.value && v !== item.value.current_version ? v : null;
});
const shownVersion = computed(() => (olderVersion.value ? versions.value.find((v) => v.version === olderVersion.value) ?? null : null));
/** An older version shows once the list says what it is (its type and size). */
const ready = computed(() => !!item.value && (!olderVersion.value || versionsFor.value === item.value.id));
const missingVersion = computed(() => ready.value && !!olderVersion.value && !shownVersion.value);
const versionNumber = computed(() => olderVersion.value ?? item.value?.current_version ?? 0);
function pickVersion(v: number) {
  if (item.value) viewer.open(item.value.id, v === item.value.current_version ? null : v);
}

// --- content ------------------------------------------------------------------------
const placeholder = { id: '', kind: 'document', subkind: 'markdown', title: '', tags: [], current_version: 0, pinned: [] } as unknown as CaseItem;
const content = useItemContent({
  item: () => item.value ?? placeholder,
  investigationId: () => investigationId.value,
  version: () => shownVersion.value,
  maxRows: PREVIEW_MAX_ROWS_FULL,
});
const { busy, preview, blobUrl, contentType } = content;
const tooBig = computed(() => content.sizeBytes.value > PREVIEW_MAX_BYTES_FULL);
const viewable = computed(() => !!item.value && item.value.kind !== 'graph' && item.value.current_version > 0);
watch(
  () => [item.value?.id, versionNumber.value, ready.value] as const,
  () => {
    if (ready.value && viewable.value && !tooBig.value && !missingVersion.value) void content.open();
  },
  { immediate: true },
);
const linkUrl = computed(() => {
  if (item.value?.subkind !== 'link') return null;
  const url = String(item.value.provenance?.url ?? '');
  return /^https?:\/\//i.test(url) ? url : null;
});

// --- stepping through the material ---------------------------------------------------
const sequence = computed(() => viewerItems(store.items));
const position = computed(() => sequence.value.findIndex((i) => i.id === item.value?.id));
const prevItem = computed(() => (position.value > 0 ? sequence.value[position.value - 1] : null));
const nextItem = computed(() => (position.value >= 0 && position.value < sequence.value.length - 1 ? sequence.value[position.value + 1] : null));
function go(target: CaseItem | null) {
  if (target) viewer.open(target.id);
}
watch(() => item.value?.id, (id) => id && markOpened(id), { immediate: true });

// --- review: judge what an agent (or anyone) suggested, pin it, move on ----------------
const acting = ref(false);
const latestShown = computed(() => !olderVersion.value);
const pinned = computed(() => !!item.value?.pinned.some((v) => v.version === versionNumber.value));
/** The next suggestion after this item, wrapping round; null when this is the only one left. */
const nextToReview = computed(() => {
  const list = sequence.value;
  const at = Math.max(position.value, 0);
  return [...list.slice(at + 1), ...list.slice(0, at)].find((i) => i.status === 'suggested') ?? null;
});
const toReview = computed(() => sequence.value.filter((i) => i.status === 'suggested').length);
async function act(run: () => Promise<unknown>, failure: string) {
  if (acting.value) return;
  acting.value = true;
  try {
    await run();
  } catch (e) {
    toast.error(getErrorMessage(e, failure));
  } finally {
    acting.value = false;
  }
}
function decide(status: 'confirmed' | 'rejected') {
  const it = item.value;
  if (!it) return;
  const next = nextToReview.value;
  void act(async () => {
    await store.setItemStatus(it.id, status);
    if (status === 'rejected') toast.undoable(`Rejected “${it.title}”`, () => void store.reopenItem(it.id));
    // Judged: on to the next suggestion, or stay on the last one.
    if (next) viewer.open(next.id);
  }, status === 'confirmed' ? 'Failed to confirm' : 'Failed to reject');
}
function pin() {
  const it = item.value;
  if (!it) return;
  void act(async () => {
    const v = await store.pinItem(it.id, olderVersion.value ? { version: olderVersion.value } : {});
    if (v) toast.success(`Pinned as evidence ${store.evidenceLabel(v.item_id ?? it.id, v.version)} (v${v.version})`);
  }, 'Failed to pin');
}

// --- window: keys, focus, full screen ------------------------------------------------
const panel = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);
let returnFocus: HTMLElement | null = null;

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen?.();
  else void panel.value?.requestFullscreen?.();
}
function onFullscreenChange() {
  isFullscreen.value = !!document.fullscreenElement;
}
function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');
  if (e.key === 'Escape') {
    e.preventDefault();
    viewer.close();
  } else if (!typing && e.key === 'ArrowLeft' && prevItem.value) {
    e.preventDefault();
    go(prevItem.value);
  } else if (!typing && e.key === 'ArrowRight' && nextItem.value) {
    e.preventDefault();
    go(nextItem.value);
  }
}

onMounted(async () => {
  returnFocus = document.activeElement as HTMLElement | null;
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  await nextTick();
  panel.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  if (document.fullscreenElement) void document.exitFullscreen?.();
  returnFocus?.focus?.();
});
</script>

<template>
  <Teleport to="body" :disabled="docked">
    <div class="viewer-overlay" :class="{ docked }" data-testid="item-viewer-overlay" @click.self="viewer.close()">
      <section
        ref="panel"
        class="viewer"
        :role="docked ? 'region' : 'dialog'"
        :aria-modal="docked ? undefined : 'true'"
        :aria-label="item?.title ?? 'Item'"
        tabindex="-1"
        data-testid="item-viewer"
      >
        <header class="viewer-head">
          <div class="viewer-nav">
            <button class="icon-btn" :disabled="!prevItem" :title="prevItem ? `Previous: ${prevItem.title} (←)` : 'Previous'" aria-label="Previous item" data-testid="viewer-prev" @click="go(prevItem)">
              <ChevronLeft :size="18" />
            </button>
            <button class="icon-btn" :disabled="!nextItem" :title="nextItem ? `Next: ${nextItem.title} (→)` : 'Next'" aria-label="Next item" data-testid="viewer-next" @click="go(nextItem)">
              <ChevronRight :size="18" />
            </button>
            <span v-if="position >= 0" class="muted" data-testid="viewer-position">{{ position + 1 }} / {{ sequence.length }}</span>
          </div>
          <div class="viewer-title">
            <span v-if="item" class="code">{{ store.shortIds.get(item.id) ?? itemKindLabel(item.kind) }}</span>
            <strong data-testid="viewer-title">{{ item?.title ?? 'Item not found' }}</strong>
            <span v-if="item && !docked" class="chip" :class="item.author_kind" :title="item.author_email">{{ AUTHOR_KIND_LABELS[item.author_kind] }} · {{ item.author_email }}</span>
            <span v-if="item && item.status !== 'confirmed'" class="chip status" :class="item.status" data-testid="viewer-status">{{ item.status }}</span>
          </div>
          <div v-if="item && viewable" class="viewer-review" data-testid="viewer-review">
            <template v-if="canEdit && item.status === 'suggested' && latestShown">
              <button class="btn btn-primary btn-sm" :disabled="acting" data-testid="viewer-confirm" @click="decide('confirmed')">✓ Confirm</button>
              <button class="btn btn-outline btn-sm" :disabled="acting" data-testid="viewer-reject" @click="decide('rejected')">✕ Reject</button>
            </template>
            <button v-else-if="nextToReview" class="btn btn-outline btn-sm" :title="`${toReview} suggestion${toReview === 1 ? '' : 's'} to review`" data-testid="viewer-next-review" @click="go(nextToReview)">Next to review ({{ toReview }}) →</button>
            <button v-if="canEdit" class="btn btn-outline btn-sm" :disabled="acting || pinned" title="Freeze this version as evidence (E1, E2… in the dossier)" data-testid="viewer-pin" @click="pin">
              <Pin :size="12" /> {{ pinned ? 'Pinned' : 'Pin as evidence' }}
            </button>
          </div>
          <div class="viewer-actions">
            <select
              v-if="versions.length > 1"
              class="form-control version"
              :value="versionNumber"
              aria-label="Version"
              data-testid="viewer-version"
              @change="pickVersion(Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="v in versions" :key="v.version" :value="v.version">
                v{{ v.version }}{{ v.version === item?.current_version ? ' (latest)' : '' }}<template v-if="v.created_at"> · {{ formatDate(v.created_at) }}</template>
              </option>
            </select>
            <span v-else-if="item?.current_version" class="muted">v{{ item.current_version }}</span>
            <a v-if="linkUrl" :href="linkUrl" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" data-testid="viewer-open-link">Open link ↗</a>
            <button class="icon-btn" :disabled="!viewable || busy" title="Download" aria-label="Download" data-testid="viewer-download" @click="content.download()">
              <Download :size="17" />
            </button>
            <button class="icon-btn" :title="isFullscreen ? 'Exit full screen' : 'Full screen'" :aria-label="isFullscreen ? 'Exit full screen' : 'Full screen'" data-testid="viewer-fullscreen" @click="toggleFullscreen">
              <Minimize2 v-if="isFullscreen" :size="17" /><Maximize2 v-else :size="17" />
            </button>
            <button class="icon-btn" :title="docked ? 'Back to the graph (Esc)' : 'Close (Esc)'" :aria-label="docked ? 'Back to the graph' : 'Close'" data-testid="viewer-close" @click="viewer.close()">
              <X :size="18" />
            </button>
          </div>
        </header>

        <div class="viewer-body">
          <p v-if="!item" class="state">This item is not in the case (it may have been removed, or the link is for another case).</p>
          <p v-else-if="!viewable" class="state">{{ item.kind === 'graph' ? 'Graphs open on the canvas.' : 'This item has no version to show yet.' }}</p>
          <p v-else-if="missingVersion" class="state">Version v{{ olderVersion }} does not exist; pick one above.</p>
          <p v-else-if="tooBig" class="state">This file is too large to open in the browser; download it.</p>
          <ItemPreviewBody v-else-if="preview" :key="`${item.id}:${versionNumber}`" :preview="preview" :item="item" :content-type="contentType" :blob-url="blobUrl" size="full" />
          <p v-else class="state" data-testid="viewer-loading">{{ busy || !ready ? 'Loading…' : 'Could not read this item.' }}</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.viewer-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.55);
}

.viewer {
  display: flex;
  flex-direction: column;
  width: 96vw;
  height: 94vh;
  overflow: hidden;
  background: var(--color-surface);
  border-radius: 8px;
  box-shadow: var(--shadow-lg, 0 12px 40px rgba(0, 0, 0, 0.3));
  outline: none;
}

.viewer-overlay.docked {
  position: absolute;
  z-index: 15;
  background: var(--color-surface);
}

.docked .viewer {
  width: 100%;
  height: 100%;
  border-radius: 0;
  box-shadow: none;
}

.viewer-review {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.chip.status {
  flex-shrink: 0;
}

.chip.status.suggested {
  background: var(--color-warning-subtle, var(--color-border-subtle));
}

.chip.status.rejected {
  text-decoration: line-through;
}

.viewer:fullscreen {
  width: 100vw;
  height: 100vh;
  border-radius: 0;
}

.viewer-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
}

.viewer-nav,
.viewer-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.viewer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 200px;
  min-width: 0;
}

.viewer-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}

.code {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--color-surface-sunken, var(--color-border-subtle));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.chip {
  overflow: hidden;
  max-width: 280px;
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--color-border-subtle);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip.agent {
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--text-color);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  border-color: var(--border-color);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.version {
  width: auto;
  padding: 2px 6px;
  font-size: 12px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.viewer-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 12px;
}

.viewer-body > * {
  flex: 1;
  min-height: 0;
}

.state {
  flex: 0 0 auto !important;
  margin: 48px auto;
  color: var(--text-muted);
}
</style>
