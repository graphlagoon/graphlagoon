/**
 * Types for the 3D force graph visualization (GraphCanvas3D).
 *
 * These interfaces describe the internal data structures used by
 * 3d-force-graph and the rendering pipeline. They are separate from
 * the API-level Node/Edge types in graph.ts.
 */

export interface GraphNode {
  id: string;
  label: string;
  nodeType: string;
  color: string;
  size: number;
  hidden?: boolean; // For search hide mode - visually hidden but keeps position
  isCluster?: boolean; // True if this is a cluster node
  __iconColor?: string; // Original appearance color (with dimming alpha) before sphere transparency override
  iconOverride?: string; // Icon name override from property-based mapping (takes precedence over type-level icon)
  // 3d-force-graph adds these
  x?: number;
  y?: number;
  z?: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
  // Velocity (for d3-force)
  vx?: number;
  vy?: number;
  vz?: number;
}

export interface GraphLink {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  relationshipType: string;
  label: string;
  color: string;
  hidden?: boolean; // For search hide mode
  curvature?: number; // For multi-edge visualization
  curveRotation?: number; // Rotation of curve for multi-edges
  __curve?: { getPoint(t: number): { x: number; y: number; z: number } } | null; // Set by forcegraph lib for curved edges
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
