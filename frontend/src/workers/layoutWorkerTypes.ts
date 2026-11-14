/**
 * Shared protocol types for layoutWorker. Kept in their own module so the
 * main-thread client can import the types without executing the worker
 * module's `self.onmessage` side effect.
 */
import type { SettleNode, SettleLink } from '@/utils/headlessLayout';
import type { Force3DSettings } from '@/utils/forceConfig3D';
import type { SerializedHubLeavesPlan } from '@/utils/hubLeaves';

export interface LayoutWorkerInput {
  type: 'SETTLE';
  nodes: SettleNode[];
  links: SettleLink[];
  settings: Force3DSettings;
  numDimensions: 2 | 3;
  nodeRelSize: number;
  hubLeaves?: { plan: SerializedHubLeavesPlan; spacing: number };
}

export type LayoutWorkerOutput =
  | { type: 'PROGRESS'; fraction: number }
  | { type: 'DONE'; positions: Float32Array; ticks: number }
  | { type: 'ERROR'; message: string };
