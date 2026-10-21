import { ref } from 'vue';
import type { Component } from 'vue';
import { useToast } from '@/composables/useToast';
import { Briefcase, Copy } from 'lucide-vue-next';
import { useCurrentCaseStore } from '@/stores/currentCase';
import { useGraphStore } from '@/stores/graph';
import { useAddToCase } from '@/composables/useAddToCase';

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
      id: 'add-selection-to-case',
      label: 'Add selection to case',
      icon: Briefcase,
      visible: (t: ContextMenuTarget) => {
        if (t.type !== 'node') return false;
        try {
          return useCurrentCaseStore().hasCase;
        } catch {
          return false; // no pinia (unit tests of the menu alone)
        }
      },
      handler: async (t: ContextMenuTarget) => {
        const graph = useGraphStore();
        const nodeIds = new Set([...graph.selectedNodeIds, t.id]);
        await useAddToCase().addSelection(nodeIds, graph.selectedEdgeIds);
      },
    },
  ];
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
    return actions.value.filter(
      a => !a.visible || a.visible(target.value!),
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
