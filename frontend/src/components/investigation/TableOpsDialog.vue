<script setup lang="ts">
/**
 * Operations on the selected table items (05 §3): **Join** by key (a new
 * table with the parents as provenance), **Compare** two tables (diff by
 * key), **Bulk promote** to enrichment (one shared key column) and
 * **Merge into the graph** (each table gets its own mapping, source/target columns).
 * The columns come from each item's latest content.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '@/services/api';
import TableDiffView from './TableDiffView.vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { commonColumn, parseTableContent } from '@/utils/caseTables';
import type { CaseItem, TableDiff } from '@/types/investigation';

export type TableOp = 'join' | 'compare' | 'enrichment' | 'graph';

const props = defineProps<{ investigationId: string; op: TableOp; items: CaseItem[] }>();
const emit = defineEmits<{ close: []; done: [] }>();

const store = useInvestigationStore();
const toast = useToast();

const TITLES: Record<TableOp, string> = {
  join: 'Join tables by key',
  compare: 'Compare two tables',
  enrichment: 'Promote to enrichment',
  graph: 'Merge into the graph',
};

const columns = ref<Record<string, string[]>>({});
const loading = ref(true);
const busy = ref(false);
const key = ref('');
const title = ref('');
const nodeTypes = ref('');
const source = ref('');
const target = ref('');
const sourceType = ref('Entity');
const edgeType = ref('related');
const normalize = ref('');
const diff = ref<TableDiff | null>(null);

const shared = computed(() => commonColumn(props.items.map((i) => columns.value[i.id] ?? [])));
const allColumns = computed(() => [...new Set(props.items.flatMap((i) => columns.value[i.id] ?? []))]);
const canSubmit = computed(() => {
  if (props.op === 'graph') return !!source.value && !!target.value;
  return !!key.value;
});

onMounted(async () => {
  try {
    for (const item of props.items) {
      const data = await api.getInvestigationItemContent(props.investigationId, item.id);
      columns.value[item.id] = parseTableContent(data, item.latest?.content_type ?? 'application/json').columns;
    }
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to read the tables'));
  } finally {
    loading.value = false;
  }
  key.value = shared.value ?? allColumns.value[0] ?? '';
  source.value = allColumns.value[0] ?? '';
  target.value = allColumns.value[1] ?? allColumns.value[0] ?? '';
  if (props.op === 'join') title.value = `${props.items.map((i) => i.title).join(' + ')} by ${key.value}`;
});

async function submit() {
  if (!canSubmit.value || busy.value) return;
  busy.value = true;
  const ids = props.items.map((i) => i.id);
  try {
    if (props.op === 'join') {
      const item = await api.joinInvestigationTables(props.investigationId, { item_ids: ids, key_column: key.value, title: title.value || undefined });
      toast.success(`Table “${item.title}” created`);
    } else if (props.op === 'compare') {
      diff.value = await api.compareInvestigationTables(props.investigationId, { left: { item_id: ids[0] }, right: { item_id: ids[1] }, key_column: key.value });
      return;
    } else if (props.op === 'enrichment') {
      const types = nodeTypes.value.split(',').map((t) => t.trim()).filter(Boolean);
      await api.promoteInvestigationTables(props.investigationId, { item_ids: ids, as: 'enrichment', options: { key_column: key.value, match_node_types: types.length ? types : ['*'] } });
      toast.success(`${ids.length} table${ids.length === 1 ? '' : 's'} promoted to enrichment by ${key.value}`);
    } else {
      await api.promoteInvestigationTables(props.investigationId, {
        item_ids: ids,
        as: 'graph',
        options: { source_column: source.value, target_column: target.value, source_type: sourceType.value || 'Entity', edge_type: edgeType.value || 'related', ...(normalize.value ? { normalize: normalize.value } : {}) },
      });
      toast.success(`${ids.length} table${ids.length === 1 ? '' : 's'} in the graph, each as a source`);
    }
    await store.fetchItems();
    if (props.op === 'graph') await store.loadWorkspace();
    emit('done');
    emit('close');
  } catch (e) {
    toast.error(getErrorMessage(e, 'The operation failed'));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal ops" :class="{ wide: diff }" data-testid="table-ops-dialog">
      <div class="modal-header">
        <h2>{{ TITLES[op] }}</h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>

      <TableDiffView v-if="diff" :diff="diff" />

      <template v-else>
        <p class="muted">
          {{ items.map((i) => i.title).join(' · ') }}
          <template v-if="loading"> · reading columns…</template>
        </p>

        <template v-if="op !== 'graph'">
          <div class="form-group">
            <label for="ops-key">Key column</label>
            <input id="ops-key" v-model="key" class="form-control" list="ops-columns" data-testid="ops-key" />
            <datalist id="ops-columns"><option v-for="c in allColumns" :key="c" :value="c"></option></datalist>
            <span v-if="shared" class="muted">In common: {{ shared }}</span>
            <span v-else-if="!loading" class="muted">The tables share no column; pick the key with care.</span>
          </div>
          <div v-if="op === 'join'" class="form-group">
            <label for="ops-title">Title of the new table</label>
            <input id="ops-title" v-model="title" class="form-control" data-testid="ops-title" />
          </div>
          <div v-if="op === 'enrichment'" class="form-group">
            <label for="ops-types">Entity types to match (comma-separated; empty = all)</label>
            <input id="ops-types" v-model="nodeTypes" class="form-control" placeholder="Person, Account" data-testid="ops-node-types" />
          </div>
        </template>

        <template v-else>
          <div class="grid">
            <div class="form-group">
              <label for="ops-src">Source column</label>
              <input id="ops-src" v-model="source" class="form-control" list="ops-columns" data-testid="ops-source" />
            </div>
            <div class="form-group">
              <label for="ops-dst">Target column</label>
              <input id="ops-dst" v-model="target" class="form-control" list="ops-columns" data-testid="ops-target" />
            </div>
            <div class="form-group">
              <label for="ops-ntype">Entity type</label>
              <input id="ops-ntype" v-model="sourceType" class="form-control" />
            </div>
            <div class="form-group">
              <label for="ops-etype">Edge type</label>
              <input id="ops-etype" v-model="edgeType" class="form-control" />
            </div>
            <div class="form-group">
              <label for="ops-norm">Normalize ids</label>
              <select id="ops-norm" v-model="normalize" class="form-control">
                <option value="">none</option>
                <option value="digits">Digits (document id)</option>
                <option value="account">account</option>
                <option value="phone">phone</option>
                <option value="email">e-mail</option>
                <option value="lower">lowercase</option>
              </select>
            </div>
          </div>
          <datalist id="ops-columns"><option v-for="c in allColumns" :key="c" :value="c"></option></datalist>
          <p class="muted">The other columns become edge properties. Each table comes in as its own source, with a ring.</p>
        </template>

        <div class="modal-footer">
          <button type="button" class="btn btn-outline" @click="emit('close')">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="!canSubmit || busy || loading" data-testid="ops-submit" @click="submit">
            {{ op === 'join' ? 'Join' : op === 'compare' ? 'Compare' : op === 'enrichment' ? 'Promote' : 'Merge into the graph' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ops {
  max-width: 560px;
  width: 95vw;
}

.ops.wide {
  max-width: 960px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  font-size: 13px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
