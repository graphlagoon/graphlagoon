<script setup lang="ts">
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import type { ClusterProgram } from '@/types/cluster'
import JavaScriptEditor from './JavaScriptEditor.vue'
import { X, Play } from 'lucide-vue-next'

const emit = defineEmits<{
  close: []
}>()

const clusterStore = useClusterStore()

// UI state
const showCreateForm = ref(false)
const editingProgramId = ref<string | null>(null)
const expandedProgramId = ref<string | null>(null)

// Form data
const formData = ref({
  program_name: '',
  description: '',
  code: `// Write JavaScript code that returns an array of clusters
// Available context: { nodes, edges, selectedNodeIds, selectedEdgeIds }

// Example: Group nodes by type
const clustersByType = new Map();

nodes.forEach(node => {
  if (!clustersByType.has(node.node_type)) {
    clustersByType.set(node.node_type, []);
  }
  clustersByType.get(node.node_type).push(node.node_id);
});

const clusters = [];
clustersByType.forEach((nodeIds, nodeType) => {
  clusters.push({
    cluster_name: \`\${nodeType} Cluster\`,
    cluster_class: 'by-type',
    figure: 'circle',
    state: 'closed',
    node_ids: nodeIds
  });
});

return clusters;
`
})

const isEditing = computed(() => editingProgramId.value !== null)

function resetForm() {
  formData.value = {
    program_name: '',
    description: '',
    code: formData.value.code // Keep the template
  }
  editingProgramId.value = null
}

function handleCreate() {
  if (!formData.value.program_name.trim()) {
    alert('Program name is required')
    return
  }

  clusterStore.createProgram({
    program_name: formData.value.program_name,
    description: formData.value.description || undefined,
    code: formData.value.code
  })

  showCreateForm.value = false
  resetForm()
}

function handleEdit(program: ClusterProgram) {
  editingProgramId.value = program.program_id
  formData.value = {
    program_name: program.program_name,
    description: program.description || '',
    code: program.code
  }
  showCreateForm.value = true
}

function handleUpdate() {
  if (!editingProgramId.value) return
  if (!formData.value.program_name.trim()) {
    alert('Program name is required')
    return
  }

  clusterStore.updateProgram(editingProgramId.value, {
    program_name: formData.value.program_name,
    description: formData.value.description || undefined,
    code: formData.value.code
  })

  showCreateForm.value = false
  resetForm()
}

function handleDelete(programId: string) {
  if (confirm('Are you sure you want to delete this program?')) {
    clusterStore.deleteProgram(programId)
  }
}

async function handleExecute(programId: string) {
  const result = await clusterStore.executeProgram(programId)

  if (result.success) {
    const count = result.clusters?.length || 0
    alert(`Program executed successfully!\nGenerated ${count} cluster${count !== 1 ? 's' : ''} in ${result.duration_ms}ms`)
  } else {
    alert(`Execution failed:\n${result.error}`)
  }
}

function toggleExpand(programId: string) {
  expandedProgramId.value = expandedProgramId.value === programId ? null : programId
}

function formatDate(dateStr: string) {
  const date = new Date(dateStr)
  return date.toLocaleString()
}

function getExecutionHistory(programId: string) {
  return clusterStore.getExecutionHistory(programId).slice(0, 5) // Last 5 executions
}
</script>

<template>
  <div class="cluster-program-panel">
    <div class="panel-header">
      <h3>Cluster Programs</h3>
      <div class="header-actions">
        <button
          v-if="!showCreateForm"
          class="btn-create"
          @click="showCreateForm = true; resetForm()"
        >
          + New Program
        </button>
        <button
          v-if="clusterStore.clusters.length > 0"
          class="btn-clear"
          @click="clusterStore.clearClusters()"
          title="Clear all clusters"
        >
          Clear Clusters
        </button>
        <button class="btn-close btn-icon-only" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- Stats -->
    <div v-if="clusterStore.programs.length > 0 || clusterStore.clusters.length > 0" class="stats">
      <div class="stat">
        <span class="stat-label">Programs:</span>
        <span class="stat-value">{{ clusterStore.programs.length }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Clusters:</span>
        <span class="stat-value">{{ clusterStore.clusterStats.total }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Nodes in clusters:</span>
        <span class="stat-value">{{ clusterStore.clusterStats.totalNodes }}</span>
      </div>
    </div>

    <!-- Create/Edit Form -->
    <div v-if="showCreateForm" class="program-form">
      <h4>{{ isEditing ? 'Edit Program' : 'Create Program' }}</h4>

      <div class="form-group">
        <label for="program-name">Program Name *</label>
        <input
          id="program-name"
          v-model="formData.program_name"
          type="text"
          placeholder="e.g., Group by Node Type"
          required
        />
      </div>

      <div class="form-group">
        <label for="program-description">Description</label>
        <input
          id="program-description"
          v-model="formData.description"
          type="text"
          placeholder="Optional description"
        />
      </div>

      <div class="form-group">
        <label for="program-code">JavaScript Code *</label>
        <JavaScriptEditor
          v-model="formData.code"
          placeholder="return [{ cluster_name: '...', node_ids: [...] }]"
        />
        <small class="help-text">
          Must return an array of cluster objects with: cluster_name, node_ids, cluster_class (optional), figure (optional), state (optional), color (optional)
        </small>
      </div>

      <div class="form-actions">
        <button
          class="btn-primary"
          @click="isEditing ? handleUpdate() : handleCreate()"
        >
          {{ isEditing ? 'Update' : 'Create' }}
        </button>
        <button
          class="btn-secondary"
          @click="showCreateForm = false; resetForm()"
        >
          Cancel
        </button>
      </div>
    </div>

    <!-- Programs List -->
    <div v-if="clusterStore.programs.length === 0 && !showCreateForm" class="empty-state">
      <p>No cluster programs yet.</p>
      <p>Create a program to group nodes into clusters programmatically.</p>
    </div>

    <div v-else class="programs-list">
      <div
        v-for="program in clusterStore.programs"
        :key="program.program_id"
        class="program-item"
        :class="{ expanded: expandedProgramId === program.program_id }"
      >
        <div class="program-header" @click="toggleExpand(program.program_id)">
          <div class="program-info">
            <h4>{{ program.program_name }}</h4>
            <p v-if="program.description" class="program-description">
              {{ program.description }}
            </p>
            <small class="program-meta">
              Updated: {{ formatDate(program.updated_at) }}
            </small>
          </div>
          <div class="program-actions" @click.stop>
            <button
              class="btn-execute"
              @click="handleExecute(program.program_id)"
              title="Execute program"
              :disabled="clusterStore.loading"
            >
              <Play :size="12" /> Execute
            </button>
            <button
              class="btn-edit"
              @click="handleEdit(program)"
              title="Edit program"
            >
              ✏️
            </button>
            <button
              class="btn-delete"
              @click="handleDelete(program.program_id)"
              title="Delete program"
            >
              🗑️
            </button>
          </div>
        </div>

        <!-- Expanded Details -->
        <div v-if="expandedProgramId === program.program_id" class="program-details">
          <div class="code-preview">
            <h5>Code:</h5>
            <pre>{{ program.code }}</pre>
          </div>

          <div class="execution-history">
            <h5>Recent Executions:</h5>
            <div v-if="getExecutionHistory(program.program_id).length === 0" class="no-history">
              Never executed
            </div>
            <div v-else class="history-list">
              <div
                v-for="(exec, index) in getExecutionHistory(program.program_id)"
                :key="index"
                class="history-item"
                :class="{ error: exec.error }"
              >
                <div class="history-time">{{ formatDate(exec.executed_at) }}</div>
                <div class="history-result">
                  <span v-if="exec.error" class="error-badge">❌ Failed</span>
                  <span v-else class="success-badge">✅ Success</span>
                  <span class="clusters-count">
                    {{ exec.clusters_generated }} cluster{{ exec.clusters_generated !== 1 ? 's' : '' }}
                  </span>
                  <span v-if="exec.duration_ms" class="duration">
                    ({{ exec.duration_ms }}ms)
                  </span>
                </div>
                <div v-if="exec.error" class="error-message">{{ exec.error }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cluster-program-panel {
  padding: 16px;
  background: #f9f9f9;
  border-radius: 8px;
  max-height: 80vh;
  overflow-y: auto;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.panel-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.header-actions {
  display: flex;
  gap: 8px;
}

button {
  padding: 8px 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.2s;
}

.btn-create {
  background: #42b883;
  color: white;
}

.btn-create:hover {
  background: #35a372;
}

.btn-clear {
  background: #f56c6c;
  color: white;
}

.btn-clear:hover {
  background: #e54545;
}

.btn-close {
  background: transparent;
  color: #666;
  padding: 4px 8px;
}

.btn-close:hover {
  background: #f5f5f5;
  color: #333;
}

.stats {
  display: flex;
  gap: 16px;
  padding: 12px;
  background: white;
  border-radius: 4px;
  margin-bottom: 16px;
}

.stat {
  display: flex;
  gap: 8px;
}

.stat-label {
  font-weight: 600;
  color: #666;
}

.stat-value {
  color: #42b883;
  font-weight: 700;
}

.program-form {
  background: white;
  padding: 16px;
  border-radius: 4px;
  margin-bottom: 16px;
}

.program-form h4 {
  margin: 0 0 16px 0;
  font-size: 16px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 4px;
  font-weight: 600;
  font-size: 14px;
}

.form-group input,
.form-group textarea {
  width: 100%;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-family: inherit;
  font-size: 14px;
}

.form-group textarea {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  resize: vertical;
}

.help-text {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: #666;
}

.form-actions {
  display: flex;
  gap: 8px;
}

.btn-primary {
  background: #42b883;
  color: white;
}

.btn-primary:hover {
  background: #35a372;
}

.btn-secondary {
  background: #ddd;
  color: #333;
}

.btn-secondary:hover {
  background: #ccc;
}

.empty-state {
  text-align: center;
  padding: 32px;
  color: #666;
}

.empty-state p {
  margin: 8px 0;
}

.programs-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.program-item {
  background: white;
  border-radius: 4px;
  overflow: hidden;
}

.program-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.program-header:hover {
  background: #f5f5f5;
}

.program-info {
  flex: 1;
}

.program-info h4 {
  margin: 0 0 4px 0;
  font-size: 15px;
}

.program-description {
  margin: 4px 0;
  font-size: 13px;
  color: #666;
}

.program-meta {
  font-size: 12px;
  color: #999;
}

.program-actions {
  display: flex;
  gap: 4px;
}

.program-actions button {
  padding: 4px 8px;
  font-size: 12px;
}

.btn-execute {
  background: #409eff;
  color: white;
}

.btn-execute:hover {
  background: #3a8ee6;
}

.btn-execute:disabled {
  background: #ccc;
  cursor: not-allowed;
}

.btn-edit {
  background: #e6a23c;
  color: white;
}

.btn-edit:hover {
  background: #d89b33;
}

.btn-delete {
  background: #f56c6c;
  color: white;
}

.btn-delete:hover {
  background: #e54545;
}

.program-details {
  border-top: 1px solid #eee;
  padding: 12px;
}

.code-preview {
  margin-bottom: 16px;
}

.code-preview h5 {
  margin: 0 0 8px 0;
  font-size: 13px;
  font-weight: 600;
}

.code-preview pre {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 4px;
  font-size: 11px;
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
}

.execution-history h5 {
  margin: 0 0 8px 0;
  font-size: 13px;
  font-weight: 600;
}

.no-history {
  color: #999;
  font-size: 12px;
  font-style: italic;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-item {
  padding: 8px;
  background: #f9f9f9;
  border-radius: 4px;
  font-size: 12px;
}

.history-item.error {
  background: #fef0f0;
}

.history-time {
  color: #666;
  margin-bottom: 4px;
}

.history-result {
  display: flex;
  gap: 8px;
  align-items: center;
}

.success-badge {
  color: #67c23a;
}

.error-badge {
  color: #f56c6c;
}

.clusters-count {
  font-weight: 600;
}

.duration {
  color: #999;
}

.error-message {
  margin-top: 4px;
  color: #f56c6c;
  font-size: 11px;
}
</style>
