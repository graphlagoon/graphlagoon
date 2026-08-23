<script setup lang="ts">
/**
 * Publishing precomputed graphs for the current context.
 *
 * There is no list here, and no listing endpoint behind it. A precomputed graph
 * is addressed by a name its author chose, so nothing needs to enumerate them —
 * and enumeration is the one operation that does not survive scale: a directory
 * listing costs ~16 µs and ~100 bytes of JSON per entry, so a context with a
 * million entries would mean a 16-second call returning 100 MB. Paging would
 * only have moved the cost, since the Databricks Files API has no server-side
 * name filter to page toward.
 *
 * So: type a name to publish, type a name to delete. Both need superuser status
 * *and* a provider that can be written to — most cannot. A graph computed from
 * a Lakebase query has nowhere to write back to, so the panel asks the server
 * what this context supports rather than assuming the volume is behind it.
 *
 * Reading needs no panel at all — it is a URL.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { LocationQueryRaw } from 'vue-router';
import { Link2, Trash2, X } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import { usePersistence } from '@/composables/usePersistence';
import { useToast } from '@/composables/useToast';
import { ARTIFACT_NAME_PATTERN } from '@/types/graph';
import type { PrecomputedGraphCapabilities } from '@/types/graph';
import { api } from '@/services/api';

const emit = defineEmits<{ (e: 'close'): void }>();

const graphStore = useGraphStore();
const router = useRouter();
const route = useRoute();
const toast = useToast();
const { isSuperuser } = usePersistence();

const saveName = ref('');
const deleteName = ref('');
const saving = ref(false);
const deleting = ref(false);
const saveError = ref<string | null>(null);
const deleteError = ref<string | null>(null);
/** The entry written in this session, so its link is at hand right after saving. */
const lastSaved = ref<{ name: string; url: string } | null>(null);

const contextId = computed(() => graphStore.currentContext?.id ?? null);

/**
 * What this context can do, straight from the server.
 *
 * `can_write` already folds in superuser status, so the template gates on one
 * flag instead of re-deriving a rule the server owns. Null while it is being
 * fetched, and left null when the fetch fails — a panel that cannot confirm it
 * may write shows the read-only hint rather than a button that would 405.
 */
const capabilities = ref<PrecomputedGraphCapabilities | null>(null);

const canWrite = computed(() => capabilities.value?.can_write === true);
const canDelete = computed(() => capabilities.value?.can_delete === true);

/** Superuser but nothing writable: worth saying, because it is not a permission
 *  problem and no amount of re-logging-in fixes it. */
const readOnlyProviders = computed(
  () => isSuperuser.value && capabilities.value !== null && !canWrite.value,
);

async function loadCapabilities() {
  if (!contextId.value) return;
  try {
    capabilities.value = await api.getPrecomputedGraphCapabilities(contextId.value);
  } catch {
    capabilities.value = null;
  }
}

onMounted(loadCapabilities);
watch(contextId, loadCapabilities);

/** Enrichment fills node properties in the background; caching mid-flight would
 *  persist nulls and replay an empty-looking graph. */
const enrichmentPending = computed(
  () => graphStore.enriching || graphStore.pendingPropertyNodeIds.size > 0,
);

function nameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return null;
  if (!ARTIFACT_NAME_PATTERN.test(name)) {
    return 'Letters, digits, _ - . only, up to 64, starting with a letter or digit';
  }
  return null;
}

const saveNameError = computed(() => nameProblem(saveName.value));
const deleteNameError = computed(() => nameProblem(deleteName.value));

const saveBlockedReason = computed(() => {
  if (!contextId.value) return 'No context loaded';
  if (!graphStore.nodes.length) return 'The graph is empty — run a query first';
  if (enrichmentPending.value) return 'Node properties are still loading';
  if (!saveName.value.trim()) return 'Enter a name';
  return saveNameError.value;
});

const deleteBlockedReason = computed(() => {
  if (!contextId.value) return 'No context loaded';
  if (!deleteName.value.trim()) return 'Enter a name';
  return deleteNameError.value;
});

function precomputedUrl(name: string): string {
  const href = router.resolve({
    name: 'graph',
    params: { contextId: contextId.value },
    query: { precomputed: name },
  }).href;
  return new URL(href, window.location.origin).toString();
}

function describeError(e: unknown, fallback: string): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data
    ?.detail;
  if (detail && typeof detail === 'object' && 'error' in detail) {
    const inner = (detail as { error?: { message?: string } }).error;
    if (inner?.message) return inner.message;
  }
  if (typeof detail === 'string') return detail;
  return e instanceof Error ? e.message : fallback;
}

async function save() {
  if (saveBlockedReason.value) return;
  saving.value = true;
  saveError.value = null;
  const name = saveName.value.trim();
  try {
    await graphStore.savePrecomputedGraph(name);
    lastSaved.value = { name, url: precomputedUrl(name) };
    saveName.value = '';
    toast.success(`Precomputed graph “${name}” published`);
  } catch (e) {
    saveError.value = describeError(e, 'Failed to publish the graph');
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (deleteBlockedReason.value || !contextId.value) return;
  const name = deleteName.value.trim();
  if (
    !window.confirm(
      `Delete precomputed graph “${name}”? Anyone using its link loses it.`,
    )
  ) {
    return;
  }
  deleting.value = true;
  deleteError.value = null;
  try {
    await api.deletePrecomputedGraph(contextId.value, name);
    if (lastSaved.value?.name === name) lastSaved.value = null;
    deleteName.value = '';
    // The API is idempotent — a name that was never there also lands here — so
    // this deliberately does not claim the entry existed.
    toast.success(`No precomputed graph named “${name}” remains`);
  } catch (e) {
    deleteError.value = describeError(e, 'Failed to delete the precomputed graph');
  } finally {
    deleting.value = false;
  }
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copied');
  } catch {
    toast.error('Could not copy the link');
  }
}

/**
 * Open the entry just published.
 *
 * Deliberately does *not* spread `route.query`: every non-reserved key is a
 * provider argument, and the arguments of whatever was on screen before are
 * unlikely to be declared by the provider serving this name — carrying them
 * over would turn "open what I just saved" into an immediate 400. `style` is
 * carried explicitly because it is the frontend's own, and applies to any graph.
 */
function openLast() {
  if (!lastSaved.value || !contextId.value) return;
  if (route.query.precomputed === lastSaved.value.name) return;
  const query: LocationQueryRaw = { precomputed: lastSaved.value.name };
  if (route.query.style) query.style = route.query.style;
  router.replace({
    name: 'graph',
    params: { contextId: contextId.value },
    query,
  });
}
</script>

<template>
  <div class="precomputed-panel" data-testid="precomputed-graph-panel">
    <div class="panel-header">
      <h3>Precomputed Graphs</h3>
      <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')">
        <X :size="16" />
      </button>
    </div>

    <p class="panel-hint">
      A named graph anyone with access to this context opens from its link,
      without running a query. Where it comes from is the server's business — a
      published file, or a query computed from the link's own parameters. Layout
      runs fresh on load; node positions and visual state belong to explorations.
    </p>

    <p
      v-if="route.query.precomputed"
      class="viewing-note"
      data-testid="precomputed-graph-viewing"
    >
      Viewing <strong>{{ route.query.precomputed }}</strong>
    </p>

    <template v-if="canWrite">
      <section class="field-section" data-testid="precomputed-graph-save">
        <label class="field-label" for="precomputed-save-name">
          Publish current graph as
        </label>
        <div class="field-row">
          <input
            id="precomputed-save-name"
            v-model="saveName"
            type="text"
            class="name-input"
            placeholder="fraude-2024"
            data-testid="precomputed-graph-name-input"
            :disabled="saving"
            @keyup.enter="save"
          />
          <button
            class="btn btn-primary btn-sm"
            data-testid="precomputed-graph-save-button"
            :disabled="!!saveBlockedReason || saving"
            :title="saveBlockedReason || 'Publish this graph under a name'"
            @click="save"
          >
            {{ saving ? 'Publishing…' : 'Publish' }}
          </button>
        </div>
        <p v-if="saveNameError" class="field-error">{{ saveNameError }}</p>
        <p v-else-if="enrichmentPending" class="field-warning">
          Node properties are still loading — publishing now would store them empty.
        </p>
        <p v-if="saveError" class="field-error" data-testid="precomputed-graph-error">
          {{ saveError }}
        </p>
      </section>

      <section
        v-if="lastSaved"
        class="saved-section"
        data-testid="precomputed-graph-last-saved"
      >
        <span class="field-label">Published</span>
        <div class="saved-row">
          <button
            class="saved-name"
            :title="`Open ${lastSaved.name}`"
            data-testid="precomputed-graph-open-last"
            @click="openLast"
          >
            {{ lastSaved.name }}
          </button>
          <button
            class="btn-icon-only"
            title="Copy link"
            data-testid="precomputed-graph-copy-last"
            @click="copyLink(lastSaved.url)"
          >
            <Link2 :size="14" />
          </button>
        </div>
        <code class="saved-url">{{ lastSaved.url }}</code>
      </section>

      <section
        v-if="canDelete"
        class="field-section"
        data-testid="precomputed-graph-delete"
      >
        <label class="field-label" for="precomputed-delete-name">
          Delete by name
        </label>
        <div class="field-row">
          <input
            id="precomputed-delete-name"
            v-model="deleteName"
            type="text"
            class="name-input"
            placeholder="fraude-2024"
            data-testid="precomputed-graph-delete-input"
            :disabled="deleting"
            @keyup.enter="remove"
          />
          <button
            class="btn btn-sm btn-danger"
            data-testid="precomputed-graph-delete-button"
            :disabled="!!deleteBlockedReason || deleting"
            :title="deleteBlockedReason || 'Delete this precomputed graph'"
            @click="remove"
          >
            <Trash2 :size="13" />
          </button>
        </div>
        <p v-if="deleteNameError" class="field-error">{{ deleteNameError }}</p>
        <p
          v-if="deleteError"
          class="field-error"
          data-testid="precomputed-graph-delete-error"
        >
          {{ deleteError }}
        </p>
      </section>
    </template>

    <p
      v-else-if="readOnlyProviders"
      class="panel-hint"
      data-testid="precomputed-graph-readonly"
    >
      Nothing here can be written from the app — the graphs this context serves
      are produced outside it. Open one by adding
      <code>?precomputed=&lt;name&gt;</code> to this page's URL.
    </p>

    <p v-else class="panel-hint" data-testid="precomputed-graph-readonly">
      Only superusers publish and delete precomputed graphs. Anyone with access
      to this context can still open one by adding
      <code>?precomputed=&lt;name&gt;</code> to this page's URL.
    </p>
  </div>
</template>

<style scoped>
/* Sidebar sibling of FilterPanel/QueryTemplatesPanel, which pin themselves to
   250–300px. Same family, but sized with clamp so it gives way on a narrow
   window instead of eating the canvas. */
.precomputed-panel {
  flex: 0 0 auto;
  width: clamp(230px, 22vw, 300px);
  box-sizing: border-box;
  background: var(--card-background);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-header h3 {
  margin: 0;
  font-size: 14px;
}

.panel-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  opacity: 0.7;
}

.panel-hint code {
  font-size: 10px;
}

.viewing-note {
  margin: 0;
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 4px;
  background: var(--hover-background, rgba(0, 123, 255, 0.08));
  overflow-wrap: anywhere;
}

.field-section,
.saved-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.field-label {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.8;
}

.field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.name-input {
  flex: 1 1 120px;
  min-width: 0;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: var(--input-bg, #fff);
  color: inherit;
}

.btn-danger {
  border-color: var(--danger-color, #c0392b);
  color: var(--danger-color, #c0392b);
}

.field-error {
  margin: 0;
  font-size: 11px;
  color: var(--danger-color, #c0392b);
  overflow-wrap: anywhere;
}

.field-warning {
  margin: 0;
  font-size: 11px;
  color: var(--warning-color, #b8860b);
}

.saved-section {
  padding: 8px;
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 4px;
}

.saved-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.saved-name {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--primary-color, #007bff);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved-url {
  font-size: 10px;
  opacity: 0.6;
  overflow-wrap: anywhere;
}
</style>
