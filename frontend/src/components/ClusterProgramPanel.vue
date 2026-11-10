<script setup lang="ts">
/**
 * The Clusters panel, results first: one run bar ("Group by" any algorithm or
 * cluster program, output Color or Collapse), then the groups on the graph
 * as layers (click = show only, Shift/Ctrl or the eye = add/remove), then the
 * display options. The program library lives in its own modal; Similarity
 * (it makes edges, not groups) is a separate tab.
 */
import { ref, computed, watch } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useCommunityStore } from '@/stores/community'
import { useSimilarityStore } from '@/stores/similarity'
import { useGraphStore } from '@/stores/graph'
import { missingRequiredParams } from '@/utils/clusterProgramParams'
import { useGroupRows, type GroupKind, type GroupRow } from '@/composables/useGroupRows'
import SimilarityPanel from './SimilarityPanel.vue'
import ClusterProgramSkillModal from './ClusterProgramSkillModal.vue'
import ClusterProgramLibraryModal from './ClusterProgramLibraryModal.vue'
import ClusterProgramParamInputs from './ClusterProgramParamInputs.vue'
import CommunityNodeModal from './CommunityNodeModal.vue'
import { X, Play, Loader2, Bot, Eye, EyeOff, MoreHorizontal, Library, ChevronDown, ChevronRight } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'

/**
 * `groups` and `similarity` are the tabs. `communities`, `results` and
 * `programs` are the tabs of the old panel, kept as aliases so links and the
 * status bar's clusters chip keep working: they open the groups (programs
 * opens the library).
 */
export type ClustersTab = 'groups' | 'similarity' | 'communities' | 'results' | 'programs'

const props = withDefaults(defineProps<{ tab?: ClustersTab }>(), { tab: undefined })

const emit = defineEmits<{
  'update:tab': [tab: ClustersTab]
  close: []
}>()

const clusterStore = useClusterStore()
const communityStore = useCommunityStore()
const similarityStore = useSimilarityStore()
const graphStore = useGraphStore()
const groups = useGroupRows()
const toast = useToast()

// ── Tabs ────────────────────────────────────────────────────────────────────
type PaneTab = 'groups' | 'similarity'
/** Which groups the list shows (declared before the tab watcher, which sets it). */
const listKind = ref<GroupKind>('community')
const showLibrary = ref(false)
const showSkillModal = ref(false)

function paneOf(tab: ClustersTab | undefined): PaneTab {
  return tab === 'similarity' ? 'similarity' : 'groups'
}

const activeTab = ref<PaneTab>(paneOf(props.tab))
watch(() => props.tab, (t) => {
  if (!t) return
  activeTab.value = paneOf(t)
  if (t === 'results' && groups.clusterRows.value.length > 0) listKind.value = 'cluster'
  if (t === 'programs') showLibrary.value = true
}, { immediate: true })

function selectTab(tab: PaneTab) {
  activeTab.value = tab
  emit('update:tab', tab)
}

// ── Run bar ─────────────────────────────────────────────────────────────────
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

function toggleEdgeTypeFilter(edgeType: string) {
  const current = communityStore.edgeTypeFilter
  communityStore.edgeTypeFilter = current.includes(edgeType)
    ? current.filter(t => t !== edgeType)
    : [...current, edgeType]
}

const algorithmName = computed(() => {
  if (selectedCommunityProgram.value) return selectedCommunityProgram.value.program_name
  if (communityStore.algorithm === 'weak-components') return 'Weak components'
  if (communityStore.algorithm === 'strong-components') return 'Strong components'
  return 'Louvain'
})

/** One line saying how the groups on screen were made. */
const runSummary = computed(() => {
  const parts = [algorithmName.value]
  if (communityStore.isLouvain) parts.push(`resolution ${communityStore.resolution.toFixed(1)}`)
  parts.push(communityStore.collapseEnabled ? 'Collapse' : 'Color')
  return parts.join(' · ')
})

// The run bar folds into its summary once there is a result, so the groups
// get the room; "change" opens it again.
const runOpen = ref(!communityStore.hasResults)
watch(() => communityStore.hasResults, (has) => { if (!has) runOpen.value = true })

async function run() {
  await communityStore.runDetection()
  if (communityStore.hasResults && !communityStore.error) {
    runOpen.value = false
    listKind.value = 'community'
  }
}

/** "Use" in the library: the program becomes the run bar's algorithm. */
function useProgram(programId: string) {
  communityStore.algorithm = `cluster-program:${programId}`
  runOpen.value = true
  activeTab.value = 'groups'
}

// ── Group list ──────────────────────────────────────────────────────────────
const hasBothKinds = computed(() => groups.communityRows.value.length > 0 && groups.clusterRows.value.length > 0)
watch(
  () => [groups.communityRows.value.length, groups.clusterRows.value.length] as const,
  ([communities, clusters]) => {
    if (communities === 0 && clusters > 0) listKind.value = 'cluster'
    if (clusters === 0 && communities > 0) listKind.value = 'community'
  },
  { immediate: true },
)

const search = ref('')
const sortBy = ref<'size' | 'name'>('size')
const SEARCH_FROM = 10

const allRows = computed(() => groups.rowsOf(listKind.value))
const visibleRows = computed(() => {
  const q = search.value.trim().toLowerCase()
  const rows = q ? allRows.value.filter(r => r.label.toLowerCase().includes(q)) : [...allRows.value]
  if (sortBy.value === 'name') rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  else rows.sort((a, b) => b.count - a.count)
  return rows
})
const shownCount = computed(() => groups.shownCount(listKind.value))
const isolating = computed(() => graphStore.isolation !== null)

// ⋯ menu of one row
const menuFor = ref<string | null>(null)
function toggleMenu(row: GroupRow) {
  menuFor.value = menuFor.value === row.key ? null : row.key
}
function menuAction(fn: () => void) {
  fn()
  menuFor.value = null
}

const membersCommunityId = ref<number | null>(null)

function deleteCluster(row: GroupRow) {
  const index = clusterStore.clusters.findIndex(c => c.cluster_id === row.id)
  const cluster = clusterStore.clusters[index]
  if (!cluster) return
  if (graphStore.isolation?.kind === 'cluster') graphStore.clearIsolation()
  clusterStore.deleteCluster(cluster.cluster_id)
  // Client-side state the app can put back: undo instead of asking first.
  toast.undoable(`“${cluster.cluster_name}” deleted`, () =>
    clusterStore.restoreCluster(cluster, index),
  )
}

function clearProgramClusters() {
  if (graphStore.isolation?.kind === 'cluster') graphStore.clearIsolation()
  clusterStore.clusters = clusterStore.clusters.filter(c => c.cluster_class === 'community' || c.cluster_class === 'group')
}

function clearCommunities() {
  if (graphStore.isolation?.kind === 'community') graphStore.clearIsolation()
  communityStore.clearCommunities()
}

// ── Display ─────────────────────────────────────────────────────────────────
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

const displayOpen = ref(false)
</script>

<template>
  <div class="cluster-panel">
    <div class="panel-header">
      <h3>Clusters</h3>
      <button class="btn-close btn-icon-only" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
    </div>

    <div class="tab-bar">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'groups' }"
        data-testid="clusters-tab-groups"
        @click="selectTab('groups')"
      >
        Groups
        <span v-if="allRows.length" class="tab-badge">{{ groups.communityRows.value.length + groups.clusterRows.value.length }}</span>
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'similarity' }"
        data-testid="clusters-tab-similarity"
        @click="selectTab('similarity')"
      >
        Similarity
        <span v-if="similarityStore.hasResults" class="tab-badge">{{ similarityStore.resultStats?.edgeCount }}</span>
      </button>
    </div>

    <div class="tab-content">
      <div v-if="activeTab === 'groups'" class="tab-pane" data-testid="clusters-groups-pane">
        <!-- ── Run bar ─────────────────────────────────────────────── -->
        <div v-if="!runOpen" class="run-summary" data-testid="cluster-run-summary">
          <span class="run-summary-text" :title="runSummary">{{ runSummary }}</span>
          <button class="btn-link" data-testid="cluster-run-change" @click="runOpen = true">change</button>
        </div>
        <div v-else class="run-bar" data-testid="cluster-run-bar">
          <div class="form-row">
            <label for="community-algorithm">Group by</label>
            <select
              id="community-algorithm"
              v-model="communityStore.algorithm"
              class="community-algorithm-select"
              data-testid="community-algorithm-select"
            >
              <optgroup label="Algorithms">
                <option value="louvain">Louvain (communities)</option>
                <option value="weak-components">Weak components</option>
                <option value="strong-components">Strong components</option>
              </optgroup>
              <optgroup v-if="clusterStore.programs.length" label="Cluster programs">
                <option
                  v-for="program in clusterStore.programs"
                  :key="program.program_id"
                  :value="`cluster-program:${program.program_id}`"
                >
                  {{ program.program_name }}
                </option>
              </optgroup>
            </select>
            <small v-if="selectedCommunityProgram?.description" class="help-text">
              {{ selectedCommunityProgram.description }}
            </small>
          </div>

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

          <div v-if="!communityStore.selectedProgramId && graphStore.edgeTypes.length > 1" class="form-row">
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
          </div>

          <div class="form-row">
            <label>Output</label>
            <div class="segmented" role="radiogroup" aria-label="Output">
              <button
                role="radio"
                :aria-checked="!communityStore.collapseEnabled"
                :class="{ active: !communityStore.collapseEnabled }"
                data-testid="cluster-output-color"
                title="Color each group; nodes stay where they are"
                @click="communityStore.collapseEnabled = false"
              >
                Color
              </button>
              <button
                role="radio"
                :aria-checked="communityStore.collapseEnabled"
                :class="{ active: communityStore.collapseEnabled }"
                data-testid="cluster-output-collapse"
                title="Collapse each group into one cluster node (open one from the list)"
                @click="communityStore.collapseEnabled = true"
              >
                Collapse
              </button>
            </div>
          </div>

          <div class="community-actions">
            <button
              class="btn-detect"
              data-testid="cluster-run"
              :disabled="communityStore.computing || communityMissingParams.length > 0"
              @click="run"
            >
              <Loader2 v-if="communityStore.computing" :size="12" class="spin" />
              <Play v-else :size="12" />
              {{ communityStore.computing ? 'Running…' : 'Run' }}
            </button>
            <button
              class="btn-secondary-sm"
              data-testid="cluster-manage-programs"
              title="Create, import, edit or run cluster programs"
              @click="showLibrary = true"
            >
              <Library :size="12" /> Programs…
            </button>
            <button
              class="btn-skill-help btn-icon-only"
              data-testid="cluster-panel-ask-ai"
              title="Not sure how? Get an AI prompt to write a cluster program"
              aria-label="Get help writing a cluster program"
              @click="showSkillModal = true"
            >
              <Bot :size="16" />
            </button>
            <button
              v-if="communityStore.hasResults"
              class="btn-link"
              @click="runOpen = false"
            >
              cancel
            </button>
          </div>

          <div v-if="communityStore.computing && communityStore.progressMessage" class="community-progress">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: communityStore.progressValue + '%' }"></div>
            </div>
            <small>{{ communityStore.progressMessage }}</small>
          </div>
        </div>

        <div v-if="communityStore.error" class="community-error">
          {{ communityStore.error }}
        </div>

        <!-- ── Groups as layers ────────────────────────────────────── -->
        <div v-if="allRows.length === 0" class="empty-state" data-testid="groups-empty">
          <p>No groups yet.</p>
          <p>Pick how to group the nodes above and press Run.</p>
        </div>

        <template v-else>
          <div v-if="hasBothKinds" class="segmented kind-switch">
            <button
              :class="{ active: listKind === 'community' }"
              data-testid="groups-kind-community"
              @click="listKind = 'community'"
            >
              Colors ({{ groups.communityRows.value.length }})
            </button>
            <button
              :class="{ active: listKind === 'cluster' }"
              data-testid="groups-kind-cluster"
              @click="listKind = 'cluster'"
            >
              Clusters ({{ groups.clusterRows.value.length }})
            </button>
          </div>

          <div class="groups-header">
            <span data-testid="groups-count">
              {{ allRows.length }} {{ listKind === 'community' ? 'groups' : 'clusters' }}
              <template v-if="listKind === 'community' && communityStore.modularity != null">
                · <span title="Modularity">Q {{ communityStore.modularity.toFixed(2) }}</span>
              </template>
            </span>
            <select v-model="sortBy" class="sort-select" aria-label="Sort groups">
              <option value="size">by size</option>
              <option value="name">by name</option>
            </select>
          </div>

          <input
            v-if="allRows.length > SEARCH_FROM"
            v-model="search"
            type="search"
            class="groups-search"
            placeholder="Find a group…"
            data-testid="groups-search"
          />

          <div v-if="isolating" class="groups-showing" data-testid="groups-showing">
            Showing {{ graphStore.isolation?.kind === listKind ? shownCount : 0 }} of {{ allRows.length }}
            <template v-if="graphStore.isolation?.kind === 'value'">({{ graphStore.isolation.label }})</template>
            · <button class="btn-link" data-testid="groups-show-all" @click="graphStore.clearIsolation()">show all</button>
          </div>
          <p v-else class="help-text groups-hint">
            Click a group to show only it; Shift+click or the eye to add or hide one.
          </p>

          <ul class="community-list" role="list">
            <li
              v-for="row in visibleRows"
              :key="row.key"
              class="community-item"
              :class="{ hidden: !groups.isShown(row), solo: groups.isSolo(row) }"
              :data-testid="`group-row-${row.key}`"
            >
              <button
                class="eye btn-icon-only"
                :aria-pressed="groups.isShown(row)"
                :aria-label="groups.isShown(row) ? `Hide ${row.label}` : `Show ${row.label}`"
                :data-testid="`group-eye-${row.key}`"
                @click="groups.toggleShown(row)"
              >
                <Eye v-if="groups.isShown(row)" :size="13" />
                <EyeOff v-else :size="13" />
              </button>
              <button
                class="group-name"
                :title="groups.isSolo(row) ? 'Show every node' : `Show only ${row.label} (Shift+click: add to what is shown)`"
                :data-testid="`group-name-${row.key}`"
                @click="groups.clickRow(row, $event)"
              >
                <span class="color-swatch" :style="{ backgroundColor: row.color }"></span>
                <span class="community-name">{{ row.label }}</span>
              </button>
              <button
                v-if="row.collapsed !== undefined"
                class="collapse-toggle"
                :title="row.collapsed ? 'Expand: show its nodes' : 'Collapse into one cluster node'"
                :data-testid="`group-collapse-${row.key}`"
                @click="groups.toggleCollapsed(row)"
              >
                {{ row.collapsed ? 'collapsed' : 'open' }}
              </button>
              <span class="community-count">{{ row.count }}</span>
              <div class="row-menu">
                <button
                  class="btn-icon-only"
                  :aria-label="`More on ${row.label}`"
                  :aria-expanded="menuFor === row.key"
                  :data-testid="`group-menu-${row.key}`"
                  @click="toggleMenu(row)"
                >
                  <MoreHorizontal :size="14" />
                </button>
                <div v-if="menuFor === row.key" class="row-menu-list" role="menu">
                  <button role="menuitem" @click="menuAction(() => groups.selectMembers(row))">Select its nodes</button>
                  <button
                    v-if="row.kind === 'community'"
                    role="menuitem"
                    :data-testid="`group-members-${row.key}`"
                    @click="menuAction(() => (membersCommunityId = row.id as number))"
                  >
                    Members table
                  </button>
                  <button
                    v-if="row.kind === 'cluster'"
                    role="menuitem"
                    class="danger"
                    @click="menuAction(() => deleteCluster(row))"
                  >
                    Delete cluster
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </template>

        <!-- ── Display ─────────────────────────────────────────────── -->
        <div v-if="allRows.length" class="display-section">
          <button class="display-toggle" :aria-expanded="displayOpen" data-testid="groups-display-toggle" @click="displayOpen = !displayOpen">
            <ChevronDown v-if="displayOpen" :size="13" /><ChevronRight v-else :size="13" /> Display
          </button>
          <div v-if="displayOpen" class="community-toggles">
            <template v-if="communityStore.hasResults">
              <label class="toggle-row">
                <input v-model="communityStore.colorEnabled" type="checkbox" />
                <span>Color by group</span>
              </label>
              <label class="toggle-row">
                <input v-model="communityStore.tableColumnEnabled" type="checkbox" data-testid="community-table-toggle" />
                <span>Group column in the Data Table</span>
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
            </template>
            <div class="clear-row">
              <button v-if="communityStore.hasResults" class="btn-clear-community" @click="clearCommunities">Clear groups</button>
              <button v-if="groups.clusterRows.value.length" class="btn-clear-community" data-testid="groups-clear-clusters" @click="clearProgramClusters">Clear program clusters</button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="activeTab === 'similarity'" class="tab-pane">
        <SimilarityPanel />
      </div>
    </div>

    <ClusterProgramSkillModal v-model="showSkillModal" />
    <ClusterProgramLibraryModal
      v-if="showLibrary"
      @close="showLibrary = false"
      @use="useProgram"
    />
    <CommunityNodeModal
      v-if="membersCommunityId !== null"
      :community-id="membersCommunityId"
      @close="membersCommunityId = null"
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
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: min(46vh, 420px);
  overflow-y: auto;
}

.community-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  background: white;
  border-radius: 4px;
  font-size: 12px;
  border: 1px solid transparent;
}

.community-item.solo {
  border-color: var(--primary-color, #42b883);
}

.community-item.hidden .group-name,
.community-item.hidden .community-count {
  opacity: 0.45;
}

.group-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  background: none;
  text-align: left;
  font-size: 12px;
}

.group-name:hover {
  background: #f2f7f5;
}

.eye {
  padding: 3px;
  background: none;
  color: #777;
}

.collapse-toggle {
  padding: 1px 6px;
  font-size: 10px;
  background: #eef3f1;
  color: #555;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.community-count {
  color: #999;
  font-size: 11px;
  min-width: 24px;
  text-align: right;
}

.row-menu {
  position: relative;
}

.row-menu > button {
  padding: 3px;
  background: none;
  color: #777;
}

.row-menu-list {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 5;
  display: flex;
  flex-direction: column;
  min-width: 150px;
  padding: 4px;
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}

.row-menu-list button {
  background: none;
  text-align: left;
  font-size: 12px;
}

.row-menu-list button:hover {
  background: #f5f5f5;
}

.row-menu-list .danger {
  color: #d64545;
}

/* ====================================================================
   Run bar, groups header, display
   ==================================================================== */
.run-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  background: white;
  border-radius: 6px;
  border: 1px solid #e6e6e6;
}

.run-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: white;
  border-radius: 6px;
  border: 1px solid #e6e6e6;
  font-size: 12px;
}

.run-summary-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.btn-link {
  padding: 0;
  background: none;
  color: var(--primary-color, #42b883);
  font-size: 12px;
  text-decoration: underline;
}

.btn-secondary-sm {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: white;
  border: 1px solid #d0d0d0;
  color: #444;
}

.btn-secondary-sm:hover {
  background: #f5f5f5;
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

.segmented {
  display: inline-flex;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  overflow: hidden;
}

.segmented button {
  flex: 1;
  border-radius: 0;
  background: white;
  color: #555;
  font-size: 12px;
}

.segmented button.active {
  background: var(--primary-color, #42b883);
  color: white;
}

.kind-switch {
  display: flex;
}

.groups-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #555;
}

.sort-select {
  font-size: 11px;
  padding: 2px 4px;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.groups-search {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 12px;
}

.groups-showing {
  font-size: 12px;
  color: #333;
}

.groups-hint {
  margin: 0;
}

.display-section {
  border-top: 1px solid #e6e6e6;
  padding-top: 6px;
}

.display-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  background: none;
  color: #555;
  font-size: 12px;
  font-weight: 600;
}

.clear-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.params-missing-hint {
  color: #e6a23c;
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
