<script setup lang="ts">
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import type { Cluster } from '@/types/cluster'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

const clusterStore = useClusterStore()

const isCollapsed = ref(false)
const filterClass = ref<string>('')
const filterState = ref<'all' | 'open' | 'closed'>('all')

const filteredClusters = computed(() => {
  let result = clusterStore.clusters

  if (filterClass.value) {
    result = result.filter(c =>
      c.cluster_class.toLowerCase().includes(filterClass.value.toLowerCase())
    )
  }

  if (filterState.value !== 'all') {
    result = result.filter(c => c.state === filterState.value)
  }

  return result
})

const clusterClasses = computed(() => {
  const classes = new Set(clusterStore.clusters.map(c => c.cluster_class))
  return Array.from(classes).sort()
})

function toggleCluster(clusterId: string) {
  clusterStore.toggleClusterState(clusterId)
}

function deleteCluster(clusterId: string) {
  if (confirm('Delete this cluster? This action cannot be undone.')) {
    clusterStore.deleteCluster(clusterId)
  }
}

function openAll() {
  clusterStore.clusters.forEach(c => {
    clusterStore.openCluster(c.cluster_id)
  })
}

function closeAll() {
  clusterStore.clusters.forEach(c => {
    clusterStore.closeCluster(c.cluster_id)
  })
}

function getClusterIcon(figure: string): string {
  const icons: Record<string, string> = {
    circle: '●',
    box: '■',
    diamond: '◆',
    hexagon: '⬢',
    star: '★'
  }
  return icons[figure] || '●'
}

function getClusterColor(cluster: Cluster): string {
  return cluster.color || '#42b883'
}
</script>

<template>
  <div class="cluster-list-panel" :class="{ collapsed: isCollapsed }">
    <div class="panel-header">
      <h3>Clusters ({{ clusterStore.clusters.length }})</h3>
      <button
        class="btn-collapse"
        @click="isCollapsed = !isCollapsed"
        :title="isCollapsed ? 'Expand' : 'Collapse'"
      >
        <ChevronLeft v-if="!isCollapsed" :size="14" /><ChevronRight v-else :size="14" />
      </button>
    </div>

    <div v-if="!isCollapsed" class="panel-content">
      <!-- Empty State -->
      <div v-if="clusterStore.clusters.length === 0" class="empty-state">
        <p>No clusters yet.</p>
        <p class="help-text">Execute a cluster program to create clusters.</p>
      </div>

      <!-- Filters and Actions -->
      <div v-else class="panel-controls">
        <div class="filters">
          <select v-model="filterState" class="filter-select">
            <option value="all">All States</option>
            <option value="open">Open Only</option>
            <option value="closed">Closed Only</option>
          </select>

          <select v-model="filterClass" class="filter-select">
            <option value="">All Classes</option>
            <option v-for="cls in clusterClasses" :key="cls" :value="cls">
              {{ cls }}
            </option>
          </select>
        </div>

        <div class="bulk-actions">
          <button class="btn-bulk" @click="openAll" title="Open all clusters">
            Open All
          </button>
          <button class="btn-bulk" @click="closeAll" title="Close all clusters">
            Close All
          </button>
        </div>
      </div>

      <!-- Cluster List -->
      <div class="clusters-list">
        <div
          v-for="cluster in filteredClusters"
          :key="cluster.cluster_id"
          class="cluster-item"
          :class="{ open: cluster.state === 'open', closed: cluster.state === 'closed' }"
        >
          <div class="cluster-header">
            <div class="cluster-icon" :style="{ color: getClusterColor(cluster) }">
              {{ getClusterIcon(cluster.figure) }}
            </div>
            <div class="cluster-info">
              <div class="cluster-name" :title="cluster.cluster_name">
                {{ cluster.cluster_name }}
              </div>
              <div class="cluster-meta">
                <span class="cluster-class">{{ cluster.cluster_class }}</span>
                <span class="cluster-count">{{ cluster.node_ids.length }} nodes</span>
              </div>
              <div v-if="cluster.description" class="cluster-description">
                {{ cluster.description }}
              </div>
            </div>
            <div class="cluster-actions">
              <button
                class="btn-toggle"
                @click="toggleCluster(cluster.cluster_id)"
                :title="cluster.state === 'open' ? 'Close cluster' : 'Open cluster'"
              >
                {{ cluster.state === 'open' ? '👁️ Open' : '👁️‍🗨️ Closed' }}
              </button>
              <button
                class="btn-delete"
                @click="deleteCluster(cluster.cluster_id)"
                title="Delete cluster"
              >
                🗑️
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Stats Footer -->
      <div class="panel-footer">
        <div class="stat">
          <span class="stat-label">Open:</span>
          <span class="stat-value">{{ clusterStore.clusterStats.open }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Closed:</span>
          <span class="stat-value">{{ clusterStore.clusterStats.closed }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Avg size:</span>
          <span class="stat-value">{{ clusterStore.clusterStats.avgNodesPerCluster }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cluster-list-panel {
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 600px;
  width: 320px;
  transition: width 0.3s;
}

.cluster-list-panel.collapsed {
  width: 50px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background: #f5f5f5;
  border-bottom: 1px solid #ddd;
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.collapsed .panel-header h3 {
  display: none;
}

.btn-collapse {
  padding: 4px 8px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: #666;
}

.btn-collapse:hover {
  color: #42b883;
}

.panel-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.empty-state {
  padding: 24px;
  text-align: center;
  color: #999;
}

.empty-state p {
  margin: 8px 0;
  font-size: 14px;
}

.help-text {
  font-size: 12px;
}

.panel-controls {
  padding: 12px;
  border-bottom: 1px solid #eee;
}

.filters {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.filter-select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 13px;
  background: white;
  cursor: pointer;
}

.bulk-actions {
  display: flex;
  gap: 8px;
}

.btn-bulk {
  flex: 1;
  padding: 6px 12px;
  background: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-bulk:hover {
  background: #e5e5e5;
}

.clusters-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.cluster-item {
  border: 1px solid #eee;
  border-radius: 6px;
  margin-bottom: 8px;
  transition: all 0.2s;
}

.cluster-item:hover {
  border-color: #42b883;
  box-shadow: 0 2px 4px rgba(66, 184, 131, 0.1);
}

.cluster-item.open {
  background: #f0f9ff;
  border-color: #409eff;
}

.cluster-item.closed {
  background: #f9f9f9;
}

.cluster-header {
  display: flex;
  align-items: flex-start;
  padding: 10px;
  gap: 10px;
}

.cluster-icon {
  font-size: 20px;
  line-height: 1;
  flex-shrink: 0;
}

.cluster-info {
  flex: 1;
  min-width: 0;
}

.cluster-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.cluster-name {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cluster-meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #666;
  margin-bottom: 2px;
}

.cluster-class {
  padding: 2px 6px;
  background: #e5e5e5;
  border-radius: 3px;
  font-size: 11px;
}

.cluster-count {
  color: #999;
}

.cluster-description {
  font-size: 11px;
  color: #999;
  margin-top: 4px;
  line-height: 1.4;
}

.btn-toggle {
  padding: 6px 10px;
  background: white;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}

.btn-toggle:hover {
  border-color: #42b883;
  color: #42b883;
}

.cluster-item.open .btn-toggle {
  background: #409eff;
  color: white;
  border-color: #409eff;
}

.cluster-item.closed .btn-toggle {
  background: #f5f5f5;
}

.btn-delete {
  padding: 6px 8px;
  background: white;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  line-height: 1;
}

.btn-delete:hover {
  background: #fee;
  border-color: #f44;
  color: #f44;
}

.panel-footer {
  display: flex;
  justify-content: space-around;
  padding: 12px;
  background: #f9f9f9;
  border-top: 1px solid #eee;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.stat-label {
  font-size: 11px;
  color: #999;
  text-transform: uppercase;
}

.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: #42b883;
}

/* Scrollbar styling */
.clusters-list::-webkit-scrollbar {
  width: 6px;
}

.clusters-list::-webkit-scrollbar-track {
  background: #f5f5f5;
}

.clusters-list::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 3px;
}

.clusters-list::-webkit-scrollbar-thumb:hover {
  background: #999;
}
</style>
