/**
 * Runs the "After a query" behaviors (communities, a cluster program) each time
 * a query you ran loads — Query panel, template, context-menu action. A restored
 * exploration brings its own analysis state, so restores do not count
 * (`graphStore.queryRunSeq` only moves on a run, see QueryRunOptions.fromRestore).
 */
import { nextTick, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';
import { useClusterStore } from '@/stores/cluster';
import { useToast } from '@/composables/useToast';
import { planAfterQueryAnalysis } from '@/utils/afterQueryAnalysis';

export function useAfterQueryAnalysis() {
  const graphStore = useGraphStore();
  const communityStore = useCommunityStore();
  const clusterStore = useClusterStore();
  const toast = useToast();

  /** Resolve once the graph and its progressive properties have landed. */
  function settled(): Promise<void> {
    if (!graphStore.loading && !graphStore.enriching) return Promise.resolve();
    return new Promise((resolve) => {
      const stop = watch(
        () => graphStore.loading || graphStore.enriching,
        (busy) => {
          if (busy) return;
          stop();
          resolve();
        },
      );
    });
  }

  async function run(seq: number) {
    const behaviors = graphStore.behaviors;
    if (!behaviors.afterQueryCommunities && !behaviors.afterQueryClusterProgram) return;
    await settled();
    // The stores clear communities and clusters when nodes change; let those
    // watchers flush first, or they would wipe what runs below.
    await nextTick();
    if (seq !== graphStore.queryRunSeq || graphStore.nodes.length === 0) return;

    const plan = planAfterQueryAnalysis(
      behaviors,
      (id) => clusterStore.getProgram(id),
      communityStore.programParams,
    );
    const problems = [...plan.problems];

    if (plan.community) {
      communityStore.algorithm = plan.community;
      await communityStore.runDetection();
      if (communityStore.error) problems.push(`Communities failed: ${communityStore.error}.`);
    }
    if (plan.clusterProgram) {
      const result = await clusterStore.executeProgram(plan.clusterProgram.id, plan.clusterProgram.params);
      if (!result.success) problems.push(`Clusters failed: ${result.error ?? 'unknown error'}.`);
    }
    if (problems.length > 0) toast.warning(`After the query: ${problems.join(' ')}`, 6000);
  }

  watch(() => graphStore.queryRunSeq, (seq) => void run(seq));
}
