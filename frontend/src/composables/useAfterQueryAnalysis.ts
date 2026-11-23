/**
 * Runs the "After a query" behaviors (communities, a cluster program) each time
 * a query you ran loads — Query panel, template, context-menu action — and again after
 * an expand that brought nodes or edges, so they describe the graph on screen. A
 * restored exploration brings its own analysis state, so restores do not count
 * (`graphStore.queryRunSeq` only moves on a run, see QueryRunOptions.fromRestore).
 *
 * A program marked `wait_for_enrichment` waits for the context's enrichment of that
 * query: it runs once every enrichment finished without a failure, is skipped (the status
 * chip says so) when one failed, and runs then by itself if a Retry leaves everything green.
 */
import { nextTick, onScopeDispose, ref, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useCommunityStore } from '@/stores/community';
import { useClusterStore } from '@/stores/cluster';
import { useToast } from '@/composables/useToast';
import { planAfterQueryAnalysis, type AfterQueryPlan } from '@/utils/afterQueryAnalysis';
import { enrichmentSettled, enrichmentSucceeded } from '@/utils/enrichmentStatus';

/** Analyses of the last query held back until enrichment succeeds; the status chip lists them. */
export interface WaitingAnalysis {
  /** "Clusters “By risk”", "Communities “By risk”". */
  labels: string[];
  /** `running`: enrichment still in progress; `failed`: one failed, a Retry that succeeds releases them. */
  reason: 'running' | 'failed';
}

export const waitingOnEnrichment = ref<WaitingAnalysis | null>(null);

export function useAfterQueryAnalysis() {
  const graphStore = useGraphStore();
  const communityStore = useCommunityStore();
  const clusterStore = useClusterStore();
  const toast = useToast();

  /** Moves on each trigger (a query, an expand): a run or a hold of an older trigger is void. */
  let trigger = 0;

  /** The gated part of the current trigger's plan, until it runs or another trigger replaces it. */
  let held: { seq: number; epoch: number; plan: AfterQueryPlan } | null = null;

  function drop() {
    held = null;
    waitingOnEnrichment.value = null;
  }
  onScopeDispose(drop);

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

  async function execute(plan: AfterQueryPlan): Promise<string[]> {
    const problems: string[] = [];
    if (plan.community) {
      communityStore.algorithm = plan.community;
      await communityStore.runDetection();
      if (communityStore.error) problems.push(`Communities failed: ${communityStore.error}.`);
    }
    if (plan.clusterProgram) {
      const result = await clusterStore.executeProgram(plan.clusterProgram.id, plan.clusterProgram.params);
      if (!result.success) problems.push(`Clusters failed: ${result.error ?? 'unknown error'}.`);
    }
    return problems;
  }

  function heldLabels(plan: AfterQueryPlan): string[] {
    return [
      plan.community ? `Communities “${plan.communityName ?? plan.community}”` : '',
      plan.clusterProgram ? `Clusters “${plan.clusterProgram.name}”` : '',
    ].filter(Boolean);
  }

  /** Runs, keeps waiting, or reports the held analyses as the enrichment stands now. */
  async function release() {
    if (!held) return;
    // Another query, or another graph altogether (context, exploration, precomputed, clear):
    // what was held belonged to a graph that is gone.
    if (held.seq !== trigger || held.epoch !== graphStore.queryEnrichmentEpoch || graphStore.nodes.length === 0) {
      drop();
      return;
    }
    const runs = graphStore.queryEnrichmentRuns;
    const labels = heldLabels(held.plan);
    if (!enrichmentSettled(runs, graphStore.queryEnrichmentInFlight)) {
      waitingOnEnrichment.value = { labels, reason: 'running' };
      return;
    }
    if (!enrichmentSucceeded(runs)) {
      // No toast of its own: the store already says an enrichment failed, and the chip says what waits.
      waitingOnEnrichment.value = { labels, reason: 'failed' };
      return;
    }
    const { plan } = held;
    drop();
    const problems = await execute(plan);
    if (problems.length > 0) toast.warning(`After the query: ${problems.join(' ')}`, 6000);
  }

  async function run(seq: number) {
    drop();
    const behaviors = graphStore.behaviors;
    if (!behaviors.afterQueryCommunities && !behaviors.afterQueryClusterProgram) return;
    await settled();
    // The stores clear communities and clusters when nodes change; let those
    // watchers flush first, or they would wipe what runs below.
    await nextTick();
    if (seq !== trigger || graphStore.nodes.length === 0) return;

    const plan = planAfterQueryAnalysis(
      behaviors,
      (id) => clusterStore.getProgram(id),
      communityStore.programParams,
    );
    const now: AfterQueryPlan = { problems: [] };
    const later: AfterQueryPlan = { problems: [] };
    if (plan.community) Object.assign(plan.communityWaits ? later : now, { community: plan.community, communityName: plan.communityName });
    if (plan.clusterProgram) (plan.clusterProgram.waits ? later : now).clusterProgram = plan.clusterProgram;

    const problems = [...plan.problems, ...(await execute(now))];
    if (problems.length > 0) toast.warning(`After the query: ${problems.join(' ')}`, 6000);
    // A newer query may have landed while the part above ran: its own run() holds what it needs.
    if ((later.community || later.clusterProgram) && seq === trigger) {
      held = { seq, epoch: graphStore.queryEnrichmentEpoch, plan: later };
      await release();
    }
  }

  watch(
    () => [graphStore.queryRunSeq, graphStore.expandSeq] as const,
    () => void run(++trigger),
  );
  // Enrichment finishing (or a Retry) is what releases a held analysis.
  watch(
    () => [graphStore.queryEnrichmentRuns, graphStore.queryEnrichmentInFlight, graphStore.queryEnrichmentEpoch] as const,
    () => void release(),
  );
}
