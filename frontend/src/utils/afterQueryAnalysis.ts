/**
 * The "After a query" behaviors — community detection and/or a cluster
 * program run automatically once a query you ran has loaded.
 *
 * Pure planning: which of the two to run and with which values, or why not.
 * The behaviors are free strings (they travel in context defaults, presets and
 * explorations, written by people and by agents), so every value is checked
 * here against what this build and this context actually have.
 */
import type { ClusterProgram, ClusterProgramParamValues, CommunityAlgorithm } from '@/types/cluster';
import { defaultParamValues, missingRequiredParams } from '@/utils/clusterProgramParams';

export const BUILT_IN_COMMUNITY_ALGORITHMS = ['louvain', 'weak-components', 'strong-components'] as const;
const PROGRAM_PREFIX = 'cluster-program:';

export interface AfterQueryPlan {
  community?: CommunityAlgorithm;
  clusterProgram?: { id: string; params: ClusterProgramParamValues };
  /** One sentence per setting that was skipped. */
  problems: string[];
}

function programProblem(
  program: ClusterProgram | undefined,
  id: string,
  values: ClusterProgramParamValues,
): string | null {
  if (!program) return `the cluster program “${id}” does not exist in this context`;
  const missing = missingRequiredParams(program.parameters, values);
  if (missing.length > 0) {
    return `“${program.program_name}” needs ${missing.map((p) => p.id).join(', ')} and has no default`;
  }
  return null;
}

export function planAfterQueryAnalysis(
  behaviors: { afterQueryCommunities: string; afterQueryClusterProgram: string },
  getProgram: (id: string) => ClusterProgram | undefined,
  /** Values the user already filled for a program run as communities, by program id. */
  communityProgramParams: Record<string, ClusterProgramParamValues> = {},
): AfterQueryPlan {
  const plan: AfterQueryPlan = { problems: [] };
  const algorithm = behaviors.afterQueryCommunities.trim();
  const programId = behaviors.afterQueryClusterProgram.trim();

  if ((BUILT_IN_COMMUNITY_ALGORITHMS as readonly string[]).includes(algorithm)) {
    plan.community = algorithm as CommunityAlgorithm;
  } else if (algorithm.startsWith(PROGRAM_PREFIX)) {
    const id = algorithm.slice(PROGRAM_PREFIX.length);
    const program = getProgram(id);
    const values = { ...defaultParamValues(program?.parameters), ...communityProgramParams[id] };
    const problem = programProblem(program, id, values);
    if (problem) plan.problems.push(`Communities skipped: ${problem}.`);
    else plan.community = algorithm as CommunityAlgorithm;
  } else if (algorithm) {
    plan.problems.push(`Communities skipped: “${algorithm}” is not a community algorithm.`);
  }

  if (programId) {
    const program = getProgram(programId);
    const params = defaultParamValues(program?.parameters);
    const problem = programProblem(program, programId, params);
    if (problem) plan.problems.push(`Clusters skipped: ${problem}.`);
    else plan.clusterProgram = { id: programId, params };
  }
  return plan;
}
