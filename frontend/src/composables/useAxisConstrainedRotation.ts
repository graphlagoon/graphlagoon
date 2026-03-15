/**
 * Composable for axis-constrained camera rotation.
 *
 * 3D mode: Hold X, Y, or Z while left-click dragging to rotate around that world axis.
 * 2D mode: Left-click drag always rotates around Z (no key needed).
 *
 * Draws a 3D dashed line through the scene showing the active rotation axis (3D only).
 */
import { ref, type Ref, type ComputedRef } from 'vue';
import * as THREE from 'three';

export type ConstrainedAxis = 'x' | 'y' | 'z';

const ROTATION_SENSITIVITY = 0.005; // radians per pixel of mouse delta

const AXIS_VECTORS: Record<ConstrainedAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

const AXIS_COLORS: Record<ConstrainedAxis, number> = {
  x: 0xe74c3c, // red
  y: 0x2ecc71, // green
  z: 0x3498db, // blue
};

const AXIS_LINE_HALF_LENGTH = 5000;

export function useAxisConstrainedRotation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGraph3d: () => any,
  containerRef: Ref<HTMLDivElement | null>,
  isPointerOverCanvas: () => boolean,
  is2DProjection: ComputedRef<boolean>,
) {
  const activeAxis = ref<ConstrainedAxis | null>(null);

  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let savedNoRotate: boolean | undefined;
  let savedEnableRotate: boolean | undefined;

  // Whether 2D rotation mode is active (always-on Z rotation, no key needed)
  let is2DRotationActive = false;

  // 3D axis line rendered in the scene
  let axisLine: THREE.Line | null = null;

  // Reusable math objects to avoid per-frame allocation
  const _quaternion = new THREE.Quaternion();
  const _offset = new THREE.Vector3();

  // ── 3D axis line helpers ──────────────────────────────────────────────

  function addAxisLine(axis: ConstrainedAxis) {
    const graph3d = getGraph3d();
    if (!graph3d) return;

    const scene = graph3d.scene();
    if (!scene) return;

    const dir = AXIS_VECTORS[axis];
    const target = graph3d.controls()?.target ?? new THREE.Vector3();

    const points = [
      new THREE.Vector3().copy(target).addScaledVector(dir, -AXIS_LINE_HALF_LENGTH),
      new THREE.Vector3().copy(target).addScaledVector(dir, AXIS_LINE_HALF_LENGTH),
    ];

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color: AXIS_COLORS[axis],
      dashSize: 8,
      gapSize: 4,
      linewidth: 1,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });

    axisLine = new THREE.Line(geometry, material);
    axisLine.computeLineDistances(); // required for dashed to work
    axisLine.renderOrder = 999;
    scene.add(axisLine);
  }

  function removeAxisLine() {
    if (!axisLine) return;

    const graph3d = getGraph3d();
    if (graph3d) {
      const scene = graph3d.scene();
      if (scene) scene.remove(axisLine);
    }

    axisLine.geometry.dispose();
    (axisLine.material as THREE.Material).dispose();
    axisLine = null;
  }

  // ── 2D rotation mode (always-on Z rotation) ──────────────────────────

  /**
   * Enable default Z-axis rotation for 2D projection mode.
   * Left-click drag rotates without any key held.
   * Call after lock2DCamera() in initGraph().
   */
  function enable2DRotation() {
    if (is2DRotationActive) return;
    is2DRotationActive = true;
    activeAxis.value = 'z';
    containerRef.value?.addEventListener('mousedown', onMouseDown);
  }

  /**
   * Disable 2D rotation mode. Call before initGraph() re-init or on 3D switch.
   */
  function disable2DRotation() {
    if (!is2DRotationActive) return;
    is2DRotationActive = false;

    if (isDragging) {
      isDragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    containerRef.value?.removeEventListener('mousedown', onMouseDown);
    activeAxis.value = null;
  }

  // ── Key handlers (3D only — called from GraphCanvas3D's keydown/keyup) ─

  /**
   * Returns true if the event was consumed (caller should `return`).
   */
  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!isPointerOverCanvas()) return false;
    // In 2D mode, rotation is always active — keys are not used
    if (is2DRotationActive) return false;
    if (activeAxis.value !== null) return false; // already constraining

    let axis: ConstrainedAxis | null = null;
    if (event.code === 'KeyX') axis = 'x';
    else if (event.code === 'KeyY') axis = 'y';
    else if (event.code === 'KeyZ') axis = 'z';
    if (!axis) return false;

    const graph3d = getGraph3d();
    if (!graph3d) return false;

    const controls = graph3d.controls();
    if (!controls) return false;

    // Save current rotation state and disable default rotation
    savedNoRotate = controls.noRotate;
    savedEnableRotate = controls.enableRotate;
    controls.noRotate = true;
    controls.enableRotate = false;

    activeAxis.value = axis;
    addAxisLine(axis);

    containerRef.value?.addEventListener('mousedown', onMouseDown);

    event.preventDefault();
    return true;
  }

  /**
   * Returns true if the event was consumed.
   */
  function handleKeyUp(event: KeyboardEvent): boolean {
    // In 2D mode, keys don't control axis rotation
    if (is2DRotationActive) return false;

    let axis: ConstrainedAxis | null = null;
    if (event.code === 'KeyX') axis = 'x';
    else if (event.code === 'KeyY') axis = 'y';
    else if (event.code === 'KeyZ') axis = 'z';
    if (!axis || axis !== activeAxis.value) return false;

    cleanupKeyMode();
    return true;
  }

  // ── Mouse drag handlers ───────────────────────────────────────────────

  function onMouseDown(event: MouseEvent) {
    if (event.button !== 0) return; // left button only
    if (activeAxis.value === null) return;

    isDragging = true;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // Prevent TrackballControls from capturing this drag
    event.preventDefault();
    event.stopPropagation();
  }

  function onMouseMove(event: MouseEvent) {
    if (!isDragging || activeAxis.value === null) return;

    const graph3d = getGraph3d();
    if (!graph3d) return;

    const camera = graph3d.camera() as THREE.PerspectiveCamera;
    const controls = graph3d.controls();
    if (!camera || !controls) return;

    const dx = event.clientX - lastMouseX;
    const dy = event.clientY - lastMouseY;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;

    // Map mouse movement to rotation based on axis:
    // - Y axis: horizontal drag (turning left/right)
    // - X axis: vertical drag (tilting up/down)
    // - Z axis: horizontal drag (spinning)
    let angle: number;
    if (activeAxis.value === 'x') {
      angle = -dy * ROTATION_SENSITIVITY;
    } else {
      angle = dx * ROTATION_SENSITIVITY;
    }

    if (Math.abs(angle) < 0.0001) return;

    const axisVec = AXIS_VECTORS[activeAxis.value];
    _quaternion.setFromAxisAngle(axisVec, angle);

    if (is2DProjection.value) {
      // 2D: camera stays at (0, 0, z) — just spin the up vector
      camera.up.applyQuaternion(_quaternion);
      camera.lookAt(controls.target);
    } else {
      // 3D: rotate camera position around the controls target
      _offset.copy(camera.position).sub(controls.target);
      _offset.applyQuaternion(_quaternion);
      camera.position.copy(controls.target).add(_offset);
      camera.up.applyQuaternion(_quaternion);
      camera.lookAt(controls.target);
    }

    // Sync TrackballControls internal state with new camera position
    controls.update?.();
  }

  function onMouseUp() {
    isDragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  // ── Cleanup & dispose ─────────────────────────────────────────────────

  /** Cleanup key-activated axis mode (3D). Does not touch 2D rotation. */
  function cleanupKeyMode() {
    if (isDragging) {
      isDragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    containerRef.value?.removeEventListener('mousedown', onMouseDown);
    removeAxisLine();

    // Restore original controls rotation state
    const graph3d = getGraph3d();
    if (graph3d) {
      const controls = graph3d.controls();
      if (controls) {
        if (savedNoRotate !== undefined) controls.noRotate = savedNoRotate;
        if (savedEnableRotate !== undefined) controls.enableRotate = savedEnableRotate;
      }
    }
    savedNoRotate = undefined;
    savedEnableRotate = undefined;

    activeAxis.value = null;
  }

  function onWindowBlur() {
    if (activeAxis.value !== null && !is2DRotationActive) {
      cleanupKeyMode();
    }
  }

  // Auto-cleanup if user switches tabs while holding key
  window.addEventListener('blur', onWindowBlur);

  function dispose() {
    disable2DRotation();
    cleanupKeyMode();
    window.removeEventListener('blur', onWindowBlur);
  }

  return {
    activeAxis,
    handleKeyDown,
    handleKeyUp,
    enable2DRotation,
    disable2DRotation,
    dispose,
  };
}
