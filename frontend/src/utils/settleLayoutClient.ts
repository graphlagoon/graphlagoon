/**
 * Main-thread client for the layout worker: same contract as
 * settleLayoutHeadless (mutates the caller's nodes with final x/y/z, returns
 * tick count), but the simulation runs off the main thread. Falls back to the
 * in-thread (time-chunked) settle if the worker can't start or errors.
 */
import {
  settleLayoutHeadless,
  type SettleNode,
  type SettleLink,
  type SettleOptions,
} from './headlessLayout';
import type { Force3DSettings } from './forceConfig3D';
import type { LayoutWorkerOutput } from '@/workers/layoutWorkerTypes';

const ABORT_POLL_MS = 150;

function settleInWorker(
  nodes: SettleNode[],
  links: SettleLink[],
  settings: Force3DSettings,
  opts: SettleOptions,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('@/workers/layoutWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }

    let abortTimer: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (abortTimer) clearInterval(abortTimer);
      worker.terminate();
    };

    if (opts.shouldAbort) {
      abortTimer = setInterval(() => {
        if (opts.shouldAbort!()) {
          cleanup();
          resolve(0); // aborted: caller checks its own token and bails anyway
        }
      }, ABORT_POLL_MS);
    }

    worker.onerror = (e) => {
      cleanup();
      reject(e instanceof ErrorEvent ? new Error(e.message) : new Error('layout worker error'));
    };

    worker.onmessage = (event: MessageEvent<LayoutWorkerOutput>) => {
      const msg = event.data;
      if (msg.type === 'PROGRESS') {
        opts.onProgress?.(msg.fraction);
      } else if (msg.type === 'DONE') {
        // Copy the settled positions back onto the caller's node objects
        // (input order is preserved by the worker).
        for (let i = 0; i < nodes.length; i++) {
          nodes[i].x = msg.positions[i * 3];
          nodes[i].y = msg.positions[i * 3 + 1];
          nodes[i].z = msg.positions[i * 3 + 2];
        }
        cleanup();
        resolve(msg.ticks);
      } else {
        cleanup();
        reject(new Error(msg.message));
      }
    };

    // Slim, structured-clone-friendly payloads: the worker only needs
    // id/size/x/y/z per node and the endpoint ids per link — never the full
    // GraphNode/GraphLink objects (labels, colors, three.js refs...).
    const slimNodes: SettleNode[] = nodes.map((n) => ({
      id: n.id, size: n.size, x: n.x, y: n.y, z: n.z,
    }));
    const slimLinks: SettleLink[] = links.map((l) => ({
      source: typeof l.source === 'string' ? l.source : l.source.id,
      target: typeof l.target === 'string' ? l.target : l.target.id,
    }));

    worker.postMessage({
      type: 'SETTLE',
      nodes: slimNodes,
      links: slimLinks,
      settings,
      numDimensions: opts.numDimensions ?? 2,
      nodeRelSize: opts.nodeRelSize ?? 4,
    });
  });
}

/**
 * Settle a layout headlessly, preferring a Web Worker (main thread stays
 * fully responsive), falling back to the in-thread time-chunked settle.
 */
export async function settleLayoutAuto(
  nodes: SettleNode[],
  links: SettleLink[],
  settings: Force3DSettings,
  opts: SettleOptions = {},
): Promise<number> {
  if (typeof Worker !== 'undefined') {
    try {
      return await settleInWorker(nodes, links, settings, opts);
    } catch (e) {
      console.warn('[settleLayoutAuto] worker settle failed; falling back to main thread', e);
    }
  }
  return settleLayoutHeadless(nodes, links, settings, opts);
}
