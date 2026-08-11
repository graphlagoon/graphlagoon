<script setup lang="ts">
import { computed } from 'vue';
import { AlertTriangle, AlertCircle, Info, CheckCircle2 } from 'lucide-vue-next';
import type { SchemaDriftSeverity } from '@/types/graph';

const props = defineProps<{
  status: SchemaDriftSeverity;
  counts: { error: number; warning: number; info: number };
}>();

const emit = defineEmits<{
  review: [];
}>();

const label = computed(() => {
  if (props.status === 'ok') return 'Schema is in sync';
  const parts: string[] = [];
  if (props.counts.error) parts.push(`${props.counts.error} error${props.counts.error === 1 ? '' : 's'}`);
  if (props.counts.warning) parts.push(`${props.counts.warning} warning${props.counts.warning === 1 ? '' : 's'}`);
  if (props.counts.info) parts.push(`${props.counts.info} suggestion${props.counts.info === 1 ? '' : 's'}`);
  return `Schema drift detected — ${parts.join(', ')}`;
});
</script>

<template>
  <div class="drift-banner" :class="`drift-banner--${status}`" data-testid="schema-drift-banner">
    <CheckCircle2 v-if="status === 'ok'" :size="16" />
    <AlertCircle v-else-if="status === 'error'" :size="16" />
    <AlertTriangle v-else-if="status === 'warning'" :size="16" />
    <Info v-else :size="16" />
    <span class="drift-banner-label">{{ label }}</span>
    <button
      v-if="status !== 'ok'"
      type="button"
      class="drift-banner-review"
      data-testid="schema-drift-review-btn"
      @click="emit('review')"
    >
      Review
    </button>
  </div>
</template>

<style scoped>
.drift-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
}

.drift-banner-label {
  flex: 1;
}

.drift-banner--ok {
  background: #e8f5e9;
  color: #2e7d32;
}

.drift-banner--info {
  background: #e3f2fd;
  color: #1565c0;
}

.drift-banner--warning {
  background: #fffbeb;
  color: #92400e;
}

.drift-banner--error {
  background: #fef2f2;
  color: #991b1b;
}

.drift-banner-review {
  padding: 4px 10px;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

.drift-banner-review:hover {
  background: rgba(0, 0, 0, 0.06);
}
</style>
