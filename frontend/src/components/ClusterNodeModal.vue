<script setup lang="ts">
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import {
  type ColMeta,
  buildNodeColumns, flattenNodeRows,
} from '@/composables/useTableColumns'
import { X } from 'lucide-vue-next'

interface Props {
  clusterId: string | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
}>()

const clusterStore = useClusterStore()

const cluster = computed(() => {
  if (!props.clusterId) return null
  return clusterStore.clusters.find(c => c.cluster_id === props.clusterId)
})

const nodes = computed(() => {
  if (!cluster.value) return []
  return clusterStore.getClusterNodes(cluster.value.cluster_id)
})

// ─── Property keys ───

const propKeys = computed(() => {
  const keys = new Set<string>()
  for (const node of nodes.value)
    if (node.properties) for (const k of Object.keys(node.properties)) keys.add(k)
  return Array.from(keys).sort()
})

// ─── Column metadata + flat rows ───

const cols = computed<ColMeta[]>(() => buildNodeColumns(nodes.value, propKeys.value))
const rows = computed(() => flattenNodeRows(nodes.value, propKeys.value))

// ─── Search & Sort ───

const searchQuery = ref('')
const sortField = ref('node_id')
const sortAsc = ref(true)

const filteredRows = computed(() => {
  let result = rows.value

  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(row =>
      cols.value.some(col => {
        const v = row[col.field]
        return v != null && String(v).toLowerCase().includes(q)
      })
    )
  }

  return [...result].sort((a, b) => {
    const av = a[sortField.value]
    const bv = b[sortField.value]
    if (av == null) return 1
    if (bv == null) return -1
    const col = cols.value.find(c => c.field === sortField.value)
    if (col?.type === 'numeric') {
      const diff = Number(av) - Number(bv)
      return sortAsc.value ? diff : -diff
    }
    const cmp = String(av).localeCompare(String(bv))
    return sortAsc.value ? cmp : -cmp
  })
})

function toggleSort(field: string) {
  if (sortField.value === field) {
    sortAsc.value = !sortAsc.value
  } else {
    sortField.value = field
    sortAsc.value = true
  }
}

function formatCell(value: unknown): string {
  if (value == null) return '-'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function handleClose() {
  emit('close')
}

function handleToggleCluster() {
  if (!cluster.value) return
  clusterStore.toggleClusterState(cluster.value.cluster_id)
}

function exportCSV() {
  const header = cols.value.map(c => c.header).join(',')
  const body = filteredRows.value.map(row =>
    cols.value.map(c => {
      const v = row[c.field]
      if (v == null) return ''
      const s = String(v)
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
    }).join(',')
  ).join('\n')
  const blob = new Blob([header + '\n' + body], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `cluster-${cluster.value?.cluster_name || 'nodes'}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div v-if="cluster" class="modal-overlay" @click.self="handleClose">
    <div class="modal-content">
      <div class="modal-header">
        <div class="header-info">
          <h2>{{ cluster.cluster_name }}</h2>
          <div class="header-meta">
            <span class="badge">{{ cluster.cluster_class }}</span>
            <span class="count">{{ nodes.length }} nodes</span>
            <span class="state-badge" :class="cluster.state">
              {{ cluster.state === 'open' ? 'Open' : 'Closed' }}
            </span>
          </div>
          <p v-if="cluster.description" class="description">{{ cluster.description }}</p>
        </div>
        <div class="header-actions">
          <button class="btn-toggle" @click="handleToggleCluster">
            {{ cluster.state === 'open' ? 'Close Cluster' : 'Open Cluster' }}
          </button>
          <button class="btn-close btn-icon-only" aria-label="Close" @click="handleClose"><X :size="16" /></button>
        </div>
      </div>

      <div class="modal-body">
        <div class="table-toolbar">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search nodes..."
            class="table-search"
          />
          <div class="toolbar-right">
            <span class="row-count">
              <template v-if="filteredRows.length !== rows.length">{{ filteredRows.length }} of </template>{{ rows.length }} nodes
            </span>
            <button class="action-btn" @click="exportCSV" title="Export CSV">CSV</button>
          </div>
        </div>

        <div class="table-container">
          <table class="nodes-table">
            <thead>
              <tr>
                <th
                  v-for="col in cols"
                  :key="col.field"
                  class="sortable"
                  @click="toggleSort(col.field)"
                >
                  {{ col.header }}
                  <span class="sort-icon">
                    {{ sortField === col.field ? (sortAsc ? '\u2191' : '\u2193') : '' }}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="filteredRows.length === 0">
                <td :colspan="cols.length" class="no-data">No nodes found</td>
              </tr>
              <tr v-for="row in filteredRows" :key="row.node_id as string">
                <td v-for="col in cols" :key="col.field" :class="{ mono: col.field === 'node_id' }">
                  {{ formatCell(row[col.field]) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" @click="handleClose">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-content {
  background: var(--card-background, white);
  border-radius: 8px;
  width: 90%;
  max-width: 1200px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
}

.modal-header {
  padding: 20px;
  border-bottom: 1px solid var(--border-color, #eee);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.header-info { flex: 1; }

.modal-header h2 {
  margin: 0 0 8px 0;
  font-size: 20px;
  font-weight: 600;
}

.header-meta {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 8px;
}

.badge {
  padding: 4px 8px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.count {
  font-size: 14px;
  color: var(--text-muted, #666);
}

.state-badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.state-badge.open {
  background: #e7f7ff;
  color: #409eff;
}

.state-badge.closed {
  background: var(--bg-secondary, #f5f5f5);
  color: var(--text-muted, #666);
}

.description {
  margin: 0;
  font-size: 14px;
  color: var(--text-muted, #666);
  line-height: 1.5;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.btn-toggle {
  padding: 8px 16px;
  background: var(--primary-color, #42b883);
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-toggle:hover {
  background: var(--primary-hover, #35a372);
}

.btn-close {
  padding: 8px 12px;
  background: transparent;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--text-muted, #666);
  transition: color 0.2s;
}

.btn-close:hover {
  color: #f56c6c;
}

.modal-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 0 20px 20px;
}

.table-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin: 12px 0;
  flex-shrink: 0;
}

.table-search {
  flex: 1;
  max-width: 300px;
  padding: 6px 10px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  font-size: 13px;
}

.table-search:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
}

.toolbar-right {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}

.row-count {
  font-size: 13px;
  color: var(--text-muted, #666);
  white-space: nowrap;
}

.action-btn {
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

.action-btn:hover {
  background: var(--bg-secondary, #f5f5f5);
}

.table-container {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-color, #eee);
  border-radius: 4px;
}

.nodes-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.nodes-table thead {
  background: var(--bg-secondary, #f9f9f9);
  position: sticky;
  top: 0;
  z-index: 1;
}

.nodes-table th {
  padding: 8px 12px;
  text-align: left;
  font-weight: 600;
  border-bottom: 2px solid var(--border-color, #ddd);
  white-space: nowrap;
}

.nodes-table th.sortable {
  cursor: pointer;
  user-select: none;
}

.nodes-table th.sortable:hover {
  background: var(--bg-tertiary, #f0f0f0);
}

.sort-icon {
  margin-left: 4px;
  font-size: 11px;
}

.nodes-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color, #f5f5f5);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nodes-table tbody tr:hover {
  background: var(--bg-secondary, #f9f9f9);
}

.nodes-table tbody tr:nth-child(even) {
  background: var(--bg-secondary, #fafafa);
}

.nodes-table tbody tr:nth-child(even):hover {
  background: var(--bg-tertiary, #f0f0f0);
}

.mono {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 11px;
  color: #409eff;
}

.no-data {
  text-align: center;
  padding: 40px !important;
  color: var(--text-muted, #999);
  font-style: italic;
}

.modal-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--border-color, #eee);
  display: flex;
  justify-content: flex-end;
}

.btn-secondary {
  padding: 10px 20px;
  background: var(--bg-secondary, #f5f5f5);
  border: none;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-secondary:hover {
  background: var(--bg-tertiary, #e5e5e5);
}
</style>
