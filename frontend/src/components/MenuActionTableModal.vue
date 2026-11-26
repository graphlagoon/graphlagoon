<script setup lang="ts">
/**
 * Rows of a right-click table action, the graph untouched. Two sources: a
 * run-query-template action with `resultMode: 'table'` (the server runs the
 * template against the warehouse) or a `show-table` action (the rows come from
 * the graph on the canvas, in the browser). The parameters arrive with the
 * answer, editable, so a filter (period, minimum amount, …) is changed and run
 * again without leaving the modal. Mounted by the exploration and the case views.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { X, Play, RefreshCw } from 'lucide-vue-next';
import DataGrid from './DataGrid.vue';
import QueryRunningState from './QueryRunningState.vue';
import { buildGenericColumns, buildGenericRows } from '@/composables/useTableColumns';
import { useMenuActionTable, MAX_TABLE_ROW_LIMIT, type MenuActionTableRequest } from '@/composables/useMenuActionTable';
import { useAddToCase } from '@/composables/useAddToCase';

const props = defineProps<{
  request: MenuActionTableRequest;
  /** The case to add the rows to (a case canvas); otherwise the current case. */
  caseId?: string | null;
  /** Columns whose cells are node ids of this context: clicking one focuses it on the canvas. */
  nodeIdColumns?: string[];
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'focus-node', payload: { id: string; multi: boolean }): void;
}>();

const table = useMenuActionTable(props.request);
const addToCase = useAddToCase(computed(() => props.caseId ?? undefined));
const adding = ref(false);
/** Rows of this run already in the case: a second click would add a duplicate. */
const added = ref(false);
const gridRef = ref<InstanceType<typeof DataGrid>>();
watch(() => table.rows.value, () => { added.value = false; });

/** "Hops 1 · Node type any": what the rows on screen were run with. */
const ranWithText = computed(() =>
  table.parameters.value
    .filter((p) => !p.binding && table.ranWith.value[p.id])
    .map((p) => `${p.label} ${table.ranWith.value[p.id]}`)
    .join(' · '),
);

const gridColumns = computed(() => buildGenericColumns(table.columns.value, table.rows.value));
const gridRows = computed(() => buildGenericRows(table.rows.value, gridColumns.value));
const nodeIdField = computed(() => {
  // A canvas table holds canvas ids: its node_id (or an edge's src) is on the canvas.
  const wanted = (table.isCanvas ? ['node_id', 'src'] : props.nodeIdColumns ?? ['node_id']).map((c) => c.toLowerCase());
  return gridColumns.value.find((c) => wanted.includes(c.header.toLowerCase()))?.field;
});

const showRows = computed(() => !table.loading.value && !table.error.value && table.columns.value.length > 0);
const showEmpty = computed(
  () => table.hasRun.value && !table.loading.value && !table.error.value && !table.needsParameters.value
    && !table.canceled.value && table.columns.value.length === 0,
);
const exportFilename = computed(() => props.request.label.replace(/[^\w-]+/g, '_').slice(0, 60) || 'table');

async function addRows() {
  if (adding.value) return;
  adding.value = true;
  try {
    const item = await addToCase.addTable({
      columns: table.columns.value,
      rows: table.rows.value,
      title: [props.request.label, props.request.target.id, ranWithText.value].filter(Boolean).join(' · '),
      description: table.templateName.value,
      provenance: props.request.canvas
        ? {
            ...(props.request.contextId ? { context_id: props.request.contextId } : {}),
            tool: 'canvas_table',
            params: {
              action: props.request.actionId,
              source: props.request.canvas.source.type,
              ...(props.request.canvas.source.type === 'neighborhood'
                ? { spec: { ...props.request.canvas.source } }
                : { code: props.request.canvas.source.code }),
              values: { ...table.ranWith.value },
              item: props.request.target.id,
            },
          }
        : {
            context_id: props.request.contextId,
            tool: 'menu_action',
            params: { action: props.request.actionId, template: table.templateName.value, values: { ...table.ranWith.value }, item: props.request.target.id },
          },
    });
    if (item) added.value = true;
  } finally {
    adding.value = false;
  }
}

onMounted(() => void table.run());
// Closed while the query runs: stop it on the warehouse too.
onBeforeUnmount(() => {
  if (table.loading.value) void table.cancel();
});
</script>

<template>
  <div class="modal-overlay" data-testid="menu-action-table-modal" @click.self="emit('close')">
    <div class="modal-content">
      <div class="modal-header">
        <div class="header-info">
          <h2>{{ request.label }}</h2>
          <div class="header-meta">
            <span class="item-id" :title="request.target.id">{{ request.target.node_type || request.target.relationship_type }} · {{ request.target.id }}</span>
            <span
              class="source-badge"
              :class="table.isCanvas ? 'canvas' : 'warehouse'"
              data-testid="menu-action-table-source"
              :title="table.isCanvas ? 'Computed from the graph on the canvas: what is loaded, not everything in the warehouse' : 'Run against the warehouse'"
            >{{ table.isCanvas ? 'Canvas' : 'Warehouse' }}</span>
            <span v-if="table.templateName.value && !table.isCanvas" class="template-name">Query: {{ table.templateName.value }}</span>
            <span v-else-if="table.isCanvas" class="template-name">{{ table.templateName.value }}</span>
            <span v-if="ranWithText && showRows" data-testid="menu-action-table-ran-with">Run with {{ ranWithText }}</span>
          </div>
        </div>
        <button class="btn-close btn-icon-only" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>

      <form v-if="table.parameters.value.length" class="params" data-testid="menu-action-table-params" @submit.prevent="table.run()">
        <label
          v-for="p in table.parameters.value"
          :key="p.id"
          class="param"
          :title="p.locked ? `Fixed by this action${p.description ? `: ${p.description}` : ''}` : p.description || undefined"
        >
          <span class="param-label">{{ p.label }}<span v-if="p.required" class="required">*</span></span>
          <select v-if="p.type === 'select'" v-model="table.values.value[p.id]" :disabled="p.locked" :class="{ invalid: table.problems.value[p.id] }">
            <option v-if="!p.required" value="">—</option>
            <option v-for="o in p.options ?? []" :key="o" :value="o">{{ o }}</option>
          </select>
          <input v-else v-model="table.values.value[p.id]" type="text" :disabled="p.locked" :class="{ invalid: table.problems.value[p.id] }" :data-testid="`menu-action-param-${p.id}`" />
          <span v-if="table.problems.value[p.id]" class="problem">{{ table.problems.value[p.id] }}</span>
        </label>
        <button type="submit" class="btn btn-primary run" :disabled="table.loading.value" data-testid="menu-action-table-run">
          <Play :size="14" /> Run
        </button>
        <span v-if="table.changed.value && !table.loading.value" class="changed" data-testid="menu-action-table-changed">Parameters changed: Run to update the rows.</span>
      </form>

      <div class="modal-body">
        <QueryRunningState
          v-if="table.loading.value"
          :can-cancel="table.canCancel.value"
          @cancel="table.cancel()"
        />
        <div v-else-if="table.error.value" class="state error" data-testid="menu-action-table-error">
          <strong>The query failed.</strong>
          <p>{{ table.error.value }}</p>
          <button class="btn btn-outline" @click="table.run()"><RefreshCw :size="14" /> Try again</button>
        </div>
        <div v-else-if="table.needsParameters.value" class="state" data-testid="menu-action-table-needs">
          Fill in the parameters above and run.
        </div>
        <div v-else-if="table.canceled.value" class="state">Canceled.</div>
        <div v-else-if="showEmpty" class="state" data-testid="menu-action-table-empty">
          No rows for this {{ request.target.type }}<template v-if="table.isCanvas"> in the graph on the canvas</template>.
        </div>
        <template v-else-if="showRows">
          <div v-if="table.truncated.value" class="truncated" data-testid="menu-action-table-truncated">
            Showing the first {{ table.rows.value.length.toLocaleString() }} rows; there are more.
            <button
              v-if="table.rowLimit.value < MAX_TABLE_ROW_LIMIT"
              class="link-btn"
              @click="table.loadAll()"
            >Load up to {{ MAX_TABLE_ROW_LIMIT.toLocaleString() }}</button>
            <span v-else>Narrow it with the parameters.</span>
          </div>
          <div class="grid-host">
            <DataGrid
              ref="gridRef"
              :columns="gridColumns"
              :rows="gridRows"
              :export-filename="exportFilename"
              :node-id-field="nodeIdField"
              @focus-node="emit('focus-node', $event)"
            />
          </div>
        </template>
      </div>

      <div class="modal-footer">
        <button v-if="showRows" class="btn btn-outline" data-testid="menu-action-table-csv" @click="gridRef?.exportCSV()">CSV</button>
        <!-- Always offered: without a current case, the click says to pick one. -->
        <button
          v-if="showRows"
          class="btn btn-outline"
          :disabled="adding || added"
          data-testid="menu-action-table-add-to-case"
          @click="addRows"
        >{{ added ? 'Added ✓' : 'Add to case' }}</button>
        <button class="btn btn-outline" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

/* A fixed height: the grid scrolls inside (virtual scroll needs a definite box). */
.modal-content {
  background: var(--card-background, white);
  border-radius: 8px;
  width: 92%;
  max-width: 1200px;
  height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
}

.modal-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #eee);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.header-info { flex: 1; min-width: 0; }

.modal-header h2 {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}

.header-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted, #666);
}

.source-badge {
  padding: 0 6px;
  border-radius: 8px;
  font-weight: 600;
  border: 1px solid var(--border-color, #ddd);
}
.source-badge.canvas { color: var(--success-text, #1b6e3a); }
.source-badge.warehouse { color: var(--text-muted, #666); }

.item-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50ch;
}

.btn-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted, #666);
  padding: 4px;
}

.params {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-color, #eee);
}

.param {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  min-width: 140px;
}

.param-label { color: var(--text-muted, #666); }
.required { color: var(--danger-color, #c0392b); margin-left: 2px; }

.param input,
.param select {
  padding: 5px 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  font-size: 13px;
  background: var(--input-background, white);
  color: inherit;
}

.param input[type='text'] { min-width: 22ch; }

.changed {
  align-self: flex-end;
  padding-bottom: 6px;
  font-size: 12px;
  color: var(--warning-text, #8a5a00);
}

.param .invalid { border-color: var(--danger-color, #c0392b); }
.problem { color: var(--danger-color, #c0392b); max-width: 240px; }

.run {
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.grid-host {
  flex: 1;
  min-height: 0;
}

.state {
  margin: auto;
  padding: 24px;
  text-align: center;
  color: var(--text-muted, #666);
}

.state.error p {
  margin: 8px 0 12px;
  max-width: 70ch;
  white-space: pre-wrap;
  color: var(--danger-color, #c0392b);
}

.truncated {
  padding: 6px 20px;
  font-size: 12px;
  background: var(--warning-background, #fff8e1);
  border-bottom: 1px solid var(--border-color, #eee);
}

.link-btn {
  background: none;
  border: none;
  padding: 0;
  margin-left: 6px;
  color: var(--primary-color, #2563eb);
  cursor: pointer;
  text-decoration: underline;
  font-size: inherit;
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border-color, #eee);
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

</style>
