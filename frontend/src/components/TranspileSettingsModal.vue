<script setup lang="ts">
/**
 * Advanced transpile / optimization settings, shared by the graph query side
 * panel and the bottom Query Console. Binds directly to the graph store (single
 * source of truth) so both panels — and saved explorations — stay in sync.
 *
 * Groups:
 *  - Transpilation: procedural BFS mode + materialization strategy + the
 *    gsql2rsql ProceduralBFSOptimizations flags.
 *  - Results: "Large results mode" (external links) — not a transpiler flag,
 *    but surfaced here per the unified settings request.
 */
import { computed } from 'vue';
import { SlidersHorizontal, X, RotateCcw } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import {
  DEFAULT_PROCEDURAL_BFS_OPTIONS,
  type ProceduralBFSOptions,
} from '@/types/graph';

const emit = defineEmits<{ close: [] }>();

const graphStore = useGraphStore();

const proceduralBfs = computed({
  get: () => graphStore.vlpRenderingMode === 'procedural',
  set: (v: boolean) => { graphStore.vlpRenderingMode = v ? 'procedural' : 'cte'; },
});

const materialization = computed({
  get: () => graphStore.materializationStrategy,
  set: (v: 'temp_tables' | 'numbered_views') => { graphStore.materializationStrategy = v; },
});

const cteFallback = computed({
  get: () => graphStore.cteFallbackEnabled,
  set: (v: boolean) => { graphStore.cteFallbackEnabled = v; },
});

const cteFallbackSilent = computed({
  get: () => graphStore.cteFallbackSilent,
  set: (v: boolean) => { graphStore.cteFallbackSilent = v; },
});

const useExternalLinks = computed({
  get: () => graphStore.useExternalLinks,
  set: (v: boolean) => { graphStore.useExternalLinks = v; },
});

type FlagKey = keyof ProceduralBFSOptions;
type Scope = 'both' | 'temp_tables' | 'numbered_views';

interface FlagMeta {
  key: FlagKey;
  label: string;
  scope: Scope;
  hint: string;
  requires?: FlagKey[]; // flags that must ALL be ON for this one to take effect
}

// Order + copy mirror gsql2rsql's ProceduralBFSOptimizations dataclass.
const FLAGS: FlagMeta[] = [
  { key: 'visited_not_exists', label: 'Visited via NOT EXISTS', scope: 'both', hint: 'Anti-join instead of a LEFT JOIN for the visited set.' },
  { key: 'loop_control_into', label: 'Loop control INTO', scope: 'numbered_views', hint: 'Applies to Numbered Views only.' },
  { key: 'undirected_doubled_adjacency', label: 'Doubled adjacency (undirected)', scope: 'both', hint: 'Mutually exclusive with UNION ALL adjacency.' },
  { key: 'deferred_edge_payload', label: 'Deferred edge payload', scope: 'temp_tables', hint: 'Applies to Temp Tables only.' },
  { key: 'barrier_precompute', label: 'Barrier precompute', scope: 'temp_tables', hint: 'Applies to Temp Tables only.' },
  { key: 'barrier_on_adjacency', label: 'Barrier on adjacency', scope: 'temp_tables', hint: 'Carries the barrier on the adjacency; needs Barrier precompute.', requires: ['barrier_precompute'] },
  { key: 'prune_barrier_adjacency', label: 'Prune barrier adjacency', scope: 'temp_tables', hint: 'Drops expand-from-barrier rows; needs Doubled adjacency + Barrier precompute.', requires: ['undirected_doubled_adjacency', 'barrier_precompute'] },
  { key: 'undirected_union_all', label: 'UNION ALL adjacency (undirected)', scope: 'both', hint: 'Mutually exclusive with doubled adjacency.' },
];

function inScope(flag: FlagMeta): boolean {
  return flag.scope === 'both' || flag.scope === materialization.value;
}

/** A flag is interactive only when in scope AND all its dependencies are ON. */
function isEnabled(flag: FlagMeta): boolean {
  if (!inScope(flag)) return false;
  if (flag.requires) {
    return flag.requires.every(k => graphStore.proceduralOptimizations[k]);
  }
  return true;
}

function isChecked(key: FlagKey): boolean {
  return graphStore.proceduralOptimizations[key];
}

/**
 * Toggle a flag. Enforces the doubled-adjacency ⊕ union-all exclusivity so we
 * never send a combination the transpiler would reject with a ValueError.
 */
function onToggle(key: FlagKey, value: boolean) {
  const next: ProceduralBFSOptions = { ...graphStore.proceduralOptimizations, [key]: value };
  if (value && key === 'undirected_union_all') next.undirected_doubled_adjacency = false;
  if (value && key === 'undirected_doubled_adjacency') next.undirected_union_all = false;
  graphStore.proceduralOptimizations = next;
}

function resetDefaults() {
  graphStore.proceduralOptimizations = { ...DEFAULT_PROCEDURAL_BFS_OPTIONS };
}

const isDefault = computed(() =>
  (Object.keys(DEFAULT_PROCEDURAL_BFS_OPTIONS) as FlagKey[]).every(
    k => graphStore.proceduralOptimizations[k] === DEFAULT_PROCEDURAL_BFS_OPTIONS[k],
  ),
);
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" data-testid="transpile-settings-modal" @click.self="emit('close')">
      <div class="modal-content">
        <div class="modal-header">
          <SlidersHorizontal :size="18" class="header-icon" />
          <h3>Transpile &amp; optimization settings</h3>
          <button class="close-btn btn-icon-only" aria-label="Close" @click="emit('close')">
            <X :size="16" />
          </button>
        </div>

        <div class="modal-body">
          <!-- ── Transpilation ── -->
          <section class="settings-group">
            <h4 class="group-title">Transpilation</h4>

            <label class="row toggle-row">
              <input
                type="checkbox"
                v-model="proceduralBfs"
                data-testid="opt-procedural-bfs"
              />
              <span class="row-label">Procedural BFS</span>
              <span class="row-hint">temp tables / views instead of WITH RECURSIVE</span>
            </label>

            <template v-if="proceduralBfs">
              <label class="row toggle-row">
                <input
                  type="checkbox"
                  v-model="cteFallback"
                  data-testid="opt-cte-fallback"
                />
                <span class="row-label">CTE fallback on error</span>
                <span class="row-hint">retry a failed procedural query in WITH RECURSIVE mode</span>
              </label>

              <label v-if="cteFallback" class="row toggle-row sub-row">
                <input
                  type="checkbox"
                  v-model="cteFallbackSilent"
                  data-testid="opt-cte-fallback-silent"
                />
                <span class="row-label">Silent fallback</span>
                <span class="row-hint">don't show notifications when the fallback runs</span>
              </label>

              <div class="row select-row">
                <span class="row-label">Materialization</span>
                <select v-model="materialization" class="strategy-select" data-testid="opt-materialization">
                  <option value="temp_tables">Temp Tables (Databricks)</option>
                  <option value="numbered_views">Numbered Views (PySpark 4.2+)</option>
                </select>
              </div>

              <div class="flags">
                <p class="flags-caption">Procedural BFS optimizations</p>
                <label
                  v-for="flag in FLAGS"
                  :key="flag.key"
                  class="row flag-row"
                  :class="{ disabled: !isEnabled(flag) }"
                >
                  <input
                    type="checkbox"
                    :checked="isChecked(flag.key)"
                    :disabled="!isEnabled(flag)"
                    :data-testid="`opt-${flag.key}`"
                    @change="onToggle(flag.key, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="row-label">{{ flag.label }}</span>
                  <span class="row-hint">
                    {{ flag.hint }}
                    <template v-if="!inScope(flag)"> — n/a for current strategy</template>
                  </span>
                </label>
              </div>

              <div class="reset-row">
                <button
                  class="reset-btn"
                  :disabled="isDefault"
                  data-testid="opt-reset"
                  @click="resetDefaults"
                >
                  <RotateCcw :size="12" /> Reset to defaults
                </button>
              </div>
            </template>
            <p v-else class="group-note">
              Enable Procedural BFS to configure per-optimization flags.
            </p>
          </section>

          <!-- ── Results ── -->
          <section class="settings-group">
            <h4 class="group-title">Results</h4>
            <label class="row toggle-row">
              <input
                type="checkbox"
                v-model="useExternalLinks"
                data-testid="opt-large-results"
              />
              <span class="row-label">Large results mode</span>
              <span class="row-hint">external links for results &gt; 25 MiB</span>
            </label>
          </section>
        </div>

        <div class="modal-footer">
          <button class="done-btn" @click="emit('close')">Done</button>
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
  z-index: 10000;
}

.modal-content {
  background: var(--card-background, white);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  max-width: 540px;
  width: 90%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-color, #eee);
}

.header-icon {
  color: var(--primary-color, #42b883);
}

.modal-header h3 {
  margin: 0;
  flex: 1;
  font-size: 16px;
  color: var(--text-primary, #333);
}

.close-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted, #666);
  padding: 0;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-primary, #333);
}

.modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-title {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #666);
}

.group-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted, #999);
  font-style: italic;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  color: var(--text-primary, #333);
}

.toggle-row,
.flag-row {
  cursor: pointer;
}

.sub-row {
  padding-left: 22px;
}

.row input[type='checkbox'] {
  position: relative;
  top: 2px;
  flex-shrink: 0;
}

.row-label {
  font-weight: 500;
}

.row-hint {
  color: var(--text-muted, #999);
  font-size: 12px;
}

.select-row {
  align-items: center;
}

.strategy-select {
  margin-left: auto;
  padding: 4px 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  font-size: 12px;
  background: var(--card-background, #fff);
  color: var(--text-primary, #333);
}

.flags {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #eee);
  border-radius: 6px;
  background: var(--bg-secondary, #f7f7f7);
}

.flags-caption {
  margin: 0 0 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #777);
}

.flag-row.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.reset-row {
  display: flex;
  justify-content: flex-end;
}

.reset-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: var(--card-background, #fff);
  color: var(--text-muted, #666);
  font-size: 11px;
  cursor: pointer;
}

.reset-btn:hover:not(:disabled) {
  background: var(--bg-secondary, #f0f0f0);
}

.reset-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.modal-footer {
  padding: 12px 18px;
  border-top: 1px solid var(--border-color, #eee);
  display: flex;
  justify-content: flex-end;
}

.done-btn {
  padding: 8px 20px;
  background: var(--primary-color, #42b883);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.done-btn:hover {
  background: var(--primary-hover, #3aa876);
}
</style>
