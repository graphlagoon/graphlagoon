/**
 * Read and write a context's default look — the style block kept under the
 * reserved `default_behaviors.look` key (no column of its own, so no migration).
 *
 * The look is applied when the context opens with no exploration, and on a case
 * canvas whose items have no look of their own (utils/caseLook). Writing it is a
 * context update, so it needs write access to the context, like a preset.
 *
 * `source` names where the look came from (`preset:<name>`, `exploration:<title>`,
 * `current`, `json`) — a caption for the context modal and the preset ★, never
 * read when the look is applied.
 */
import { api } from '@/services/api';
import { useGraphStore } from '@/stores/graph';
import { useInvestigationStore } from '@/stores/investigation';
import { useContextsStore } from '@/stores/contexts';
import type { GraphContext, StylePresetSettings } from '@/types/graph';

export type DefaultLook = StylePresetSettings & { source?: string };

/** The settings block a context default keeps: no behaviors (those are the context's other keys). */
export function toDefaultLook(settings: StylePresetSettings, source: string): DefaultLook {
  const { behaviors: _b, ...rest } = settings;
  return { ...rest, source };
}

/** The raw default look stored on a context (with its `source`), or null. */
export function storedDefaultLook(ctx?: Pick<GraphContext, 'default_behaviors'> | null): DefaultLook | null {
  const raw = ctx?.default_behaviors?.look;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as DefaultLook) : null;
}

/** `default_behaviors` with the look replaced (null removes it), the other keys untouched. */
export function withDefaultLook(
  defaultBehaviors: Record<string, unknown> | undefined | null,
  look: DefaultLook | null,
): Record<string, unknown> {
  const { look: _old, ...rest } = defaultBehaviors ?? {};
  return look ? { ...rest, look } : rest;
}

export function useContextDefaultLook() {
  const graphStore = useGraphStore();
  const investigationStore = useInvestigationStore();
  const contextsStore = useContextsStore();

  /** The freshest copy of the context this page holds, else the server's. */
  async function contextOf(contextId: string): Promise<GraphContext> {
    if (graphStore.currentContext?.id === contextId) return graphStore.currentContext;
    return investigationStore.contexts[contextId] ?? (await api.getGraphContext(contextId));
  }

  /** Save (or, with null, remove) the default look; every copy the page holds is updated. */
  async function setDefaultLook(contextId: string, look: DefaultLook | null): Promise<GraphContext> {
    const ctx = await contextOf(contextId);
    const updated = await api.updateGraphContext(contextId, {
      default_behaviors: withDefaultLook(ctx.default_behaviors, look),
    });
    if (graphStore.currentContext?.id === contextId) graphStore.currentContext = updated;
    if (investigationStore.contexts[contextId]) {
      investigationStore.contexts = { ...investigationStore.contexts, [contextId]: updated };
    }
    const i = contextsStore.contexts.findIndex((c) => c.id === contextId);
    if (i !== -1) contextsStore.contexts[i] = updated;
    return updated;
  }

  return { setDefaultLook };
}
