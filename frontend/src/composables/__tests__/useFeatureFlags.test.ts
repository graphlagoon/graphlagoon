import { describe, it, expect, afterEach } from 'vitest';
import { useFeatureFlags } from '@/composables/useFeatureFlags';

afterEach(() => {
  delete (window as { __GRAPH_LAGOON_CONFIG__?: unknown }).__GRAPH_LAGOON_CONFIG__;
});

describe('useFeatureFlags', () => {
  it('every flag is on when the config is absent or silent', () => {
    const f = useFeatureFlags();
    expect(f.customMetricsEnabled.value).toBe(true);
    expect(f.customMetricsAutoRunEnabled.value).toBe(true);
    expect(f.stylePresetsEnabled.value).toBe(true);
    expect(f.precomputedGraphsEnabled.value).toBe(true);
    window.__GRAPH_LAGOON_CONFIG__ = { dev_mode: true };
    expect(useFeatureFlags().customMetricsEnabled.value).toBe(true);
  });

  it('only an explicit false turns a flag off', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { custom_metrics_auto_run_enabled: false, style_presets_enabled: false };
    const f = useFeatureFlags();
    expect(f.customMetricsEnabled.value).toBe(true);
    expect(f.customMetricsAutoRunEnabled.value).toBe(false);
    expect(f.stylePresetsEnabled.value).toBe(false);
  });

  it('auto-run is implied off when custom metrics are off', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { custom_metrics_enabled: false, custom_metrics_auto_run_enabled: true };
    expect(useFeatureFlags().customMetricsAutoRunEnabled.value).toBe(false);
  });
});
