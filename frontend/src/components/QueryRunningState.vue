<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Shared "query is running" state: spinner + elapsed timer + optional
 * chunk-download progress (percentage + loaded/total) + optional Cancel button.
 * Used by both the Query Console (table results) and the graph loading overlay
 * so cancellation and progress look and behave identically. Purely
 * presentational — owns no state beyond the self-contained elapsed timer that
 * starts on mount (the component is only mounted while a query runs).
 */
const props = withDefaults(
  defineProps<{
    /** Show the Cancel button (true once a statement/job id is known). */
    canCancel?: boolean;
    /** Chunk download progress; the bar only shows when total > 1. */
    chunkProgress?: { done: number; total: number } | null;
    /** Leading label, e.g. "Running query…" / "Running Cypher query…". */
    label?: string;
    /** Show the elapsed-time counter (defaults to true). */
    showElapsed?: boolean;
  }>(),
  {
    canCancel: false,
    chunkProgress: null,
    label: 'Running query…',
    showElapsed: true,
  },
);

const emit = defineEmits<{ (e: 'cancel'): void }>();

/**
 * Elapsed whole seconds since mount. Kept as an integer so nothing float-ish
 * (e.g. "12.999s") can ever reach the label — we floor the ms delta once per
 * tick and only ever format integers below.
 */
const elapsedSec = ref(0);
let startMs = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Format integer seconds without producing any float. Under a minute we show
 * plain seconds ("42s"); at/after a minute we switch to minutes + zero-padded
 * seconds ("1m 05s"). All arithmetic is integer division/modulo, and the
 * seconds part is padded as a string so we never string-truncate a float.
 */
function formatElapsed(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

const elapsedLabel = computed(() => formatElapsed(elapsedSec.value));

onMounted(() => {
  startMs = performance.now();
  timer = setInterval(() => {
    elapsedSec.value = Math.floor((performance.now() - startMs) / 1000);
  }, 1000);
});

onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
});

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

    <span
      v-if="showElapsed"
      class="elapsed-label"
      data-testid="query-running-elapsed"
    >
      {{ elapsedLabel }}
    </span>

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

.elapsed-label {
  font-family: monospace;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  opacity: 0.75;
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
