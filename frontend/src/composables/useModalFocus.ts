import { onMounted, onUnmounted } from 'vue';

/**
 * Moves keyboard focus into a modal when it opens, and back to whatever was
 * focused when it closes.
 *
 * Only one modal in the app had an `autofocus`, so opening any of the other 29
 * left focus on the button behind the dialog: Tab walked the page underneath,
 * and a screen reader stayed there too. As with `useEscapeToCloseModals`, one
 * observer beats editing every modal — the next one written gets the behaviour
 * for free.
 *
 * Deliberately *not* a focus trap. A trap has to fight every nested surface
 * (a confirmation opened from inside a modal, a PrimeVue overlay teleported to
 * the body), and getting that wrong locks the keyboard out of the page. Escape
 * closes, focus starts inside, focus comes back: the parts that matter without
 * the part that breaks.
 */
const FOCUSABLE = [
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function firstFocusable(root: HTMLElement): HTMLElement | null {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  // Skip the close button when there is something more useful — landing on ×
  // means Enter closes the dialog you just opened.
  const meaningful = candidates.find(
    (el) => !el.classList.contains('modal-close') && el.offsetParent !== null,
  );
  return meaningful ?? candidates.find((el) => el.offsetParent !== null) ?? null;
}

export function useModalFocus() {
  let restoreTo: HTMLElement | null = null;

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        const overlay = node.matches?.('.modal-overlay')
          ? node
          : node.querySelector<HTMLElement>('.modal-overlay');
        if (!overlay) continue;
        // Remember where we came from, but never overwrite an earlier one:
        // a modal opened from a modal should return to the outer one.
        if (!restoreTo && document.activeElement instanceof HTMLElement) {
          restoreTo = document.activeElement;
        }
        // Let the modal render its contents first.
        requestAnimationFrame(() => firstFocusable(overlay)?.focus());
      }

      for (const node of Array.from(record.removedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        const wasOverlay =
          node.matches?.('.modal-overlay') || !!node.querySelector?.('.modal-overlay');
        if (!wasOverlay) continue;
        // Only hand focus back once every modal is gone.
        if (document.querySelector('.modal-overlay')) continue;
        const target = restoreTo;
        restoreTo = null;
        if (target?.isConnected) target.focus();
      }
    }
  });

  onMounted(() => observer.observe(document.body, { childList: true, subtree: true }));
  onUnmounted(() => observer.disconnect());
}
