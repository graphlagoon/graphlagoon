/**
 * Layout Worker — runs the headless force-layout settle OFF the main thread.
 *
 * The settle is pure computation over plain node/link data (d3-force-3d, no
 * DOM/Three), which made it the dominant main-thread blocker on large graphs:
 * ~730ms per tick at 100k nodes + 150k links, ~110 ticks to converge. Here it
 * runs in a worker; the main thread only receives throttled progress messages
 * and, at the end, a packed Float32Array of positions (transferred, not
 * copied).
 *
 * Protocol:
 *   in : { type: 'SETTLE', nodes, links, settings, numDimensions, nodeRelSize }
 *   out: { type: 'PROGRESS', fraction }
 *        { type: 'DONE', positions: Float32Array (x,y,z per node, input order), ticks }
 *        { type: 'ERROR', message }
 * Cancellation: the owner simply terminates the worker.
 */
import { settleLayoutHeadless } from '@/utils/headlessLayout';
import type { LayoutWorkerInput, LayoutWorkerOutput } from './layoutWorkerTypes';

self.onmessage = async (event: MessageEvent<LayoutWorkerInput>) => {
  const msg = event.data;
  if (msg.type !== 'SETTLE') return;

  try {
    let lastProgressPost = 0;
    const ticks = await settleLayoutHeadless(msg.nodes, msg.links, msg.settings, {
      numDimensions: msg.numDimensions,
      nodeRelSize: msg.nodeRelSize,
      // No UI in a worker: use big time chunks so we don't yield too often;
      // yielding still lets a terminate() land between chunks promptly enough.
      tickBudgetMs: 250,
      onProgress: (fraction) => {
        const now = Date.now();
        if (fraction >= 1 || now - lastProgressPost > 100) {
          lastProgressPost = now;
          (self as unknown as Worker).postMessage({ type: 'PROGRESS', fraction } satisfies LayoutWorkerOutput);
        }
      },
    });

    const positions = new Float32Array(msg.nodes.length * 3);
    for (let i = 0; i < msg.nodes.length; i++) {
      const n = msg.nodes[i];
      positions[i * 3] = n.x ?? 0;
      positions[i * 3 + 1] = n.y ?? 0;
      positions[i * 3 + 2] = n.z ?? 0;
    }
    (self as unknown as Worker).postMessage(
      { type: 'DONE', positions, ticks } satisfies LayoutWorkerOutput,
      [positions.buffer],
    );
  } catch (e) {
    (self as unknown as Worker).postMessage({
      type: 'ERROR',
      message: e instanceof Error ? e.message : String(e),
    } satisfies LayoutWorkerOutput);
  }
};
