<script setup lang="ts">
/**
 * Material of the case (05 §3, left column): the brief at the top (★, markdown),
 * then one list grouped by kind. A row shows the "on canvas" checkbox (graph
 * items), icon, title, short id, author chip, "suggested" with Confirm/Reject
 * in place, the pin badge and remove. "+ Add" opens the exploration picker;
 * "Upload" the file assistant; "Note" a markdown editor for a new document/note.
 */
import { computed, ref } from 'vue';
import { Bot, FileText, GitBranch, Lock, Pin, Plus, StickyNote, Table2, Terminal, Upload, User } from 'lucide-vue-next';
import { useInvestigationStore, isGraphItem } from '@/stores/investigation';
import { useAuthStore } from '@/stores/auth';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import type { CaseItem, ItemKind } from '@/types/investigation';

defineProps<{ canEdit: boolean; activeItem?: string | null }>();
const emit = defineEmits<{ add: []; upload: []; select: [item: CaseItem] }>();

const store = useInvestigationStore();
const auth = useAuthStore();
const { can } = usePermissions();
const toast = useToast();

const GROUPS: { kind: ItemKind; label: string; icon: typeof GitBranch }[] = [
  { kind: 'graph', label: 'Graphs', icon: GitBranch },
  { kind: 'query', label: 'Queries', icon: Terminal },
  { kind: 'table', label: 'Tables', icon: Table2 },
  { kind: 'document', label: 'Documents', icon: FileText },
  { kind: 'note', label: 'Notes', icon: StickyNote },
];
const PREFIX: Record<ItemKind, string> = { graph: 'G', query: 'Q', table: 'T', document: 'D', note: 'N' };

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
/** `G3`, `Q2`, `D1`: the item's position within its kind (05 §3: never a raw UUID). */
const shortIds = computed(() => {
  const counters: Partial<Record<ItemKind, number>> = {};
  return new Map(store.items.filter((i) => i.subkind !== 'brief').map((i) => [i.id, `${PREFIX[i.kind]}${(counters[i.kind] = (counters[i.kind] ?? 0) + 1)}`]));
});

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
const timeAgo = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '');
</script>

<template>
  <aside class="material" data-testid="case-items-panel">
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
            :checked="!store.offCanvas.has(item.id)"
            title="On canvas"
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
          <span v-if="item.subkind === 'exploration_ref'" class="badge live" title="Live reference to the exploration">🔗</span>
          <span v-if="item.status === 'suggested'" class="badge suggested-badge" :data-testid="`item-suggested-${item.id}`">suggested</span>
          <span class="actions" @click.stop>
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
        </div>
      </template>
    </section>

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
  background: #fffbeb;
  border: 1px solid #b45309;
  color: #b45309;
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
  background: #fffbeb;
  border: 1px dashed #b45309;
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
  background: #ede9fe;
  color: #5b21b6;
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
  color: #b45309;
}

.actions {
  display: inline-flex;
  gap: 4px;
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
