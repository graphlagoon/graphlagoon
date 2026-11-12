/**
 * After-run on the click paths (execute modal, context-menu action): applied
 * once the graph loads, skipped when the query failed, fail-open on a focus
 * node missing from the result. The link path is covered end to end in
 * e2e/tests/template-url-autoexec.spec.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTemplateExecution } from '@/composables/useTemplateExecution';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import type { QueryTemplate } from '@/types/graph';

const template = (afterRun: Record<string, string>): QueryTemplate => ({
  id: 't1',
  graph_context_id: 'ctx',
  owner_email: 'a@b.c',
  name: 'Ego',
  query_type: 'cypher',
  query: 'MATCH (n {node_id: "$node_id"})-[r]-() RETURN r',
  parameters: [{ id: 'node_id', type: 'input', label: 'node_id', required: true }],
  options: { procedural_bfs: true, large_results_mode: true, after_run: afterRun },
  visibility: 'shared',
  created_at: '',
  updated_at: '',
});

describe('executeTemplateAsGraph after-run', () => {
  let store: ReturnType<typeof useGraphStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useGraphStore();
    useToast().toasts.value.splice(0);
    vi.spyOn(store, 'executeCypherQuery').mockImplementation(async () => {
      store.nodes = [{ node_id: 'n1' }, { node_id: 'n3' }] as never;
      return null;
    });
  });

  it('switches layout, centres ego and arms the focus once the graph loads', async () => {
    const { executeTemplateAsGraph } = useTemplateExecution();
    await executeTemplateAsGraph(template({ layout: 'ego', focus: '$node_id' }), { node_id: 'n3' });

    expect(store.layoutAlgorithm).toBe('ego');
    expect(store.layoutModeConfig.ego.focusNodeId).toBe('n3');
    expect(store.pendingFocusNodeId).toBe('n3');
  });

  it('does nothing when the query failed', async () => {
    vi.spyOn(store, 'executeCypherQuery').mockImplementation(async () => {
      store.queryError = 'boom' as never;
      return null;
    });
    const { executeTemplateAsGraph } = useTemplateExecution();
    await executeTemplateAsGraph(template({ layout: 'ego', focus: 'n3' }), { node_id: 'n3' });

    expect(store.layoutAlgorithm).not.toBe('ego');
    expect(store.pendingFocusNodeId).toBeNull();
  });

  it('a focus node missing from the result warns and leaves the layout alone', async () => {
    const before = store.layoutAlgorithm;
    const { executeTemplateAsGraph } = useTemplateExecution();
    await executeTemplateAsGraph(template({ layout: 'ego', focus: 'n-999' }), { node_id: 'x' });

    expect(store.layoutAlgorithm).toBe(before);
    expect(store.pendingFocusNodeId).toBeNull();
    expect(useToast().toasts.value.map((t) => t.message).join(' ')).toContain('n-999');
  });

  it('{ afterRun: false } leaves it to the caller (the link path)', async () => {
    const { executeTemplateAsGraph } = useTemplateExecution();
    await executeTemplateAsGraph(template({ focus: 'n3' }), { node_id: 'n3' }, { afterRun: false });
    expect(store.pendingFocusNodeId).toBeNull();
  });
});
