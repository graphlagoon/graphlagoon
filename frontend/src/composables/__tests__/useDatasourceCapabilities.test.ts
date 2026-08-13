import { describe, it, expect, afterEach } from 'vitest';
import { ref } from 'vue';
import {
  DATASOURCE_LABELS,
  capabilitiesFor,
  resolveDatasourceType,
  useAvailableDatasources,
  useDatasourceCapabilities,
} from '@/composables/useDatasourceCapabilities';
import {
  createGraphContext,
  createNeptuneGraphContext,
} from '@/__tests__/fixtures/contexts';

afterEach(() => {
  delete (window as any).__GRAPH_LAGOON_CONFIG__;
});

describe('resolveDatasourceType', () => {
  it('reads the type off a context', () => {
    expect(resolveDatasourceType(createNeptuneGraphContext())).toBe('neptune');
    expect(resolveDatasourceType(createGraphContext())).toBe('sql_warehouse');
  });

  it('treats a context predating the field as a warehouse context', () => {
    // Every context created before datasources were pluggable is a warehouse
    // context, so "unspecified" and "sql_warehouse" mean the same thing.
    expect(resolveDatasourceType({ datasource_type: undefined })).toBe('sql_warehouse');
    expect(resolveDatasourceType(null)).toBe('sql_warehouse');
    expect(resolveDatasourceType(undefined)).toBe('sql_warehouse');
  });

  it('falls back for an unrecognized type rather than throwing', () => {
    expect(resolveDatasourceType({ datasource_type: 'gremlin' as any })).toBe(
      'sql_warehouse',
    );
  });
});

describe('capabilitiesFor', () => {
  it('gives the warehouse everything', () => {
    const caps = capabilitiesFor('sql_warehouse');
    expect(caps.supportsSql).toBe(true);
    expect(caps.supportsTranspile).toBe(true);
    expect(caps.supportsCtePrefilter).toBe(true);
    expect(caps.supportsDrift).toBe(true);
    expect(caps.supportsCatalog).toBe(true);
    expect(caps.supportsProgressiveLoad).toBe(true);
  });

  it('gives a native graph database none of the warehouse machinery', () => {
    const caps = capabilitiesFor('neptune');
    expect(caps.supportsSql).toBe(false);
    expect(caps.supportsTranspile).toBe(false);
    expect(caps.supportsCtePrefilter).toBe(false);
    expect(caps.supportsDrift).toBe(false);
    expect(caps.supportsCatalog).toBe(false);
    expect(caps.supportsProgressiveLoad).toBe(false);
  });
});

describe('useDatasourceCapabilities', () => {
  it('accepts a plain context', () => {
    const caps = useDatasourceCapabilities(createNeptuneGraphContext());
    expect(caps.value.supportsSql).toBe(false);
  });

  it('reacts when the context changes', () => {
    const context = ref<any>(createGraphContext());
    const caps = useDatasourceCapabilities(context);
    expect(caps.value.supportsDrift).toBe(true);

    context.value = createNeptuneGraphContext();
    expect(caps.value.supportsDrift).toBe(false);
  });

  it('defaults to warehouse capabilities with no context', () => {
    expect(useDatasourceCapabilities(ref(null)).value.supportsSql).toBe(true);
  });
});

describe('useAvailableDatasources', () => {
  it('offers only what the server says it can serve', () => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = {
      datasources: { sql_warehouse: true, neptune: true },
    };
    expect(useAvailableDatasources().value).toEqual(['sql_warehouse', 'neptune']);
  });

  it('omits a datasource the server has not configured', () => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = {
      datasources: { sql_warehouse: true, neptune: false },
    };
    expect(useAvailableDatasources().value).toEqual(['sql_warehouse']);
  });

  it('offers only the warehouse when the server said nothing', () => {
    // Offering a type the server cannot serve would fail at creation time.
    (window as any).__GRAPH_LAGOON_CONFIG__ = {};
    expect(useAvailableDatasources().value).toEqual(['sql_warehouse']);
  });
});

describe('DATASOURCE_LABELS', () => {
  it('names every datasource type', () => {
    expect(DATASOURCE_LABELS.sql_warehouse).toBeTruthy();
    expect(DATASOURCE_LABELS.neptune).toBeTruthy();
  });
});
