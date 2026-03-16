<script setup lang="ts">
import { ref, computed } from 'vue';
import { X } from 'lucide-vue-next';
import {
  isUniformObjectArray,
  extractCommonKeys,
  truncateValue,
  isComplexValue,
} from '@/utils/jsonDetection';

const MAX_KEYS_COLLAPSED = 10;
const MAX_DEPTH = 4;
const PAGE_SIZE = 50;

const props = withDefaults(defineProps<{
  value: unknown;
  maxRows?: number;
  depth?: number;
}>(), {
  maxRows: PAGE_SIZE,
  depth: 0,
});

const showTableModal = ref(false);
const showAllKeys = ref(false);
const visiblePage = ref(1);

// Expanded cells in table modal: "row:col" keys
const expandedCells = ref(new Set<string>());

// Depth limit — beyond MAX_DEPTH, fall back to raw JSON
const tooDeep = computed(() => props.depth >= MAX_DEPTH);

// What kind of JSON value is this?
const isObject = computed(() =>
  typeof props.value === 'object' && props.value !== null && !Array.isArray(props.value)
);
const isArrayTable = computed(() => !tooDeep.value && isUniformObjectArray(props.value));

// Object → vertical table entries (with pagination)
const allObjectEntries = computed(() => {
  if (!isObject.value) return [];
  return Object.entries(props.value as Record<string, unknown>);
});

const objectEntries = computed(() => {
  if (showAllKeys.value) return allObjectEntries.value;
  return allObjectEntries.value.slice(0, MAX_KEYS_COLLAPSED);
});

const hasHiddenKeys = computed(() =>
  !showAllKeys.value && allObjectEntries.value.length > MAX_KEYS_COLLAPSED
);

const hiddenKeyCount = computed(() =>
  allObjectEntries.value.length - MAX_KEYS_COLLAPSED
);

// Object should start collapsed when it has many keys or is nested
const startOpen = computed(() =>
  props.depth === 0 && allObjectEntries.value.length <= MAX_KEYS_COLLAPSED
);

// Array of objects → horizontal table
const tableColumns = computed(() => {
  if (!isArrayTable.value) return [];
  return extractCommonKeys(props.value as Record<string, unknown>[]);
});

const tableRows = computed(() => {
  if (!Array.isArray(props.value)) return [];
  return props.value as Record<string, unknown>[];
});

const visibleRows = computed(() => {
  return tableRows.value.slice(0, visiblePage.value * PAGE_SIZE);
});

const totalRows = computed(() => tableRows.value.length);
const hasMoreRows = computed(() => visibleRows.value.length < totalRows.value);

const formattedJson = computed(() => JSON.stringify(props.value, null, 2));

function cellKey(rowIndex: number, col: string): string {
  return `${rowIndex}:${col}`;
}

function toggleCell(rowIndex: number, col: string) {
  const key = cellKey(rowIndex, col);
  if (expandedCells.value.has(key)) {
    expandedCells.value.delete(key);
  } else {
    expandedCells.value.add(key);
  }
}

function isCellExpanded(rowIndex: number, col: string): boolean {
  return expandedCells.value.has(cellKey(rowIndex, col));
}

function formatPrimitive(value: unknown, maxLen = 120): string {
  if (value === null || value === undefined) return 'null';
  const str = typeof value === 'string' ? value : String(value);
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

function openTableModal() {
  showTableModal.value = true;
  visiblePage.value = 1;
  expandedCells.value.clear();
}

function loadMoreRows() {
  visiblePage.value++;
}
</script>

<template>
  <div class="json-value-viewer">

    <!-- CASE 0: Too deep → raw JSON -->
    <pre v-if="tooDeep && (isObject || Array.isArray(value))" class="json-block">{{ formattedJson }}</pre>

    <!-- CASE 1: Object → collapsible vertical table (Key | Value) -->
    <details v-else-if="isObject" class="object-details" :open="startOpen">
      <summary class="object-summary">
        Object { {{ allObjectEntries.length }} keys }
      </summary>
      <table class="vertical-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="[key, val] in objectEntries" :key="key">
            <td class="vt-key" :title="key">{{ key }}</td>
            <td class="vt-val">
              <!-- Nested complex value: recursive viewer with depth tracking -->
              <JsonValueViewer v-if="isComplexValue(val)" :value="val" :maxRows="maxRows" :depth="depth + 1" />
              <span v-else :title="String(val)">{{ formatPrimitive(val) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <button v-if="hasHiddenKeys" class="show-more-btn" @click="showAllKeys = true">
        Show {{ hiddenKeyCount }} more keys
      </button>
    </details>

    <!-- CASE 2: Array of uniform objects → button to open table modal -->
    <template v-else-if="isArrayTable">
      <button class="open-table-btn" @click="openTableModal">
        View Table ({{ totalRows }} rows)
      </button>

      <!-- Table Modal -->
      <Teleport to="body">
        <div v-if="showTableModal" class="table-modal-overlay" @click.self="showTableModal = false">
          <div class="table-modal-content">
            <div class="table-modal-header">
              <h3>JSON Array — {{ totalRows }} rows, {{ tableColumns.length }} columns</h3>
              <button class="close-btn btn-icon-only" aria-label="Close" @click="showTableModal = false"><X :size="16" /></button>
            </div>
            <div class="table-modal-body">
              <div class="table-scroll">
                <table class="json-table">
                  <thead>
                    <tr>
                      <th class="row-num-header">#</th>
                      <th v-for="col in tableColumns" :key="col">{{ col }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="(row, rowIdx) in visibleRows" :key="rowIdx">
                      <tr>
                        <td class="row-num">{{ rowIdx + 1 }}</td>
                        <td v-for="col in tableColumns" :key="col">
                          <template v-if="isComplexValue(row[col])">
                            <span
                              class="cell-complex"
                              @click="toggleCell(rowIdx, col)"
                              :title="isCellExpanded(rowIdx, col) ? 'Click to collapse' : 'Click to expand'"
                            >
                              {{ truncateValue(row[col]) }}
                              <span class="expand-indicator">
                                {{ isCellExpanded(rowIdx, col) ? '&#9660;' : '&#9654;' }}
                              </span>
                            </span>
                          </template>
                          <span v-else>{{ formatPrimitive(row[col]) }}</span>
                        </td>
                      </tr>
                      <!-- Expanded inline detail for complex cells -->
                      <tr
                        v-for="col in tableColumns.filter(c => isCellExpanded(rowIdx, c))"
                        :key="`${rowIdx}-${col}-expand`"
                        class="expanded-row"
                      >
                        <td :colspan="tableColumns.length + 1" class="expanded-cell">
                          <div class="expanded-cell-header">{{ col }}:</div>
                          <pre class="expanded-json">{{ JSON.stringify(row[col], null, 2) }}</pre>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
              <button
                v-if="hasMoreRows"
                class="show-more-btn"
                @click="loadMoreRows"
              >
                Load {{ Math.min(PAGE_SIZE, totalRows - visibleRows.length) }} more
                ({{ totalRows - visibleRows.length }} remaining)
              </button>
            </div>
            <div class="table-modal-footer">
              <button class="dismiss-btn" @click="showTableModal = false">Close</button>
            </div>
          </div>
        </div>
      </Teleport>
    </template>

    <!-- CASE 3: Other (array of primitives, etc.) → formatted JSON -->
    <pre v-else class="json-block">{{ formattedJson }}</pre>
  </div>
</template>

<style scoped>
.json-value-viewer {
  width: 100%;
}

/* ─── Object: vertical collapsible table ─── */
.object-details {
  font-size: 12px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.object-summary {
  cursor: pointer;
  padding: 4px 0;
  color: var(--text-muted, #666);
  font-size: 11px;
  user-select: none;
  list-style: inside;
}

.object-summary:hover {
  color: var(--text-primary, #333);
}

.vertical-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
  margin-top: 4px;
}

.vertical-table th {
  background: var(--bg-secondary, #f0f0f0);
  padding: 4px 8px;
  text-align: left;
  font-weight: 600;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-muted, #888);
  border-bottom: 1px solid var(--border-color, #ddd);
}

.vertical-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-color, #eee);
  vertical-align: top;
}

.vertical-table tr:last-child td {
  border-bottom: none;
}

.vt-key {
  color: var(--text-muted, #666);
  font-weight: 500;
  width: 30%;
  word-break: break-word;
  overflow-wrap: break-word;
}

.vt-val {
  color: var(--text-primary, #333);
  word-break: break-word;
  overflow-wrap: break-word;
  overflow: hidden;
}

/* ─── Array: open table button ─── */
.open-table-btn {
  padding: 6px 14px;
  font-size: 12px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  background: var(--bg-secondary, #f0f0f0);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
  color: var(--primary-color, #42b883);
  transition: all 0.15s;
}

.open-table-btn:hover {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

/* ─── Table Modal ─── */
.table-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10001;
}

.table-modal-content {
  background: var(--card-background, white);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  max-width: 90vw;
  width: 900px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.table-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color, #eee);
}

.table-modal-header h3 {
  margin: 0;
  font-size: 16px;
  color: var(--text-primary, #333);
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--text-muted, #666);
  padding: 0;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-primary, #333);
}

.table-modal-body {
  padding: 16px 20px;
  overflow: auto;
  flex: 1;
}

.table-modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border-color, #eee);
  display: flex;
  justify-content: flex-end;
}

.dismiss-btn {
  padding: 8px 20px;
  background: var(--primary-color, #42b883);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.dismiss-btn:hover {
  background: var(--primary-hover, #3aa876);
}

/* ─── Table (shared between inline and modal) ─── */
.table-scroll {
  overflow: auto;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
}

.json-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.json-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

.json-table th {
  background: var(--bg-secondary, #f0f0f0);
  padding: 6px 10px;
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  border-bottom: 2px solid var(--border-color, #ddd);
  white-space: nowrap;
}

.json-table td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-color, #eee);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.json-table tbody tr:hover {
  background: var(--bg-secondary, #f8f8f8);
}

.row-num-header {
  width: 40px;
  text-align: center;
}

.row-num {
  color: var(--text-muted, #999);
  text-align: center;
  font-size: 10px;
  width: 40px;
}

.cell-complex {
  cursor: pointer;
  color: var(--primary-color, #42b883);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.cell-complex:hover {
  text-decoration: underline;
}

.expand-indicator {
  font-size: 9px;
  flex-shrink: 0;
}

.expanded-row {
  background: var(--bg-secondary, #f8f8f8);
}

.expanded-cell {
  padding: 8px 12px !important;
  max-width: none !important;
  white-space: normal !important;
}

.expanded-cell-header {
  font-weight: 600;
  font-size: 11px;
  color: var(--text-muted, #666);
  margin-bottom: 4px;
}

.expanded-json {
  margin: 0;
  padding: 8px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #eee);
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.show-more-btn {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--bg-secondary, #f0f0f0);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-muted, #666);
  text-align: center;
}

.show-more-btn:hover {
  background: var(--bg-tertiary, #e0e0e0);
}

/* ─── Fallback: raw JSON ─── */
.json-block {
  margin: 0;
  padding: 8px 12px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}
</style>
