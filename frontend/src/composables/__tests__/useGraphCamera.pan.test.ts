import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import * as THREE from 'three'
import { useGraphCamera } from '@/composables/useGraphCamera'
import { useGraphStore } from '@/stores/graph'

const ORTHO_FRUSTUM_SIZE = 2000
const WIDTH = 1600
const HEIGHT = 900 // 16:9 — the aspect ratio that exposes the upstream clientWidth bug

function makeControls() {
  return {
    target: new THREE.Vector3(0, 0, 0),
    noPan: false,
    update: vi.fn(),
  }
}

function makeOrthographicCamera(zoom = 1) {
  const camera = new THREE.OrthographicCamera()
  camera.zoom = zoom
  camera.position.set(0, 0, 1000)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrix()
  camera.updateMatrixWorld()
  return camera
}

function makePerspectiveCamera(distance = 1000, fov = 50) {
  const camera = new THREE.PerspectiveCamera(fov, WIDTH / HEIGHT, 0.1, 10000)
  camera.position.set(0, 0, distance)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrix()
  camera.updateMatrixWorld()
  return camera
}

function setup(camera: THREE.Camera) {
  const controls = makeControls()
  const graph3d = {
    camera: () => camera,
    controls: () => controls,
    getGraphBbox: () => ({ x: [-500, 500], y: [-500, 500], z: [-500, 500] }),
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
  return { graphCamera, controls, callbacks, camera }
}

/**
 * Project a world point to screen pixels using the camera's real projection matrix.
 * This is the ground truth for "is the point still under the cursor?".
 */
function projectToScreen(camera: THREE.Camera, world: THREE.Vector3) {
  const ndc = world.clone().project(camera)
  return {
    x: ((ndc.x + 1) / 2) * WIDTH,
    y: ((1 - ndc.y) / 2) * HEIGHT,
  }
}

/** Rebuild the patched ortho projection the app actually uses (useGraphCamera). */
function applyPatchedOrthoProjection(camera: THREE.OrthographicCamera) {
  const aspect = WIDTH / HEIGHT
  camera.left = (-ORTHO_FRUSTUM_SIZE * aspect) / 2
  camera.right = (ORTHO_FRUSTUM_SIZE * aspect) / 2
  camera.top = ORTHO_FRUSTUM_SIZE / 2
  camera.bottom = -ORTHO_FRUSTUM_SIZE / 2
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useGraphCamera — map-style pan', () => {
  describe('syncPanMode', () => {
    it('takes right-drag from TrackballControls by default', () => {
      const store = useGraphStore()
      const { graphCamera, controls } = setup(makeOrthographicCamera())

      expect(store.behaviors.mapStylePan).toBe(true)

      graphCamera.syncPanMode()

      // noPan disables the controls' own (panSpeed 0.3, aspect-buggy) pan.
      expect(controls.noPan).toBe(true)
    })

    it('gives right-drag back to the controls when disabled', () => {
      const store = useGraphStore()
      const { graphCamera, controls } = setup(makeOrthographicCamera())

      store.updateBehaviors({ mapStylePan: false })
      graphCamera.syncPanMode()

      expect(controls.noPan).toBe(false)
    })
  })

  describe('cursor lock (orthographic)', () => {
    it('keeps the grabbed world point exactly under the cursor', () => {
      const camera = makeOrthographicCamera(1)
      applyPatchedOrthoProjection(camera)
      const { graphCamera } = setup(camera)

      // Grab a world point and note where it sits on screen.
      const grabbed = new THREE.Vector3(300, -200, 0)
      const before = projectToScreen(camera, grabbed)

      // Drag the mouse.
      const dx = 120
      const dy = -80
      graphCamera.applyMapStylePan(dx, dy)
      camera.updateMatrixWorld()

      // The point must have followed the cursor 1:1.
      const after = projectToScreen(camera, grabbed)
      expect(after.x - before.x).toBeCloseTo(dx, 4)
      expect(after.y - before.y).toBeCloseTo(dy, 4)
    })

    it('stays locked when zoomed in', () => {
      const camera = makeOrthographicCamera(4)
      applyPatchedOrthoProjection(camera)
      const { graphCamera } = setup(camera)

      const grabbed = new THREE.Vector3(50, 30, 0)
      const before = projectToScreen(camera, grabbed)

      graphCamera.applyMapStylePan(60, 45)
      camera.updateMatrixWorld()

      const after = projectToScreen(camera, grabbed)
      expect(after.x - before.x).toBeCloseTo(60, 4)
      expect(after.y - before.y).toBeCloseTo(45, 4)
    })

    it('stays locked when zoomed out', () => {
      const camera = makeOrthographicCamera(0.25)
      applyPatchedOrthoProjection(camera)
      const { graphCamera } = setup(camera)

      const grabbed = new THREE.Vector3(-800, 400, 0)
      const before = projectToScreen(camera, grabbed)

      graphCamera.applyMapStylePan(-90, 30)
      camera.updateMatrixWorld()

      const after = projectToScreen(camera, grabbed)
      expect(after.x - before.x).toBeCloseTo(-90, 4)
      expect(after.y - before.y).toBeCloseTo(30, 4)
    })

    it('pans the vertical axis at the same rate as the horizontal', () => {
      // This is the upstream TrackballControls bug: its ortho branch divides scale_y by
      // clientWidth instead of clientHeight, so on a 16:9 screen vertical pan is ~1.78x
      // too slow. Equal drags must produce equal world movement on both axes.
      const camera = makeOrthographicCamera(1)
      applyPatchedOrthoProjection(camera)

      const horizontal = setup(camera)
      const startX = camera.position.x
      horizontal.graphCamera.applyMapStylePan(100, 0)
      const movedX = Math.abs(camera.position.x - startX)

      const camera2 = makeOrthographicCamera(1)
      applyPatchedOrthoProjection(camera2)
      const vertical = setup(camera2)
      const startY = camera2.position.y
      vertical.graphCamera.applyMapStylePan(0, 100)
      const movedY = Math.abs(camera2.position.y - startY)

      expect(movedY).toBeCloseTo(movedX, 6)
    })

    it('moves the world with the drag, not against it', () => {
      const camera = makeOrthographicCamera(1)
      applyPatchedOrthoProjection(camera)
      const { graphCamera } = setup(camera)

      // Drag right: the world should follow right, so the camera moves left.
      graphCamera.applyMapStylePan(100, 0)

      expect(camera.position.x).toBeLessThan(0)
    })

    it('scales with zoom — the same drag covers less world when zoomed in', () => {
      const out = makeOrthographicCamera(0.5)
      applyPatchedOrthoProjection(out)
      setup(out).graphCamera.applyMapStylePan(100, 0)
      const movedOut = Math.abs(out.position.x)

      const inn = makeOrthographicCamera(4)
      applyPatchedOrthoProjection(inn)
      setup(inn).graphCamera.applyMapStylePan(100, 0)
      const movedIn = Math.abs(inn.position.x)

      expect(movedOut).toBeGreaterThan(movedIn)
    })
  })

  describe('cursor lock (perspective)', () => {
    it('keeps a point at the target depth locked under the cursor', () => {
      const camera = makePerspectiveCamera(1000)
      const { graphCamera } = setup(camera)

      // A point on the plane through the orbit target (z=0) — exact for perspective.
      const grabbed = new THREE.Vector3(120, -60, 0)
      const before = projectToScreen(camera, grabbed)

      graphCamera.applyMapStylePan(75, 40)
      camera.updateMatrixWorld()

      const after = projectToScreen(camera, grabbed)
      expect(after.x - before.x).toBeCloseTo(75, 3)
      expect(after.y - before.y).toBeCloseTo(40, 3)
    })

    it('pans further when the camera is further from the target', () => {
      const near = makePerspectiveCamera(500)
      setup(near).graphCamera.applyMapStylePan(100, 0)
      const movedNear = Math.abs(near.position.x)

      const far = makePerspectiveCamera(5000)
      setup(far).graphCamera.applyMapStylePan(100, 0)
      const movedFar = Math.abs(far.position.x)

      expect(movedFar).toBeGreaterThan(movedNear)
    })
  })

  describe('target tracking', () => {
    it('moves the orbit target with the camera so rotation stays centered', () => {
      const camera = makeOrthographicCamera(1)
      applyPatchedOrthoProjection(camera)
      const { graphCamera, controls } = setup(camera)

      const before = camera.position.clone().sub(controls.target)

      graphCamera.applyMapStylePan(140, -70)

      // The camera→target vector is unchanged: the pair translated rigidly.
      const after = camera.position.clone().sub(controls.target)
      expect(after.x).toBeCloseTo(before.x, 6)
      expect(after.y).toBeCloseTo(before.y, 6)
      expect(after.z).toBeCloseTo(before.z, 6)
      expect(controls.target.x).not.toBe(0)
    })

    it('updates controls without triggering a full visual recompute', () => {
      const camera = makeOrthographicCamera(1)
      applyPatchedOrthoProjection(camera)
      const { graphCamera, controls, callbacks } = setup(camera)

      graphCamera.applyMapStylePan(10, 10)

      expect(controls.update).toHaveBeenCalled()
      // updateVisuals is O(nodes + links) and mousemove fires faster than rAF —
      // calling it per pan event made panning lag on graphs with tens of
      // thousands of edges. Pan must only move the camera.
      expect(callbacks.updateVisuals).not.toHaveBeenCalled()
    })
  })
})
