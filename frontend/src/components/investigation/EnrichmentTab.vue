<script setup lang="ts">
/**
 * Inspector "Enrichment" tab (T2, F2.2): the source contexts' enrichment tables for
 * the selected node. Each table is looked up once for every node of the graph it
 * applies to: "one row" tables become node properties, "many rows" tables show as a
 * table, and a table with `promote` can turn a column into nodes (e.g. devices).
 */
import { computed, ref, watch } from 'vue';
import { api } from '@/services/api';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { getErrorMessage } from '@/utils/errorMessage';
import {
  enrichmentKey,
  enrichmentTargets,
  keyedNodes,
  promoteToNodes,
  type EnrichmentTarget,
} from '@/utils/enrichment';
import type { UnifiedNode } from '@/utils/unifyGraph';

const props = defineProps<{ node: UnifiedNode; canEdit: boolean }>();

// Matches the server default (enrichment_max_keys). shortcut: the first 500 keys of the graph only.
const MAX_KEYS = 500;

type Row = Record<string, string | null>;
interface Lookup {
  signature: string;
  loading: boolean;
  error: string | null;
  rows: Record<string, Row[]>;
  truncated: boolean;
  keyed: { node: UnifiedNode; key: string }[];
}

const store = useInvestigationStore();
const graphStore = useGraphStore();
const lookups = ref<Record<string, Lookup>>({});
const promoteError = ref<string | null>(null);

const targets = computed(() => enrichmentTargets(props.node, store.contexts));
const idOf = (t: EnrichmentTarget) => `${t.contextId}:${t.table.name}`;

async function load() {
  for (const t of targets.value) {
    const keyed = keyedNodes(store.unified.nodes, t);
    const keys = [...new Set(keyed.map((k) => k.key))];
    const signature = keys.join('\u0000');
    const id = idOf(t);
    const known = lookups.value[id];
    if (known?.signature === signature) {
      // Same keys, new node objects (the unified graph was rebuilt): keep the rows.
      known.keyed = keyed;
      if (!known.loading && t.table.cardinality === 'one') applyAsProperties(keyed, known.rows);
      continue;
    }
    lookups.value[id] = { signature, loading: true, error: null, rows: {}, truncated: false, keyed };
    try {
      const result = await api.lookupEnrichment(t.contextId, t.table.name, keys.slice(0, MAX_KEYS));
      lookups.value[id] = {
        ...lookups.value[id],
        loading: false,
        rows: result.rows,
        truncated: result.truncated || keys.length > MAX_KEYS,
      };
      if (t.table.cardinality === 'one') applyAsProperties(keyed, result.rows);
    } catch (e) {
      lookups.value[id] = { ...lookups.value[id], loading: false, error: getErrorMessage(e, 'Lookup failed') };
    }
  }
}

/**
 * "One row" tables: the columns become properties of every node that has a row,
 * in one batch. Set on the unified nodes (every tab) and through the graph store
 * so the canvas redraws.
 */
function applyAsProperties(keyed: Lookup['keyed'], rows: Record<string, Row[]>) {
  const patch = new Map<string, Record<string, unknown>>();
  for (const { node, key } of keyed) {
    const row = rows[key]?.[0];
    if (!row) continue;
    node.properties = { ...node.properties, ...row };
    patch.set(node.node_id, row);
  }
  graphStore.patchNodeProperties(patch, { merge: true, clearPending: false });
}

watch([targets, () => store.unified.nodes], load, { immediate: true });

function rowsOf(t: EnrichmentTarget): Row[] {
  const key = enrichmentKey(props.node, t);
  return key === null ? [] : lookups.value[idOf(t)]?.rows[key] ?? [];
}

/** How many nodes of the graph share each value of the promote column. */
function sharedCount(t: EnrichmentTarget, value: string | null): number {
  const lookup = lookups.value[idOf(t)];
  const column = t.table.promote?.id_column;
  if (!lookup || !column || !value) return 0;
  return lookup.keyed.filter(({ key }) => (lookup.rows[key] ?? []).some((r) => r[column] === value)).length;
}

async function promote(t: EnrichmentTarget) {
  const lookup = lookups.value[idOf(t)];
  if (!lookup || !t.table.promote) return;
  promoteError.value = null;
  const source = promoteToNodes(t, lookup.keyed, lookup.rows);
  const promoted = source.nodes.filter((n) => n.node_type === t.table.promote!.node_type).length;
  if (!promoted) {
    promoteError.value = 'No values to promote in this graph.';
    return;
  }
  try {
    await store.addDerived(source, {
      table: t.table.name,
      context_id: t.contextId,
      node_type: t.table.promote.node_type,
      nodes: promoted,
      edges: source.edges.length,
    });
  } catch (e) {
    promoteError.value = getErrorMessage(e, 'Failed to promote');
  }
}
</script>

<template>
  <div class="enrichment" data-testid="inspector-enrichment">
    <p v-if="!targets.length" class="muted">
      No enrichment table applies to this node. Attach one in the context form.
    </p>
    <section v-for="t in targets" :key="idOf(t)" class="card" data-testid="enrichment-card">
      <header>
        <strong>{{ t.table.label }}</strong>
        <span class="muted">
          extra table of {{ store.contexts[t.contextId]?.title ?? t.contextId }} ·
          {{ rowsOf(t).length }} {{ rowsOf(t).length === 1 ? 'row' : 'rows' }}
        </span>
      </header>
      <p v-if="lookups[idOf(t)]?.loading" class="muted">Loading…</p>
      <p v-else-if="lookups[idOf(t)]?.error" class="error">{{ lookups[idOf(t)]?.error }}</p>
      <p v-else-if="!rowsOf(t).length" class="muted">No row for this node.</p>
      <dl v-else-if="t.table.cardinality === 'one'" class="props">
        <template v-for="c in t.table.columns" :key="c">
          <dt>{{ c }}</dt>
          <dd>{{ rowsOf(t)[0][c] ?? '—' }}</dd>
        </template>
      </dl>
      <table v-else class="rows" data-testid="enrichment-rows">
        <thead>
          <tr>
            <th v-for="c in t.table.columns" :key="c">{{ c }}</th>
            <th v-if="t.table.promote" title="Nodes in this graph that share the value">Shared by</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rowsOf(t)" :key="i">
            <td v-for="c in t.table.columns" :key="c">{{ r[c] ?? '—' }}</td>
            <td v-if="t.table.promote" :class="{ shared: sharedCount(t, r[t.table.promote.id_column]) > 1 }">
              {{ sharedCount(t, r[t.table.promote.id_column]) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="lookups[idOf(t)]?.truncated" class="muted">Partial: the lookup hit its key or row limit.</p>
      <button
        v-if="t.table.promote && canEdit"
        class="btn btn-sm btn-outline"
        data-testid="enrichment-promote"
        :disabled="lookups[idOf(t)]?.loading"
        @click="promote(t)"
      >
        Promote {{ t.table.label }} to {{ t.table.promote.node_type }} nodes
      </button>
    </section>
    <p v-if="promoteError" class="error">{{ promoteError }}</p>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 10px;
}
.card header {
  display: flex;
  flex-direction: column;
  margin-bottom: 6px;
}
.muted {
  color: var(--text-muted);
  font-size: 0.8rem;
}
.error {
  color: var(--error-color);
  font-size: 0.8rem;
}
.props {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 0;
  font-size: 0.85rem;
}
.props dt {
  color: var(--text-muted);
}
.props dd {
  margin: 0;
  word-break: break-word;
}
.rows {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
  margin-bottom: 6px;
}
.rows th,
.rows td {
  text-align: left;
  padding: 3px 4px;
  border-bottom: 1px solid var(--border-color);
  word-break: break-word;
}
.shared {
  font-weight: 700;
  color: var(--error-color);
}
</style>
