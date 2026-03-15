import { ref } from 'vue';

export interface Toast {
  id: number;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  duration: number;
}

const toasts = ref<Toast[]>([]);
let nextId = 0;

export function useToast() {
  function show(message: string, type: Toast['type'] = 'info', duration = 3000) {
    const id = nextId++;
    toasts.value.push({ id, message, type, duration });

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

  return {
    toasts,
    show,
    remove,
    info,
    success,
    warning,
    error,
  };
}
