<script setup lang="ts">
import { ref, computed } from 'vue'
import { useClusterStore, isDefaultProgramId } from '@/stores/cluster'
import { useGraphStore } from '@/stores/graph'
import type { ClusterProgram } from '@/types/cluster'
import ClusterProgramSkillModal from './ClusterProgramSkillModal.vue'
import ClusterProgramEditorModal from './ClusterProgramEditorModal.vue'
import ClusterProgramRunModal from './ClusterProgramRunModal.vue'
import { parseImportedClusterPrograms, portableClusterProgram } from '@/utils/clusterProgramImport'
import { buildSourceSchema, downloadJson, readFileAsText, safeFilename } from '@/utils/portableExport'
import { PORTABLE_EXPORT_VERSION, type PortableClusterPrograms } from '@/types/portable'
import { X, Play, Bot, Pencil, Trash2, Download, Upload, ChevronDown, ChevronRight, CornerDownLeft } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import { confirmAction } from '@/composables/useConfirm'

/**
 * The cluster-program library: create, import/export, edit, delete, run into
 * cluster nodes, and "Use" (hand a program to the Clusters panel's run bar).
 * The Clusters panel itself only picks programs; managing them lives here.
 */
const emit = defineEmits<{
  close: []
  use: [programId: string]
}>()

const clusterStore = useClusterStore()
const graphStore = useGraphStore()
const toast = useToast()

const expandedProgramId = ref<string | null>(null)
const showSkillModal = ref(false)
const showEditor = ref(false)
const editorProgram = ref<ClusterProgram | null>(null)
const runProgram = ref<ClusterProgram | null>(null)

function openCreate() {
  editorProgram.value = null
  showEditor.value = true
}

function handleEdit(program: ClusterProgram) {
  editorProgram.value = program
  showEditor.value = true
}

async function handleDelete(program: ClusterProgram) {
  const ok = await confirmAction({
    title: `Delete "${program.program_name}"?`,
    message: 'Clusters it already produced stay on the graph; the program itself is gone.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (ok) clusterStore.deleteProgram(program.program_id)
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

function use(program: ClusterProgram) {
  emit('use', program.program_id)
  emit('close')
}

function toggleExpand(programId: string) {
  expandedProgramId.value = expandedProgramId.value === programId ? null : programId
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString()
}

function getExecutionHistory(programId: string) {
  return clusterStore.getExecutionHistory(programId).slice(0, 5)
}

function scopeLabel(program: ClusterProgram): string {
  if (isDefaultProgramId(program.program_id)) return 'built-in'
  return program.scope === 'exploration' ? 'exploration' : 'context'
}

// ─── Import several / Export all ───
const showImport = ref(false)
const importText = ref('')
const importError = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const parsedImport = computed(() => {
  const text = importText.value.trim()
  return text ? parseImportedClusterPrograms(text) : null
})

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importError.value = null
  try {
    importText.value = await readFileAsText(file)
  } catch {
    importError.value = 'Could not read the file'
  } finally {
    input.value = ''
  }
}

function applyImport() {
  const result = parseImportedClusterPrograms(importText.value)
  if (!result.ok) {
    importError.value = result.error
    return
  }
  // Scope follows createProgram's rule: the context when writable, else this exploration.
  for (const p of result.programs) clusterStore.createProgram({ ...p })
  const n = result.programs.length
  toast.success(`Imported ${n} program${n !== 1 ? 's' : ''}`)
  importText.value = ''
  importError.value = null
  showImport.value = false
}

const userPrograms = computed(() => clusterStore.programs.filter(p => !isDefaultProgramId(p.program_id)))

function exportAll() {
  const payload: PortableClusterPrograms = {
    graphlagoon_export: 'cluster-programs',
    export_version: PORTABLE_EXPORT_VERSION,
    source: buildSourceSchema({
      context: graphStore.currentContext,
      loadedNodeTypes: graphStore.nodeTypes,
      loadedEdgeTypes: graphStore.edgeTypes,
    }),
    programs: userPrograms.value.map(p => portableClusterProgram(p)),
  }
  downloadJson(safeFilename(`cluster-programs-${graphStore.currentContext?.title || 'graph'}`), payload)
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal library-modal" data-testid="cluster-program-library">
        <div class="modal-header">
          <h2>Cluster programs</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="library-toolbar">
          <button class="btn btn-primary" data-testid="cluster-program-new" @click="openCreate">+ New</button>
          <button
            class="btn btn-outline"
            :class="{ active: showImport }"
            data-testid="cluster-program-library-import"
            @click="showImport = !showImport"
          >
            <Upload :size="13" /> Import…
          </button>
          <button
            class="btn btn-outline"
            data-testid="cluster-program-library-export"
            :disabled="userPrograms.length === 0"
            title="Download your programs (not the built-ins) as one JSON file"
            @click="exportAll"
          >
            <Download :size="13" /> Export all
          </button>
          <button
            class="btn btn-outline btn-icon"
            data-testid="cluster-skill-help"
            title="Not sure how? Get an AI prompt to write a cluster program"
            aria-label="Get help writing a cluster program"
            @click="showSkillModal = true"
          >
            <Bot :size="15" />
          </button>
        </div>

        <div class="modal-body">
          <div v-if="showImport" class="import-section">
            <span class="field-hint">
              Paste one program, a list, or a file from <strong>Export all</strong> — the
              programs are added to this {{ graphStore.currentContext?.has_write_access ? 'context' : 'exploration' }}.
            </span>
            <textarea
              v-model="importText"
              class="field-input import-textarea"
              rows="6"
              data-testid="cluster-program-library-import-text"
              placeholder='[{"program_name": "...", "code": "return [...]"}]'
            />
            <div class="import-actions">
              <input ref="fileInput" type="file" accept=".json,application/json" class="file-input" @change="pickFile" />
              <button type="button" class="btn btn-outline" @click="fileInput?.click()">Choose file…</button>
              <button
                type="button"
                class="btn btn-primary"
                data-testid="cluster-program-library-import-apply"
                :disabled="!parsedImport?.ok"
                @click="applyImport"
              >
                Add {{ parsedImport?.ok ? parsedImport.programs.length : '' }} program{{ parsedImport?.ok && parsedImport.programs.length === 1 ? '' : 's' }}
              </button>
            </div>
            <span v-if="parsedImport && !parsedImport.ok" class="field-error" data-testid="cluster-program-library-import-error">
              {{ parsedImport.error }}
            </span>
            <span v-if="importError" class="field-error">{{ importError }}</span>
          </div>

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
              :data-testid="`cluster-program-${program.program_id}`"
            >
              <div class="program-header">
                <button
                  class="btn-expand btn-icon-only"
                  :aria-label="expandedProgramId === program.program_id ? 'Hide code and history' : 'Show code and history'"
                  :aria-expanded="expandedProgramId === program.program_id"
                  @click="toggleExpand(program.program_id)"
                >
                  <ChevronDown v-if="expandedProgramId === program.program_id" :size="14" />
                  <ChevronRight v-else :size="14" />
                </button>
                <div class="program-info" @click="toggleExpand(program.program_id)">
                  <h4>
                    {{ program.program_name }}
                    <span class="scope-badge" :class="`scope-${scopeLabel(program)}`">{{ scopeLabel(program) }}</span>
                  </h4>
                  <p v-if="program.description" class="program-description">{{ program.description }}</p>
                  <small class="program-meta">
                    Updated: {{ formatDate(program.updated_at) }}
                    <template v-if="(program.parameters?.length ?? 0) > 0"> · Params: {{ program.parameters!.length }}</template>
                    <template v-if="program.show_in_context_menu"> · right-click menu</template>
                  </small>
                </div>
                <div class="program-actions">
                  <button
                    class="btn btn-outline btn-sm"
                    :data-testid="`cluster-program-use-${program.program_id}`"
                    title="Pick this program in the Clusters panel (color or collapse from there)"
                    @click="use(program)"
                  >
                    <CornerDownLeft :size="12" /> Use
                  </button>
                  <button
                    class="btn btn-outline btn-sm"
                    :data-testid="`cluster-program-run-${program.program_id}`"
                    title="Run now into cluster nodes"
                    :disabled="clusterStore.loading"
                    @click="handleExecute(program)"
                  >
                    <Play :size="12" /> Run
                  </button>
                  <button
                    class="btn-icon-only"
                    :data-testid="`cluster-program-edit-${program.program_id}`"
                    :aria-label="`Edit ${program.program_name}`"
                    title="Edit program"
                    @click="handleEdit(program)"
                  >
                    <Pencil :size="14" />
                  </button>
                  <button
                    v-if="!isDefaultProgramId(program.program_id)"
                    class="btn-icon-only btn-danger-icon"
                    :data-testid="`cluster-program-delete-${program.program_id}`"
                    :aria-label="`Delete ${program.program_name}`"
                    title="Delete program"
                    @click="handleDelete(program)"
                  >
                    <Trash2 :size="14" />
                  </button>
                </div>
              </div>

              <div v-if="expandedProgramId === program.program_id" class="program-details">
                <h5>Code</h5>
                <pre class="code-preview">{{ program.code }}</pre>
                <h5>Recent runs</h5>
                <div v-if="getExecutionHistory(program.program_id).length === 0" class="no-history">Never run</div>
                <ul v-else class="history-list">
                  <li
                    v-for="(exec, index) in getExecutionHistory(program.program_id)"
                    :key="index"
                    class="history-item"
                    :class="{ error: exec.error }"
                  >
                    <span class="history-time">{{ formatDate(exec.executed_at) }}</span>
                    <span v-if="exec.error" class="error-badge">Failed</span>
                    <span v-else class="success-badge">
                      {{ exec.clusters_generated }} cluster{{ exec.clusters_generated !== 1 ? 's' : '' }}
                      <template v-if="exec.duration_ms"> ({{ exec.duration_ms }}ms)</template>
                    </span>
                    <div v-if="exec.error" class="error-message">{{ exec.error }}</div>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ClusterProgramSkillModal v-model="showSkillModal" />
    <ClusterProgramEditorModal v-if="showEditor" :program="editorProgram" @close="showEditor = false" />
    <ClusterProgramRunModal v-if="runProgram" :program="runProgram" @close="runProgram = null" />
  </Teleport>
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
}

.library-modal {
  background: var(--card-background, #fff);
  border-radius: 12px;
  width: 640px;
  max-width: 95vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 22px 12px;
}

.modal-header h2 {
  font-size: 17px;
  font-weight: 600;
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted, #666);
}

.library-toolbar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 22px 12px;
  border-bottom: 1px solid var(--border-color, #ddd);
}

.modal-body {
  padding: 14px 22px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.btn {
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border-color, #ddd);
  padding: 6px 12px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  color: var(--text-color, #333);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-sm {
  padding: 3px 8px;
  font-size: 12px;
}

.btn-primary {
  background: var(--primary-color, #42b883);
  border-color: var(--primary-color, #42b883);
  color: #fff;
}

.btn.active {
  border-color: var(--primary-color, #42b883);
  color: var(--primary-color, #42b883);
}

.btn-icon-only {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  color: var(--text-muted, #666);
  display: inline-flex;
  align-items: center;
}

.btn-icon-only:hover {
  color: var(--text-color, #333);
}

.btn-danger-icon:hover {
  color: var(--error-color, #e74c3c);
}

.import-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px dashed var(--border-color, #ddd);
  border-radius: 8px;
}

.field-input {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  box-sizing: border-box;
}

.import-textarea {
  font-family: 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  resize: vertical;
}

.import-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.file-input {
  display: none;
}

.field-hint {
  font-size: 12px;
  color: var(--text-muted, #666);
}

.field-error {
  font-size: 12px;
  color: var(--error-color, #e74c3c);
}

.empty-state {
  text-align: center;
  color: var(--text-muted, #666);
  font-size: 13px;
}

.programs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.program-item {
  border: 1px solid var(--border-color, #e5e5e5);
  border-radius: 8px;
}

.program-header {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 12px;
}

.program-info {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.program-info h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.scope-badge {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 8px;
  margin-left: 4px;
  background: var(--bg-secondary, #f0f0f0);
  color: var(--text-muted, #666);
}

.scope-context {
  background: rgba(66, 184, 131, 0.15);
  color: #2c8a5e;
}

.scope-exploration {
  background: rgba(52, 152, 219, 0.15);
  color: #2471a3;
}

.program-description {
  margin: 4px 0 2px;
  font-size: 12px;
  color: var(--text-muted, #666);
  line-height: 1.4;
}

.program-meta {
  font-size: 11px;
  color: var(--text-muted, #999);
}

.program-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-shrink: 0;
}

.program-details {
  padding: 0 12px 12px 34px;
}

.program-details h5 {
  margin: 8px 0 4px;
  font-size: 12px;
}

.code-preview {
  margin: 0;
  padding: 10px;
  background: var(--bg-secondary, #f6f6f6);
  border-radius: 6px;
  font-family: 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  max-height: 220px;
  overflow: auto;
  white-space: pre;
}

.no-history {
  font-size: 12px;
  color: var(--text-muted, #999);
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.history-item {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.history-time {
  color: var(--text-muted, #999);
}

.error-badge,
.history-item.error .error-message {
  color: var(--error-color, #e74c3c);
}

.success-badge {
  color: #2c8a5e;
}

.error-message {
  flex-basis: 100%;
  white-space: pre-wrap;
}
</style>
