/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Asset imports
declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.json' {
  const value: unknown;
  export default value;
}

// Local d3-force-3d (aliased from ext-3d-force)
declare module 'd3-force-3d' {
  export interface ForceNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface ForceCollide<N extends ForceNode = ForceNode> {
    (alpha: number): void;
    initialize(nodes: N[], random: () => number, nDim: number): void;
    radius(): number | ((node: N, i: number, nodes: N[]) => number);
    radius(radius: number | ((node: N, i: number, nodes: N[]) => number)): ForceCollide<N>;
    strength(): number;
    strength(strength: number): ForceCollide<N>;
    iterations(): number;
    iterations(iterations: number): ForceCollide<N>;
  }

  export function forceCollide<N extends ForceNode = ForceNode>(radius?: number | ((node: N, i: number, nodes: N[]) => number)): ForceCollide<N>;
  export function forceCenter<N extends ForceNode = ForceNode>(x?: number, y?: number, z?: number): unknown;
  export function forceLink<N extends ForceNode = ForceNode>(links?: unknown[]): unknown;
  export function forceManyBody<N extends ForceNode = ForceNode>(): unknown;
  export function forceSimulation<N extends ForceNode = ForceNode>(nodes?: N[], numDimensions?: number): unknown;
  export function forceX<N extends ForceNode = ForceNode>(x?: number | ((node: N) => number)): unknown;
  export function forceY<N extends ForceNode = ForceNode>(y?: number | ((node: N) => number)): unknown;
  export function forceZ<N extends ForceNode = ForceNode>(z?: number | ((node: N) => number)): unknown;
  export function forceRadial<N extends ForceNode = ForceNode>(radius: number | ((node: N) => number), x?: number, y?: number, z?: number): unknown;
}

// Local 3d-force-graph (aliased from ext-3d-force)
declare module '3d-force-graph' {
  interface ForceGraph3DInstance {
    // Graph data
    graphData(data?: { nodes: unknown[]; links: unknown[] }): ForceGraph3DInstance | { nodes: unknown[]; links: unknown[] };
    nodeId(accessor: string | ((node: unknown) => string)): ForceGraph3DInstance;

    // Node styling
    nodeColor(accessor: string | ((node: unknown) => string)): ForceGraph3DInstance;
    nodeVal(accessor: string | number | ((node: unknown) => number)): ForceGraph3DInstance;
    nodeRelSize(size: number): ForceGraph3DInstance;
    nodeOpacity(opacity: number): ForceGraph3DInstance;
    nodeVisibility(accessor: boolean | ((node: unknown) => boolean)): ForceGraph3DInstance;
    nodeThreeObject(accessor: ((node: unknown) => unknown) | undefined): ForceGraph3DInstance;
    nodeThreeObjectExtend(extend: boolean): ForceGraph3DInstance;

    // Link styling
    linkSource(accessor: string): ForceGraph3DInstance;
    linkTarget(accessor: string): ForceGraph3DInstance;
    linkColor(accessor: string | ((link: unknown) => string)): ForceGraph3DInstance;
    linkWidth(accessor: number | ((link: unknown) => number)): ForceGraph3DInstance;
    linkOpacity(opacity: number): ForceGraph3DInstance;
    linkVisibility(accessor: boolean | ((link: unknown) => boolean)): ForceGraph3DInstance;
    linkCurvature(accessor: number | ((link: unknown) => number)): ForceGraph3DInstance;
    linkDirectionalArrowLength(length: number): ForceGraph3DInstance;
    linkDirectionalArrowRelPos(pos: number): ForceGraph3DInstance;

    // Layout engine (D3 force)
    d3Force(forceName: string, force?: unknown): ForceGraph3DInstance | unknown;
    d3AlphaDecay(decay: number): ForceGraph3DInstance;
    d3AlphaMin(min: number): ForceGraph3DInstance;
    d3VelocityDecay(decay: number): ForceGraph3DInstance;
    d3ReheatSimulation(): ForceGraph3DInstance;

    // Simulation control
    warmupTicks(ticks: number): ForceGraph3DInstance;
    cooldownTicks(ticks: number): ForceGraph3DInstance;
    cooldownTime(ms: number): ForceGraph3DInstance;
    onEngineStop(callback: () => void): ForceGraph3DInstance;
    onEngineTick(callback: () => void): ForceGraph3DInstance;

    // Rendering
    backgroundColor(color: string): ForceGraph3DInstance;
    showNavInfo(show: boolean): ForceGraph3DInstance;
    width(width: number): ForceGraph3DInstance;
    height(height: number): ForceGraph3DInstance;

    // Interaction
    onNodeClick(callback: (node: unknown, event: MouseEvent) => void): ForceGraph3DInstance;
    onLinkClick(callback: (link: unknown, event: MouseEvent) => void): ForceGraph3DInstance;
    onBackgroundClick(callback: () => void): ForceGraph3DInstance;
    onNodeHover(callback: (node: unknown | null, prevNode: unknown | null) => void): ForceGraph3DInstance;
    onLinkHover(callback: (link: unknown | null, prevLink: unknown | null) => void): ForceGraph3DInstance;
    onNodeRightClick(callback: (node: unknown, event: MouseEvent) => void): ForceGraph3DInstance;
    onLinkRightClick(callback: (link: unknown, event: MouseEvent) => void): ForceGraph3DInstance;

    // Camera
    cameraPosition(position?: { x: number; y: number; z: number }, lookAt?: { x: number; y: number; z: number }, transitionMs?: number): ForceGraph3DInstance | { x: number; y: number; z: number };
    zoomToFit(transitionMs?: number, padding?: number): ForceGraph3DInstance;

    // Three.js access
    scene(): unknown;
    camera(): unknown;
    renderer(): unknown;
    controls(): unknown;

    // Cleanup
    _destructor?(): void;
  }

  function ForceGraph3D(options?: { rendererConfig?: Record<string, unknown> }): (element: HTMLElement) => ForceGraph3DInstance;
  export default ForceGraph3D;
}
