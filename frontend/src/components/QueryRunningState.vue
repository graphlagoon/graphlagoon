<script setup lang="ts">
import { computed } from 'vue';

/**
 * Shared "query is running" state: spinner + optional chunk-download progress
 * (percentage + loaded/total) + optional Cancel button. Used by both the Query
 * Console (table results) and the graph loading overlay so cancellation and
 * progress look and behave identically. Purely presentational — owns no state.
 *
 * There is deliberately NO elapsed-seconds counter: while the query executes we
 * show only the spinner; once the warehouse starts streaming result chunks we
 * switch to a real percentage + count.
 */
const props = withDefaults(
  defineProps<{
    /** Show the Cancel button (true once a statement/job id is known). */
    canCancel?: boolean;
    /** Chunk download progress; the bar only shows when total > 1. */
    chunkProgress?: { done: number; total: number } | null;
    /** Leading label, e.g. "Running query…" / "Running Cypher query…". */
    label?: string;
  }>(),
  {
    canCancel: false,
    chunkProgress: null,
    label: 'Running query…',
  },
);

const emit = defineEmits<{ (e: 'cancel'): void }>();

const showChunks = computed(
  () => !!props.chunkProgress && props.chunkProgress.total > 1,
);

/** Raw percentage as a float (0–100). Kept numeric for the bar width. */
const chunkPct = computed(() => {
  const cp = props.chunkProgress;
  if (!cp || cp.total <= 0) return 0;
  return (cp.done / cp.total) * 100;
});

/** Float-safe display: format via toFixed (never string-truncate the float). */
const chunkPctLabel = computed(() => `${chunkPct.value.toFixed(1)}%`);

/** Clamp for the bar width so a rounding overshoot can't exceed 100%. */
const barWidth = computed(() => `${Math.min(100, chunkPct.value)}%`);
</script>

<template>
  <div class="query-running" data-testid="query-running">
    <div class="loading"></div>
    <span class="running-label">{{ label }}</span>

    <div v-if="showChunks" class="chunk-progress" data-testid="query-running-chunks">
      <div class="chunk-bar">
        <div class="chunk-bar-fill" :style="{ width: barWidth }"></div>
      </div>
      <span class="chunk-label">
        <span data-testid="query-running-pct">{{ chunkPctLabel }}</span>
        ·
        <span data-testid="query-running-count">
          {{ chunkProgress!.done }}/{{ chunkProgress!.total }} chunks
        </span>
      </span>
    </div>

    <button
      v-if="canCancel"
      class="cancel-btn"
      data-testid="query-running-cancel"
      @click="emit('cancel')"
    >
      Cancel
    </button>
  </div>
</template>

<style scoped>
.query-running {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-muted, #999);
}

.loading {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border-color, #ddd);
  border-top-color: var(--primary-color, #7c3aed);
  border-radius: 50%;
  animation: query-running-spin 0.8s linear infinite;
}

@keyframes query-running-spin {
  to {
    transform: rotate(360deg);
  }
}

.running-label {
  font-weight: 500;
}

.chunk-progress {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 220px;
  max-width: 60vw;
}

.chunk-bar {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--border-color, #e5e5e5);
  overflow: hidden;
}

.chunk-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--primary-color, #7c3aed);
  transition: width 0.2s ease;
}

.chunk-label {
  font-family: monospace;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.cancel-btn {
  border: 1px solid var(--color-error, #e53e3e);
  background: var(--card-background, #fff);
  border-radius: 4px;
  padding: 3px 12px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  color: var(--color-error, #e53e3e);
}

.cancel-btn:hover {
  background: rgba(229, 62, 62, 0.1);
}
</style>
