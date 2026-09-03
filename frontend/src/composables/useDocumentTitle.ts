/**
 * Keeps `document.title` in step with what is open.
 *
 * The tab said "Graph Lagoon Studio" for every page, so two graphs open side by
 * side were indistinguishable in the tab strip, in the history and in a
 * bookmark. The toolbar already truncates both names, which makes the title a
 * second place the full names survive.
 */
import { watchEffect } from 'vue';
import { useRoute } from 'vue-router';
import { useGraphStore } from '@/stores/graph';

export const APP_NAME = 'Graph Lagoon Studio';

export interface TitleParts {
  isGraphPage: boolean;
  context?: string | null;
  exploration?: string | null;
  dirty?: boolean;
}

/** Pure, so the shape of the title is testable without a router or a DOM. */
export function buildDocumentTitle(parts: TitleParts): string {
  if (!parts.isGraphPage || !parts.context) return APP_NAME;
  // Most specific first: a tab strip shows the first few characters only.
  const opened = parts.exploration ? `${parts.exploration} · ${parts.context}` : parts.context;
  // The same dot the toolbar shows, for the same reason.
  return `${parts.dirty ? '● ' : ''}${opened} — ${APP_NAME}`;
}

export function useDocumentTitle() {
  const route = useRoute();
  const graphStore = useGraphStore();

  watchEffect(() => {
    document.title = buildDocumentTitle({
      isGraphPage: route.name === 'graph',
      context: graphStore.currentContext?.title,
      exploration: graphStore.currentExploration?.title,
      dirty: graphStore.isExplorationDirty,
    });
  });
}
