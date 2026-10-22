<script setup lang="ts">
/**
 * The inspector (05 §3), three states plus the decision: one entity (label by
 * template, provenance rings, role and tags, data, items that cite it, notes,
 * enrichment), a multi-selection (composition and bulk role · tag · group · same-as
 * · note · save selection · compare · use as parameter), or an item (card, versions,
 * confirm/reject, pin, preview or download any version, use in the dossier).
 */
import { computed, ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { caseNodeLabel, shortId } from '@/utils/caseLabels';
import { formatDate } from '@/utils/format';
import { itemKindLabel } from '@/utils/investigationStatus';
import { explorationUrl } from '@/utils/investigationLinks';
import { isTabular } from '@/utils/itemPreview';
import { getErrorMessage } from '@/utils/errorMessage';
import { GROUP_COLORS } from '@/utils/caseVocabulary';
import { baseSourceId, nodeSourceIds, type UnifiedNode } from '@/utils/unifyGraph';
import EnrichmentTab from '@/components/investigation/EnrichmentTab.vue';
import DecisionPanel from '@/components/investigation/DecisionPanel.vue';
import ItemPreview from '@/components/investigation/ItemPreview.vue';
import SeenInOtherCases from '@/components/investigation/SeenInOtherCases.vue';
import type { CaseAnnotation, CaseItem } from '@/types/investigation';

const props = defineProps<{ activeItem: CaseItem | null; canEdit: boolean; decideMode: boolean }>();
const emit = defineEmits<{
  'open-entity': [node: UnifiedNode];
  'select-item': [item: CaseItem | null];
  activate: [item: CaseItem];
  'use-as-param': [ids: string[]];
  decided: [];
  'cancel-decide': [];
  trace: [target: { type: 'node' | 'edge'; id: string }, direction: 'forward' | 'backward'];
  'path-from': [id: string];
}>();

const store = useInvestigationStore();
const graph = useGraphStore();
const auth = useAuthStore();
const toast = useToast();

const actionError = ref<string | null>(null);
async function run(action: () => Promise<unknown>, fallback: string) {
  actionError.value = null;
  try {
    await action();
  } catch (e) {
    actionError.value = getErrorMessage(e, fallback);
  }
}

const byId = computed(() => new Map(store.unified.nodes.map((n) => [n.node_id, n])));
const label = (n: Pick<UnifiedNode, 'node_id' | 'node_type' | 'properties'>) => caseNodeLabel(n, { templates: store.labelTemplates });
const nameOf = (id: string) => {
  const n = byId.value.get(id);
  return n ? label(n) : shortId(id);
};
const sourceTitle = (sourceId: string) => store.itemTitle(baseSourceId(sourceId));
const contextTitle = (contextId: string) => store.contexts[contextId]?.title ?? store.itemTitle(contextId);
/** The exploration page of an `exploration_ref` item, with `?case=` for the way back. */
function explorationLink(itemId: string): string | null {
  const it = store.items.find((i) => i.id === itemId);
  if (!it || it.subkind !== 'exploration_ref' || !store.current) return null;
  return explorationUrl(it, store.current.id);
}

// --- one entity ------------------------------------------------------------------
/** The one selected entity, from the unified graph (the canvas may show a traced subset). */
const selected = computed(() => (graph.selectedNodeIds.size === 1 ? byId.value.get([...graph.selectedNodeIds][0]) ?? null : null));
const multi = computed(() => (graph.selectedNodeIds.size > 1 ? [...graph.selectedNodeIds].map((id) => byId.value.get(id)).filter((n): n is UnifiedNode => !!n) : []));
const inspectorTab = ref<'data' | 'items' | 'enrichment' | 'notes' | 'origin'>('data');
const noteDraft = ref('');
const tagDraft = ref('');

const selectedSources = computed(() => (selected.value ? nodeSourceIds(selected.value) : []));
const selectedProps = computed(() => Object.entries(selected.value?.properties ?? {}));
const selectedRole = computed(() => (selected.value ? store.roles[selected.value.node_id] ?? '' : ''));
const roleOptions = computed(() => {
  const used = new Set(Object.values(store.roles));
  for (const a of store.annotations) if (a.kind === 'role') used.add(String(a.value.role));
  return [...new Set([...store.vocabulary.roles, ...used])];
});
const selectedTags = computed(() => (selected.value ? store.entityTags.get(selected.value.node_id) ?? [] : []));
const selectedGroups = computed(() => (selected.value ? store.groups.filter((g) => g.targets.includes(selected.value!.node_id)) : []));
const selectedNotes = computed(() => store.notes.filter((n) => n.anchor?.entity_ids?.includes(selected.value?.node_id ?? '')));
/** Items that cite the entity: anchored notes, analyses whose params name it, graph items it came from. */
const citingItems = computed<CaseItem[]>(() => {
  const id = selected.value?.node_id;
  if (!id) return [];
  const sources = new Set(selectedSources.value);
  return store.items.filter(
    (i) => !i.deleted_at && (i.anchor?.entity_ids?.includes(id) || sources.has(i.id) || JSON.stringify(i.provenance?.params ?? {}).includes(id)),
  );
});
const selectedSuggestions = computed(() => store.annotations.filter((a) => a.status === 'suggested' && selected.value && a.targets.includes(selected.value.node_id)));
const selectedAnnotations = computed(() =>
  store.annotations.filter((a) => a.status === 'confirmed' && !['role', 'tag', 'group'].includes(a.kind) && selected.value && a.targets.includes(selected.value.node_id)),
);
const selectedEvents = computed(() => {
  const id = selected.value?.node_id;
  return id ? store.events.filter((e) => JSON.stringify(e.payload).includes(id)).slice(-5).reverse() : [];
});

function onRoleChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  const id = selected.value?.node_id;
  if (id) run(() => store.setRole(id, value || null), 'Failed to set role');
}

function addTag() {
  const id = selected.value?.node_id;
  const tag = tagDraft.value.trim();
  if (!id || !tag) return;
  run(async () => {
    await store.setTags(id, [...selectedTags.value, tag]);
    tagDraft.value = '';
  }, 'Failed to add the tag');
}

function removeTag(tag: string) {
  const id = selected.value?.node_id;
  if (id) run(() => store.setTags(id, selectedTags.value.filter((t) => t !== tag)), 'Failed to remove the tag');
}

function addNote(ids: string[]) {
  const body = noteDraft.value.trim();
  if (!ids.length || !body) return;
  run(async () => {
    await store.addItem({
      kind: 'note',
      subkind: 'anchored',
      title: body.length > 60 ? `${body.slice(0, 57)}…` : body,
      description: body,
      content: body,
      anchor: { entity_ids: ids },
    });
    noteDraft.value = '';
  }, 'Failed to add note');
}

function decideSuggestion(a: CaseAnnotation, status: 'confirmed' | 'rejected') {
  run(() => store.setAnnotationStatus(a.id, status), 'Failed to update the suggestion');
}

const describeAnnotation = (a: CaseAnnotation) => {
  const v = a.value;
  if (a.kind === 'role') return `role: ${v.role}`;
  if (a.kind === 'tag') return `tag: ${v.tag}`;
  if (a.kind === 'group') return `group: ${v.name}`;
  if (a.kind === 'same_as') return `same as ${nameOf(a.targets.find((t) => t !== selected.value?.node_id) ?? '')}`;
  return a.kind;
};

// --- multi-selection -------------------------------------------------------------
const bulkRole = ref('');
const bulkTag = ref('');
const groupName = ref('');
const groupColor = ref(0);
const groupClosed = ref(false);
const sameAsReason = ref('');
const compare = ref(false);
const composition = computed(() => {
  const counts: Record<string, number> = {};
  for (const n of multi.value) counts[n.node_type] = (counts[n.node_type] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
});
const multiIds = computed(() => multi.value.map((n) => n.node_id));
const compareKeys = computed(() => {
  const keys = new Set<string>();
  for (const n of multi.value) for (const k of Object.keys(n.properties ?? {})) keys.add(k);
  return [...keys];
});

function applyBulkRole() {
  if (!bulkRole.value) return;
  run(async () => {
    for (const id of multiIds.value) await store.setRole(id, bulkRole.value);
    toast.success(`Role set on ${multiIds.value.length} entities`);
  }, 'Failed to set the role');
}

function applyBulkTag() {
  const tag = bulkTag.value.trim();
  if (!tag) return;
  run(async () => {
    await store.addAnnotation({ kind: 'tag', targets: multiIds.value, value: { tag } });
    bulkTag.value = '';
  }, 'Failed to tag');
}

function createGroup() {
  run(async () => {
    await store.addGroup(groupName.value.trim() || `Group ${store.groups.length + 1}`, multiIds.value, { color: groupColor.value, by: 'selection', closed: groupClosed.value });
    groupName.value = '';
    toast.success('Group created');
  }, 'Failed to create the group');
}

function sameAs() {
  if (multiIds.value.length !== 2) return;
  run(async () => {
    await store.addAnnotation({ kind: 'same_as', targets: [multiIds.value[0], multiIds.value[1]], value: { score: 1 }, reason: sameAsReason.value.trim() || undefined });
    sameAsReason.value = '';
    toast.success('Marked as the same entity');
  }, 'Failed to mark as the same');
}

function saveSelection() {
  run(async () => {
    const ids = new Set(multiIds.value);
    const item = await store.addItem({
      kind: 'graph',
      subkind: 'selection',
      title: `Selection · ${ids.size} entities`,
      provenance: { tool: 'selection', params: { nodes: ids.size } },
      content_json: {
        unified: true,
        nodes: multi.value.map((n) => ({ id: n.node_id, type: n.node_type, properties: n.properties ?? {} })),
        edges: store.unified.edges
          .filter((e) => ids.has(e.src) && ids.has(e.dst))
          .map((e) => ({ id: e.edge_id, source: e.src, target: e.dst, type: e.relationship_type, properties: e.properties ?? {} })),
      },
    });
    // A saved selection duplicates what is on the canvas: it stays off it until checked.
    if (item) store.toggleCanvas(item.id, false);
    toast.success('Selection saved as an item');
  }, 'Failed to save the selection');
}

function useAsParam() {
  emit('use-as-param', multiIds.value);
  navigator.clipboard?.writeText(multiIds.value.map((id) => shortId(id)).join(', ')).catch(() => {});
  toast.success(`${multiIds.value.length} ids copied; pick "current selection" as a query parameter`);
}

// --- item ------------------------------------------------------------------------
const item = computed(() => props.activeItem);
const itemPinned = computed(() => !!item.value && item.value.pinned.some((v) => v.version === item.value!.current_version));
const inDossier = computed(() => !!item.value?.tags.includes('dossier'));
const isAnalysis = computed(() => !!item.value && store.analyses.some((a) => a.id === item.value!.id));
const formatTime = (iso: string) => formatDate(iso);
</script>

<template>
  <aside class="inspector" data-testid="workspace-inspector">
    <!-- decision -->
    <template v-if="decideMode">
      <div class="head" data-testid="decision-panel">
        <div class="muted">Decision</div>
        <h3 class="entity">Record the decision</h3>
      </div>
      <DecisionPanel @decided="emit('decided')" @cancel="emit('cancel-decide')" />
    </template>

    <!-- multi-selection -->
    <template v-else-if="multi.length > 1">
      <div class="muted">Selection</div>
      <h3 class="entity" data-testid="inspector-multi-title">{{ multi.length }} entities</h3>
      <div class="chips" data-testid="inspector-composition">
        <span v-for="[t, n] in composition" :key="t" class="chip plain">{{ n }} {{ t }}</span>
      </div>
      <div v-if="actionError" class="action-error">{{ actionError }}</div>
      <template v-if="canEdit">
        <div class="bulk">
          <span class="muted">Role</span>
          <select v-model="bulkRole" data-testid="bulk-role"><option value="">— role —</option><option v-for="r in roleOptions" :key="r" :value="r">{{ r }}</option></select>
          <button class="btn btn-outline btn-sm" :disabled="!bulkRole" data-testid="bulk-role-apply" @click="applyBulkRole">Apply</button>
        </div>
        <div class="bulk">
          <span class="muted">Tag</span>
          <input v-model="bulkTag" list="case-tags" placeholder="tag" data-testid="bulk-tag" @keydown.enter.prevent="applyBulkTag" />
          <datalist id="case-tags"><option v-for="t in [...store.vocabulary.tags, ...store.tagsUsed]" :key="t" :value="t"></option></datalist>
          <button class="btn btn-outline btn-sm" :disabled="!bulkTag.trim()" data-testid="bulk-tag-apply" @click="applyBulkTag">Tag</button>
        </div>
        <div class="bulk group" data-testid="bulk-group">
          <span class="muted">Group</span>
          <input v-model="groupName" placeholder="Group name" data-testid="bulk-group-name" @keydown.enter.prevent="createGroup" />
          <span class="palette">
            <button v-for="(c, i) in GROUP_COLORS" :key="c" class="swatch" :class="{ on: groupColor === i }" :style="{ background: c }" :aria-label="`Color ${i + 1}`" :data-testid="`bulk-group-color-${i}`" @click="groupColor = i"></button>
          </span>
          <label class="small"><input v-model="groupClosed" type="checkbox" data-testid="bulk-group-closed" /> close</label>
          <button class="btn btn-primary btn-sm" data-testid="bulk-group-create" @click="createGroup">Group</button>
        </div>
        <div v-if="multi.length === 2" class="bulk">
          <span class="muted">Same as</span>
          <input v-model="sameAsReason" placeholder="why (reason)" data-testid="bulk-same-as-reason" />
          <button class="btn btn-outline btn-sm" data-testid="bulk-same-as" @click="sameAs">Mark the same</button>
        </div>
        <div class="bulk">
          <span class="muted">Note</span>
          <input v-model="noteDraft" placeholder="A note on all of them" data-testid="bulk-note" @keydown.enter.prevent="addNote(multiIds)" />
          <button class="btn btn-outline btn-sm" :disabled="!noteDraft.trim()" data-testid="bulk-note-add" @click="addNote(multiIds)">Add</button>
        </div>
      </template>
      <div class="row-actions">
        <button v-if="canEdit" class="btn btn-outline btn-sm" data-testid="bulk-save-selection" @click="saveSelection">Save selection</button>
        <button class="btn btn-outline btn-sm" :class="{ on: compare }" data-testid="bulk-compare" @click="compare = !compare">Compare</button>
        <button class="btn btn-outline btn-sm" data-testid="bulk-use-param" @click="useAsParam">Use as parameter</button>
      </div>
      <div v-if="compare" class="compare" data-testid="bulk-compare-table">
        <table>
          <thead><tr><th></th><th v-for="n in multi" :key="n.node_id">{{ label(n) }}</th></tr></thead>
          <tbody>
            <tr v-for="k in compareKeys" :key="k"><th>{{ k }}</th><td v-for="n in multi" :key="n.node_id">{{ n.properties?.[k] ?? '' }}</td></tr>
          </tbody>
        </table>
      </div>
      <ul class="plain-list">
        <li v-for="n in multi.slice(0, 30)" :key="n.node_id"><button class="link-btn" @click="graph.selectNode(n.node_id)">{{ label(n) }}</button> <span class="muted">{{ n.node_type }}</span></li>
        <li v-if="multi.length > 30" class="muted">… {{ multi.length - 30 }} more</li>
      </ul>
    </template>

    <!-- one entity -->
    <template v-else-if="selected">
      <div class="muted">{{ selected.node_type }} · {{ shortId(selected.node_id) }}</div>
      <h3 class="entity" :title="selected.node_id" data-testid="inspector-title">{{ label(selected) }}</h3>
      <div class="chips">
        <span v-for="sid in selectedSources" :key="sid" class="chip" :style="{ borderColor: store.sourceColors[sid], color: store.sourceColors[sid] }">{{ sourceTitle(sid) }}</span>
        <span v-if="selectedSources.length > 1" class="chip linked" data-testid="inspector-linked">in {{ selectedSources.length }} items</span>
        <span v-for="g in selectedGroups" :key="g.id" class="chip plain" :style="{ borderColor: g.color }" :data-testid="`inspector-group-${g.id}`">{{ g.name }}</span>
        <span v-for="a in selectedAnnotations" :key="a.id" class="chip plain" :data-testid="`inspector-annotation-${a.id}`">{{ describeAnnotation(a) }}</span>
      </div>
      <SeenInOtherCases :uid="selected.node_id" :current-id="store.current?.id ?? null" />
      <label class="role-row">
        <span class="muted">Role</span>
        <select :value="selectedRole" :disabled="!canEdit" data-testid="inspector-role" @change="onRoleChange">
          <option value="">— none —</option>
          <option v-for="role in roleOptions" :key="role" :value="role">{{ role }}</option>
        </select>
      </label>
      <div class="tags" data-testid="inspector-tags">
        <span class="muted">Tags</span>
        <span v-for="t in selectedTags" :key="t" class="chip plain">{{ t }} <button v-if="canEdit" class="x" :aria-label="`Remove ${t}`" @click="removeTag(t)">×</button></span>
        <input v-if="canEdit" v-model="tagDraft" list="case-tags" placeholder="+ tag" data-testid="inspector-tag-input" @keydown.enter.prevent="addTag" />
        <datalist id="case-tags"><option v-for="t in [...store.vocabulary.tags, ...store.tagsUsed]" :key="t" :value="t"></option></datalist>
      </div>
      <div v-if="selectedSuggestions.length" class="suggestions" data-testid="inspector-suggestions">
        <div v-for="a in selectedSuggestions" :key="a.id" class="suggestion" :data-testid="`suggestion-${a.id}`">
          <span>
            <strong>{{ describeAnnotation(a) }}</strong>
            <span class="muted"> · suggested by {{ a.author_kind === 'agent' ? 'agent' : a.author_email }}</span>
            <span v-if="a.reason" class="muted"> — {{ a.reason }}</span>
          </span>
          <span v-if="canEdit" class="row">
            <button class="link-btn ok" :data-testid="`suggestion-confirm-${a.id}`" @click="decideSuggestion(a, 'confirmed')">✓ Confirm</button>
            <button class="link-btn danger" :data-testid="`suggestion-reject-${a.id}`" @click="decideSuggestion(a, 'rejected')">✕ Reject</button>
          </span>
        </div>
      </div>
      <div v-if="actionError" class="action-error">{{ actionError }}</div>
      <div class="row-actions">
        <button class="link-btn" data-testid="inspector-trace" @click="emit('trace', { type: 'node', id: selected.node_id }, 'forward')">Follow the money →</button>
        <button class="link-btn" data-testid="inspector-path-from" @click="emit('path-from', selected.node_id)">Path to…</button>
        <button class="link-btn" data-testid="inspector-open-entity" @click="emit('open-entity', selected)">Full profile</button>
      </div>
      <div class="inspector-tabs">
        <button :class="{ active: inspectorTab === 'data' }" @click="inspectorTab = 'data'">Data</button>
        <button :class="{ active: inspectorTab === 'items' }" data-testid="inspector-items-tab" @click="inspectorTab = 'items'">Items<template v-if="citingItems.length"> ({{ citingItems.length }})</template></button>
        <button :class="{ active: inspectorTab === 'enrichment' }" data-testid="inspector-enrichment-tab" @click="inspectorTab = 'enrichment'">Enrichment</button>
        <button :class="{ active: inspectorTab === 'notes' }" data-testid="inspector-notes-tab" @click="inspectorTab = 'notes'">Notes<template v-if="selectedNotes.length"> ({{ selectedNotes.length }})</template></button>
        <button :class="{ active: inspectorTab === 'origin' }" data-testid="inspector-origin-tab" @click="inspectorTab = 'origin'">Origin</button>
      </div>
      <dl v-if="inspectorTab === 'data'" class="props">
        <template v-for="[k, v] in selectedProps" :key="k">
          <dt>{{ k }}</dt>
          <dd>
            {{ v }}
            <span v-if="selected.__conflicts?.[k]" class="conflict" title="Other items disagree">≠ {{ selected.__conflicts[k].map((c) => c.value).join(', ') }}</span>
          </dd>
        </template>
        <template v-if="selectedEvents.length">
          <dt class="section">Events</dt>
          <dd class="section"></dd>
          <template v-for="e in selectedEvents" :key="e.id">
            <dt class="muted">{{ formatTime(e.at) }}</dt>
            <dd class="muted">{{ e.kind }} · {{ e.actor_kind === 'agent' ? 'agent' : e.actor_email }}</dd>
          </template>
        </template>
      </dl>
      <div v-else-if="inspectorTab === 'items'" class="notes" data-testid="inspector-items">
        <button v-for="i in citingItems" :key="i.id" class="item-link" @click="emit('select-item', i)">
          <span class="muted">{{ itemKindLabel(i.kind) }}/{{ i.subkind }}</span> {{ i.title }}
        </button>
        <p v-if="!citingItems.length" class="muted">No item cites this entity yet.</p>
      </div>
      <EnrichmentTab v-else-if="inspectorTab === 'enrichment'" :node="selected" :can-edit="canEdit" />
      <div v-else-if="inspectorTab === 'notes'" class="notes" data-testid="inspector-notes">
        <div v-for="n in selectedNotes" :key="n.id" class="note" data-testid="note">
          <p>{{ n.description ?? n.title }}</p>
          <div class="muted">
            {{ n.author_kind === 'agent' ? 'agent · ' : '' }}{{ n.author_email }} · {{ n.created_at ? formatTime(n.created_at) : '' }}
            <button v-if="canEdit && n.author_email === auth.email" class="link-btn" @click="run(() => store.removeItem(n.id), 'Failed to delete note')">delete</button>
          </div>
        </div>
        <p v-if="!selectedNotes.length" class="muted">No notes on this entity yet.</p>
        <template v-if="canEdit">
          <textarea v-model="noteDraft" rows="3" placeholder="Add a note…" data-testid="note-input"></textarea>
          <button class="btn btn-primary btn-sm" :disabled="!noteDraft.trim()" data-testid="note-add" @click="addNote([selected.node_id])">Add note</button>
        </template>
      </div>
      <div v-else class="origin" data-testid="inspector-origin">
        <div v-for="o in selected.__sources" :key="`${o.sourceId}:${o.nodeId}`" class="origin-row">
          <strong>{{ sourceTitle(o.sourceId) }}</strong>
          <span class="muted">{{ o.sourceId.startsWith('expansion:') ? 'expansion · ' : '' }}{{ contextTitle(o.contextId) }} · id {{ o.nodeId }}</span>
          <RouterLink
            v-if="explorationLink(baseSourceId(o.sourceId))"
            :to="explorationLink(baseSourceId(o.sourceId))!"
            class="link-btn"
            :data-testid="`origin-open-exploration-${baseSourceId(o.sourceId)}`"
          >Open in exploration ↗</RouterLink>
        </div>
        <div v-for="(list, prop) in selected.__conflicts ?? {}" :key="prop" class="origin-row conflict">
          {{ prop }}: kept “{{ prop === 'node_type' ? selected.node_type : selected.properties?.[prop] }}”; also {{ list.map((c) => `“${c.value}” (${sourceTitle(c.sourceId)})`).join(', ') }}
        </div>
      </div>
    </template>

    <!-- item -->
    <template v-else-if="item">
      <div class="muted">{{ itemKindLabel(item.kind) }} / {{ item.subkind }}<template v-if="item.provenance?.tool"> · {{ item.provenance.tool }}</template></div>
      <h3 class="entity" data-testid="inspector-item-title">{{ item.title }}</h3>
      <p v-if="item.description" class="muted">{{ item.description }}</p>
      <div v-if="item.status === 'suggested'" class="suggestions" data-testid="item-suggested">
        <div class="suggestion">
          <span><strong>Suggested</strong><span class="muted"> · by {{ item.author_kind === 'agent' ? 'agent' : item.author_email }}</span></span>
          <span v-if="canEdit" class="row">
            <button class="link-btn ok" data-testid="item-confirm" @click="run(() => store.setItemStatus(item!.id, 'confirmed'), 'Failed to confirm')">✓ Confirm</button>
            <button class="link-btn danger" data-testid="item-reject" @click="run(() => store.setItemStatus(item!.id, 'rejected'), 'Failed to reject')">✕ Reject</button>
          </span>
        </div>
      </div>
      <dl class="props">
        <dt>Author</dt><dd>{{ item.author_kind === 'agent' ? 'agent · ' : '' }}{{ item.author_email }}</dd>
        <dt>Status</dt><dd>{{ item.status }}</dd>
        <dt>Versions</dt><dd>{{ item.current_version }}<template v-if="item.pinned.length"> · {{ item.pinned.length }} pinned</template></dd>
        <template v-if="item.latest"><dt>Hash</dt><dd class="mono">{{ item.latest.sha256.slice(0, 12) }}…</dd></template>
        <template v-if="item.latest?.run"><dt>Run</dt><dd>{{ item.latest.run.row_count }} rows · {{ item.latest.run.duration_ms }} ms</dd></template>
        <template v-if="item.query"><dt>Query</dt><dd class="mono">{{ item.query.text }}</dd></template>
        <template v-if="item.mapping"><dt>Mapping</dt><dd>{{ item.mapping.as }} · {{ (item.mapping.spec as any)?.name ?? '' }}</dd></template>
        <template v-if="item.provenance?.params"><dt>Params</dt><dd class="mono small">{{ JSON.stringify(item.provenance.params).slice(0, 300) }}</dd></template>
      </dl>
      <div v-if="actionError" class="action-error">{{ actionError }}</div>
      <div class="row-actions">
        <RouterLink
          v-if="explorationLink(item.id)"
          :to="explorationLink(item.id)!"
          class="btn btn-outline btn-sm"
          data-testid="item-open-exploration"
        >Open exploration ↗</RouterLink>
        <button v-if="isAnalysis" class="btn btn-outline btn-sm" data-testid="item-show-analysis" @click="emit('activate', item)">Show analysis</button>
        <button v-if="canEdit && item.current_version" class="btn btn-outline btn-sm" :disabled="itemPinned" data-testid="item-pin" @click="run(async () => { const v = await store.pinItem(item!.id); if (v) toast.success(`Pinned · hash ${v.sha256.slice(0, 8)}`); }, 'Failed to pin')">
          {{ itemPinned ? '📌 Pinned' : 'Pin' }}
        </button>
        <button v-if="canEdit && isTabular(item)" class="btn btn-outline btn-sm" :class="{ on: inDossier }" data-testid="item-dossier" @click="run(() => store.setInDossier(item!, !inDossier), 'Failed to update')">
          {{ inDossier ? '✓ In the dossier' : 'Use in the dossier' }}
        </button>
      </div>
      <ItemPreview v-if="item.current_version && store.current" :key="`${item.id}:${item.current_version}`" :item="item" :investigation-id="store.current.id" />
    </template>

    <template v-else>
      <p class="muted">Select a node to see its data and where it came from, shift-click for a selection, or pick an item of the material.</p>
      <section v-if="store.current?.decisions?.length" class="decisions-so-far" data-testid="inspector-decisions">
        <h4>Decisions so far</h4>
        <div v-for="(d, i) in store.current.decisions" :key="d.id" class="decision-row" :data-testid="`inspector-decision-${d.id}`">
          <strong>D{{ i + 1 }} · {{ d.outcome_label }}</strong>
          <span class="muted">
            {{ d.decided_by }} · {{ formatTime(d.decided_at) }}<template v-if="d.closes_case"> · closes the case</template>
            <template v-if="d.review"> · review {{ d.review }}</template>
          </span>
        </div>
        <RouterLink :to="`/investigations/${store.current.id}?mode=dossier#decisions`" class="link-btn" data-testid="inspector-decisions-dossier">Rationale and reviews in the dossier →</RouterLink>
      </section>
    </template>
  </aside>
</template>

<style scoped>
.decisions-so-far {
  margin-top: 14px;
}

.decisions-so-far h4 {
  margin: 0 0 6px;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.decision-row {
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  border-bottom: 1px solid var(--color-border-subtle);
}

.inspector {
  padding: 14px;
  overflow-y: auto;
  border-left: 1px solid var(--border-color);
  background: var(--color-surface);
  font-size: 13px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.entity {
  margin: 2px 0 8px;
  font-size: 16px;
  word-break: break-all;
}

.chips,
.tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.tags {
  margin-top: 8px;
}

.tags input {
  width: 90px;
  font-size: 12px;
}

.chip {
  padding: 2px 8px;
  border: 1.5px solid;
  border-radius: var(--radius-pill);
  font-size: 12px;
}

.chip.linked {
  border-color: transparent;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.chip.plain {
  border-color: var(--border-color);
  color: var(--text-color);
}

.x {
  padding: 0 2px;
  border: 0;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.suggestions {
  margin-top: 10px;
  padding: 8px;
  border: 1px dashed var(--color-suggested-fg);
  border-radius: var(--radius-sm);
  background: var(--color-suggested-bg);
}

.suggestion {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0;
}

.suggestion .row {
  display: flex;
  gap: 10px;
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}

.row-actions .on {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.inspector-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 8px 0;
  border-bottom: 1px solid var(--border-color);
}

.inspector-tabs button {
  padding: 6px 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.inspector-tabs button.active {
  font-weight: 600;
  border-bottom-color: var(--color-primary);
}

.props {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
}

.props dt {
  color: var(--text-muted);
}

.props dd {
  margin: 0;
  word-break: break-word;
}

.props .section {
  margin-top: 8px;
  font-weight: 600;
}

.mono {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  white-space: pre-wrap;
}

.mono.small {
  font-size: 11px;
}

.conflict {
  color: var(--color-warning);
  font-size: 12px;
}

.origin-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-color);
}

.role-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.role-row select {
  flex: 1;
}

.action-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-error);
}

.notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.note {
  padding: 6px 0;
  border-bottom: 1px solid var(--border-color);
}

.note p {
  margin: 0 0 2px;
  white-space: pre-wrap;
}

.item-link {
  padding: 4px 0;
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  background: none;
  font: inherit;
  text-align: left;
  color: var(--color-primary);
  cursor: pointer;
}

.link-btn {
  padding: 0;
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

.bulk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.bulk input,
.bulk select {
  flex: 1;
  min-width: 90px;
  font-size: 12px;
}

.palette {
  display: inline-flex;
  gap: 3px;
}

.swatch {
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}

.swatch.on {
  border-color: var(--text-color);
}

.small {
  font-size: 12px;
}

.compare {
  max-height: 260px;
  overflow: auto;
  margin-top: 6px;
}

.compare table {
  border-collapse: collapse;
  font-size: 12px;
}

.compare th,
.compare td {
  padding: 2px 6px;
  border-bottom: 1px solid var(--color-border-subtle);
  text-align: left;
  white-space: nowrap;
}

.plain-list {
  margin: 8px 0 0;
  padding-left: 16px;
}
</style>
