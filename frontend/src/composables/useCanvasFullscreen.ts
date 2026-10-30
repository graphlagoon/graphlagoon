import { onMounted, onUnmounted, ref, type Ref } from 'vue';

/**
 * Fullscreen for a graph canvas host.
 *
 * Fullscreens the DOCUMENT, not the host element. A native fullscreen element
 * is rendered alone in the top layer, so anything teleported to <body> — the
 * right-click context menu, every modal, toasts, PrimeVue overlays in the Data
 * Table — was invisible while the container itself was fullscreen. The host's
 * `.fullscreen` class pins it over the whole viewport (position: fixed, high
 * z-index); overlays keep their higher z-indices and stay usable.
 */
export function useCanvasFullscreen(hostRef: Ref<HTMLElement | null>) {
  const isFullscreen = ref(false);

  function toggle() {
    if (!hostRef.value) return;
    if (!document.fullscreenElement) {
      document.documentElement
        .requestFullscreen()
        .then(() => {
          isFullscreen.value = true;
        })
        .catch(() => {
          // Fullscreen not supported or denied
        });
    } else {
      document.exitFullscreen().then(() => {
        isFullscreen.value = false;
      });
    }
  }

  // The user may leave with Esc: follow the document.
  function onChange() {
    isFullscreen.value = !!document.fullscreenElement;
  }

  onMounted(() => document.addEventListener('fullscreenchange', onChange));
  onUnmounted(() => document.removeEventListener('fullscreenchange', onChange));

  return { isFullscreen, toggle };
}
