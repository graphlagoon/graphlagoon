import { ref, onUnmounted } from 'vue';

/**
 * Composable for resizable bottom drawer (drag handle).
 * Returns reactive height and mouse handlers. With `storageKey` the height the
 * person dragged to is kept per browser; without one saved, the default never
 * takes more than `defaultRatio` of the window (a 440 px console left a 208 px
 * canvas on a 700 px screen).
 */
export function useDrawerResize(options: {
  initialHeight?: number;
  minHeight?: number;
  maxHeightRatio?: number;
  defaultRatio?: number;
  storageKey?: string;
}) {
  const {
    initialHeight = 250,
    minHeight = 120,
    maxHeightRatio = 0.6,
    defaultRatio = 0.4,
    storageKey,
  } = options;

  const viewport = typeof window !== 'undefined' ? window.innerHeight : 900;
  const clamp = (h: number) => Math.min(viewport * maxHeightRatio, Math.max(minHeight, h));
  function startHeightFor(): number {
    if (storageKey) {
      try {
        const saved = Number(localStorage.getItem(storageKey));
        if (saved > 0) return clamp(saved);
      } catch {
        /* storage blocked */
      }
    }
    return clamp(Math.min(initialHeight, viewport * defaultRatio));
  }

  const height = ref(startHeightFor());
  const isResizing = ref(false);

  let startY = 0;
  let startHeight = 0;

  function onMouseDown(e: MouseEvent) {
    e.preventDefault();
    isResizing.value = true;
    startY = e.clientY;
    startHeight = height.value;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }

  function onMouseMove(e: MouseEvent) {
    if (!isResizing.value) return;
    const maxHeight = window.innerHeight * maxHeightRatio;
    const delta = startY - e.clientY; // dragging up = positive
    const newHeight = Math.min(maxHeight, Math.max(minHeight, startHeight + delta));
    height.value = newHeight;
  }

  function onMouseUp() {
    isResizing.value = false;
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, String(Math.round(height.value)));
      } catch {
        /* storage blocked */
      }
    }
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  onUnmounted(() => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  });

  return {
    height,
    isResizing,
    onMouseDown,
  };
}
