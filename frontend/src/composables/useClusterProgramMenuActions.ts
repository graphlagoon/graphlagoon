import { ref, computed, watch } from 'vue';
import { Network } from 'lucide-vue-next';
import { useContextMenu } from './useContextMenu';
import { useToast } from './useToast';
import { useClusterStore } from '@/stores/cluster';
import { useCommunityStore } from '@/stores/community';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import {
  defaultParamValues,
  resolveNodeBoundValues,
} from '@/utils/clusterProgramParams';

export const CLUSTER_PROGRAM_ACTION_PREFIX = 'cluster-program-action:';

/**
 * Node context-menu actions for cluster programs flagged with
 * `show_in_context_menu`.
 *
 * Each flagged program becomes a menu item (labeled with the program name)
 * that runs the program as a COMMUNITY algorithm on the right-clicked node:
 * parameter defaults, overridden by node-bound parameters (`node_binding` =
 * node_id / node_type / prop:<name> / metric:<ref>) resolved from the clicked node. Feedback
 * is toast-only; the graph recolors through existing community reactivity.
 *
 * The owning component (GraphVisualizationView) calls register()/unregister()
 * in its mount/unmount hooks. The action list reconciles automatically when
 * programs are created/deleted/renamed/toggled or replaced by an exploration
 * load.
 */
export function useClusterProgramMenuActions() {
  const contextMenu = useContextMenu();
  const clusterStore = useClusterStore();
  const communityStore = useCommunityStore();
  const graphStore = useGraphStore();
  const metricsStore = useMetricsStore();
  const { success, error } = useToast();

  const registered = ref(false);
  let registeredIds: string[] = [];

  const eligible = computed(() =>
    clusterStore.programs
      .filter(p => p.show_in_context_menu)
      .map(p => ({ id: p.program_id, name: p.program_name }))
  );

  /** Drop all our actions and re-add from the current eligible list. */
  function reconcile() {
    for (const actionId of registeredIds) {
      contextMenu.removeAction(actionId);
    }
    registeredIds = [];
    if (!registered.value) return;

    for (const { id, name } of eligible.value) {
      const actionId = CLUSTER_PROGRAM_ACTION_PREFIX + id;
      contextMenu.addAction({
        id: actionId,
        label: name,
        icon: Network,
        // Real graph nodes only — cluster synthetic nodes are not in graphStore.nodes
        visible: (t) => t.type === 'node' && graphStore.nodes.some(n => n.node_id === t.id),
        disabled: () => communityStore.computing,
        handler: (t) => runProgramForNode(id, t.id),
      });
      registeredIds.push(actionId);
    }
  }

  watch(eligible, reconcile, { deep: true });

  async function runProgramForNode(programId: string, nodeId: string): Promise<void> {
    const program = clusterStore.getProgram(programId);
    if (!program) {
      error('Cluster program no longer exists');
      return;
    }

    const node = graphStore.nodes.find(n => n.node_id === nodeId);
    if (!node) {
      error(`Node "${nodeId}" not found in the current graph`);
      return;
    }

    const { values, missing } = resolveNodeBoundValues(
      program.parameters,
      node,
      (ref, id) => metricsStore.metricResolver('node', id, ref),
    );
    if (missing.length > 0) {
      const what = missing
        .map(m => {
          if (m.binding.startsWith('prop:')) {
            return `property "${m.binding.slice('prop:'.length)}" (for ${m.paramId})`;
          }
          if (m.binding.startsWith('metric:')) {
            return `metric "${m.binding.slice('metric:'.length)}" (for ${m.paramId}; compute it in the Metrics panel)`;
          }
          return `${m.binding} (for ${m.paramId})`;
        })
        .join(', ');
      error(`Cannot run "${program.program_name}": node is missing ${what}`);
      return;
    }

    // Defaults + node-bound values, replacing any panel-edited values so the
    // Communities tab shows exactly what this run used.
    communityStore.programParams[programId] = {
      ...defaultParamValues(program.parameters),
      ...values,
    };
    communityStore.algorithm = `cluster-program:${programId}`;
    await communityStore.runDetection();

    if (communityStore.error) {
      error(communityStore.error);
      return;
    }

    const labels = communityStore.communitiesSorted.map(c => c.label);
    const shown = labels.slice(0, 4).join(', ') + (labels.length > 4 ? ', …' : '');
    success(`${communityStore.communityCount} communities: ${shown}`);
  }

  function register() {
    registered.value = true;
    reconcile();
  }

  function unregister() {
    registered.value = false;
    reconcile();
  }

  return { register, unregister, runProgramForNode };
}
