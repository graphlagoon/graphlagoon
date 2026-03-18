declare module 'graphology-communities-louvain' {
  import Graph from 'graphology';

  interface LouvainOptions {
    resolution?: number;
    randomWalk?: boolean;
    weighted?: boolean;
    getEdgeWeight?: string | ((edge: string) => number);
  }

  interface LouvainDetailedResult {
    communities: Record<string, number>;
    count: number;
    modularity: number;
  }

  function louvain(graph: Graph, options?: LouvainOptions): Record<string, number>;

  namespace louvain {
    function detailed(graph: Graph, options?: LouvainOptions): LouvainDetailedResult;
    function assign(graph: Graph, options?: LouvainOptions): void;
  }

  export default louvain;
}
