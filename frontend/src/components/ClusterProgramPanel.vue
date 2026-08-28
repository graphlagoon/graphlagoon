<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useClusterStore, isDefaultProgramId } from '@/stores/cluster'
import { useCommunityStore } from '@/stores/community'
import { useSimilarityStore } from '@/stores/similarity'
import { useGraphStore } from '@/stores/graph'
import type { ClusterProgram } from '@/types/cluster'
import { missingRequiredParams } from '@/utils/clusterProgramParams'
import SimilarityPanel from './SimilarityPanel.vue'
import ClusterProgramSkillModal from './ClusterProgramSkillModal.vue'
import ClusterProgramEditorModal from './ClusterProgramEditorModal.vue'
import ClusterProgramRunModal from './ClusterProgramRunModal.vue'
import ClusterProgramParamInputs from './ClusterProgramParamInputs.vue'
import { X, Play, Loader2, Bot } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import { confirmAction } from '@/composables/useConfirm';

const emit = defineEmits<{
  close: []
}>()

const toast = useToast()

const clusterStore = useClusterStore()
const communityStore = useCommunityStore()
const similarityStore = useSimilarityStore()
const graphStore = useGraphStore()

// UI state
const activeTab = ref<'communities' | 'programs' | 'similarity'>('communities')

// Community layout: one control for the mutually-exclusive spatial arrangements
// (radial force vs. hive plot with one axis per community).
type CommunityLayout = 'none' | 'radial' | 'hive'

const communityLayout = computed<CommunityLayout>(() => {
  if (communityStore.radialLayoutEnabled) return 'radial'
  if (graphStore.layoutAlgorithm === 'hive' && graphStore.layoutModeConfig.hive.axisKey === 'community') return 'hive'
  return 'none'
})

function setCommunityLayout(layout: CommunityLayout) {
  if (layout === 'radial') {
    // Enabling radial reverts any non-force layout mode (store watcher)
    communityStore.radialLayoutEnabled = true
  } else if (layout === 'hive') {
    graphStore.updateLayoutModeConfig({ hive: { axisKey: 'community' } })
    graphStore.setLayoutAlgorithm('hive') // disables radial via mutual exclusion
  } else {
    communityStore.radialLayoutEnabled = false
    if (communityLayout.value === 'hive') {
      graphStore.setLayoutAlgorithm('force')
    }
  }
}
const showSkillModal = ref(false)
const expandedProgramId = ref<string | null>(null)

// Editor modal: null = closed; { program: null } = create; { program } = edit
const showEditor = ref(false)
const editorProgram = ref<ClusterProgram | null>(null)

// Run modal: set when executing a program that declares parameters
const runProgram = ref<ClusterProgram | null>(null)

function openCreate() {
  editorProgram.value = null
  showEditor.value = true
}

function handleEdit(program: ClusterProgram) {
  editorProgram.value = program
  showEditor.value = true
}

async function handleDelete(programId: string) {
  const ok = await confirmAction({
    title: 'Delete this cluster program?',
    message: 'Clusters it already produced stay on the graph; the program itself is gone.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (ok) clusterStore.deleteProgram(programId)
}

async function handleExecute(program: ClusterProgram) {
  // Programs with parameters prompt for values first
  if ((program.parameters?.length ?? 0) > 0) {
    runProgram.value = program
    return
  }

  const result = await clusterStore.executeProgram(program.program_id)

  if (result.success) {
    const count = result.clusters?.length || 0
    toast.success(`Generated ${count} cluster${count !== 1 ? 's' : ''} in ${result.duration_ms}ms`)
  } else {
    toast.error(`Cluster program failed: ${result.error}`)
  }
}

// Communities tab: cluster program selected as algorithm, with inline params
const selectedCommunityProgram = computed(() =>
  communityStore.selectedProgramId
    ? clusterStore.getProgram(communityStore.selectedProgramId)
    : undefined
)

watch(
  () => communityStore.selectedProgramId,
  (id) => {
    if (id) communityStore.ensureProgramParams(id)
  },
  { immediate: true }
)

const communityMissingParams = computed(() => {
  const program = selectedCommunityProgram.value
  if (!program) return []
  return missingRequiredParams(
    program.parameters,
    communityStore.programParams[program.program_id] ?? {}
  )
})

function setCommunityProgramParams(values: Record<string, string | number | boolean>) {
  if (!communityStore.selectedProgramId) return
  communityStore.programParams[communityStore.selectedProgramId] = values
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

function scopeLabel(program: ClusterProgram): string {
  if (isDefaultProgramId(program.program_id)) return 'built-in'
  return program.scope === 'exploration' ? 'exploration' : 'context'
}

function toggleEdgeTypeFilter(edgeType: string) {
  const current = communityStore.edgeTypeFilter
  const idx = current.indexOf(edgeType)
  if (idx >= 0) {
    communityStore.edgeTypeFilter = current.filter(t => t !== edgeType)
  } else {
    communityStore.edgeTypeFilter = [...current, edgeType]
  }
}
</script>

<template>
  <div class="cluster-panel">
    <!-- Header -->
    <div class="panel-header">
      <h3>Clusters</h3>
      <button class="btn-close btn-icon-only" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
    </div>

    <!-- Tabs -->
    <div class="tab-bar">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'communities' }"
        @click="activeTab = 'communities'"
      >
        Communities
        <span v-if="communityStore.hasResults" class="tab-badge">{{ communityStore.communityStats.count }}</span>
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'programs' }"
        @click="activeTab = 'programs'"
      >
        Programs
        <span v-if="clusterStore.clusters.length > 0" class="tab-badge">{{ clusterStore.clusterStats.total }}</span>
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'similarity' }"
        @click="activeTab = 'similarity'"
      >
        Similarity
        <span v-if="similarityStore.hasResults" class="tab-badge">{{ similarityStore.resultStats?.edgeCount }}</span>
      </button>
    </div>

    <!-- Tab Content -->
    <div class="tab-content">

      <!-- ================================================================ -->
      <!-- Communities Tab -->
      <!-- ================================================================ -->
      <div v-if="activeTab === 'communities'" class="tab-pane">
        <div class="community-config">
          <!-- Algorithm selector: Louvain or a cluster program used as a community algorithm -->
          <div class="form-row">
            <label for="community-algorithm">Algorithm</label>
            <select
              id="community-algorithm"
              v-model="communityStore.algorithm"
              class="community-algorithm-select"
              data-testid="community-algorithm-select"
            >
              <option value="louvain">Louvain</option>
              <option
                v-for="program in clusterStore.programs"
                :key="program.program_id"
                :value="`cluster-program:${program.program_id}`"
              >
                {{ program.program_name }}
              </option>
            </select>
            <small v-if="!communityStore.isLouvain" class="help-text">
              Runs the cluster program as a community algorithm (no collapsed nodes).
              Nodes in multiple clusters use the first; uncovered nodes form an "others" community.
            </small>
          </div>

          <!-- Cluster program parameters (inline, like the Louvain resolution slider) -->
          <div
            v-if="selectedCommunityProgram && (selectedCommunityProgram.parameters?.length ?? 0) > 0"
            class="form-row"
            data-testid="community-program-params"
          >
            <label>Parameters</label>
            <ClusterProgramParamInputs
              compact
              :parameters="selectedCommunityProgram.parameters ?? []"
              :model-value="communityStore.programParams[selectedCommunityProgram.program_id] ?? {}"
              @update:model-value="setCommunityProgramParams"
            />
            <small v-if="communityMissingParams.length > 0" class="help-text params-missing-hint">
              Required: {{ communityMissingParams.map(p => p.label || p.id).join(', ') }}
            </small>
          </div>

          <div v-if="communityStore.isLouvain" class="form-row">
            <label for="community-resolution">Resolution</label>
            <div class="slider-row">
              <input
                id="community-resolution"
                v-model.number="communityStore.resolution"
                type="range"
                min="0.1"
                max="5.0"
                step="0.1"
                class="slider"
              />
              <span class="slider-value">{{ communityStore.resolution.toFixed(1) }}</span>
            </div>
            <small class="help-text">Higher = more communities, lower = fewer</small>
          </div>

          <!-- Edge type filter (Louvain only) -->
          <div v-if="communityStore.isLouvain && graphStore.edgeTypes.length > 1" class="form-row">
            <label>Edge types</label>
            <div class="edge-type-chips">
              <button
                class="chip"
                :class="{ active: communityStore.edgeTypeFilter.length === 0 }"
                @click="communityStore.edgeTypeFilter = []"
              >
                All
              </button>
              <button
                v-for="et in graphStore.edgeTypes"
                :key="et"
                class="chip"
                :class="{ active: communityStore.edgeTypeFilter.includes(et) }"
                @click="toggleEdgeTypeFilter(et)"
              >
                {{ et }}
              </button>
            </div>
            <small class="help-text">
              Self-loops ignored. Multi-edges merged (weighted).
            </small>
          </div>

          <div class="community-actions">
            <button
              class="btn-detect"
              :disabled="communityStore.computing || communityMissingParams.length > 0"
              @click="communityStore.runDetection()"
            >
              <Loader2 v-if="communityStore.computing" :size="12" class="spin" />
              <Play v-else :size="12" />
              {{ communityStore.computing ? 'Detecting...' : 'Detect' }}
            </button>
            <button
              v-if="communityStore.hasResults"
              class="btn-clear-community"
              @click="communityStore.clearCommunities()"
            >
              Clear
            </button>
          </div>

          <!-- Progress -->
          <div v-if="communityStore.computing && communityStore.progressMessage" class="community-progress">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: communityStore.progressValue + '%' }"></div>
            </div>
            <small>{{ communityStore.progressMessage }}</small>
          </div>

          <!-- Error -->
          <div v-if="communityStore.error" class="community-error">
            {{ communityStore.error }}
          </div>
        </div>

        <!-- Results -->
        <template v-if="communityStore.hasResults">
          <div class="stats">
            <div class="stat">
              <span class="stat-label">Found:</span>
              <span class="stat-value">{{ communityStore.communityStats.count }}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Q:</span>
              <span class="stat-value" title="Modularity">{{ communityStore.modularity?.toFixed(3) ?? '—' }}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Avg:</span>
              <span class="stat-value">{{ communityStore.communityStats.avgSize }}</span>
            </div>
          </div>

          <!-- Visualization toggles -->
          <div class="community-toggles">
            <label class="toggle-row">
              <input v-model="communityStore.colorEnabled" type="checkbox" />
              <span>Color by community</span>
            </label>
            <label class="toggle-row">
              <input
                v-model="communityStore.tableColumnEnabled"
                type="checkbox"
                data-testid="community-table-toggle"
              />
              <span>Community column in Data Table</span>
            </label>
            <label class="toggle-row layout-select-row">
              <span>Layout</span>
              <select
                class="community-layout-select"
                data-testid="community-layout-select"
                :value="communityLayout"
                @change="setCommunityLayout(($event.target as HTMLSelectElement).value as CommunityLayout)"
              >
                <option value="none">None (force)</option>
                <option value="radial">Radial</option>
                <option value="hive">Hive plot</option>
              </select>
            </label>
          </div>

          <!-- Community list -->
          <div class="community-list">
            <div
              v-for="comm in communityStore.communitiesSorted"
              :key="comm.id"
              class="community-item"
            >
              <span class="color-swatch" :style="{ backgroundColor: comm.color }"></span>
              <span class="community-name">{{ comm.label }}</span>
              <span class="community-count">{{ comm.nodeCount }}</span>
            </div>
          </div>
        </template>
      </div>

      <!-- ================================================================ -->
      <!-- Programs Tab -->
      <!-- ================================================================ -->
      <div v-if="activeTab === 'programs'" class="tab-pane">
        <!-- Programs toolbar -->
        <div class="programs-toolbar">
          <button
            class="btn-create"
            data-testid="cluster-program-new"
            @click="openCreate"
          >
            + New
          </button>
          <button
            class="btn-skill-help btn-icon-only"
            data-testid="cluster-skill-help"
            title="Not sure how? Get an AI prompt to write a cluster program"
            aria-label="Get help writing a cluster program"
            @click="showSkillModal = true"
          >
            <Bot :size="16" />
          </button>
          <button
            v-if="clusterStore.clusters.length > 0"
            class="btn-clear"
            @click="clusterStore.clearClusters()"
            title="Clear all clusters"
          >
            Clear Clusters
          </button>
        </div>

        <!-- Stats -->
        <div v-if="clusterStore.clusters.length > 0" class="stats">
          <div class="stat">
            <span class="stat-label">Clusters:</span>
            <span class="stat-value">{{ clusterStore.clusterStats.total }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Nodes:</span>
            <span class="stat-value">{{ clusterStore.clusterStats.totalNodes }}</span>
          </div>
        </div>

        <!-- Programs List -->
        <div v-if="clusterStore.programs.length === 0" class="empty-state">
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
                <h4>
                  {{ program.program_name }}
                  <span class="scope-badge" :class="`scope-${scopeLabel(program)}`">
                    {{ scopeLabel(program) }}
                  </span>
                </h4>
                <p v-if="program.description" class="program-description">
                  {{ program.description }}
                </p>
                <small class="program-meta">
                  Updated: {{ formatDate(program.updated_at) }}
                  <template v-if="(program.parameters?.length ?? 0) > 0">
                    · Params: {{ program.parameters!.length }}
                  </template>
                </small>
              </div>
              <div class="program-actions" @click.stop>
                <button
                  class="btn-execute"
                  @click="handleExecute(program)"
                  title="Execute program"
                  :disabled="clusterStore.loading"
                >
                  <Play :size="12" /> Run
                </button>
                <button
                  class="btn-edit"
                  @click="handleEdit(program)"
                  title="Edit program"
                >
                  ✏️
                </button>
                <button
                  v-if="!isDefaultProgramId(program.program_id)"
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

      <!-- ================================================================ -->
      <!-- Similarity Tab -->
      <!-- ================================================================ -->
      <div v-if="activeTab === 'similarity'" class="tab-pane">
        <SimilarityPanel />
      </div>

    </div>

    <!-- AI skill helper modal -->
    <ClusterProgramSkillModal v-model="showSkillModal" />

    <!-- Create/Edit program modal -->
    <ClusterProgramEditorModal
      v-if="showEditor"
      :program="editorProgram"
      @close="showEditor = false"
    />

    <!-- Parameter-fill modal for programs with declared parameters -->
    <ClusterProgramRunModal
      v-if="runProgram"
      :program="runProgram"
      @close="runProgram = null"
    />
  </div>
</template>

<style scoped>
/* ====================================================================
   Panel Shell
   ==================================================================== */
.cluster-panel {
  padding: 12px;
  background: #f9f9f9;
  border-radius: 8px;
  max-height: 80vh;
  max-width: min(360px, 30vw);
  overflow-y: auto;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

/* ====================================================================
   Tab Bar
   ==================================================================== */
.tab-bar {
  display: flex;
  gap: 0;
  border-bottom: 2px solid #e0e0e0;
  margin-bottom: 12px;
}

.tab-btn {
  flex: 1;
  padding: 8px 4px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: #999;
  transition: color 0.15s, border-color 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.tab-btn:hover {
  color: #555;
}

.tab-btn.active {
  color: #333;
  border-bottom-color: #42b883;
  font-weight: 600;
}

.tab-badge {
  background: #42b883;
  color: white;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 8px;
  min-width: 16px;
  text-align: center;
}

.tab-content {
  min-height: 120px;
}

.tab-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ====================================================================
   Shared
   ==================================================================== */
button {
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  transition: background-color 0.15s;
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
  gap: 12px;
  padding: 8px 10px;
  background: white;
  border-radius: 4px;
  font-size: 12px;
  flex-wrap: wrap;
}

.stat {
  display: flex;
  gap: 4px;
}

.stat-label {
  font-weight: 600;
  color: #888;
}

.stat-value {
  color: #42b883;
  font-weight: 700;
}

.help-text {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: #999;
}

.empty-state {
  text-align: center;
  padding: 24px;
  color: #999;
  font-size: 13px;
}

.empty-state p {
  margin: 4px 0;
}

/* ====================================================================
   Communities Tab
   ==================================================================== */
.community-config {
  background: white;
  padding: 10px;
  border-radius: 4px;
}

.form-row {
  margin-bottom: 6px;
}

.form-row label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 3px;
  color: #555;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.slider {
  flex: 1;
  height: 4px;
  cursor: pointer;
}

.slider-value {
  font-size: 13px;
  font-weight: 600;
  color: #42b883;
  min-width: 28px;
  text-align: right;
}

.edge-type-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 10px;
  background: #e8e8e8;
  color: #666;
  border: 1px solid transparent;
}

.chip:hover {
  background: #ddd;
}

.chip.active {
  background: #42b883;
  color: white;
}

.community-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.btn-detect {
  background: #409eff;
  color: white;
  display: flex;
  align-items: center;
  gap: 4px;
}

.btn-detect:hover:not(:disabled) {
  background: #3a8ee6;
}

.btn-detect:disabled {
  background: #a0cfff;
  cursor: not-allowed;
}

.btn-clear-community {
  background: #f56c6c;
  color: white;
}

.btn-clear-community:hover {
  background: #e54545;
}

.community-progress {
  margin-top: 6px;
}

.progress-bar {
  height: 3px;
  background: #e0e0e0;
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 3px;
}

.progress-fill {
  height: 100%;
  background: #409eff;
  transition: width 0.3s ease;
}

.community-error {
  margin-top: 6px;
  padding: 6px 8px;
  background: #fef0f0;
  border-radius: 4px;
  color: #f56c6c;
  font-size: 12px;
}

.community-toggles {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.toggle-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}

.toggle-row input[type="checkbox"] {
  cursor: pointer;
}

.layout-select-row {
  justify-content: space-between;
}

.community-layout-select {
  flex: 1;
  margin-left: 8px;
  padding: 4px 6px;
  font-size: 11px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: var(--card-background, white);
  cursor: pointer;
}

.community-layout-select:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
}

.community-algorithm-select {
  width: 100%;
  padding: 5px 6px;
  font-size: 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: var(--card-background, white);
  cursor: pointer;
}

.community-algorithm-select:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
}

.community-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 200px;
  overflow-y: auto;
}

.community-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: white;
  border-radius: 3px;
  font-size: 12px;
}

.color-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}

.community-name {
  flex: 1;
  font-weight: 500;
}

.community-count {
  color: #999;
  font-size: 11px;
}

/* ====================================================================
   Programs Tab
   ==================================================================== */
.programs-toolbar {
  display: flex;
  gap: 6px;
}

.btn-create {
  background: #42b883;
  color: white;
}

.btn-create:hover {
  background: #35a372;
}

.btn-skill-help {
  background: transparent;
  color: #409eff;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #cfe4ff;
}

.btn-skill-help:hover {
  background: #ecf5ff;
  color: #3a8ee6;
}

.btn-clear {
  background: #f56c6c;
  color: white;
}

.btn-clear:hover {
  background: #e54545;
}

.params-missing-hint {
  color: #f56c6c;
}

.programs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  padding: 10px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.program-header:hover {
  background: #f5f5f5;
}

.program-info {
  flex: 1;
}

.program-info h4 {
  margin: 0 0 2px 0;
  font-size: 13px;
}

.scope-badge {
  margin-left: 4px;
  padding: 1px 5px;
  border-radius: 8px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  vertical-align: middle;
}

.scope-context {
  background: #e7f6ef;
  color: #2f9e6e;
}

.scope-exploration {
  background: #ecf5ff;
  color: #409eff;
}

.scope-built-in {
  background: #f0f0f0;
  color: #888;
}

.program-description {
  margin: 2px 0;
  font-size: 12px;
  color: #666;
}

.program-meta {
  font-size: 11px;
  color: #999;
}

.program-actions {
  display: flex;
  gap: 3px;
}

.program-actions button {
  padding: 3px 6px;
  font-size: 11px;
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
  padding: 10px;
}

.code-preview {
  margin-bottom: 12px;
}

.code-preview h5 {
  margin: 0 0 6px 0;
  font-size: 12px;
  font-weight: 600;
}

.code-preview pre {
  background: #f5f5f5;
  padding: 8px;
  border-radius: 4px;
  font-size: 11px;
  overflow-x: auto;
  max-height: 180px;
  overflow-y: auto;
}

.execution-history h5 {
  margin: 0 0 6px 0;
  font-size: 12px;
  font-weight: 600;
}

.no-history {
  color: #999;
  font-size: 11px;
  font-style: italic;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-item {
  padding: 6px;
  background: #f9f9f9;
  border-radius: 4px;
  font-size: 11px;
}

.history-item.error {
  background: #fef0f0;
}

.history-time {
  color: #666;
  margin-bottom: 3px;
}

.history-result {
  display: flex;
  gap: 6px;
  align-items: center;
}

.success-badge { color: #67c23a; }
.error-badge { color: #f56c6c; }
.clusters-count { font-weight: 600; }
.duration { color: #999; }

.error-message {
  margin-top: 3px;
  color: #f56c6c;
  font-size: 10px;
}

/* ====================================================================
   Animations
   ==================================================================== */
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spin {
  animation: spin 1s linear infinite;
}
</style>
