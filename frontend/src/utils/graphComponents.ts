/**
 * Weakly and strongly connected components (investigations F3.7), for the metrics
 * worker (component id per node) and the community options. Ids are deterministic:
 * 0 is the largest component, ties by smallest node id; an isolated node is its own
 * component. Edges to nodes outside `nodes` are ignored.
 */
export type ComponentKind = 'weak' | 'strong';

export function connectedComponents(
  nodes: string[],
  edges: [src: string, dst: string][],
  kind: ComponentKind,
): Map<string, number> {
  const known = new Set(nodes);
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [s, d] of edges) {
    if (!known.has(s) || !known.has(d)) continue;
    adj.get(s)!.push(d);
    if (kind === 'weak') adj.get(d)!.push(s);
  }
  const groups = kind === 'weak' ? weak(nodes, adj) : tarjan(nodes, adj);
  const min = (g: string[]) => g.reduce((a, b) => (b < a ? b : a));
  groups.sort((a, b) => b.length - a.length || (min(a) < min(b) ? -1 : 1));
  const out = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((n) => out.set(n, i)));
  return out;
}

function weak(nodes: string[], adj: Map<string, string[]>): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const s of nodes) {
    if (seen.has(s)) continue;
    seen.add(s);
    const group = [s];
    for (let i = 0; i < group.length; i++) {
      for (const w of adj.get(group[i])!) {
        if (!seen.has(w)) {
          seen.add(w);
          group.push(w);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Tarjan's strongly connected components, iterative (deep graphs would overflow the call stack). */
function tarjan(nodes: string[], adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let next = 0;
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
  };
  for (const s of nodes) {
    if (index.has(s)) continue;
    visit(s);
    const work: [string, number][] = [[s, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      const out = adj.get(v)!;
      if (top[1] < out.length) {
        const w = out[top[1]++];
        if (!index.has(w)) {
          visit(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        const group: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          group.push(w);
        } while (w !== v);
        groups.push(group);
      }
    }
  }
  return groups;
}
