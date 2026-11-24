<script setup lang="ts">
/**
 * The enrichment of the graph on screen, in the status bar: running, failed or done, and
 * on click every run with when it started, how long it took, what it matched and why it
 * failed, with Retry. Hidden when nothing ran (no enrichment, or the case canvas).
 */
import { computed, ref } from 'vue';
import Popover from 'primevue/popover';
import { AlertTriangle, CheckCircle2, Clock, Loader2, PauseCircle } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import { waitingOnEnrichment } from '@/composables/useAfterQueryAnalysis';
import { describeRun, summarizeEnrichment } from '@/utils/enrichmentStatus';
import { enrichmentDescription } from '@/utils/enrichmentSources';
import YourDataModal from '@/components/YourDataModal.vue';

const graph = useGraphStore();
const panel = ref<InstanceType<typeof Popover>>();
const yourDataOpen = ref(false);

const summary = computed(() => summarizeEnrichment(graph.queryEnrichmentRuns, graph.queryEnrichmentInFlight));
const runs = computed(() => Object.entries(graph.queryEnrichmentRuns));
const failedNames = computed(() => runs.value.filter(([, r]) => r.status === 'error').map(([name]) => name));
/** name → what the enrichment says it does (the author's description, or its provider's). */
const descriptions = computed(() => {
  const out: Record<string, string> = {};
  for (const entry of graph.currentContext?.enrichment_tables ?? []) out[entry.name] = enrichmentDescription(entry);
  return out;
});
const busy = computed(() => summary.value?.state === 'running');

function retry(names: string[]) {
  void graph.runQueryEnrichment({ names });
}

function openYourData() {
  panel.value?.hide();
  yourDataOpen.value = true;
}
</script>

<template>
  <template v-if="summary">
    <button
      type="button"
      class="enrichment-chip"
      :class="summary.state"
      data-testid="enrichment-status-chip"
      :aria-label="`${summary.text}. Show the enrichment runs`"
      @click="panel?.toggle($event)"
    >
      <Loader2 v-if="summary.state === 'running'" :size="12" class="spin" aria-hidden="true" />
      <AlertTriangle v-else-if="summary.state === 'error'" :size="12" aria-hidden="true" />
      <CheckCircle2 v-else :size="12" aria-hidden="true" />
      {{ summary.text }}<template v-if="waitingOnEnrichment?.reason === 'failed'"> · {{ waitingOnEnrichment.labels.length === 1 ? '1 analysis' : `${waitingOnEnrichment.labels.length} analyses` }} skipped</template>
    </button>
    <Popover ref="panel" class="enrichment-popover">
      <div class="enrichment-panel" data-testid="enrichment-status-panel">
        <h4>Enrichment of this graph</h4>
        <ul>
          <li v-for="[name, r] in runs" :key="name" :class="r.status" data-testid="enrichment-status-run">
            <div class="row">
              <Loader2 v-if="r.status === 'running'" :size="14" class="spin" aria-hidden="true" />
              <Clock v-else-if="r.status === 'queued'" :size="14" aria-hidden="true" />
              <AlertTriangle v-else-if="r.status === 'error'" :size="14" aria-hidden="true" />
              <CheckCircle2 v-else :size="14" aria-hidden="true" />
              <strong>{{ r.label }}</strong>
              <span class="muted">{{ r.target }}</span>
              <button
                v-if="r.status === 'error'"
                type="button"
                class="link"
                data-testid="enrichment-status-retry"
                :disabled="busy"
                @click="retry([name])"
              >Retry</button>
            </div>
            <p v-if="descriptions[name]" class="what" data-testid="enrichment-status-description">{{ descriptions[name] }}</p>
            <p class="detail" data-testid="enrichment-status-detail">{{ describeRun(r) }}</p>
          </li>
          <li v-if="waitingOnEnrichment" class="waiting" data-testid="enrichment-status-waiting">
            <div class="row">
              <PauseCircle :size="14" aria-hidden="true" />
              <strong>{{ waitingOnEnrichment.labels.join(', ') }}</strong>
            </div>
            <p class="detail">
              {{ waitingOnEnrichment.reason === 'failed'
                ? 'Skipped: runs only after every enrichment succeeds. Retry the failed one and it runs.'
                : 'Waits for the enrichment to finish.' }}
            </p>
          </li>
        </ul>
        <div class="actions">
          <button
            v-if="failedNames.length > 1"
            type="button"
            class="btn btn-sm btn-primary"
            data-testid="enrichment-status-retry-failed"
            :disabled="busy"
            @click="retry(failedNames)"
          >Retry failed</button>
          <button type="button" class="link" data-testid="enrichment-status-open" @click="openYourData">
            Open Your data → Context enrichments
          </button>
        </div>
      </div>
    </Popover>
    <YourDataModal v-if="yourDataOpen" initial-tab="databricks" @close="yourDataOpen = false" />
  </template>
</template>

<style scoped>
.enrichment-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border: none;
  border-radius: 10px;
  background: var(--color-primary-subtle);
  color: var(--text-color);
  font: inherit;
  cursor: pointer;
}
.enrichment-chip.error {
  color: var(--color-error);
}
.enrichment-chip:hover {
  text-decoration: underline;
}
.enrichment-chip:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.enrichment-panel {
  width: min(380px, calc(100vw - 32px));
  font-size: 0.85rem;
}
.enrichment-panel h4 {
  margin: 0 0 8px;
  font-size: 0.9rem;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow-y: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.row svg {
  flex-shrink: 0;
}
.row strong {
  overflow-wrap: anywhere;
}
.muted {
  color: var(--color-text-muted);
}
.what {
  margin: 2px 0 0 20px;
  color: var(--color-text);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.detail {
  margin: 2px 0 0 20px;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
li.error .detail {
  color: var(--color-error);
}
.link {
  margin-left: auto;
  border: none;
  background: none;
  padding: 0 4px;
  min-height: 24px;
  color: var(--color-primary);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.link:disabled {
  opacity: 0.5;
  cursor: default;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
