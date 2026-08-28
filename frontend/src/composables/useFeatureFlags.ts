/**
 * Server-side feature flags, injected by the backend into
 * `window.__GRAPH_LAGOON_CONFIG__` (see api/graphlagoon/app.py render_spa and
 * routers/config.py) from GRAPH_LAGOON_* environment variables.
 *
 * Every flag defaults to ENABLED when absent, so a frontend running against
 * an older backend (or the Vite dev server without config injection) behaves
 * as before; only an explicit `false` turns a feature off.
 */
import { computed } from 'vue';

function flag(name: keyof NonNullable<Window['__GRAPH_LAGOON_CONFIG__']>): boolean {
  return window.__GRAPH_LAGOON_CONFIG__?.[name] !== false;
}

export function useFeatureFlags() {
  /** Custom (writer-authored) metrics as a whole — GRAPH_LAGOON_CUSTOM_METRICS_ENABLED */
  const customMetricsEnabled = computed(() => flag('custom_metrics_enabled'));
  /** Whether `auto_run` definitions may evaluate on graph load — GRAPH_LAGOON_CUSTOM_METRICS_AUTO_RUN_ENABLED */
  const customMetricsAutoRunEnabled = computed(
    () => customMetricsEnabled.value && flag('custom_metrics_auto_run_enabled'),
  );
  /** GRAPH_LAGOON_STYLE_PRESETS_ENABLED */
  const stylePresetsEnabled = computed(() => flag('style_presets_enabled'));
  /** GRAPH_LAGOON_PRECOMPUTED_GRAPHS_ENABLED */
  const precomputedGraphsEnabled = computed(() => flag('precomputed_graphs_enabled'));

  return { customMetricsEnabled, customMetricsAutoRunEnabled, stylePresetsEnabled, precomputedGraphsEnabled };
}
