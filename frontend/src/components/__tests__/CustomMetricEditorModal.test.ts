import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import CustomMetricEditorModal from '@/components/CustomMetricEditorModal.vue';
import { useCustomMetricsStore } from '@/stores/customMetrics';
import { useGraphStore } from '@/stores/graph';
import type { CustomMetricDefinition } from '@/types/customMetrics';
import type { GraphContext } from '@/types/graph';

vi.mock('@/services/api', () => ({
  api: { updateGraphContext: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@/services/customMetricRunner', () => ({
  runDefinitions: vi.fn(() => ({ cancel: vi.fn(), done: Promise.resolve() })),
  serializeGraphForCustomMetrics: vi.fn(() => ({})),
  testDefinition: vi.fn(),
}));

import { testDefinition } from '@/services/customMetricRunner';
const mockedTest = vi.mocked(testDefinition);

// JavaScriptEditor embeds CodeMirror, which doesn't render in happy-dom —
// stub it with a plain textarea wired to v-model.
const stubs = {
  CustomMetricSkillModal: { template: '<div v-if="modelValue" data-testid="skill-stub" />', props: ['modelValue'] },
  JavaScriptEditor: {
    props: ['modelValue', 'disabled'],
    emits: ['update:modelValue'],
    template: `<textarea data-testid="code-stub" :disabled="disabled" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
  },
};

function makeContext(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    id: 'ctx-1',
    title: 'Ctx',
    tags: [],
    edge_table_name: 'edges',
    node_table_name: 'nodes',
    edge_structure: { edge_id_col: 'edge_id', src_col: 'src', dst_col: 'dst', relationship_type_col: 'relationship_type' },
    node_structure: { node_id_col: 'node_id', node_type_col: 'node_type' },
    edge_properties: [],
    node_properties: [],
    node_types: [],
    relationship_types: [],
    owner_email: 'me@example.com',
    shared_with: [],
    has_write_access: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeDef(overrides: Partial<CustomMetricDefinition> = {}): CustomMetricDefinition {
  return { id: 'd1', name: 'Email domain', target: 'node', value_type: 'string', code: 'return 1;', ...overrides };
}

function renderModal(definition: CustomMetricDefinition | null = null) {
  return render(CustomMetricEditorModal, { props: { definition }, global: { stubs } });
}

function q<T extends Element>(selector: string): T {
  return document.body.querySelector(selector) as T;
}

beforeEach(() => {
  setActivePinia(createPinia());
  useGraphStore().currentContext = makeContext();
  mockedTest.mockReset();
});

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
});

describe('CustomMetricEditorModal', () => {
  it('creates a definition with a generated id and closes', async () => {
    const store = useCustomMetricsStore();
    const { emitted } = renderModal(null);

    expect(q<HTMLButtonElement>('[data-testid="custom-metric-save"]').disabled).toBe(true);
    await fireEvent.update(q<HTMLInputElement>('[data-testid="custom-metric-name"]'), 'Neighbour mean degree');
    await fireEvent.click(q<HTMLInputElement>('[data-testid="custom-metric-target-node"]'));
    await fireEvent.update(q<HTMLSelectElement>('[data-testid="custom-metric-value-type"]'), 'number');
    await fireEvent.update(q<HTMLTextAreaElement>('[data-testid="code-stub"]'), 'return ctx.degree * 2;');
    await fireEvent.update(q<HTMLInputElement>('[data-testid="custom-metric-description"]'), 'doubles');
    expect(q<HTMLButtonElement>('[data-testid="custom-metric-save"]').disabled).toBe(false);

    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-save"]'));

    expect(store.definitions).toHaveLength(1);
    expect(store.definitions[0]).toMatchObject({
      name: 'Neighbour mean degree',
      target: 'node',
      value_type: 'number',
      code: 'return ctx.degree * 2;',
      description: 'doubles',
    });
    expect(store.definitions[0].id).toMatch(/[0-9a-f-]{20,}/);
    expect(emitted().saved).toHaveLength(1);
    expect(emitted().close).toHaveLength(1);
  });

  it('edit mode keeps the id and updates in place', async () => {
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef()]);
    renderModal(makeDef());
    expect(q<HTMLInputElement>('[data-testid="custom-metric-name"]').value).toBe('Email domain');
    await fireEvent.update(q<HTMLInputElement>('[data-testid="custom-metric-name"]'), 'Domain');
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-save"]'));
    expect(store.definitions).toHaveLength(1);
    expect(store.definitions[0]).toMatchObject({ id: 'd1', name: 'Domain' });
  });

  it('rejects a duplicate name (case-insensitive) and an empty code', async () => {
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef({ id: 'other', name: 'Taken' })]);
    renderModal(null);
    await fireEvent.update(q<HTMLInputElement>('[data-testid="custom-metric-name"]'), 'TAKEN');
    await nextTick();
    expect(q('[data-testid="custom-metric-name-error"]').textContent).toMatch(/already uses this name/);
    expect(q<HTMLButtonElement>('[data-testid="custom-metric-save"]').disabled).toBe(true);

    await fireEvent.update(q<HTMLInputElement>('[data-testid="custom-metric-name"]'), 'Fresh');
    await fireEvent.update(q<HTMLTextAreaElement>('[data-testid="code-stub"]'), '   ');
    await nextTick();
    expect(q<HTMLButtonElement>('[data-testid="custom-metric-save"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="custom-metric-test"]').disabled).toBe(true);
  });

  it('switching target on a fresh definition swaps the starter code (but not edited code)', async () => {
    renderModal(null);
    const code = () => q<HTMLTextAreaElement>('[data-testid="code-stub"]').value;
    expect(code()).toContain('return ctx.degree;');
    await fireEvent.click(q<HTMLInputElement>('[data-testid="custom-metric-target-edge"]'));
    expect(code()).toContain('item.properties.weight');
    await fireEvent.update(q<HTMLTextAreaElement>('[data-testid="code-stub"]'), 'return 42;');
    await fireEvent.click(q<HTMLInputElement>('[data-testid="custom-metric-target-node"]'));
    expect(code()).toBe('return 42;');
  });

  it('Test runs the draft through the store and renders samples, item errors and a type hint', async () => {
    mockedTest.mockResolvedValue({
      samples: [
        { id: 'p1', value: 'foo.com', rawType: 'string' },
        { id: 'p2', value: null, rawType: 'number' },
        { id: 'p3', value: null, rawType: 'undefined' },
      ],
      errorCount: 1,
      firstItemError: 'TypeError: boom',
      elapsedMs: 3,
    });
    renderModal(makeDef());
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-test"]'));
    await waitFor(() => expect(q('[data-testid="custom-metric-test-results"]')).not.toBeNull());

    expect(mockedTest).toHaveBeenCalledTimes(1);
    expect(mockedTest.mock.calls[0][0]).toMatchObject({ id: 'd1', name: 'Email domain', code: 'return 1;' });
    const rows = document.body.querySelectorAll('[data-testid="custom-metric-test-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('foo.com');
    expect(q('[data-testid="custom-metric-test-item-errors"]').textContent).toMatch(/1 of 3 items threw/);
    expect(q('[data-testid="custom-metric-test-item-errors"]').textContent).toContain('TypeError: boom');
    // p2 returned a number for a string metric → hint; p3 (undefined) does not count
    expect(q('[data-testid="custom-metric-test-type-hint"]').textContent).toMatch(/1 item\(s\) returned a value that is not a string/);
  });

  it('Test surfaces a compile error / timeout', async () => {
    mockedTest.mockResolvedValue({ samples: [], errorCount: 0, error: 'SyntaxError: Unexpected token', elapsedMs: 0 });
    renderModal(makeDef());
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-test"]'));
    await waitFor(() => expect(q('[data-testid="custom-metric-test-error"]')).not.toBeNull());
    expect(q('[data-testid="custom-metric-test-error"]').textContent).toContain('SyntaxError');
  });

  it('the robot button next to the code field opens the Ask-AI prompt modal', async () => {
    renderModal(null);
    expect(q('[data-testid="skill-stub"]')).toBeNull();
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-skill-help"]'));
    expect(q('[data-testid="skill-stub"]')).not.toBeNull();
  });

  it('the auto-run checkbox is off by default and persists as auto_run: true when ticked', async () => {
    const store = useCustomMetricsStore();
    renderModal(null);
    const box = q<HTMLInputElement>('[data-testid="custom-metric-auto-run"]');
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    await fireEvent.update(q<HTMLInputElement>('[data-testid="custom-metric-name"]'), 'Auto one');
    await fireEvent.click(box);
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-save"]'));
    expect(store.definitions[0].auto_run).toBe(true);

    // Editing shows it ticked; unticking drops the key
    document.body.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    renderModal({ ...store.definitions[0] });
    const box2 = q<HTMLInputElement>('[data-testid="custom-metric-auto-run"]');
    expect(box2.checked).toBe(true);
    await fireEvent.click(box2);
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-save"]'));
    expect(store.definitions[0].auto_run).toBeUndefined();
  });

  it('when the server disables auto-run the checkbox is disabled and says why', () => {
    window.__GRAPH_LAGOON_CONFIG__ = { custom_metrics_auto_run_enabled: false };
    setActivePinia(createPinia());
    useGraphStore().currentContext = makeContext();
    renderModal(null);
    expect(q<HTMLInputElement>('[data-testid="custom-metric-auto-run"]').disabled).toBe(true);
    expect(q('[data-testid="custom-metric-auto-run-disabled"]').textContent).toContain('GRAPH_LAGOON_CUSTOM_METRICS_AUTO_RUN_ENABLED');
    delete (window as { __GRAPH_LAGOON_CONFIG__?: unknown }).__GRAPH_LAGOON_CONFIG__;
  });

  it('Import JSON carries auto_run into the checkbox', async () => {
    renderModal(null);
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-toggle"]'));
    await fireEvent.update(
      q<HTMLTextAreaElement>('[data-testid="custom-metric-import-text"]'),
      JSON.stringify({ name: 'A', target: 'node', code: 'return 1;', auto_run: true }),
    );
    await nextTick();
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-apply"]'));
    expect(q<HTMLInputElement>('[data-testid="custom-metric-auto-run"]').checked).toBe(true);
  });

  it('read-only access disables the form and hides Save', async () => {
    useGraphStore().currentContext = makeContext({ has_write_access: false });
    renderModal(makeDef());
    expect(q('[data-testid="custom-metric-readonly"]')).not.toBeNull();
    expect(q<HTMLInputElement>('[data-testid="custom-metric-name"]').disabled).toBe(true);
    expect(q<HTMLTextAreaElement>('[data-testid="code-stub"]').disabled).toBe(true);
    expect(q('[data-testid="custom-metric-save"]')).toBeNull();
  });
});

describe('CustomMetricEditorModal — import / export', () => {
  const LLM_ANSWER = JSON.stringify({
    name: 'Is hub',
    target: 'edge',
    value_type: 'boolean',
    description: 'from the AI',
    code: 'return ctx.hasEdge(item.dst, item.src);',
  });

  it('Import JSON fills the form from the AI answer', async () => {
    renderModal(null);
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-toggle"]'));
    expect(q<HTMLButtonElement>('[data-testid="custom-metric-import-apply"]').disabled).toBe(true);
    await fireEvent.update(q<HTMLTextAreaElement>('[data-testid="custom-metric-import-text"]'), LLM_ANSWER);
    await nextTick();
    expect(q<HTMLButtonElement>('[data-testid="custom-metric-import-apply"]').disabled).toBe(false);
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-apply"]'));

    expect(q<HTMLInputElement>('[data-testid="custom-metric-name"]').value).toBe('Is hub');
    expect(q<HTMLInputElement>('[data-testid="custom-metric-target-edge"]').checked).toBe(true);
    expect(q<HTMLSelectElement>('[data-testid="custom-metric-value-type"]').value).toBe('boolean');
    expect(q<HTMLInputElement>('[data-testid="custom-metric-description"]').value).toBe('from the AI');
    expect(q<HTMLTextAreaElement>('[data-testid="code-stub"]').value).toBe('return ctx.hasEdge(item.dst, item.src);');
    // The import box closes once applied; Save is enabled
    expect(q('[data-testid="custom-metric-import-text"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="custom-metric-save"]').disabled).toBe(false);
  });

  it('edit mode: "Edit as JSON" is prefilled with the current metric; applying updates the form and Save keeps the id', async () => {
    const store = useCustomMetricsStore();
    store.hydrateFromContext([makeDef()]);
    renderModal(makeDef());
    const toggle = q<HTMLButtonElement>('[data-testid="custom-metric-import-toggle"]');
    expect(toggle.textContent).toContain('Edit as JSON');
    await fireEvent.click(toggle);
    const box = q<HTMLTextAreaElement>('[data-testid="custom-metric-import-text"]');
    const current = JSON.parse(box.value);
    expect(current).toMatchObject({ id: 'd1', name: 'Email domain', code: 'return 1;' });

    await fireEvent.update(box, JSON.stringify({ ...current, name: 'Domain', code: 'return 2;' }));
    await nextTick();
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-apply"]'));
    expect(q<HTMLInputElement>('[data-testid="custom-metric-name"]').value).toBe('Domain');
    expect(q<HTMLTextAreaElement>('[data-testid="code-stub"]').value).toBe('return 2;');

    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-save"]'));
    expect(store.definitions).toHaveLength(1);
    expect(store.definitions[0]).toMatchObject({ id: 'd1', name: 'Domain', code: 'return 2;' });
  });

  it('shows a parse error for bad JSON and keeps the apply button disabled', async () => {
    renderModal(null);
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-toggle"]'));
    await fireEvent.update(q<HTMLTextAreaElement>('[data-testid="custom-metric-import-text"]'), '{"name": "x"}');
    await nextTick();
    expect(q('[data-testid="custom-metric-import-parse-error"]').textContent).toContain('"target"');
    expect(q<HTMLButtonElement>('[data-testid="custom-metric-import-apply"]').disabled).toBe(true);
  });

  it('warns about properties / metrics this graph lacks and offers the adapt prompt', async () => {
    useGraphStore().currentContext = makeContext({ node_properties: [{ name: 'name', data_type: 'string' }] });
    renderModal(null);
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-toggle"]'));
    await fireEvent.update(
      q<HTMLTextAreaElement>('[data-testid="custom-metric-import-text"]'),
      JSON.stringify({ name: 'X', target: 'node', code: "return item.properties.receita + ctx.metric('pagerank');" }),
    );
    await nextTick();
    const warnings = q('[data-testid="custom-metric-import-warnings"]');
    expect(warnings.textContent).toContain('properties: receita');
    expect(warnings.textContent).toContain('metrics: pagerank');
    expect(q('[data-testid="skill-stub"]')).toBeNull();
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-adapt"]'));
    expect(q('[data-testid="skill-stub"]')).not.toBeNull();
  });

  it('does not warn about a property that exists only on the loaded graph', async () => {
    useGraphStore().currentContext = makeContext({ node_properties: [] });
    useGraphStore().nodes = [{ node_id: 'n1', node_type: 'T', properties: { receita: 1 } }];
    renderModal(null);
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-toggle"]'));
    await fireEvent.update(
      q<HTMLTextAreaElement>('[data-testid="custom-metric-import-text"]'),
      JSON.stringify({ name: 'X', target: 'node', code: 'return item.properties.receita;' }),
    );
    await nextTick();
    expect(q('[data-testid="custom-metric-import-warnings"]')).toBeNull();
  });

  it('with several metrics pasted, loads the first and says so', async () => {
    renderModal(null);
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-toggle"]'));
    await fireEvent.update(
      q<HTMLTextAreaElement>('[data-testid="custom-metric-import-text"]'),
      JSON.stringify([
        { name: 'First', target: 'node', code: 'return 1;' },
        { name: 'Second', target: 'node', code: 'return 2;' },
      ]),
    );
    await nextTick();
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-import-apply"]'));
    expect(q<HTMLInputElement>('[data-testid="custom-metric-name"]').value).toBe('First');
    expect(q('[data-testid="custom-metric-import-note"]').textContent).toContain('first of 2');
  });

  it('Export JSON downloads the form as a custom-metrics envelope', async () => {
    const clicks: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    let blob: Blob | null = null;
    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:x';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    try {
      renderModal(makeDef({ name: 'Email domain' }));
      await fireEvent.click(q<HTMLButtonElement>('[data-testid="custom-metric-export"]'));
      expect(clicks).toEqual(['metric-Email-domain.json']);
      const payload = JSON.parse(await (blob as unknown as Blob).text());
      expect(payload.graphlagoon_export).toBe('custom-metrics');
      expect(payload.metrics).toHaveLength(1);
      expect(payload.metrics[0]).toMatchObject({ id: 'd1', name: 'Email domain', code: 'return 1;' });
      expect(payload.source.context_title).toBe('Ctx');
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('readers get neither Import nor Export', () => {
    useGraphStore().currentContext = makeContext({ has_write_access: false });
    renderModal(makeDef());
    expect(q('[data-testid="custom-metric-import-toggle"]')).toBeNull();
    expect(q('[data-testid="custom-metric-export"]')).toBeNull();
  });
});
