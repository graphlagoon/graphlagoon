<script setup lang="ts">
import { onUnmounted } from 'vue'
import ClusterProgramRunModal from './ClusterProgramRunModal.vue'
import { useClusterProgramRunRequest } from '@/composables/useClusterProgramRunRequest'

// Renders the run dialog asked for by the right-click menu (see
// useClusterProgramRunRequest). One per page.
const { pendingRunRequest, clearRunRequest } = useClusterProgramRunRequest()
onUnmounted(clearRunRequest)
</script>

<template>
  <ClusterProgramRunModal
    v-if="pendingRunRequest"
    :key="pendingRunRequest.program.program_id"
    :program="pendingRunRequest.program"
    :mode="pendingRunRequest.mode"
    :initial-values="pendingRunRequest.initialValues"
    @close="clearRunRequest"
  />
</template>
