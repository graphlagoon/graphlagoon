<script setup lang="ts">
/**
 * Material of the case (05 §3, left column): the brief at the top (★, markdown),
 * then one list grouped by kind. A row shows the "on canvas" checkbox (graph
 * items), icon, title, short id, author chip, "suggested" with Confirm/Reject
 * in place, the pin badge and remove. "+ Add" opens the exploration picker;
 * "Upload" the file assistant; "Note" a markdown editor for a new document/note.
 */
import { computed, ref } from 'vue';
import { AlertTriangle, Bot, ExternalLink, FileText, GitBranch, Lock, Pin, Plus, StickyNote, Table2, Terminal, Upload, User } from 'lucide-vue-next';
import QueryItemCard from './QueryItemCard.vue';
import TableOpsDialog, { type TableOp } from './TableOpsDialog.vue';
import { useInvestigationStore, isGraphItem } from '@/stores/investigation';
import { useAuthStore } from '@/stores/auth';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { useAddToCase } from '@/composables/useAddToCase';
import { getErrorMessage } from '@/utils/errorMessage';
import { formatRelative } from '@/utils/format';
import { ITEM_KIND_PLURALS } from '@/utils/investigationStatus';
import { explorationUrl } from '@/utils/investigationLinks';
import type { CaseItem, ItemKind } from '@/types/investigation';

const props = defineProps<{ canEdit: boolean; activeItem?: string | null }>();
const emit = defineEmits<{ add: []; upload: []; select: [item: CaseItem] }>();

const store = useInvestigationStore();
const auth = useAuthStore();
const { can } = usePermissions();
const toast = useToast();
const addToCase = useAddToCase(computed(() => store.current?.id));

// --- drop and paste (05 §3): files → documents/tables, text → note | link | table ---
const dragging = ref(false);
async function onDrop(event: DragEvent) {
  dragging.value = false;
  if (!props.canEdit) return;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) {
    for (const file of files) await addToCase.addDocument(file);
    return;
  }
  const text = event.dataTransfer?.getData('text/plain');
  if (text?.trim()) await addToCase.addPasted(text);
}
async function onPaste(event: ClipboardEvent) {
  const target = event.target as HTMLElement | null;
  if (!props.canEdit || target?.closest('input, textarea, [contenteditable]')) return;
  const files = [...(event.clipboardData?.files ?? [])];
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!files.length && !text.trim()) return;
  event.preventDefault();
  for (const file of files) await addToCase.addDocument(file);
  if (!files.length) await addToCase.addPasted(text);
}

// --- operations between tables (05 §3): multi-select → Join | Compare | Promote | Merge ---
const selectedTables = ref<Set<string>>(new Set());
const tableOp = ref<TableOp | null>(null);
const opItems = computed(() => store.items.filter((i) => selectedTables.value.has(i.id)));
function toggleTable(id: string, on: boolean) {
  const next = new Set(selectedTables.value);
  if (on) next.add(id);
  else next.delete(id);
  selectedTables.value = next;
}

/** Query cards expanded in place (parameters, history, promotion). */
const expanded = ref<Set<string>>(new Set());
function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

const GROUPS: { kind: ItemKind; label: string; icon: typeof GitBranch }[] = [
  { kind: 'graph', label: ITEM_KIND_PLURALS.graph, icon: GitBranch },
  { kind: 'query', label: ITEM_KIND_PLURALS.query, icon: Terminal },
  { kind: 'table', label: ITEM_KIND_PLURALS.table, icon: Table2 },
  { kind: 'document', label: ITEM_KIND_PLURALS.document, icon: FileText },
  { kind: 'note', label: ITEM_KIND_PLURALS.note, icon: StickyNote },
];

const search = ref('');
const collapsed = ref<Set<ItemKind>>(new Set());
const editingBrief = ref(false);
const briefDraft = ref('');
const composing = ref<'note' | 'markdown' | null>(null);
const draftTitle = ref('');
const draftBody = ref('');
const busy = ref<string | null>(null);

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return store.items.filter((i) => i.subkind !== 'brief' && (!q || i.title.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q))));
});
const groups = computed(() =>
  GROUPS.map((g) => ({ ...g, items: visible.value.filter((i) => i.kind === g.kind) })).filter((g) => g.items.length || !search.value),
);
const suggestedCount = computed(() => store.suggestions.length);
/** `G3`, `Q2`, `D1`: stable short ids (05 §3: never a raw UUID; see `caseShortIds`). */
const shortIds = computed(() => store.shortIds);

function toggle(kind: ItemKind) {
  const next = new Set(collapsed.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  collapsed.value = next;
}

async function run(id: string, action: () => Promise<unknown>, fallback: string) {
  busy.value = id;
  try {
    await action();
  } catch (e) {
    toast.error(getErrorMessage(e, fallback));
  } finally {
    busy.value = null;
  }
}

function startBrief() {
  briefDraft.value = store.brief.text;
  editingBrief.value = true;
}

function saveBrief() {
  run('brief', async () => {
    await store.saveBrief(briefDraft.value);
    editingBrief.value = false;
  }, 'Failed to save the brief');
}

function compose(kind: 'note' | 'markdown') {
  composing.value = kind;
  draftTitle.value = '';
  draftBody.value = '';
}

function saveDraft() {
  const body = draftBody.value.trim();
  if (!body) return;
  const kind = composing.value;
  run('draft', async () => {
    if (kind === 'note') await store.addNote(null, body);
    else await store.addItem({ kind: 'document', subkind: 'markdown', title: draftTitle.value.trim() || 'Untitled document', content: body });
    composing.value = null;
  }, 'Failed to add');
}

function remove(item: CaseItem) {
  run(item.id, async () => {
    await store.removeItem(item.id);
    toast.success(`Removed “${item.title}” from the case`);
  }, 'Failed to remove the item');
}

function decide(item: CaseItem, status: 'confirmed' | 'rejected') {
  run(item.id, () => store.setItemStatus(item.id, status), 'Failed to update the suggestion');
}

function pin(item: CaseItem) {
  run(item.id, async () => {
    const v = await store.pinItem(item.id);
    if (v) toast.success(`Pinned v${v.version} · hash ${v.sha256.slice(0, 8)}`);
  }, 'Failed to pin');
}

function rerun(item: CaseItem) {
  run(item.id, async () => {
    const updated = await store.runQuery(item.id);
    const run = updated?.latest?.run as Record<string, unknown> | undefined;
    if (run) toast.success(`Ran “${item.title}”: ${run.row_count ?? '?'} rows in ${run.duration_ms ?? '?'} ms`);
  }, 'Failed to run the query');
}

const authorChip = (item: CaseItem) => (item.author_kind === 'agent' ? 'agent' : item.author_email === auth.email ? 'you' : item.author_email.split('@')[0]);
const lastRun = (item: CaseItem) => item.latest?.run as { row_count?: number; duration_ms?: number; run_by?: string; author_kind?: string } | null | undefined;
const timeAgo = (iso?: string | null) => formatRelative(iso);
</script>

<template>
  <aside
    class="material"
    :class="{ dragging }"
    tabindex="0"
    data-testid="case-items-panel"
    @dragover.prevent="dragging = canEdit"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
    @paste="onPaste"
  >
    <div v-if="dragging" class="drop-hint" data-testid="items-drop-hint">Drop to add to the case (files, text, URL or TSV)</div>
    <header class="head">
      <h2>Material</h2>
      <span v-if="suggestedCount" class="suggested-count" data-testid="suggested-count">{{ suggestedCount }} suggested</span>
      <span class="spacer"></span>
      <template v-if="canEdit">
        <button class="btn btn-primary btn-sm" data-testid="items-add" @click="emit('add')"><Plus :size="14" /> Add</button>
        <button v-if="can('investigation.upload')" class="btn btn-outline btn-sm" title="Upload a file" data-testid="items-upload" @click="emit('upload')">
          <Upload :size="14" />
        </button>
      </template>
    </header>

    <section class="brief" data-testid="case-brief">
      <div class="brief-head">
        <strong>★ Brief</strong>
        <span v-if="store.brief.item" class="chip" :class="store.brief.item.latest?.author_kind">
          <Bot v-if="store.brief.item.latest?.author_kind === 'agent'" :size="11" /><User v-else :size="11" />
          v{{ store.brief.item.current_version }}
        </span>
        <span class="spacer"></span>
        <button v-if="canEdit && !editingBrief" class="link-btn" data-testid="brief-edit" @click="startBrief">
          {{ store.brief.text ? 'Edit' : 'Write' }}
        </button>
      </div>
      <template v-if="editingBrief">
        <textarea v-model="briefDraft" rows="6" class="form-control mono" placeholder="# What this case is about…" data-testid="brief-input"></textarea>
        <div class="row">
          <button class="btn btn-primary btn-sm" :disabled="busy === 'brief'" data-testid="brief-save" @click="saveBrief">Save version</button>
          <button class="btn btn-outline btn-sm" @click="editingBrief = false">Cancel</button>
        </div>
      </template>
      <pre v-else-if="store.brief.text" class="brief-text" data-testid="brief-text">{{ store.brief.text }}</pre>
      <p v-else class="muted">No brief yet.</p>
    </section>

    <input v-model="search" class="form-control search" placeholder="Search material…" data-testid="items-search" />

    <div v-if="!store.items.length" class="empty" data-testid="items-empty">
      <p>Nothing in the case yet. Add a recent exploration, upload a file, or write a note.</p>
      <button v-if="canEdit" class="btn btn-primary btn-sm" data-testid="items-empty-add" @click="emit('add')"><Plus :size="14" /> Add exploration</button>
    </div>

    <section v-for="g in groups" :key="g.kind" class="group" :data-testid="`items-group-${g.kind}`">
      <button class="group-head" @click="toggle(g.kind)">
        <span>{{ collapsed.has(g.kind) ? '▸' : '▾' }}</span>
        <component :is="g.icon" :size="13" />
        {{ g.label }} <span class="muted">{{ g.items.length }}</span>
      </button>
      <template v-if="!collapsed.has(g.kind)">
        <div v-if="g.kind === 'table' && selectedTables.size && canEdit" class="ops-bar" data-testid="table-ops-bar">
          <span class="muted">{{ selectedTables.size }} selected</span>
          <button class="link-btn" :disabled="selectedTables.size < 2" data-testid="table-op-join" @click="tableOp = 'join'">Join</button>
          <button class="link-btn" :disabled="selectedTables.size !== 2" data-testid="table-op-compare" @click="tableOp = 'compare'">Compare</button>
          <button class="link-btn" data-testid="table-op-enrichment" @click="tableOp = 'enrichment'">Promote in bulk</button>
          <button class="link-btn" data-testid="table-op-graph" @click="tableOp = 'graph'">Merge into the graph</button>
          <button class="link-btn muted" @click="selectedTables = new Set()">clear</button>
        </div>
        <div
          v-for="item in g.items"
          :key="item.id"
          class="row item"
          :class="{ suggested: item.status === 'suggested', rejected: item.status === 'rejected', active: activeItem === item.id }"
          :data-testid="`item-${item.id}`"
          @click="emit('select', item)"
        >
          <input
            v-if="isGraphItem(item) && item.accessible"
            type="checkbox"
            :checked="store.canvasIds.has(item.id)"
            title="On canvas (adds it to the graphs shown)"
            :aria-label="`${item.title} on canvas`"
            :data-testid="`item-canvas-${item.id}`"
            @click.stop
            @change="store.toggleCanvas(item.id, ($event.target as HTMLInputElement).checked)"
          />
          <Lock v-else-if="isGraphItem(item)" :size="12" class="muted" title="Restricted: you cannot read this item's context" />
          <span v-else class="dot" :style="{ background: store.sourceColors[item.id] ?? 'transparent' }"></span>
          <span v-if="isGraphItem(item)" class="ring" :style="{ borderColor: store.sourceColors[item.id] }"></span>
          <span class="title" :title="item.title">{{ item.title }}</span>
          <span class="short muted">{{ shortIds.get(item.id) }}</span>
          <span class="chip" :class="item.author_kind" :title="item.author_email" :data-testid="`item-author-${item.id}`">
            <Bot v-if="item.author_kind === 'agent'" :size="11" /><User v-else :size="11" />{{ authorChip(item) }}
          </span>
          <span v-if="item.pinned.length" class="badge pin" :title="`${item.pinned.length} pinned version(s)`" :data-testid="`item-pinned-${item.id}`">
            <Pin :size="10" /> v{{ item.pinned[item.pinned.length - 1].version }}
          </span>
          <AlertTriangle v-if="store.sourceErrors[item.id]" :size="12" class="warn" :title="store.sourceErrors[item.id]" :data-testid="`item-error-${item.id}`" />
          <RouterLink
            v-if="item.subkind === 'exploration_ref' && store.current && explorationUrl(item, store.current.id)"
            :to="explorationUrl(item, store.current.id)!"
            class="badge live"
            title="Open the exploration"
            :aria-label="`Open the exploration ${item.title}`"
            :data-testid="`item-open-exploration-${item.id}`"
            @click.stop
          ><ExternalLink :size="10" /></RouterLink>
          <span v-else-if="item.subkind === 'exploration_ref'" class="badge live" title="Live reference to the exploration">🔗</span>
          <span v-if="item.status === 'suggested'" class="badge suggested-badge" :data-testid="`item-suggested-${item.id}`">suggested</span>
          <span class="actions" @click.stop>
            <button
              v-if="isGraphItem(item) && item.accessible && store.readableGraphItems.length > 1"
              class="link-btn only"
              title="Show only this graph on the canvas"
              :aria-label="`Show only ${item.title} on the canvas`"
              :data-testid="`item-only-${item.id}`"
              @click="store.showOnly(item.id)"
            >only</button>
            <input
              v-if="item.kind === 'table' && canEdit"
              type="checkbox"
              class="pick"
              title="Select to join, compare or promote"
              :checked="selectedTables.has(item.id)"
              :data-testid="`item-select-${item.id}`"
              @change="toggleTable(item.id, ($event.target as HTMLInputElement).checked)"
            />
            <button v-if="item.kind === 'query'" class="link-btn" title="Parameters, history, promote" :data-testid="`item-expand-${item.id}`" @click="toggleExpand(item.id)">
              {{ expanded.has(item.id) ? '▾' : '▸' }}
            </button>
            <template v-if="item.status === 'suggested' && canEdit">
              <button class="link-btn ok" :disabled="busy === item.id" :data-testid="`item-confirm-${item.id}`" @click="decide(item, 'confirmed')">✓</button>
              <button class="link-btn danger" :disabled="busy === item.id" :data-testid="`item-reject-${item.id}`" @click="decide(item, 'rejected')">✕</button>
            </template>
            <button v-if="canEdit && item.kind === 'query'" class="link-btn" title="Run again" :disabled="busy === item.id" :data-testid="`item-run-${item.id}`" @click="rerun(item)">▶</button>
            <button v-if="canEdit && (item.current_version || item.subkind === 'exploration_ref')" class="link-btn" title="Pin this version as evidence" :disabled="busy === item.id" :data-testid="`item-pin-${item.id}`" @click="pin(item)">
              <Pin :size="12" />
            </button>
            <button v-if="canEdit" class="link-btn danger" title="Remove from the case" :disabled="busy === item.id" :data-testid="`item-remove-${item.id}`" @click="remove(item)">×</button>
          </span>
          <div v-if="item.kind === 'query'" class="sub muted">
            <template v-if="lastRun(item)">
              last run {{ timeAgo(item.latest?.created_at) }} · {{ lastRun(item)!.row_count ?? '?' }} rows · {{ lastRun(item)!.duration_ms ?? '?' }} ms
              · by {{ lastRun(item)!.author_kind === 'agent' ? 'agent' : lastRun(item)!.run_by }} · {{ item.current_version }} run{{ item.current_version === 1 ? '' : 's' }}
            </template>
            <template v-else>never run · {{ item.query?.language }} → {{ item.query?.output }}</template>
          </div>
          <QueryItemCard v-if="item.kind === 'query' && expanded.has(item.id)" :item="item" :can-edit="canEdit" />
        </div>
      </template>
    </section>

    <TableOpsDialog
      v-if="tableOp && store.current"
      :investigation-id="store.current.id"
      :op="tableOp"
      :items="opItems"
      @close="tableOp = null"
      @done="selectedTables = new Set()"
    />

    <div v-if="canEdit" class="compose">
      <template v-if="composing">
        <input v-if="composing === 'markdown'" v-model="draftTitle" class="form-control" placeholder="Title" data-testid="compose-title" />
        <textarea v-model="draftBody" rows="4" class="form-control mono" :placeholder="composing === 'note' ? 'A note…' : '# Markdown…'" data-testid="compose-body"></textarea>
        <div class="row">
          <button class="btn btn-primary btn-sm" :disabled="!draftBody.trim() || busy === 'draft'" data-testid="compose-save" @click="saveDraft">Add</button>
          <button class="btn btn-outline btn-sm" @click="composing = null">Cancel</button>
        </div>
      </template>
      <div v-else class="row">
        <button class="link-btn" data-testid="compose-note" @click="compose('note')"><StickyNote :size="12" /> Note</button>
        <button class="link-btn" data-testid="compose-markdown" @click="compose('markdown')"><FileText :size="12" /> Markdown</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.material.dragging {
  outline: 2px dashed var(--color-primary);
  outline-offset: -4px;
}

.drop-hint {
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  color: var(--color-primary);
  font-size: 12px;
}

.ops-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.pick {
  margin: 0 2px;
}

.material {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 10px 12px;
  overflow-y: auto;
  border-right: 1px solid var(--border-color);
  background: var(--color-surface);
  font-size: 13px;
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.head h2 {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.spacer {
  flex: 1;
}

.suggested-count {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--color-suggested-bg);
  border: 1px solid var(--color-suggested-fg);
  color: var(--color-suggested-fg);
  font-size: 11px;
}

.brief {
  padding: 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.brief-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.brief-text {
  max-height: 160px;
  margin: 6px 0 0;
  overflow: auto;
  white-space: pre-wrap;
  font: inherit;
  font-size: 12px;
}

.search {
  font-size: 12px;
}

.empty {
  padding: 12px;
  color: var(--text-muted);
}

.empty p {
  margin: 0 0 8px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 0;
  border: none;
  background: none;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  color: var(--text-color);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.item {
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.item:hover,
.item.active {
  background: var(--color-bg-muted);
}

.item.suggested {
  background: var(--color-suggested-bg);
  border: 1px dashed var(--color-suggested-fg);
}

.item.rejected {
  opacity: 0.5;
  text-decoration: line-through;
}

.title {
  flex: 1;
  min-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.short {
  font-size: 11px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.ring {
  width: 10px;
  height: 10px;
  border: 2px solid;
  border-radius: 50%;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--border-color);
  font-size: 11px;
}

.chip.agent {
  background: var(--color-agent-subtle);
  color: var(--color-agent);
}

.badge {
  font-size: 11px;
}

.badge.pin {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--color-primary);
}

.suggested-badge {
  color: var(--color-suggested-fg);
}

.actions {
  display: inline-flex;
  gap: 4px;
}

/* "only" shows on hover and keyboard focus: the row stays quiet otherwise. */
.only {
  font-size: 11px;
  opacity: 0;
}

.item:hover .only,
.item:focus-within .only {
  opacity: 1;
}

a.badge.live {
  display: inline-flex;
  align-items: center;
  color: var(--color-primary);
}

.warn {
  color: var(--color-warning, #d97706);
  flex-shrink: 0;
}

.sub {
  flex-basis: 100%;
  font-size: 11px;
}

.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 2px;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--color-primary);
  cursor: pointer;
}

.link-btn.ok {
  color: #15803d;
}

.link-btn.danger {
  color: var(--color-error);
}

.compose {
  padding-top: 6px;
  border-top: 1px solid var(--border-color);
}

.mono {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.muted {
  color: var(--text-muted);
}
</style>
