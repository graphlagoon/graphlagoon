import type { Cluster, ClusterProgram } from '@/types/cluster'

export function createCluster(overrides: Partial<Cluster> = {}): Cluster {
  return {
    cluster_id: 'cluster-1',
    cluster_name: 'Test Cluster',
    cluster_class: 'default',
    figure: 'circle',
    state: 'closed',
    node_ids: ['node-1', 'node-2'],
    ...overrides,
  }
}

export function createClusterProgram(overrides: Partial<ClusterProgram> = {}): ClusterProgram {
  return {
    program_id: 'prog-1',
    program_name: 'Test Program',
    description: 'A test program',
    code: 'return []',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}
