<script setup lang="ts">
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useCommunityStore } from '@/stores/community'
import type { ClusterProgram, ClusterProgramParamValues } from '@/types/cluster'
import {
  defaultParamValues,
  missingRequiredParams,
} from '@/utils/clusterProgramParams'
import ClusterProgramParamInputs from './ClusterProgramParamInputs.vue'
import { X, Play, Loader2 } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'

const props = withDefaults(defineProps<{
  program: ClusterProgram
  /**
   * 'clusters' runs the program into cluster nodes (Programs list);
   * 'community' runs it as the community algorithm (right-click menu), which
   * colors nodes and creates no cluster geometry.
   */
  mode?: 'clusters' | 'community'
  /** Values to start from (e.g. node-bound ones), over the declared defaults */
  initialValues?: ClusterProgramParamValues
}>(), { mode: 'clusters', initialValues: undefined })
const emit = defineEmits<{ (e: 'close'): void }>()

const clusterStore = useClusterStore()
const communityStore = useCommunityStore()
const toast = useToast()

const values = ref<ClusterProgramParamValues>({
  ...defaultParamValues(props.program.parameters),
  ...(props.initialValues ?? {}),
})
const running = ref(false)
const errorMsg = ref<string | null>(null)

const missingRequired = computed(() =>
  missingRequiredParams(props.program.parameters, values.value)
)

const canRun = computed(() => missingRequired.value.length === 0 && !running.value)

async function runNow() {
  if (!canRun.value) return

  running.value = true
  errorMsg.value = null
  try {
    if (props.mode === 'community') {
      const id = props.program.program_id
      communityStore.programParams[id] = { ...values.value }
      communityStore.algorithm = `cluster-program:${id}`
      await communityStore.runDetection()
      if (communityStore.error) {
        errorMsg.value = communityStore.error
        return
      }
      emit('close')
      const labels = communityStore.communitiesSorted.map(c => c.label)
      const shown = labels.slice(0, 4).join(', ') + (labels.length > 4 ? ', …' : '')
      toast.success(`${communityStore.communityCount} communities: ${shown}`)
      return
    }
    const result = await clusterStore.executeProgram(props.program.program_id, values.value)

    if (result.success) {
      const count = result.clusters?.length || 0
      emit('close')
      toast.success(`Generated ${count} cluster${count !== 1 ? 's' : ''} in ${result.duration_ms}ms`)
    } else {
      errorMsg.value = result.error ?? 'Execution failed'
    }
  } finally {
    running.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal run-modal" data-testid="cluster-program-run-modal">
        <div class="modal-header">
          <h2>Run "{{ program.program_name }}"</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <p v-if="program.description" class="program-desc">{{ program.description }}</p>

          <ClusterProgramParamInputs
            :parameters="program.parameters ?? []"
            v-model="values"
          />

          <div v-if="missingRequired.length > 0" class="validation-hint">
            Required: {{ missingRequired.map(p => p.label || p.id).join(', ') }}
          </div>

          <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-outline" @click="emit('close')">Cancel</button>
          <button
            class="btn btn-primary"
            data-testid="run-program"
            :disabled="!canRun"
            @click="runNow"
          >
            <Loader2 v-if="running" :size="12" class="spin" />
            <Play v-else :size="12" />
            {{ running ? 'Running...' : 'Run' }}
          </button>
        </div>
      </div>
    </div>
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

.run-modal {
  background: var(--card-background, #fff);
  border-radius: 12px;
  width: 440px;
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
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
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
  line-height: 1;
  padding: 0 4px;
  flex-shrink: 0;
}

.modal-close:hover {
  color: var(--text-color, #333);
}

.modal-body {
  padding: 20px 24px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.program-desc {
  font-size: 13px;
  color: var(--text-muted, #666);
  margin: 0;
  line-height: 1.5;
}

.validation-hint {
  font-size: 12px;
  color: var(--error-color, #e74c3c);
}

.error-msg {
  padding: 8px 12px;
  background: rgba(231, 76, 60, 0.1);
  border: 1px solid var(--error-color, #e74c3c);
  border-radius: 6px;
  color: var(--error-color, #e74c3c);
  font-size: 12px;
  white-space: pre-wrap;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 24px 20px;
  border-top: 1px solid var(--border-color, #ddd);
  flex-shrink: 0;
}

.btn {
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border-color, #ddd);
  padding: 8px 16px;
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-outline {
  background: transparent;
  color: var(--text-color, #333);
}

.btn-outline:hover:not(:disabled) {
  background: var(--bg-secondary, #f5f5f5);
}

.btn-primary {
  background: var(--primary-color, #42b883);
  border-color: var(--primary-color, #42b883);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover, #3aa876);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spin {
  animation: spin 1s linear infinite;
}
</style>
