/**
 * Types for the Similarity system.
 *
 * These mirror the backend's similarity endpoint schema and are used
 * by the similarity store and panel component.
 */

/** Schema for a single parameter accepted by a similarity endpoint. */
export interface SimilarityParamSpec {
  name: string;
  type: 'str' | 'int' | 'float' | 'bool';
  default?: unknown;
  required: boolean;
  description: string;
  choices?: string[];
}

/** Endpoint metadata returned by GET /api/similarity/endpoints. */
export interface SimilarityEndpointInfo {
  name: string;
  description: string;
  endpoint: string;  // path on the same origin, e.g. "/my-api/similarity/cosine"
  params: SimilarityParamSpec[];
}

/** Request payload sent directly to the parent's similarity endpoint. */
export interface SimilarityComputeRequest {
  node_keys: string[];
  params: Record<string, unknown>;
}

/** A single similarity edge returned by the backend. */
export interface SimilarityEdge {
  source: string;
  target: string;
  score: number;
}

/** Response from POST /api/similarity/compute. */
export interface SimilarityResponse {
  edges: SimilarityEdge[];
  metadata?: Record<string, unknown>;
}

/** Display mode for similarity edges in the graph. */
export type SimilarityDisplayMode = 'overlay' | 'exclusive' | 'hidden';

/** Layout strategy when filtering by edge type. */
export type LayoutStrategy = 'unified' | 'fix-then-recompute' | 'selected-only';
