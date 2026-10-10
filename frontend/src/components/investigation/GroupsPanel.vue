<script setup lang="ts">
/**
 * Groups without code (05 §5): from the current selection (name, color, close),
 * or by property, role, tag, community (Louvain) or connected component. A group
 * is a `group` annotation; closed groups collapse into a cluster node and the
 * list below renames, paints, closes and deletes them.
 */
import { computed, ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';
import { useToast } from '@/composables/useToast';
import { GROUP_COLORS } from '@/utils/casePresets';
import { connectedComponents } from '@/utils/graphComponents';
import { getErrorMessage } from '@/utils/errorMessage';
import { ROLE_LABELS } from '@/utils/graphAppearance';

const props = defineProps<{ canEdit: boolean; paintByGroup: boolean }>();
const emit = defineEmits<{ 'update:paintByGroup': [on: boolean] }>();

const store = useInvestigationStore();
const graph = useGraphStore();
const community = useCommunityStore();
const toast = useToast();

type By = 'property' | 'role' | 'tag' | 'community' | 'component';
const by = ref<By>('property');
const property = ref('');
const busy = ref(false);
const name = ref('');
const color = ref(0);
const closed = ref(false);
const renaming = ref<string | null>(null);
const renameDraft = ref('');

const selected = computed(() => [...graph.selectedNodeIds]);
const properties = computed(() => {
  const keys = new Set<string>();
  for (const n of store.unified.nodes) for (const k of Object.keys(n.properties ?? {})) keys.add(k);
  return [...keys].sort();
});

/** Rule → named member lists, without persisting (preview first). */
function partition(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (label: string, id: string) => out.set(label, [...(out.get(label) ?? []), id]);
  const nodes = store.unified.nodes;
  if (by.value === 'property' && property.value) {
    for (const n of nodes) {
      const v = n.properties?.[property.value];
      if (v !== null && v !== undefined && String(v) !== '') add(`${property.value} = ${String(v)}`, n.node_id);
    }
  } else if (by.value === 'role') {
    for (const [id, role] of Object.entries(store.roles)) add(ROLE_LABELS[role] ?? role, id);
  } else if (by.value === 'tag') {
    for (const [id, tags] of store.entityTags) for (const t of tags) add(t, id);
  } else if (by.value === 'community') {
    for (const [id, c] of community.communityMap) add(community.communityLabels[c] ?? `Comunidade ${c + 1}`, id);
  } else if (by.value === 'component') {
    const comps = connectedComponents(
      nodes.map((n) => n.node_id),
      store.unified.edges.map((e) => [e.src, e.dst] as [string, string]),
      'weak',
    );
    for (const [id, c] of comps) add(`Componente ${c + 1}`, id);
  }
  // Singletons are not groups.
  for (const [k, v] of [...out]) if (v.length < 2) out.delete(k);
  return out;
}

const preview = computed(() => partition());

async function detectCommunities() {
  busy.value = true;
  try {
    community.algorithm = 'louvain';
    await community.runDetection();
    if (community.error) toast.error(community.error);
  } finally {
    busy.value = false;
  }
}

async function createFromRule() {
  const parts = partition();
  if (!parts.size) return;
  busy.value = true;
  try {
    let i = store.groups.length;
    for (const [label, ids] of parts) {
      await store.addGroup(`${label} · ${ids.length} nós`, ids, { color: i++, by: by.value === 'property' ? `property:${property.value}` : by.value });
    }
    toast.success(`${parts.size} ${parts.size === 1 ? 'group' : 'groups'} created`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to create the groups'));
  } finally {
    busy.value = false;
  }
}

async function createFromSelection() {
  if (selected.value.length < 2) return;
  busy.value = true;
  try {
    await store.addGroup(name.value.trim() || `Grupo ${store.groups.length + 1}`, selected.value, { color: color.value, by: 'selection', closed: closed.value });
    name.value = '';
    toast.success('Group created');
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to create the group'));
  } finally {
    busy.value = false;
  }
}

function startRename(id: string, current: string) {
  renaming.value = id;
  renameDraft.value = current;
}

async function commitRename(id: string) {
  const value = renameDraft.value.trim();
  renaming.value = null;
  if (value) await store.renameGroup(id, { name: value }).catch((e) => toast.error(getErrorMessage(e, 'Failed to rename')));
}

const act = (fn: () => Promise<unknown>, fallback: string) => fn().catch((e) => toast.error(getErrorMessage(e, fallback)));
</script>

<template>
  <div class="groups" data-testid="groups-panel">
    <section>
      <h4>From the selection <span class="muted">{{ selected.length }} selected</span></h4>
      <div class="row">
        <input v-model="name" placeholder="Group name" data-testid="group-name" :disabled="!canEdit" />
        <span class="palette">
          <button
            v-for="(c, i) in GROUP_COLORS"
            :key="c"
            class="swatch"
            :class="{ on: color === i }"
            :style="{ background: c }"
            :aria-label="`Color ${i + 1}`"
            :data-testid="`group-color-${i}`"
            @click="color = i"
          ></button>
        </span>
        <label><input v-model="closed" type="checkbox" data-testid="group-closed" /> close (one node)</label>
        <button class="btn btn-primary btn-sm" :disabled="!canEdit || busy || selected.length < 2" data-testid="group-create" @click="createFromSelection">Group</button>
      </div>
    </section>

    <section>
      <h4>By…</h4>
      <div class="row">
        <select v-model="by" data-testid="group-by">
          <option value="property">property</option>
          <option value="role">role</option>
          <option value="tag">tag</option>
          <option value="community">community (Louvain)</option>
          <option value="component">connected component</option>
        </select>
        <select v-if="by === 'property'" v-model="property" data-testid="group-property">
          <option value="">— property —</option>
          <option v-for="p in properties" :key="p" :value="p">{{ p }}</option>
        </select>
        <button v-if="by === 'community'" class="btn btn-outline btn-sm" :disabled="busy" data-testid="group-detect" @click="detectCommunities">
          {{ community.hasResults ? `Detect again (${community.communityCount})` : 'Detect communities' }}
        </button>
        <span class="muted" data-testid="group-preview">{{ preview.size }} {{ preview.size === 1 ? 'group' : 'groups' }}</span>
        <button class="btn btn-primary btn-sm" :disabled="!canEdit || busy || !preview.size" data-testid="group-create-rule" @click="createFromRule">Create</button>
      </div>
    </section>

    <section v-if="store.groups.length">
      <h4>
        Groups
        <label class="paint"><input :checked="props.paintByGroup" type="checkbox" data-testid="paint-by-group" @change="emit('update:paintByGroup', ($event.target as HTMLInputElement).checked)" /> paint by group</label>
      </h4>
      <div v-for="g in store.groups" :key="g.id" class="group-row" :data-testid="`group-${g.id}`">
        <span class="dot" :style="{ background: g.color }"></span>
        <input
          v-if="renaming === g.id"
          v-model="renameDraft"
          class="rename"
          @keydown.enter.prevent="commitRename(g.id)"
          @keydown.esc.prevent="renaming = null"
          @blur="commitRename(g.id)"
        />
        <button v-else class="name" :title="g.by ? `by ${g.by}` : ''" :disabled="!canEdit" @click="startRename(g.id, g.name)">{{ g.name }}</button>
        <span class="muted">{{ g.targets.length }}</span>
        <button class="link-btn" :data-testid="`group-select-${g.id}`" @click="graph.selectedNodeIds = new Set(g.targets)">select</button>
        <button
          v-if="canEdit"
          class="link-btn"
          :data-testid="`group-close-${g.id}`"
          @click="act(() => store.setGroupClosed(g.id, !store.groupsClosed.includes(g.id)), 'Failed to update the group')"
        >
          {{ store.groupsClosed.includes(g.id) ? 'open' : 'close' }}
        </button>
        <button v-if="canEdit" class="link-btn danger" :data-testid="`group-delete-${g.id}`" @click="act(() => store.deleteAnnotation(g.id), 'Failed to delete the group')">delete</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
}

h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 13px;
}

.muted {
  font-weight: normal;
  color: var(--text-muted);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.row input[type='text'],
.row input:not([type]) {
  flex: 1;
  min-width: 120px;
}

.palette {
  display: inline-flex;
  gap: 3px;
}

.swatch {
  width: 16px;
  height: 16px;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}

.swatch.on {
  border-color: var(--text-color);
}

.paint {
  margin-left: auto;
  font-weight: normal;
  font-size: 12px;
}

.group-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.name {
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  cursor: text;
  color: var(--text-color);
}

.rename {
  font: inherit;
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

.link-btn.danger {
  color: var(--color-error);
}
</style>
