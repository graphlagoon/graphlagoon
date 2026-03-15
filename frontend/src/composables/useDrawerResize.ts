import { ref, onUnmounted } from 'vue';

/**
 * Composable for resizable bottom drawer (drag handle).
 * Returns reactive height and mouse handlers.
 */
export function useDrawerResize(options: {
  initialHeight?: number;
  minHeight?: number;
  maxHeightRatio?: number;
}) {
  const {
    initialHeight = 250,
    minHeight = 120,
    maxHeightRatio = 0.6,
  } = options;

  const height = ref(initialHeight);
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
