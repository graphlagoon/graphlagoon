import { shallowRef } from 'vue';
import type { ClusterProgram, ClusterProgramParamValues } from '@/types/cluster';

/**
 * A request to show the run dialog of a cluster program, raised where no
 * component can mount one (the right-click menu, a composable). The page's
 * `ClusterProgramRunHost` renders `ClusterProgramRunModal` for it.
 */
export interface ClusterProgramRunRequest {
  program: ClusterProgram;
  mode: 'clusters' | 'community';
  initialValues?: ClusterProgramParamValues;
}

const pendingRunRequest = shallowRef<ClusterProgramRunRequest | null>(null);

export function useClusterProgramRunRequest() {
  return {
    pendingRunRequest,
    requestRun(request: ClusterProgramRunRequest) {
      pendingRunRequest.value = request;
    },
    clearRunRequest() {
      pendingRunRequest.value = null;
    },
  };
}
