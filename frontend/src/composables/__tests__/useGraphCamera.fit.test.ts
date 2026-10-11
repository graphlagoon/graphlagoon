import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import * as THREE from 'three'
import { useGraphCamera } from '@/composables/useGraphCamera'

const WIDTH = 1200
const HEIGHT = 800
const FRUSTUM = 2000

/** zoomToFit on an orthographic camera: frames the bbox, but never magnifies
 * a small case graph past the cap (05 §3 "Legibilidade"). */
function setup(bboxHalf: number) {
  const camera = new THREE.OrthographicCamera(-WIDTH / 2, WIDTH / 2, HEIGHT / 2, -HEIGHT / 2, 1, 5000)
  camera.position.set(0, 0, 400)
  const cameraPosition = vi.fn()
  const graph3d = {
    camera: () => camera,
    controls: () => ({ target: new THREE.Vector3(), update: vi.fn() }),
    getGraphBbox: () => ({ x: [-bboxHalf, bboxHalf], y: [-bboxHalf, bboxHalf], z: [0, 0] }),
    cameraPosition,
  }
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { value: WIDTH })
  Object.defineProperty(container, 'clientHeight', { value: HEIGHT })
  const callbacks = {
    setLabelsVisible: vi.fn(),
    setIconsVisible: vi.fn(),
    setSelfEdgesVisible: vi.fn(),
    updateVisuals: vi.fn(),
    updateLabels: vi.fn(),
  }
  const graphCamera = useGraphCamera(() => graph3d, ref(container), ref(true), callbacks)
  return { graphCamera, camera, cameraPosition }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useGraphCamera.zoomToFit (orthographic)', () => {
  it('frames a large graph by its bbox', () => {
    const { graphCamera, camera, cameraPosition } = setup(500) // 1000 wide
    graphCamera.zoomToFit()
    expect(camera.zoom).toBeCloseTo(FRUSTUM / (1000 * 1.3), 5)
    expect(cameraPosition).toHaveBeenCalled()
  })

  it('caps the magnification of a small case graph', () => {
    const { graphCamera, camera } = setup(80) // 160 wide → uncapped zoom would be ~9.6
    graphCamera.zoomToFit()
    expect(camera.zoom).toBe(6)
  })
})
