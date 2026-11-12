import { ref } from 'vue';
import type { Component } from 'vue';
import { useToast } from '@/composables/useToast';
import { Briefcase, CirclePlus, Copy, Eraser, Spline, Trash2 } from 'lucide-vue-next';
import { useCurrentCaseStore } from '@/stores/currentCase';
import { useGraphStore } from '@/stores/graph';
import { useAddToCase } from '@/composables/useAddToCase';
import { useSketch } from '@/composables/useSketch';

export type ContextMenuTargetType = 'node' | 'edge';

export interface ContextMenuTarget {
  type: ContextMenuTargetType;
  id: string;
  label: string;
}

export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: Component | string;
  handler: (target: ContextMenuTarget) => void | Promise<void>;
  visible?: (target: ContextMenuTarget) => boolean;
  disabled?: (target: ContextMenuTarget) => boolean;
}

// Module-level singleton state (shared across all useContextMenu() calls)
const visible = ref(false);
const x = ref(0);
const y = ref(0);
const target = ref<ContextMenuTarget | null>(null);

function createBuiltInActions(): ContextMenuAction[] {
  const { success, error } = useToast();

  return [
    {
      id: 'copy-id',
      label: 'Copy ID',
      icon: Copy,
      handler: async (t: ContextMenuTarget) => {
        try {
          await navigator.clipboard.writeText(t.id);
          success(`Copied ${t.type} ID`);
        } catch {
          error('Failed to copy to clipboard');
        }
      },
    },
    {
      // The selection (plus the clicked node) as a graph/selection item of the current case (05 §4).
      // Always offered on a node: hidden without a current case, nobody found the way in.
      // With none picked it opens the top-bar picker instead.
      id: 'add-selection-to-case',
      label: 'Add selection to case',
      icon: Briefcase,
      visible: (t: ContextMenuTarget) => t.type === 'node',
      handler: async (t: ContextMenuTarget) => {
        const current = useCurrentCaseStore();
        if (!current.hasCase) {
          current.requestPick();
          useToast().info('Pick the case in the top bar, then add the selection again.');
          return;
        }
        const graph = useGraphStore();
        const nodeIds = new Set([...graph.selectedNodeIds, t.id]);
        await useAddToCase().addSelection(nodeIds, graph.selectedEdgeIds);
      },
    },
    // Drawing by hand (BYOD-2): into the exploration's layer or the case's "Manual additions".
    {
      id: 'sketch-add-linked-node',
      label: 'Add a linked node…',
      icon: CirclePlus,
      visible: (t: ContextMenuTarget) => t.type === 'node' && sketchAllowed(),
      handler: (t: ContextMenuTarget) => useSketch().openNodeDialog(t.id),
    },
    {
      id: 'sketch-connect',
      label: 'Connect to the selected node…',
      icon: Spline,
      visible: (t: ContextMenuTarget) => t.type === 'node' && sketchAllowed() && otherSelected(t) !== null,
      handler: (t: ContextMenuTarget) => useSketch().openEdgeDialog(otherSelected(t)!, t.id),
    },
    {
      id: 'sketch-remove',
      label: 'Remove from your data',
      icon: Eraser,
      visible: (t: ContextMenuTarget) => {
        if (!sketchAllowed()) return false;
        const sketch = useSketch();
        return t.type === 'node' ? sketch.isOwnNode(t.id) : sketch.isOwnEdge(t.id);
      },
      handler: async (t: ContextMenuTarget) => {
        const failed = await (t.type === 'node' ? useSketch().remove([t.id]) : useSketch().remove([], [t.id]));
        if (failed) error(`Removed here, but not saved: ${failed}`);
      },
    },
    {
      // Off the canvas: the clicked node or edge, or the whole selection when it is part of it.
      // Undo puts it back; saving the exploration makes it stick. A case's canvas has its own
      // items, and the layer's own elements already have "Remove from your data".
      id: 'delete-from-graph',
      label: 'Delete from graph',
      icon: Trash2,
      visible: (t: ContextMenuTarget) => {
        let graph;
        try {
          graph = useGraphStore();
        } catch {
          return false; // no pinia (unit tests of the menu alone)
        }
        if (graph.investigationMode) return false;
        const own = t.type === 'node' ? graph.overlayAddedNodeIds : graph.overlayAddedEdgeIds;
        return !own.has(t.id);
      },
      handler: async (t: ContextMenuTarget) => {
        const graph = useGraphStore();
        const selected = t.type === 'node' ? graph.selectedNodeIds : graph.selectedEdgeIds;
        const [nodeIds, edgeIds] = selected.has(t.id)
          ? [[...graph.selectedNodeIds], [...graph.selectedEdgeIds]]
          : t.type === 'node' ? [[t.id], []] : [[], [t.id]];
        const result = await graph.deleteFromGraph(nodeIds, edgeIds);
        if (result.error) error(`Deleted here, but your data layer was not saved: ${result.error}`);
        const what = deletedSummary(result.removedNodes, result.removedEdges);
        if (result.undo) useToast().undoable(`Deleted ${what}.`, result.undo);
        else success(`Deleted ${what}.`);
      },
    },
  ];
}

function deletedSummary(nodes: number, edges: number): string {
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [nodes ? part(nodes, 'node') : '', edges ? part(edges, 'edge') : ''].filter(Boolean).join(' and ');
}

/** Built-in items the person hid (Behaviors → Context Menu); none without pinia. */
function hiddenMenuActions(): string[] {
  try {
    return useGraphStore().behaviors.hiddenMenuActions;
  } catch {
    return []; // no pinia (unit tests of the menu alone)
  }
}

/** Whether drawing applies here (a writable exploration or case); false without pinia. */
function sketchAllowed(): boolean {
  try {
    return useSketch().canSketch.value;
  } catch {
    return false; // no pinia (unit tests of the menu alone)
  }
}

/** The one other selected node, when exactly one is selected besides `t` (an edge to draw). */
function otherSelected(t: ContextMenuTarget): string | null {
  const others = [...useGraphStore().selectedNodeIds].filter((id) => id !== t.id);
  return others.length === 1 ? others[0] : null;
}

const actions = ref<ContextMenuAction[]>(createBuiltInActions());

export function useContextMenu() {
  function show(event: MouseEvent, menuTarget: ContextMenuTarget) {
    event.preventDefault();
    event.stopPropagation();

    target.value = menuTarget;
    x.value = event.clientX;
    y.value = event.clientY;
    visible.value = true;
  }

  function hide() {
    visible.value = false;
    target.value = null;
  }

  /** Reset actions to built-in defaults (useful for tests) */
  function resetActions() {
    actions.value = createBuiltInActions();
  }

  function addAction(action: ContextMenuAction) {
    actions.value.push(action);
  }

  function removeAction(actionId: string) {
    actions.value = actions.value.filter(a => a.id !== actionId);
  }

  function getVisibleActions(): ContextMenuAction[] {
    if (!target.value) return [];
    const hidden = new Set(hiddenMenuActions());
    return actions.value.filter(
      a => !hidden.has(a.id) && (!a.visible || a.visible(target.value!)),
    );
  }

  return {
    visible,
    x,
    y,
    target,
    actions,
    show,
    hide,
    addAction,
    removeAction,
    resetActions,
    getVisibleActions,
  };
}
