<script setup lang="ts">
/**
 * Footer chip "N agentes ativos" (05 §6): the caller's active agent tokens
 * that can reach this case (scope user, or a case token naming it), linking to
 * /settings/agents. Silent when agents are off or the list cannot be read.
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/services/api';
import type { AgentToken } from '@/types/admin';

const props = defineProps<{ investigationId: string }>();
const router = useRouter();
const tokens = ref<AgentToken[]>([]);

const active = computed(() =>
  tokens.value.filter((t) => t.active && (t.scope !== 'case' || (t.investigation_ids ?? []).includes(props.investigationId))),
);

onMounted(async () => {
  if ((window.__GRAPH_LAGOON_CONFIG__ ?? {}).agents_enabled !== true) return;
  try {
    tokens.value = await api.getAgentTokens();
  } catch {
    tokens.value = [];
  }
});
</script>

<template>
  <a
    v-if="active.length"
    href="/settings/agents"
    class="agents-indicator"
    data-testid="status-agents"
    :title="active.map((t) => t.name).join(', ')"
    @click.prevent="router.push('/settings/agents')"
  >
    ◆ {{ active.length }} {{ active.length === 1 ? 'agente ativo' : 'agentes ativos' }}
  </a>
</template>

<style scoped>
.agents-indicator {
  color: var(--color-primary);
  text-decoration: none;
}

.agents-indicator:hover {
  text-decoration: underline;
}
</style>
