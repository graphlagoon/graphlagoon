/** Communities and cluster programs run on what the user has not hidden. */
import { describe, it, expect, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useGraphStore } from '@/stores/graph';
import { useClusterStore } from '@/stores/cluster';
import { useCommunityStore } from '@/stores/community';
import { useMetricsStore } from '@/stores/metrics';
import { useSimilarityStore } from '@/stores/similarity';
import { serializeGraphForCustomMetrics } from '@/services/customMetricRunner';
import { useGroupRows } from '@/composables/useGroupRows';
import { createNode } from '@/__tests__/fixtures/nodes';
import { createEdge } from '@/__tests__/fixtures/edges';

beforeEach(async () => {
  setActivePinia(createPinia());
  const g = useGraphStore();
  useCommunityStore();
  useClusterStore();
  g.nodes = [
    createNode({ node_id: 'p1', node_type: 'Person' }),
    createNode({ node_id: 'p2', node_type: 'Person' }),
    createNode({ node_id: 'p3', node_type: 'Person' }),
    createNode({ node_id: 'c1', node_type: 'Company' }),
  ];
  g.edges = [
    createEdge({ edge_id: 'e1', src: 'p1', dst: 'c1', relationship_type: 'OWNS' }),
    createEdge({ edge_id: 'e2', src: 'c1', dst: 'p2', relationship_type: 'OWNS' }),
    createEdge({ edge_id: 'e3', src: 'p2', dst: 'p3', relationship_type: 'KNOWS' }),
  ];
  await nextTick();
});

const ids = () => useGraphStore().visibleNodes.map((n) => n.node_id);
const edgeIds = () => useGraphStore().visibleEdges.map((e) => e.edge_id);

describe('visible graph', () => {
  it('is the whole graph, not a copy, when nothing is hidden', () => {
    const g = useGraphStore();
    expect(g.visibleNodes).toBe(g.filteredNodes);
    expect(g.visibleEdges).toEqual(g.filteredEdges);
  });

  it('honours types, case chips, the Data Table and "show only"', () => {
    const g = useGraphStore();
    g.applyFilters({ node_types: ['Person'] });
    expect(ids()).toEqual(['p1', 'p2', 'p3']);
    expect(edgeIds()).toEqual(['e3']);
    g.caseHiddenNodeIds = new Set(['p1']);
    expect(ids()).toEqual(['p2', 'p3']);
    g.setTableFilteredIds(new Set(['p2', 'p3']), new Set());
    expect(edgeIds()).toEqual([]);
    g.setTableFilteredIds(null, null);
    g.isolate({ kind: 'value', field: 'node_id', value: 'p3', mode: 'same', label: 'p3' });
    expect(ids()).toEqual(['p3']);
    expect(g.nodesInFilters.map((n) => n.node_id)).toEqual(['p2', 'p3']);
  });
});

describe('what runs on it', () => {
  it('components split when the node joining them is hidden', async () => {
    const g = useGraphStore();
    const community = useCommunityStore();
    community.algorithm = 'weak-components';
    await community.runDetection();
    expect(community.communityCount).toBe(1);
    g.caseHiddenNodeIds = new Set(['c1']);
    await community.runDetection();
    expect(community.communityCount).toBe(2);
    expect(community.communityMap.has('c1')).toBe(false);
  });

  it('a re-run under "show only this community" keeps what is on screen', async () => {
    const g = useGraphStore();
    const community = useCommunityStore();
    community.algorithm = 'weak-components';
    g.applyFilters({ edge_types: ['KNOWS'] });
    await community.runDetection(); // {p2,p3} {p1} {c1}
    const solo = community.communityMap.get('p1')!;
    g.isolate({ kind: 'community', ids: [solo], label: 'x' });
    await community.runDetection();
    expect([...community.communityMap.keys()]).toEqual(['p1']);
    expect(ids()).toEqual(['p1']);
  });

  it('a cluster program sees only visible nodes, edges and selection', async () => {
    const g = useGraphStore();
    const clusters = useClusterStore();
    g.selectNode('c1');
    g.applyFilters({ node_types: ['Person'] });
    const program = clusters.createProgram({
      program_name: 'all',
      code: `return [{ cluster_name: nodes.length + '/' + edges.length + '/' + selectedNodeIds.length, node_ids: nodes.map(n => n.node_id) }]`,
    } as never);
    const result = await clusters.computeClustersFromProgram(program.program_id);
    expect(result.clusters?.[0].cluster_name).toBe('3/1/0');
  });

  it('re-running a program under "show only" its cluster shows the new clusters', async () => {
    const g = useGraphStore();
    const clusters = useClusterStore();
    const program = clusters.createProgram({
      program_name: 'one', code: `return [{ cluster_name: 'x', state: 'open', node_ids: nodes.filter(n => n.node_type === 'Person').map(n => n.node_id) }]`,
    } as never);
    await clusters.executeProgram(program.program_id);
    g.isolate({ kind: 'cluster', ids: [clusters.clusters[0].cluster_id], label: 'x' });
    await clusters.executeProgram(program.program_id);
    expect(ids()).toEqual(['p1', 'p2', 'p3']);
    expect(g.isolation).toMatchObject({ kind: 'cluster', ids: [clusters.clusters[0].cluster_id] });
  });

  it('algorithm metrics and similarity keys use the visible graph; custom metrics leave "show only" out', () => {
    const g = useGraphStore();
    g.isolate({ kind: 'value', field: 'node_type', value: 'Person', mode: 'same', label: 'P' });
    expect(useMetricsStore().graphInfo).toMatchObject({ nodeCount: 3, edgeCount: 1 });
    expect(useSimilarityStore().extractKeys().total).toBe(3);
    expect(serializeGraphForCustomMetrics().nodes).toHaveLength(4);
  });

  it('everything hidden is an error, not an empty result', async () => {
    const g = useGraphStore();
    g.caseHiddenNodeIds = new Set(['p1', 'p2', 'p3', 'c1']);
    const community = useCommunityStore();
    await community.runDetection();
    expect(community.error).toContain('hide every node');
  });

  it('group counts follow the filters, not "show only"', async () => {
    const g = useGraphStore();
    const community = useCommunityStore();
    community.algorithm = 'weak-components';
    await community.runDetection();
    const rows = useGroupRows();
    g.applyFilters({ node_types: ['Person'] });
    expect(rows.communityRows.value[0]).toMatchObject({ count: 3, total: 4 });
    g.isolate({ kind: 'value', field: 'node_id', value: 'p3', mode: 'same', label: 'p3' });
    expect(rows.communityRows.value[0].count).toBe(3);
  });
});
