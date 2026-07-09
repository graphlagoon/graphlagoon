import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import QueryConsolePanel from '@/components/QueryConsolePanel.vue';
import { useGraphStore } from '@/stores/graph';
import { useQueryConsoleStore } from '@/stores/queryConsole';
import type { ColMeta } from '@/composables/useTableColumns';

// Stub heavy children (codemirror-based editor, modals). The DataGrid stub
// declares nodeIdField as a prop so the computed value is observable as a
// data attribute.
const stubs = {
  CypherEditor: true,
  QueryErrorModal: true,
  QueryRunningState: true,
  TemplateEditorModal: true,
  TranspileSettingsModal: true,
  DataGrid: {
    props: ['nodeIdField', 'columns', 'rows'],
    template: '<div data-testid="grid-stub" :data-node-id-field="nodeIdField" />',
  },
};

function col(field: string, header: string): ColMeta {
  return { field, header, type: 'text' };
}

function setupStores(nodeIdCol: string, columns: ColMeta[]) {
  const graph = useGraphStore();
  graph.currentContext = {
    id: 'ctx-1',
    title: 'Test Context',
    node_structure: { node_id_col: nodeIdCol, node_type_col: 'node_type' },
  } as any;

  const consoleStore = useQueryConsoleStore();
  consoleStore.hasRun = true;
  consoleStore.columns = columns;
  consoleStore.rows = [{ col_0: 'n1', col_1: 'Alice' }];
}

function renderedNodeIdField(): string | null {
  const grid = document.body.querySelector('[data-testid="grid-stub"]');
  expect(grid).not.toBeNull();
  return grid!.getAttribute('data-node-id-field');
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('QueryConsolePanel nodeIdField detection', () => {
  it("detects the context's custom node_id_col in raw results", () => {
    // Context uses a custom id column name — NOT the default 'node_id'.
    setupStores('source_id', [col('col_0', 'source_id'), col('col_1', 'name')]);
    render(QueryConsolePanel, { global: { stubs } });

    expect(renderedNodeIdField()).toBe('col_0');
  });

  it('falls back to a literal node_id column when the custom one is absent', () => {
    setupStores('source_id', [col('col_0', 'node_id'), col('col_1', 'name')]);
    render(QueryConsolePanel, { global: { stubs } });

    expect(renderedNodeIdField()).toBe('col_0');
  });

  it('yields no nodeIdField when no id-like column is present', () => {
    setupStores('source_id', [col('col_0', 'name'), col('col_1', 'age')]);
    render(QueryConsolePanel, { global: { stubs } });

    expect(renderedNodeIdField()).toBeNull();
  });
});
