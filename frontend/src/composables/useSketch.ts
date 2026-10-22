/**
 * Drawing nodes and edges by hand (BYOD-2), on whatever canvas is open:
 *
 * - an exploration: they go to its user layer (graph store `addSketchNode`/`addSketchEdge`),
 *   saved beside the exploration, never in the context;
 * - a case: they go to the case's `graph/sketch` item ("Manual additions"), one per case,
 *   a new version per change. Its ids are the case's unified ids; a node already on the
 *   canvas is written as a stub (id and type, no properties) so an edge can reach it.
 *
 * The dialog state is module-level: the context menu opens it, `SketchDialog` renders it.
 */
import { computed, ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useInvestigationStore } from '@/stores/investigation';
import { usePermissions } from '@/composables/usePermissions';
import { newOverlayId, SKETCH_PREFIX } from '@/utils/graphOverlay';
import type { CaseItem } from '@/types/investigation';

export const SKETCH_ITEM_TITLE = 'Manual additions';

/** `graph/sketch` content: unified ids. */
export interface SketchContent {
  unified: true;
  nodes: { id: string; type: string; properties: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; type: string; properties: Record<string, unknown> }[];
}

export type SketchDialogMode = 'node' | 'edge';

const dialog = ref<{ mode: SketchDialogMode; linkTo: string | null; source: string | null; target: string | null } | null>(null);
/** Whether the drawing dialog is open; readable without Pinia (the menu mounts the dialog on it). */
export const sketchDialogOpen = computed(() => dialog.value !== null);

/** The case's sketch item, if it has one. */
export function sketchItemOf(items: CaseItem[]): CaseItem | null {
  return items.find((i) => i.kind === 'graph' && i.subkind === 'sketch' && !i.deleted_at && i.status !== 'rejected') ?? null;
}

export function useSketch() {
  const graph = useGraphStore();
  const { can } = usePermissions();

  /** A case is open on the canvas (its sketch item is the target). */
  const inCase = computed(() => !!graph.investigationMode);

  function caseStore() {
    try {
      const store = useInvestigationStore();
      return store.current ? store : null;
    } catch {
      return null;
    }
  }

  const canSketch = computed(() => {
    if (inCase.value) {
      const current = caseStore()?.current;
      return !!current?.has_write_access && current.status !== 'closed';
    }
    return graph.canEditOverlay && can('exploration.edit_graph');
  });

  /** Nodes the person drew (or added from a file) — the only ones "Remove" applies to. */
  function isOwnNode(id: string): boolean {
    if (inCase.value) return id.startsWith(SKETCH_PREFIX);
    return graph.overlayAddedNodeIds.has(id) || !!graph.overlay?.nodes.some((n) => n.id === id);
  }

  function isOwnEdge(id: string): boolean {
    if (inCase.value) return graph.edges.some((e) => e.edge_id === id && e.edge_id.includes(`:${SKETCH_PREFIX}`));
    return graph.overlayAddedEdgeIds.has(id);
  }

  // --- the case's sketch item ---------------------------------------------------

  async function caseContent(): Promise<{ item: CaseItem | null; content: SketchContent }> {
    const store = caseStore()!;
    const item = sketchItemOf(store.items);
    const stored = item ? await store.loadItemJson<SketchContent>(item) : null;
    return { item, content: stored ?? { unified: true, nodes: [], edges: [] } };
  }

  /** A node of the canvas as a stub of the sketch, so an edge can reach it. */
  function withStub(content: SketchContent, id: string) {
    if (content.nodes.some((n) => n.id === id)) return;
    const node = graph.nodes.find((n) => n.node_id === id);
    content.nodes.push({ id, type: node?.node_type ?? 'Entity', properties: {} });
  }

  async function saveCase(item: CaseItem | null, content: SketchContent) {
    const store = caseStore()!;
    if (item) {
      await store.addVersion(item.id, { content_json: content });
    } else {
      const created = await store.addItem({ kind: 'graph', subkind: 'sketch', title: SKETCH_ITEM_TITLE, content_json: content });
      // Drawn over the graphs on the canvas: its stubs are their nodes.
      if (created) void store.toggleCanvas(created.id, true);
    }
    // The case view reloads its canvas when a graph item gets a new version.
  }

  // --- actions ----------------------------------------------------------------

  async function addNode(input: {
    type: string;
    label?: string;
    properties?: Record<string, unknown>;
    linkTo?: string | null;
    edgeType?: string;
    incoming?: boolean;
  }): Promise<string | null> {
    if (!inCase.value) {
      const { error } = await graph.addSketchNode({ ...input, linkTo: input.linkTo ?? undefined });
      return error;
    }
    const { item, content } = await caseContent();
    const id = `${SKETCH_PREFIX}${newOverlayId()}`;
    content.nodes.push({ id, type: input.type, properties: { ...(input.properties ?? {}), ...(input.label ? { label: input.label } : {}) } });
    if (input.linkTo) {
      withStub(content, input.linkTo);
      const [source, target] = input.incoming ? [input.linkTo, id] : [id, input.linkTo];
      content.edges.push({ id: `${SKETCH_PREFIX}${newOverlayId()}`, source, target, type: input.edgeType || 'related', properties: {} });
    }
    await saveCase(item, content);
    return null;
  }

  async function addEdge(source: string, target: string, type: string): Promise<string | null> {
    if (!inCase.value) return graph.addSketchEdge(source, target, type);
    const { item, content } = await caseContent();
    withStub(content, source);
    withStub(content, target);
    content.edges.push({ id: `${SKETCH_PREFIX}${newOverlayId()}`, source, target, type: type || 'related', properties: {} });
    await saveCase(item, content);
    return null;
  }

  /** Removes drawn nodes (and the edges touching them) and drawn edges. */
  async function remove(nodeIds: string[], edgeIds: string[] = []): Promise<string | null> {
    if (!inCase.value) return graph.removeOverlayElements(nodeIds, edgeIds);
    const { item, content } = await caseContent();
    if (!item) return null;
    const nodesGone = new Set(nodeIds);
    // Case edge ids are `<itemId>:<edgeId>`.
    const edgesGone = new Set(edgeIds.map((e) => e.slice(e.indexOf(':') + 1)));
    content.edges = content.edges.filter((e) => !edgesGone.has(e.id) && !nodesGone.has(e.source) && !nodesGone.has(e.target));
    const used = new Set(content.edges.flatMap((e) => [e.source, e.target]));
    // Stubs no edge needs any more go too: they only exist to carry an edge.
    content.nodes = content.nodes.filter((n) => !nodesGone.has(n.id) && (n.id.startsWith(SKETCH_PREFIX) || used.has(n.id)));
    await saveCase(item, content);
    return null;
  }

  // --- dialog -----------------------------------------------------------------

  function openNodeDialog(linkTo: string | null = null) {
    dialog.value = { mode: 'node', linkTo, source: null, target: null };
  }

  function openEdgeDialog(source: string, target: string) {
    dialog.value = { mode: 'edge', linkTo: null, source, target };
  }

  function closeDialog() {
    dialog.value = null;
  }

  return { inCase, canSketch, isOwnNode, isOwnEdge, addNode, addEdge, remove, dialog, openNodeDialog, openEdgeDialog, closeDialog };
}
