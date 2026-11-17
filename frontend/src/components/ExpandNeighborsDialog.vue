<script setup lang="ts">
/**
 * Selective expand (hubs-densos F3): opened by graphStore.requestExpand when a
 * node has more than EXPAND_DIALOG_THRESHOLD edges in the source. Shows the
 * counts per relationship type and direction before anything is loaded, and
 * loads only the chosen types.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { formatNodeLabel } from '@/utils/labelFormatter';

const graphStore = useGraphStore();
const MAX_LIMIT = 1000; // what /expand accepts

interface Row {
  type: string;
  inEdges: number;
  outEdges: number;
}

const choice = computed(() => graphStore.expandChoice);
const rows = computed<Row[]>(() => {
  const byType = new Map<string, Row>();
  for (const b of choice.value?.summary.buckets ?? []) {
    const row = byType.get(b.relationship_type) ?? { type: b.relationship_type, inEdges: 0, outEdges: 0 };
    if (b.direction === 'out') row.outEdges += b.edges;
    else row.inEdges += b.edges;
    byType.set(b.relationship_type, row);
  }
  return [...byType.values()].sort((a, b) => b.inEdges + b.outEdges - (a.inEdges + a.outEdges));
});

/** Hide the Out column when nothing goes out (and In when nothing comes in): an empty column reads as "unknown". */
const hasIn = computed(() => rows.value.some((r) => r.inEdges > 0));
const hasOut = computed(() => rows.value.some((r) => r.outEdges > 0));
const checked = ref(new Set<string>());
const limit = ref(100);
const limitTouched = ref(false);
const acceptRef = ref<HTMLButtonElement | null>(null);

const selectedEdges = computed(() =>
  rows.value.filter((r) => checked.value.has(r.type)).reduce((n, r) => n + r.inEdges + r.outEdges, 0),
);
const loadedNow = computed(() => (choice.value ? graphStore.expandProgress.get(choice.value.nodeId)?.loaded ?? 0 : 0));
const effectiveLimit = computed(() => Math.max(4, Math.min(MAX_LIMIT, Math.floor(limit.value || 0))));
const cut = computed(() => Math.max(0, selectedEdges.value - effectiveLimit.value));

/** Own edges load first; some room is left for links among the neighbours. */
function defaultLimit(selected: number): number {
  return Math.min(MAX_LIMIT, Math.max(100, selected + 200));
}

const nodeName = computed(() => {
  const id = choice.value?.nodeId;
  if (!id) return '';
  const node = graphStore.nodes.find((n) => n.node_id === id);
  if (!node) return id;
  return formatNodeLabel(node, graphStore.textFormatRules, graphStore.textFormatDefaults.nodeTemplate) || id;
});

watch(
  choice,
  async (c) => {
    if (!c) return;
    checked.value = new Set(rows.value.map((r) => r.type));
    limitTouched.value = false;
    limit.value = defaultLimit(c.summary.total_edges);
    await nextTick();
    acceptRef.value?.focus();
  },
  { immediate: true },
);

watch(selectedEdges, (n) => {
  if (!limitTouched.value) limit.value = defaultLimit(n);
});

function toggle(type: string) {
  const next = new Set(checked.value);
  if (next.has(type)) next.delete(type);
  else next.add(type);
  checked.value = next;
}

function close() {
  graphStore.expandChoice = null;
}

async function confirm() {
  const c = choice.value;
  if (!c || checked.value.size === 0) return;
  const all = checked.value.size === rows.value.length;
  close();
  await graphStore.expandFromNode(c.nodeId, 1, all ? [] : [...checked.value], effectiveLimit.value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="choice"
      class="expand-overlay"
      data-testid="expand-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="expand-dialog-title"
      @click.self="close"
      @keydown="onKeydown"
    >
      <div class="expand-dialog">
        <h2 id="expand-dialog-title" class="expand-title">Expand {{ nodeName }}</h2>
        <p class="expand-intro" data-testid="expand-dialog-total">
          {{ choice.summary.total_edges.toLocaleString() }} edges in the source<template v-if="loadedNow">,
          {{ loadedNow.toLocaleString() }} already on the canvas</template>. Choose what to load.
        </p>

        <table class="expand-table">
          <thead>
            <tr>
              <th />
              <th>Relationship</th>
              <th v-if="hasIn" class="num">In</th>
              <th v-if="hasOut" class="num">Out</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.type" :data-testid="`expand-row-${r.type}`">
              <td>
                <input
                  :id="`expand-type-${r.type}`"
                  type="checkbox"
                  :checked="checked.has(r.type)"
                  :data-testid="`expand-type-${r.type}`"
                  @change="toggle(r.type)"
                >
              </td>
              <td><label :for="`expand-type-${r.type}`">{{ r.type || '(no type)' }}</label></td>
              <td v-if="hasIn" class="num">{{ r.inEdges.toLocaleString() }}</td>
              <td v-if="hasOut" class="num">{{ r.outEdges.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>

        <label class="expand-limit">
          Load up to
          <input
            v-model.number="limit"
            type="number"
            min="4"
            :max="MAX_LIMIT"
            step="50"
            data-testid="expand-limit"
            @input="limitTouched = true"
          >
          edges
        </label>
        <p class="expand-note" data-testid="expand-dialog-note">
          <template v-if="cut > 0">
            {{ cut.toLocaleString() }} of the {{ selectedEdges.toLocaleString() }} selected edges will not load.
            The node will show how many are loaded.
          </template>
          <template v-else>
            Loads the {{ selectedEdges.toLocaleString() }} selected edges, then up to
            {{ Math.max(0, effectiveLimit - selectedEdges).toLocaleString() }} links between those neighbours.
          </template>
        </p>

        <div class="expand-actions">
          <button type="button" class="btn btn-ghost" data-testid="expand-dialog-cancel" @click="close">Cancel</button>
          <button
            ref="acceptRef"
            type="button"
            class="btn btn-primary"
            data-testid="expand-dialog-accept"
            :disabled="checked.size === 0"
            @click="confirm"
          >
            Expand
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.expand-overlay {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  padding: var(--space-4);
}

.expand-dialog {
  width: min(460px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  padding: var(--space-5);
}

.expand-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
  font-weight: var(--font-semibold);
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.expand-intro,
.expand-note {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: 1.5;
}

.expand-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
  margin-bottom: var(--space-3);
}

.expand-table th {
  text-align: left;
  font-weight: var(--font-medium);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  padding: var(--space-1) var(--space-2);
}

.expand-table td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle, var(--color-border));
}

.expand-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.expand-limit {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  margin-bottom: var(--space-2);
}

.expand-limit input {
  width: 90px;
}

.expand-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.btn-ghost {
  background: transparent;
  color: var(--color-text);
  border: 1px solid var(--color-border);
}
.btn-ghost:hover {
  background: var(--color-bg-muted);
}
</style>
