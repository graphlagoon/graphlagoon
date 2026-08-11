import { reactive } from 'vue';
import { api } from '@/services/api';
import type { SchemaDriftResponse } from '@/types/graph';

export interface SchemaDriftState {
  drift: SchemaDriftResponse | null;
  loading: boolean;
  error: string | null;
}

/**
 * Module-level cache keyed by context id, so a context's drift row action, its
 * edit modal, and the "Check context schema" CTA in QueryErrorModal all read
 * (and react to) the same result instead of each holding an independent copy.
 */
const cache = reactive<Record<string, SchemaDriftState>>({});

function ensureEntry(contextId: string): SchemaDriftState {
  if (!cache[contextId]) {
    cache[contextId] = { drift: null, loading: false, error: null };
  }
  return cache[contextId];
}

export function useSchemaDrift() {
  /** Reactive per-context state — read this in a computed/template. */
  function state(contextId: string): SchemaDriftState {
    return ensureEntry(contextId);
  }

  /**
   * Run (or re-run) the drift check for a context. Always hits the API — this
   * is not a request-dedup cache, only a shared-state one; `checkTypes` runs
   * the expensive type discovery on top of the (always-run) column check.
   */
  async function check(
    contextId: string,
    checkTypes = false,
  ): Promise<SchemaDriftResponse | null> {
    const entry = ensureEntry(contextId);
    entry.loading = true;
    entry.error = null;

    try {
      const drift = await api.getSchemaDrift(contextId, { checkTypes });
      entry.drift = drift;
      return drift;
    } catch (e: unknown) {
      entry.error = e instanceof Error ? e.message : 'Failed to check context schema';
      return null;
    } finally {
      entry.loading = false;
    }
  }

  function clear(contextId: string) {
    delete cache[contextId];
  }

  return { state, check, clear };
}
