/**
 * Dev-only performance overlay using stats-gl.
 *
 * Shows FPS, CPU frame time, and GPU time (when available) as a floating panel.
 * Automatically patches the Three.js renderer for GPU timing.
 *
 * Usage in a component:
 *   const devPerf = useDevPerf()
 *   onMounted(() => devPerf.attach(renderer, containerEl))
 *   onUnmounted(() => devPerf.dispose())
 *
 * In production builds, all methods are no-ops.
 */

import type * as THREE from 'three'

interface DevPerfHandle {
  /** Attach stats-gl to a Three.js renderer. Call after renderer is created. */
  attach: (renderer: THREE.WebGLRenderer, container: HTMLElement) => Promise<void>
  /** Dispose and remove the overlay. */
  dispose: () => void
}

const NOOP_HANDLE: DevPerfHandle = {
  attach: async () => {},
  dispose: () => {},
}

export function useDevPerf(): DevPerfHandle {
  if (import.meta.env.PROD) return NOOP_HANDLE

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stats: any = null
  let rafId: number | null = null

  const attach = async (renderer: THREE.WebGLRenderer, container: HTMLElement) => {
    // Dispose previous instance if re-attaching (e.g. graph re-init)
    dispose()

    try {
      const { default: Stats } = await import('stats-gl')

      stats = new Stats({
        trackGPU: true,
        trackCPT: false,
        trackHz: true,
        minimal: false,
        horizontal: true,
        precision: 1,
        logsPerSecond: 4,
        graphsPerSecond: 20,
        samplesLog: 40,
        samplesGraph: 10,
      })

      // Append to the container — it must be a positioned element (relative/absolute)
      // Do NOT override container's position, just set the overlay to absolute
      stats.dom.style.cssText =
        'position:absolute;top:4px;left:4px;z-index:9999;opacity:0.85;pointer-events:auto;'
      container.appendChild(stats.dom)

      // Patch renderer for GPU timing
      await stats.init(renderer)

      // Update loop (synced to rAF)
      const loop = () => {
        if (!stats) return
        stats.update()
        rafId = requestAnimationFrame(loop)
      }
      rafId = requestAnimationFrame(loop)
    } catch (err) {
      console.warn('[useDevPerf] Failed to initialize stats-gl:', err)
    }
  }

  const dispose = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    if (stats) {
      stats.dom?.remove()
      stats.dispose()
      stats = null
    }
  }

  return { attach, dispose }
}
