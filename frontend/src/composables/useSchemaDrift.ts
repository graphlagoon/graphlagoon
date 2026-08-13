import { reactive } from 'vue';
import { api } from '@/services/api';
import {
  capabilitiesFor,
  resolveDatasourceType,
} from '@/composables/useDatasourceCapabilities';
import type { GraphContext, SchemaDriftResponse } from '@/types/graph';

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

/**
 * Whether drift checking means anything for a context.
 *
 * Drift is the gap between a context's stored table snapshot and the live
 * tables. A schemaless graph database has neither, so the check is not merely
 * unavailable — the question does not apply, and the backend rejects it.
 */
export function supportsSchemaDrift(
  context?: Pick<GraphContext, 'datasource_type'> | null,
): boolean {
  return capabilitiesFor(resolveDatasourceType(context)).supportsDrift;
}

export function useSchemaDrift() {
  /** Reactive per-context state — read this in a computed/template. */
  function state(contextId: string): SchemaDriftState {
    return ensureEntry(contextId);
  }

  /**
   * Run (or re-run) the drift check for a context. Always hits the API — this
   * is not a request-dedup cache, only a shared-state one.
   *
   * `checkTypes` defaults to TRUE: node/relationship type discovery is a
   * `SELECT DISTINCT` (a full scan of both tables), which is why it used to be
   * opt-in — that was to keep the once-automatic on-load check cheap. Now that
   * every check is explicitly user-initiated, the cost is bounded by a
   * deliberate click and the right default is the complete answer. A check that
   * silently skipped types would report "ok" on a context whose new node types
   * are invisible to Cypher — exactly the silent drift this feature exists to
   * catch. Which findings actually get *applied* is still per-finding opt-in in
   * the review modal.
   */
  async function check(
    contextId: string,
    checkTypes = true,
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
