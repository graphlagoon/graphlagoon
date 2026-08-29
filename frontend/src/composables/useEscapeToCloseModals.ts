import { onMounted, onUnmounted } from 'vue';

/**
 * Escape closes the top-most modal.
 *
 * Every modal in the app renders a `.modal-overlay` whose backdrop closes it
 * (`@click.self="close"`) — 30 of them at the time of writing, and not one
 * handled Escape. Wiring a listener into all 28 components would work until
 * the next modal is written and forgets; one document-level listener cannot be
 * forgotten.
 *
 * `@click.self` compiles to "run only when `event.target === currentTarget`",
 * so dispatching a click *on the overlay element itself* is exactly the event
 * that handler is waiting for, whatever each modal does to close.
 *
 * Registered in the capture phase and stopping propagation, so that a modal
 * over the graph takes Escape instead of the canvas clearing the selection
 * underneath it. `ConfirmDialog` owns its own Escape (it has to resolve a
 * promise) and uses a different class, so it is left alone.
 */
export function useEscapeToCloseModals() {
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;

    // A confirmation is the top-most thing whenever it is open, and it handles
    // Escape itself.
    if (document.querySelector('.confirm-overlay')) return;

    const overlays = document.querySelectorAll<HTMLElement>('.modal-overlay');
    const top = overlays[overlays.length - 1];
    if (!top) return;

    // The modal owns this Escape: don't let the graph canvas also act on it.
    event.stopPropagation();
    top.dispatchEvent(new MouseEvent('click', { bubbles: false }));
  }

  onMounted(() => document.addEventListener('keydown', onKeydown, true));
  onUnmounted(() => document.removeEventListener('keydown', onKeydown, true));
}
