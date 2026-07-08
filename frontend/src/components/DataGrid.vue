<script setup lang="ts">
/**
 * Generic, prop-driven results table. Renders arbitrary tabular data with
 * dynamic columns, per-column type-aware filtering, sorting, virtual scrolling,
 * global search and CSV export.
 *
 * The presentational core (PrimeVue DataTable + filter widgets + cell popover)
 * is lifted from DataTablePanel.vue, but decoupled from the graph store: data
 * comes in via props and there is no node/edge selection or graph-sync
 * behavior. Use it for any "rows of objects with dynamic columns" surface.
 */
import { ref, computed, watch } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import MultiSelect from 'primevue/multiselect';
import DatePicker from 'primevue/datepicker';
import Popover from 'primevue/popover';
import { type ColMeta, initFilters } from '@/composables/useTableColumns';
import { useDebouncedModel } from '@/composables/useDebouncedModel';
import { SEARCH_FIELD } from '@/utils/searchText';

const props = withDefaults(
  defineProps<{
    columns: ColMeta[];
    rows: Record<string, unknown>[];
    exportFilename?: string;
    /** When set, cells of this column field render as a clickable node link. */
    nodeIdField?: string;
  }>(),
  {
    exportFilename: 'query-result',
    nodeIdField: undefined,
  },
);

const emit = defineEmits<{
  (e: 'focus-node', payload: { id: string; multi: boolean }): void;
}>();

function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function onNodeClick(event: MouseEvent, value: unknown) {
  const multi = event.ctrlKey || event.metaKey || event.shiftKey;
  emit('focus-node', { id: String(value), multi });
}

const dtRef = ref<InstanceType<typeof DataTable>>();

// Attach a stable synthetic key so virtual scrolling has a dataKey without
// depending on any particular id column existing in the result.
const indexedRows = computed(() => props.rows.map((r, i) => ({ ...r, __i: i })));

const filters = ref(initFilters(props.columns));
watch(
  () => props.columns,
  cols => { filters.value = initFilters(cols); },
);

// Search the single pre-built search field instead of every column (built by
// buildGenericRows); one string scan per row rather than N.
const globalFilterFields = [SEARCH_FIELD];

// Debounced global search — writing `global.value` re-filters the whole result
// set (O(n) per keystroke). Clearing filters flows back into the input.
const globalSearch = useDebouncedModel(
  () => filters.value['global'].value as string | null,
  v => { filters.value['global'].value = v; },
);

// ─── Filtered row count ───
const filteredCount = ref(props.rows.length);
watch(
  () => props.rows,
  rows => { filteredCount.value = rows.length; },
);
function onFilter(event: { filteredValue?: unknown[] }) {
  filteredCount.value = (event.filteredValue ?? props.rows).length;
}

function clearFilters() {
  filters.value = initFilters(props.columns);
  globalSearch.value = null; // cancel any pending debounced write + blank the box
  filteredCount.value = props.rows.length;
}

function exportCSV() {
  dtRef.value?.exportCSV();
}

// ─── Cell popover (double-click to inspect / copy) ───
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

defineExpose({ exportCSV, clearFilters });
</script>

<template>
  <div class="data-grid">
    <div class="grid-toolbar">
      <InputText
        v-model="globalSearch"
        placeholder="Search results..."
        class="grid-search"
        data-testid="data-grid-search"
      />
      <span class="grid-count">
        <template v-if="filteredCount !== rows.length">{{ filteredCount }} of {{ rows.length }} rows</template>
        <template v-else>{{ rows.length }} rows</template>
      </span>
    </div>

    <div class="grid-table-wrapper">
      <DataTable
        ref="dtRef"
        :value="indexedRows"
        v-model:filters="filters"
        filterDisplay="menu"
        :globalFilterFields="globalFilterFields"
        scrollable
        scrollHeight="flex"
        :virtualScrollerOptions="{ itemSize: 32 }"
        @filter="onFilter"
        dataKey="__i"
        size="small"
        :exportFilename="exportFilename"
        stripedRows
        data-testid="data-grid-table"
      >
        <Column
          v-for="col in columns"
          :key="col.field"
          :field="col.field"
          :header="col.header"
          :sortable="true"
          :dataType="col.type === 'date' ? 'date' : col.type === 'numeric' ? 'numeric' : 'text'"
          :showFilterMatchModes="col.type !== 'categorical'"
          :style="{ minWidth: col.type === 'date' ? '160px' : '120px' }"
        >
          <template #body="{ data }">
            <span v-if="isNull(data[col.field])" class="cell-null">NULL</span>
            <a
              v-else-if="col.field === nodeIdField"
              class="cell-node-link"
              :title="`Focus node '${formatCell(data[col.field])}' in the graph`"
              @click.stop="onNodeClick($event, data[col.field])"
            >{{ formatCell(data[col.field]) }}</a>
            <span v-else class="cell-text" @dblclick="onCellDblClick($event, data[col.field])">
              {{ formatCell(data[col.field]) }}
            </span>
          </template>
          <template #filter="{ filterModel }">
            <DatePicker
              v-if="col.type === 'date'"
              v-model="filterModel.value"
              dateFormat="yy-mm-dd"
              placeholder="Pick date..."
              :showIcon="false"
            />
            <InputNumber
              v-else-if="col.type === 'numeric'"
              v-model="filterModel.value"
              :useGrouping="false"
              placeholder="Filter..."
            />
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
            <InputText
              v-else
              v-model="filterModel.value"
              type="text"
              placeholder="Search..."
            />
          </template>
        </Column>

        <template #empty>
          <div class="grid-empty">No rows</div>
        </template>
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
  </div>
</template>

<style scoped>
.data-grid {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.grid-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  flex-shrink: 0;
}

.grid-search {
  width: 240px;
}

.grid-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted, #999);
}

.grid-table-wrapper {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.grid-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted, #999);
}

:deep(.p-datatable) {
  font-size: 12px;
}

:deep(.p-datatable-header-cell) {
  white-space: nowrap;
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

.cell-null {
  color: var(--text-muted, #999);
  font-style: italic;
  opacity: 0.7;
}

.cell-node-link {
  color: var(--primary-color, #42b883);
  cursor: pointer;
  text-decoration: none;
  border-bottom: 1px dashed currentColor;
}

.cell-node-link:hover {
  text-decoration: none;
  filter: brightness(0.9);
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
