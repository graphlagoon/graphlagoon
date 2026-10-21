import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useGraphStore } from '@/stores/graph';
import { api } from '@/services/api';
import type { Edge, Exploration, GraphContext, Node } from '@/types/graph';
import type { ComputedMetric } from '@/types/metrics';
import {
  applyOverlay,
  baseGraphOf,
  emptyOverlay,
  emptyOverlayState,
  parseSnapshotJson,
  type GraphOverlay,
  type OverlayEnrichment,
} from '@/utils/graphOverlay';

/** BYOD-2: the user's layer on an exploration — on top of the context's answer, never inside it. */

const risk: OverlayEnrichment = {
  id: 'f1',
  filename: 'risk.csv',
  spec: { name: 'Risk', input: { delimiter: ',', header: true }, key_column: 'id', columns: ['risk', 'segment'], match_node_types: [], match_source: 'node_id' },
  rows: { a: [{ risk: 'high', segment: 'retail' }], b: [{ risk: 'mid' }], c: [{ risk: 'new' }] },
  row_count: 3,
};

const graph = (): { nodes: Node[]; edges: Edge[] } => ({
  nodes: [
    { node_id: 'a', node_type: 'Account', properties: { risk: 'low' } },
    { node_id: 'b', node_type: 'Account', properties: {} },
  ],
  edges: [{ edge_id: 'e1', src: 'a', dst: 'b', relationship_type: 'PIX', properties: {} }],
});

const layer = (over: Partial<GraphOverlay> = {}): GraphOverlay => ({ ...emptyOverlay(), enrichments: [risk], ...over });

describe('applyOverlay (pure)', () => {
  it('fills missing values, keeps existing ones, and gives the context graph back untouched', () => {
    const g = graph();
    const out = applyOverlay(g.nodes, g.edges, layer(), emptyOverlayState());
    expect(out.nodes.map((n) => n.properties)).toEqual([{ risk: 'low', segment: 'retail' }, { risk: 'mid' }]);
    const base = baseGraphOf(out.nodes, out.edges, out.state);
    expect(base.nodes.map((n) => n.properties)).toEqual([{ risk: 'low' }, {}]);
  });

  it('is idempotent and never "restores" fresh objects that share ids with enriched ones', () => {
    const g = graph();
    let out = applyOverlay(g.nodes, g.edges, layer(), emptyOverlayState());
    out = applyOverlay(out.nodes, out.edges, layer(), out.state);
    expect(out.nodes[0].properties).toEqual({ risk: 'low', segment: 'retail' });
    // A new query answer: new objects, same ids, a value the context now has.
    const fresh: Node[] = [{ node_id: 'a', node_type: 'Account', properties: { risk: 'low', segment: 'corporate' } }];
    const again = applyOverlay(fresh, [], layer(), out.state);
    expect(again.nodes[0].properties).toEqual({ risk: 'low', segment: 'corporate' });
  });

  it('adds its nodes, merges one whose id the context returned, draws edges with both ends present', () => {
    const g = graph();
    const out = applyOverlay(g.nodes, g.edges, layer({
      enrichments: [],
      nodes: [{ id: 'sketch:p', type: 'Person', properties: { label: 'Ana' } }, { id: 'b', type: 'Account', properties: { branch: '9' } }],
      edges: [
        { id: 'sketch:x', source: 'sketch:p', target: 'a', type: 'OWNS', properties: {} },
        { id: 'sketch:y', source: 'sketch:p', target: 'zz', type: 'OWNS', properties: {} },
      ],
    }), emptyOverlayState());
    expect(out.nodes.map((n) => n.node_id)).toEqual(['a', 'b', 'sketch:p']);
    expect(out.nodes[1].properties).toEqual({ branch: '9' });
    expect(out.edges.map((e) => e.edge_id)).toEqual(['e1', 'sketch:x']); // zz is not on the canvas
    const base = baseGraphOf(out.nodes, out.edges, out.state);
    expect(base.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(base.nodes[1].properties).toEqual({});
    expect(base.edges.map((e) => e.edge_id)).toEqual(['e1']);
  });

  it('enriches edges by their endpoints and can overwrite', () => {
    const g = graph();
    const byEnds: OverlayEnrichment = {
      ...risk,
      id: 'f2',
      spec: { ...risk.spec, target: 'edges', key_column: null, columns: ['channel'], overwrite: true, edge_key: { by: 'endpoints', source_column: 's', target_column: 't' } },
      rows: { 'b>a': [{ channel: 'app' }] },
    };
    const out = applyOverlay(g.nodes, g.edges, layer({ enrichments: [byEnds] }), emptyOverlayState());
    expect(out.edges[0].properties).toEqual({ channel: 'app' });
  });

  it('reads pasted JSON or says what is wrong', () => {
    expect(parseSnapshotJson('{"nodes":[{"id":1,"type":"T"}],"edges":[{"source":1,"target":1,"type":"S"}]}').snapshot?.edges[0].id).toBe('e1');
    expect(parseSnapshotJson('{"nodes":[{"id":1}]}').error).toContain('"type"');
    expect(parseSnapshotJson('nope').error).toContain('JSON');
  });
});

describe('graph store — the user layer', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  function storeWithGraph(exploration: Partial<Exploration> | null = null) {
    const store = useGraphStore();
    store.currentContext = { id: 'c1', title: 'Bank' } as GraphContext;
    const g = graph();
    store.nodes = g.nodes;
    store.edges = g.edges;
    if (exploration) store.currentExploration = { id: 'x1', title: 'Pix', has_write_access: true, state: {}, ...exploration } as unknown as Exploration;
    return store;
  }

  it('an enrichment patches in place: same arrays, values on the nodes, not in the snapshot', async () => {
    const store = storeWithGraph();
    const put = vi.spyOn(api, 'putExplorationOverlay');
    const before = store.nodes;
    const version = store.nodePatchVersion;
    await store.setOverlayEnrichment(risk);
    expect(store.nodes).toStrictEqual(before);
    expect(store.nodePatchVersion).toBeGreaterThan(version);
    expect(store.nodes.map((n) => n.properties)).toEqual([{ risk: 'low', segment: 'retail' }, { risk: 'mid' }]);
    expect(store.baseGraph().nodes.map((n) => n.properties)).toEqual([{ risk: 'low' }, {}]);
    expect(store.overlayKeysFor('node', 'a')).toEqual(new Set(['segment']));
    expect(put).not.toHaveBeenCalled(); // no exploration yet: kept in memory

    await store.removeOverlayEnrichment('f1');
    expect(store.nodes.map((n) => n.properties)).toEqual([{ risk: 'low' }, {}]);
  });

  it('a sketch node is drawn with a ring, cannot be expanded and stays out of the snapshot', async () => {
    const store = storeWithGraph({});
    const put = vi.spyOn(api, 'putExplorationOverlay').mockImplementation(async (id) => ({ id, has_write_access: true, state: { has_overlay: true } }) as unknown as Exploration);
    const { id } = await store.addSketchNode({ type: 'Person', label: 'Ana', linkTo: 'a', edgeType: 'OWNS' });
    expect(id.startsWith('sketch:')).toBe(true);
    expect(store.nodes.map((n) => n.node_id)).toEqual(['a', 'b', id]);
    expect(store.edges.find((e) => e.src === id)?.relationship_type).toBe('OWNS');
    expect(store.overlayAddedNodeIds.has(id)).toBe(true);
    expect(store.nodeRings?.get(id)).toHaveLength(1);
    expect(store.nodeTypes).toContain('Person');
    expect(store.baseGraph().nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(put).toHaveBeenCalledWith('x1', expect.objectContaining({ nodes: [expect.objectContaining({ id })] }));

    await store.removeOverlayElements([id]);
    expect(store.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(store.edges.map((e) => e.edge_id)).toEqual(['e1']);
  });

  it('expand and background property loading keep the layer on', async () => {
    const store = storeWithGraph();
    await store.setOverlayEnrichment(risk);
    vi.spyOn(api, 'expandFromNode').mockResolvedValue({ nodes: [{ node_id: 'c', node_type: 'Account', properties: {} }], edges: [] } as never);
    await store.expandFromNode('a', 1);
    expect(store.nodes.find((n) => n.node_id === 'c')?.properties).toEqual({ risk: 'new' });
    expect(store.nodes.find((n) => n.node_id === 'a')?.properties).toEqual({ risk: 'low', segment: 'retail' });

    // Properties arriving late replace the dict: the layer's values come back on top.
    store.patchNodeProperties(new Map([['b', { name: 'Bob' }]]));
    expect(store.nodes.find((n) => n.node_id === 'b')?.properties).toEqual({ name: 'Bob', risk: 'mid' });
    expect(store.baseGraph().nodes.find((n) => n.node_id === 'b')?.properties).toEqual({ name: 'Bob' });
  });

  it('"save as property" wins over the layer for the same key and reaches the snapshot', async () => {
    const store = storeWithGraph({});
    vi.spyOn(api, 'putExplorationOverlay').mockResolvedValue({ id: 'x1', has_write_access: true, state: { has_overlay: true } } as never);
    await store.setOverlayEnrichment(risk);
    const update = vi.spyOn(api, 'updateExploration').mockResolvedValue({ id: 'x1', has_write_access: true, state: {} } as never);
    vi.spyOn(api, 'getInvestigations').mockResolvedValue([]);
    const metric = { id: 'm', name: 'segment', algorithmId: 'degree', target: 'node', values: new Map([['a', 3]]) } as unknown as ComputedMetric;
    await store.saveMetricAsProperty(metric);
    expect(store.nodes[0].properties).toEqual({ risk: 'low', segment: 3 });
    const snap = update.mock.calls[0][1].snapshot as { nodes: { properties: object }[] };
    expect(snap.nodes[0].properties).toEqual({ risk: 'low', segment: 3 });
  });

  it('saving a new exploration saves its layer after it exists, and says so when that fails', async () => {
    const store = storeWithGraph();
    await store.setOverlayEnrichment(risk);
    vi.spyOn(api, 'createExploration').mockResolvedValue({ id: 'new', title: 'T', has_write_access: true, state: {} } as never);
    const put = vi.spyOn(api, 'putExplorationOverlay').mockRejectedValueOnce(new Error('403 forbidden'));
    const r = await store.saveExploration('T');
    expect(r.success).toBe(true);
    expect(r.warning).toContain('without your data layer');
    expect(put).toHaveBeenCalledWith('new', expect.objectContaining({ enrichments: [expect.objectContaining({ id: 'f1' })] }));
    // The snapshot sent with the exploration is the context's graph.
    const created = vi.mocked(api.createExploration).mock.calls[0][1] as { snapshot: { nodes: { properties: object }[] } };
    expect(created.snapshot.nodes.map((n) => n.properties)).toEqual([{ risk: 'low' }, {}]);
  });

  it('loading an exploration with a layer draws it on the snapshot', async () => {
    const store = useGraphStore();
    vi.spyOn(api, 'getExploration').mockResolvedValue({
      id: 'x1', title: 'Pix', has_write_access: true,
      state: { has_snapshot: true, has_overlay: true, filters: { node_types: [], edge_types: [] }, viewport: { zoom: 1, center_x: 0, center_y: 0 } },
    } as never);
    vi.spyOn(api, 'getExplorationSnapshot').mockResolvedValue({
      nodes: [{ id: 'a', type: 'Account', properties: { risk: 'low' } }, { id: 'b', type: 'Account', properties: {} }], edges: [],
    } as never);
    const get = vi.spyOn(api, 'getExplorationOverlay').mockResolvedValue(layer({ nodes: [{ id: 'sketch:p', type: 'Person', properties: {} }] }));
    await store.loadExploration('x1');
    expect(get).toHaveBeenCalledWith('x1');
    expect(store.nodes.map((n) => [n.node_id, n.properties])).toEqual([
      ['a', { risk: 'low', segment: 'retail' }],
      ['b', { risk: 'mid' }],
      ['sketch:p', {}],
    ]);
  });

  it('takes entries that hold Vue proxies (a spec edited in a form)', async () => {
    const { reactive } = await import('vue');
    const store = storeWithGraph();
    const fromForm = reactive({ ...risk, spec: reactive({ ...risk.spec, columns: reactive(['risk']) }) });
    await expect(store.setOverlayEnrichment(fromForm as OverlayEnrichment)).resolves.toBeNull();
    expect(store.nodes[1].properties).toEqual({ risk: 'mid' });
  });

  it('a case canvas never carries an exploration layer', async () => {
    const store = storeWithGraph();
    await store.setOverlayEnrichment(risk);
    store.loadInvestigationGraph({ rings: new Map() } as never, graph().nodes, []);
    expect(store.overlay).toBeNull();
    expect(store.nodes[0].properties).toEqual({ risk: 'low' });
  });
});
