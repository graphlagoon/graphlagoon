import { ref, readonly } from 'vue';

/**
 * In-app replacement for `window.confirm()`.
 *
 * `confirmAction()` resolves to `true` when the user accepts and `false` when
 * they cancel, close, or press Escape. The dialog itself is `ConfirmDialog.vue`,
 * mounted once in App.vue; the state below is module-level so any component
 * (or store) can ask without prop drilling.
 *
 * Native `confirm()` was replaced because it blocks the event loop, cannot be
 * styled, shows the browser's chrome instead of the app's, and — in a native
 * fullscreen session — drops the user out of fullscreen.
 */
export interface ConfirmOptions {
  title: string;
  /** One or two sentences. State what is lost; "Are you sure?" says nothing. */
  message?: string;
  /** Verb on the accept button, e.g. "Delete". Defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red accept button; focus lands on Cancel so Enter does not destroy. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (accepted: boolean) => void;
}

const pending = ref<PendingConfirm | null>(null);
let hostMounted = false;

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  // No ConfirmDialog in the tree (unit tests render components in
  // isolation): fall back to the native dialog so callers keep working and
  // `vi.spyOn(window, 'confirm')` keeps controlling the answer.
  if (!hostMounted) {
    const text = options.message ? `${options.title}\n\n${options.message}` : options.title;
    return Promise.resolve(window.confirm(text));
  }
  // A second request while one is open cancels the first: nothing sensible
  // can stack two blocking questions.
  pending.value?.resolve(false);
  return new Promise((resolve) => {
    pending.value = { ...options, resolve };
  });
}

/** Called by ConfirmDialog.vue only. */
export function settlePending(accepted: boolean) {
  const p = pending.value;
  pending.value = null;
  p?.resolve(accepted);
}

/** Called by ConfirmDialog.vue on mount/unmount. */
export function setConfirmHostMounted(mounted: boolean) {
  hostMounted = mounted;
  if (!mounted) settlePending(false);
}

export function useConfirm() {
  return { confirmAction, pending: readonly(pending) };
}
