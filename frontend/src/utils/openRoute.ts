import type { RouteLocationRaw, Router } from 'vue-router';

/** Ctrl/Cmd/Shift-click or middle-click means "new tab", as on any link. */
export function wantsNewTab(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1;
}

/** Navigate like a link would: in a new tab when a modifier is held, in place otherwise. */
export function openRoute(router: Router, to: RouteLocationRaw, event: MouseEvent): void {
  if (wantsNewTab(event)) window.open(router.resolve(to).href, '_blank', 'noopener');
  else void router.push(to);
}
