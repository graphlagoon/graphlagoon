import { describe, it, expect, afterEach } from 'vitest';
import { ref } from 'vue';
import {
  DATASOURCE_COPY,
  DATASOURCE_LABELS,
  resolveDatasourceDescriptor,
  useDatasourceDescriptors,
  capabilitiesFor,
  resolveDatasourceType,
  useAvailableDatasources,
  useDatasourceCapabilities,
} from '@/composables/useDatasourceCapabilities';
import {
  createGraphContext,
  createNeptuneGraphContext,
  createRestConnectionConfig,
  createRestGraphContext,
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

  it('agrees with the picker copy', () => {
    expect(DATASOURCE_LABELS.sql_warehouse).toBe(DATASOURCE_COPY.sql_warehouse.label);
    expect(DATASOURCE_LABELS.neptune).toBe(DATASOURCE_COPY.neptune.label);
  });
});

describe('DATASOURCE_COPY', () => {
  it.each(['sql_warehouse', 'neptune'] as const)(
    'gives %s a complete card',
    (type) => {
      const copy = DATASOURCE_COPY[type];
      // A card missing its caveat sells the datasource instead of explaining
      // the trade-off, which is the whole point of the picker.
      for (const field of ['label', 'kind', 'tagline', 'description', 'caveat'] as const) {
        expect(copy[field]).toBeTruthy();
      }
    },
  );

  it('says what each one is for, not how it is built', () => {
    // Storage layout is not something the person creating a context can act
    // on; the workload is.
    expect(DATASOURCE_COPY.sql_warehouse.tagline.toLowerCase()).toContain('analytical');
    expect(DATASOURCE_COPY.neptune.tagline.toLowerCase()).toContain('oltp');
  });
});

describe('rest datasource type', () => {
  it('resolves and gets none of the warehouse machinery', () => {
    expect(resolveDatasourceType(createRestGraphContext())).toBe('rest');
    const caps = capabilitiesFor('rest');
    expect(caps.supportsSql).toBe(false);
    expect(caps.supportsTranspile).toBe(false);
    expect(caps.supportsDrift).toBe(false);
    expect(caps.supportsCatalog).toBe(false);
  });
});

describe('resolveDatasourceDescriptor', () => {
  it('wraps the static types unchanged', () => {
    const descriptor = resolveDatasourceDescriptor(createGraphContext());
    expect(descriptor.id).toBe('sql_warehouse');
    expect(descriptor.name).toBeNull();
    expect(descriptor.copy).toBe(DATASOURCE_COPY.sql_warehouse);
    expect(descriptor.available).toBe(true);
    expect(descriptor.restOps).toBeUndefined();
  });

  it('builds a rest descriptor from the server config', () => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = {
      datasource_connections: [createRestConnectionConfig()],
    };
    const descriptor = resolveDatasourceDescriptor(createRestGraphContext());
    expect(descriptor.id).toBe('rest:fraud-api');
    expect(descriptor.copy.label).toBe('Fraud Graph Service');
    expect(descriptor.copy.queryLanguage).toBe('FraudQL');
    expect(descriptor.copy.exampleQuery).toBe('accounts linked to case 42');
    expect(descriptor.restOps).toEqual({
      expand: true,
      subgraph: true,
      fetchNodes: true,
      schemaDiscovery: true,
    });
    expect(descriptor.available).toBe(true);
  });

  it('maps declared-but-false operations honestly', () => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = {
      datasource_connections: [
        createRestConnectionConfig({
          capabilities: {
            expand: false,
            subgraph: false,
            fetch_nodes: false,
            schema_discovery: false,
          },
        }),
      ],
    };
    const descriptor = resolveDatasourceDescriptor(createRestGraphContext());
    expect(descriptor.restOps).toEqual({
      expand: false,
      subgraph: false,
      fetchNodes: false,
      schemaDiscovery: false,
    });
  });

  it('falls back to an unavailable descriptor for an orphaned context', () => {
    // The connection existed when the context was created; the server no
    // longer registers it.
    (window as any).__GRAPH_LAGOON_CONFIG__ = { datasource_connections: [] };
    const descriptor = resolveDatasourceDescriptor(createRestGraphContext());
    expect(descriptor.available).toBe(false);
    expect(descriptor.copy.label).toBe('fraud-api');
    expect(descriptor.copy.caveat).toContain('no longer configured');
    expect(descriptor.restOps?.expand).toBe(false);
  });
});

describe('useDatasourceDescriptors', () => {
  it('offers static types plus every registered connection', () => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = {
      datasources: { sql_warehouse: true, neptune: true },
      datasource_connections: [
        createRestConnectionConfig(),
        createRestConnectionConfig({ name: 'scores-api', label: 'Scores' }),
      ],
    };
    const ids = useDatasourceDescriptors().value.map((d) => d.id);
    expect(ids).toEqual([
      'sql_warehouse',
      'neptune',
      'rest:fraud-api',
      'rest:scores-api',
    ]);
  });

  it('still gates the static types on the boolean record', () => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = {
      datasources: { sql_warehouse: true, neptune: false },
      datasource_connections: [createRestConnectionConfig()],
    };
    const ids = useDatasourceDescriptors().value.map((d) => d.id);
    expect(ids).toEqual(['sql_warehouse', 'rest:fraud-api']);
  });

  it('offers only the warehouse when the server said nothing', () => {
    (window as any).__GRAPH_LAGOON_CONFIG__ = {};
    const ids = useDatasourceDescriptors().value.map((d) => d.id);
    expect(ids).toEqual(['sql_warehouse']);
  });
});
