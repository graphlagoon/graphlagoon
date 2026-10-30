/**
 * Polls `GET /api/live` while the tab is visible, so an open exploration or case
 * picks up what an agent (or another tab) changed without a reload. Revisions
 * only: `onUpdate` decides what to fetch when one moved. One timer per page; it
 * stops on unmount, pauses while the tab is hidden and asks at once when the tab
 * comes back or the window gets focus. `live_refresh_seconds` (0: off) comes from
 * the config and from each answer, so an admin's change applies without a reload.
 */
import { onBeforeUnmount, onMounted } from 'vue';
import { api } from '@/services/api';
import type { LiveResponse } from '@/types/graph';

export interface LiveTargets {
  exploration?: string | null;
  case?: string | null;
}

export function useLiveRevision(options: {
  targets: () => LiveTargets;
  onUpdate: (live: LiveResponse) => void | Promise<void>;
  /** Skip a round (a load or a save in flight); the next one asks again. */
  paused?: () => boolean;
}) {
  let seconds = Number(window.__GRAPH_LAGOON_CONFIG__?.live_refresh_seconds ?? 5);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let stopped = false;

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!stopped && seconds > 0) timer = setTimeout(() => void poll(), seconds * 1000);
  }

  async function poll() {
    if (stopped || inFlight) return;
    const targets = options.targets();
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    if (!visible || options.paused?.() || (!targets.exploration && !targets.case)) {
      schedule();
      return;
    }
    inFlight = true;
    try {
      const live = await api.getLive({
        explorations: targets.exploration ? [targets.exploration] : [],
        cases: targets.case ? [targets.case] : [],
      });
      if (typeof live.refresh_seconds === 'number') seconds = live.refresh_seconds;
      await options.onUpdate(live);
    } catch (e) {
      // A failed poll is not the person's problem: the next one asks again.
      console.debug('[live] poll failed', e);
    } finally {
      inFlight = false;
      schedule();
    }
  }

  function wake() {
    if (document.visibilityState === 'visible') void poll();
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    schedule();
  });

  onBeforeUnmount(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('focus', wake);
  });

  return { poll };
}
