import { ref } from 'vue';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  duration: number;
  /** Optional button inside the toast, e.g. Undo. */
  action?: ToastAction;
}

const toasts = ref<Toast[]>([]);
let nextId = 0;

export function useToast() {
  function show(
    message: string,
    type: Toast['type'] = 'info',
    duration = 3000,
    action?: ToastAction,
  ) {
    const id = nextId++;
    toasts.value.push({ id, message, type, duration, action });

    if (duration > 0) {
      setTimeout(() => {
        remove(id);
      }, duration);
    }

    return id;
  }

  function remove(id: number) {
    const index = toasts.value.findIndex(t => t.id === id);
    if (index > -1) {
      toasts.value.splice(index, 1);
    }
  }

  function info(message: string, duration = 3000) {
    return show(message, 'info', duration);
  }

  function success(message: string, duration = 3000) {
    return show(message, 'success', duration);
  }

  function warning(message: string, duration = 3000) {
    return show(message, 'warning', duration);
  }

  function error(message: string, duration = 4000) {
    return show(message, 'error', duration);
  }

  /**
   * "Done — Undo" instead of "Are you sure?". For a change the app can put
   * back itself, asking first costs every user a click to prevent a mistake
   * few of them make; this costs nothing and still repairs the mistake.
   * Longer-lived than a normal toast because it has to be read and acted on.
   */
  function undoable(message: string, onUndo: () => void, duration = 8000) {
    let id = -1;
    id = show(message, 'info', duration, {
      label: 'Undo',
      onClick: () => {
        onUndo();
        remove(id);
      },
    });
    return id;
  }

  return {
    toasts,
    show,
    remove,
    undoable,
    info,
    success,
    warning,
    error,
  };
}
