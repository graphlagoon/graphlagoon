import { describe, it, expect } from 'vitest';
import { planAfterQueryAnalysis } from '@/utils/afterQueryAnalysis';
import type { ClusterProgram } from '@/types/cluster';

const program = (id: string, parameters: ClusterProgram['parameters'] = []): ClusterProgram => ({
  program_id: id,
  program_name: `Program ${id}`,
  code: 'return []',
  parameters,
  created_at: '',
  updated_at: '',
});

const programs: Record<string, ClusterProgram> = {
  plain: program('plain'),
  needsSeed: program('needsSeed', [{ id: 'seed', type: 'text', required: true }]),
  seeded: program('seeded', [{ id: 'k', type: 'number', required: true, default: 3 }]),
};
const get = (id: string) => programs[id];
const off = { afterQueryCommunities: '', afterQueryClusterProgram: '' };

describe('planAfterQueryAnalysis', () => {
  it('plans nothing when both are off', () => {
    expect(planAfterQueryAnalysis(off, get)).toEqual({ problems: [] });
  });

  it('runs a built-in community algorithm and a cluster program with its defaults', () => {
    const plan = planAfterQueryAnalysis(
      { afterQueryCommunities: 'louvain', afterQueryClusterProgram: 'seeded' },
      get,
    );
    expect(plan.community).toBe('louvain');
    expect(plan.clusterProgram).toEqual({ id: 'seeded', params: { k: 3 } });
    expect(plan.problems).toEqual([]);
  });

  it('accepts a cluster program as the community algorithm', () => {
    expect(
      planAfterQueryAnalysis({ ...off, afterQueryCommunities: 'cluster-program:plain' }, get).community,
    ).toBe('cluster-program:plain');
  });

  it('a program used as communities may take values the user already filled', () => {
    const plan = planAfterQueryAnalysis(
      { ...off, afterQueryCommunities: 'cluster-program:needsSeed' },
      get,
      { needsSeed: { seed: 'n1' } },
    );
    expect(plan.community).toBe('cluster-program:needsSeed');
  });

  it('skips with a reason: unknown algorithm, missing program, required value without default', () => {
    const plan = planAfterQueryAnalysis(
      { afterQueryCommunities: 'leiden', afterQueryClusterProgram: 'needsSeed' },
      get,
    );
    expect(plan.community).toBeUndefined();
    expect(plan.clusterProgram).toBeUndefined();
    expect(plan.problems).toHaveLength(2);
    expect(plan.problems.join(' ')).toMatch(/leiden.*seed/);

    const missing = planAfterQueryAnalysis({ ...off, afterQueryClusterProgram: 'gone' }, get);
    expect(missing.problems[0]).toContain('“gone” does not exist');
  });
});
