<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import InputText from 'primevue/inputtext';
import { X } from 'lucide-vue-next';
import InputNumber from 'primevue/inputnumber';
import MultiSelect from 'primevue/multiselect';
import Popover from 'primevue/popover';

import { useGraphStore } from '@/stores/graph';
import { useDrawerResize } from '@/composables/useDrawerResize';
import DatePicker from 'primevue/datepicker';
import {
  type ColMeta,
  detectType, collectOptions, buildColMeta, buildNodeColumns,
  flattenNodeRows, initFilters, coerceValue,
} from '@/composables/useTableColumns';

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'focus-node', nodeId: string): void;
  (e: 'focus-edge', edgeId: string): void;
}>();

const graphStore = useGraphStore();
const { height, isResizing, onMouseDown } = useDrawerResize({
  initialHeight: 280,
  minHeight: 120,
  maxHeightRatio: 0.6,
});

const activeTab = ref<'nodes' | 'edges'>('nodes');
const dtRef = ref<InstanceType<typeof DataTable>>();

// ─── Property keys ───

const nodePropKeys = computed(() => {
  const s = new Set<string>();
  for (const n of graphStore.filteredNodes)
    if (n.properties) for (const k of Object.keys(n.properties)) s.add(k);
  return Array.from(s).sort();
});

const edgePropKeys = computed(() => {
  const s = new Set<string>();
  for (const e of graphStore.filteredEdges)
    if (e.properties) for (const k of Object.keys(e.properties)) s.add(k);
  return Array.from(s).sort();
});

// ─── Flattened data (properties as top-level fields for PrimeVue) ───

const nodeRows = computed(() => flattenNodeRows(graphStore.filteredNodes, nodePropKeys.value, nodeCols.value));

const edgeRows = computed(() => {
  const keys = edgePropKeys.value;
  const colMap = new Map(edgeCols.value.map(c => [c.field, c]));
  return graphStore.filteredEdges.map(e => {
    const r: Record<string, unknown> = {
      edge_id: e.edge_id, relationship_type: e.relationship_type, src: e.src, dst: e.dst,
    };
    for (const k of keys) {
      const field = `prop_${k}`;
      const col = colMap.get(field);
      r[field] = coerceValue(e.properties?.[k] ?? null, col?.type ?? 'text');
    }
    return r;
  });
});

const currentRows = computed(() => activeTab.value === 'nodes' ? nodeRows.value : edgeRows.value);

// ─── Column metadata ───

const nodeCols = computed<ColMeta[]>(() =>
  buildNodeColumns(graphStore.filteredNodes, nodePropKeys.value),
);

const edgeCols = computed<ColMeta[]>(() => {
  const cols: ColMeta[] = [
    buildColMeta('edge_id', 'ID', 'text'),
    buildColMeta('relationship_type', 'Type', 'categorical', collectOptions(graphStore.filteredEdges, e => e.relationship_type)),
    buildColMeta('src', 'Source', 'text'),
    buildColMeta('dst', 'Target', 'text'),
  ];
  for (const k of edgePropKeys.value) {
    const t = detectType(graphStore.filteredEdges, e => e.properties?.[k]);
    const opts = t === 'categorical' ? collectOptions(graphStore.filteredEdges, e => e.properties?.[k]) : undefined;
    cols.push(buildColMeta(`prop_${k}`, k, t, opts));
  }
  return cols;
});

const currentCols = computed(() => activeTab.value === 'nodes' ? nodeCols.value : edgeCols.value);

// ─── Filters (matching PrimeVue menu format) ───

const nodeFilters = ref(initFilters(nodeCols.value));
const edgeFilters = ref(initFilters(edgeCols.value));
watch(nodeCols, c => { nodeFilters.value = initFilters(c); });
watch(edgeCols, c => { edgeFilters.value = initFilters(c); });

const currentFilters = computed({
  get: () => activeTab.value === 'nodes' ? nodeFilters.value : edgeFilters.value,
  set: v => { if (activeTab.value === 'nodes') nodeFilters.value = v; else edgeFilters.value = v; },
});

const globalFilterFields = computed(() => currentCols.value.map(c => c.field));

function clearFilters() {
  if (activeTab.value === 'nodes') nodeFilters.value = initFilters(nodeCols.value);
  else edgeFilters.value = initFilters(edgeCols.value);
  graphStore.setTableFilteredIds(null, null);
}

// Clear graph filter on tab switch (filters are per-tab, graph shouldn't keep stale IDs)
watch(activeTab, () => {
  graphStore.setTableFilteredIds(null, null);
});

// Clear graph filter when component unmounts (panel closed)
onUnmounted(() => {
  graphStore.setTableFilteredIds(null, null);
});

// ─── Row click & selection ───

function onRowClick(event: any) {
  const data = event.data;
  if (!data) return;
  const multi = event.originalEvent?.ctrlKey || event.originalEvent?.metaKey || event.originalEvent?.shiftKey;
  if (activeTab.value === 'nodes') {
    graphStore.selectNode(data.node_id, multi);
    emit('focus-node', data.node_id);
  } else {
    graphStore.selectEdge(data.edge_id, multi);
    const edge = graphStore.filteredEdges.find(e => e.edge_id === data.edge_id);
    if (edge) emit('focus-edge', edge.src);
  }
}

function rowClass(data: Record<string, unknown>) {
  const id = (activeTab.value === 'nodes' ? data.node_id : data.edge_id) as string;
  const sel = activeTab.value === 'nodes' ? graphStore.selectedNodeIds : graphStore.selectedEdgeIds;
  return sel.has(id) ? 'row-selected' : '';
}

// ─── Filtered row count ───

const filteredCount = ref(0);
watch(currentRows, rows => { filteredCount.value = rows.length; }, { immediate: true });

function onFilter(event: any) {
  const filtered = event.filteredValue ?? currentRows.value;
  filteredCount.value = filtered.length;
  syncGraphFilter(filtered);
}

function syncGraphFilter(filteredRows: Record<string, unknown>[]) {
  const total = currentRows.value.length;
  // No filter active — clear table filter
  if (filteredRows.length === total) {
    graphStore.setTableFilteredIds(null, null);
    return;
  }
  if (activeTab.value === 'nodes') {
    const nodeIds = new Set(filteredRows.map(r => r.node_id as string));
    // Also keep all edges whose both endpoints are in the filtered set
    const edgeIds = new Set(
      graphStore.filteredEdges
        .filter(e => nodeIds.has(e.src) && nodeIds.has(e.dst))
        .map(e => e.edge_id)
    );
    graphStore.setTableFilteredIds(nodeIds, edgeIds);
  } else {
    const edgeIds = new Set(filteredRows.map(r => r.edge_id as string));
    // Keep all nodes that are endpoints of filtered edges
    const nodeIds = new Set<string>();
    for (const row of filteredRows) {
      nodeIds.add(row.src as string);
      nodeIds.add(row.dst as string);
    }
    graphStore.setTableFilteredIds(nodeIds, edgeIds);
  }
}

// ─── Cell popover (double-click to inspect) ───

const cellPopover = ref<InstanceType<typeof Popover>>();
const popoverContent = ref('');
const popoverCopied = ref(false);

function onCellDblClick(event: MouseEvent, value: unknown) {
  event.stopPropagation();
  window.getSelection()?.removeAllRanges();
  const text = formatCell(value);
  if (!text) return;
  popoverContent.value = text;
  popoverCopied.value = false;
  cellPopover.value?.toggle(event);
}

function copyPopoverContent() {
  navigator.clipboard.writeText(popoverContent.value);
  popoverCopied.value = true;
}

// ─── Export CSV ───

function exportCSV() {
  dtRef.value?.exportCSV();
}
</script>

<template>
  <div class="data-table-drawer" :style="{ height: height + 'px' }">
    <!-- Drag handle -->
    <div class="drawer-handle" :class="{ resizing: isResizing }" @mousedown="onMouseDown">
      <div class="handle-grip"></div>
    </div>

    <!-- Header -->
    <div class="drawer-header">
      <div class="header-left">
        <button class="tab-btn" :class="{ active: activeTab === 'nodes' }" @click="activeTab = 'nodes'">
          Nodes ({{ graphStore.filteredNodes.length }})
        </button>
        <button class="tab-btn" :class="{ active: activeTab === 'edges' }" @click="activeTab = 'edges'">
          Edges ({{ graphStore.filteredEdges.length }})
        </button>
      </div>
      <div class="header-center">
        <InputText v-model="currentFilters['global'].value" placeholder="Search table..." class="table-search" />
      </div>
      <div class="header-right">
        <button class="action-btn" @click="clearFilters" title="Clear all filters">Clear</button>
        <button class="action-btn" @click="exportCSV" title="Export CSV">CSV</button>
        <button class="action-btn close-btn btn-icon-only" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- Table -->
    <div class="table-wrapper">
      <DataTable
        :key="activeTab"
        ref="dtRef"
        :value="currentRows"
        v-model:filters="currentFilters"
        filterDisplay="menu"
        :globalFilterFields="globalFilterFields"
        scrollable
        scrollHeight="flex"
        :virtualScrollerOptions="{ itemSize: 32 }"
        :rowClass="rowClass"
        @row-click="onRowClick"
        @filter="onFilter"
        :dataKey="activeTab === 'nodes' ? 'node_id' : 'edge_id'"
        size="small"
        :exportFilename="`${activeTab}-${graphStore.currentContext?.title || 'graph'}`"
        stripedRows
      >
        <Column
          v-for="col in currentCols"
          :key="col.field"
          :field="col.field"
          :header="col.header"
          :sortable="true"
          :dataType="col.type === 'date' ? 'date' : col.type === 'numeric' ? 'numeric' : 'text'"
          :showFilterMatchModes="col.type !== 'categorical'"
          :style="{ minWidth: col.field.endsWith('_id') ? '180px' : col.type === 'date' ? '160px' : '120px' }"
        >
          <template #body="{ data }">
            <span
              class="cell-text"
              @dblclick="onCellDblClick($event, data[col.field])"
            >
              {{ formatCell(data[col.field]) }}
            </span>
          </template>
          <template #filter="{ filterModel }">
            <!-- Date -->
            <DatePicker
              v-if="col.type === 'date'"
              v-model="filterModel.value"
              dateFormat="yy-mm-dd"
              placeholder="Pick date..."
              :showIcon="false"
            />
            <!-- Numeric -->
            <InputNumber
              v-else-if="col.type === 'numeric'"
              v-model="filterModel.value"
              :useGrouping="false"
              placeholder="Filter..."
            />
            <!-- Categorical: multi-select -->
            <MultiSelect
              v-else-if="col.type === 'categorical'"
              v-model="filterModel.value"
              :options="col.options"
              optionLabel="label"
              optionValue="value"
              placeholder="All"
              :maxSelectedLabels="1"
              selectedItemsLabel="{0} selected"
            />
            <!-- Text -->
            <InputText
              v-else
              v-model="filterModel.value"
              type="text"
              placeholder="Search..."
            />
          </template>
        </Column>
      </DataTable>

      <Popover ref="cellPopover" class="cell-popover">
        <div class="popover-body">
          <pre class="popover-text">{{ popoverContent }}</pre>
          <button class="popover-copy-btn" @click="copyPopoverContent">
            {{ popoverCopied ? 'Copied!' : 'Copy' }}
          </button>
        </div>
      </Popover>
    </div>

    <!-- Footer -->
    <div class="drawer-footer">
      <span v-if="filteredCount !== currentRows.length">
        {{ filteredCount }} of {{ currentRows.length }} rows
      </span>
      <span v-else>{{ currentRows.length }} rows</span>
    </div>
  </div>
</template>

<style scoped>
.data-table-drawer {
  display: flex;
  flex-direction: column;
  background: var(--card-background, #fff);
  border-top: 1px solid var(--border-color, #ddd);
  overflow: hidden;
}

/* ─── Drag handle ─── */
.drawer-handle {
  height: 8px;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary, #f5f5f5);
  border-bottom: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.drawer-handle:hover,
.drawer-handle.resizing {
  background: var(--border-color, #ddd);
}

.handle-grip {
  width: 40px;
  height: 3px;
  border-radius: 2px;
  background: var(--text-muted, #999);
  opacity: 0.5;
}

.drawer-handle:hover .handle-grip {
  opacity: 0.8;
}

/* ─── Header ─── */
.drawer-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  gap: 4px;
}

.header-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.header-right {
  display: flex;
  gap: 4px;
  align-items: center;
}

.tab-btn {
  padding: 4px 10px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: none;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted, #666);
  transition: all 0.15s;
}

.tab-btn.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.tab-btn:hover:not(.active) {
  background: var(--bg-secondary, #f5f5f5);
}

.table-search {
  width: 220px;
}

.action-btn {
  padding: 4px 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: none;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted, #666);
  transition: all 0.15s;
}

.action-btn:hover {
  background: var(--bg-secondary, #f5f5f5);
}

.close-btn {
  font-size: 16px;
  padding: 2px 8px;
  line-height: 1;
}

/* ─── Table wrapper ─── */
.table-wrapper {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ─── Footer ─── */
.drawer-footer {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--text-muted, #999);
  border-top: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

/* ─── Selected row ─── */
:deep(.row-selected) {
  background: rgba(66, 184, 131, 0.12) !important;
}

:deep(.row-selected:hover) {
  background: rgba(66, 184, 131, 0.2) !important;
}

:deep(.p-datatable) {
  font-size: 12px;
}

:deep(.p-datatable-header-cell) {
  white-space: nowrap;
}

:deep(.p-datatable-tbody > tr) {
  cursor: pointer;
}

:deep(.p-datatable-tbody > tr > td) {
  overflow: hidden;
  max-width: 280px;
}

.cell-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  cursor: default;
}

/* ─── Cell popover ─── */
.popover-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 420px;
  max-height: 260px;
}

.popover-text {
  margin: 0;
  font-size: 12px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-y: auto;
  max-height: 220px;
  padding: 8px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 4px;
  border: 1px solid var(--border-color, #ddd);
}

.popover-copy-btn {
  align-self: flex-end;
  padding: 3px 10px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: none;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted, #666);
  transition: all 0.15s;
}

.popover-copy-btn:hover {
  background: var(--bg-secondary, #f5f5f5);
}
</style>
