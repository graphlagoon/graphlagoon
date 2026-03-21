/**
 * Composable for 3D graph camera management.
 *
 * Handles orthographic camera patching, camera movement tracking,
 * zoom-to-fit, and center-on-search-match.
 */
import * as THREE from 'three';
import type { Ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import type { GraphNode } from '@/types/graph3d';

const ORTHO_FRUSTUM_SIZE = 2000;

export function useGraphCamera(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGraph3d: () => any,
  containerRef: Ref<HTMLDivElement | null>,
  initialLayoutDone: Ref<boolean>,
  callbacks: {
    setLabelsVisible: (visible: boolean) => void;
    setIconsVisible: (visible: boolean) => void;
    setSelfEdgesVisible: (visible: boolean) => void;
    updateVisuals: () => void;
    updateLabels: () => void;
  },
) {
  const graphStore = useGraphStore();

  // Camera movement state
  let lastCameraPosition = { x: 0, y: 0, z: 0 };
  let lastCameraUp = { x: 0, y: 1, z: 0 };
  let lastCameraZoom = 1;
  let cameraIdleTimeout: ReturnType<typeof setTimeout> | null = null;
  let animationFrameId: number | null = null;
  let isCameraMoving = false;

  /**
   * Monkey-patch the PerspectiveCamera to behave as OrthographicCamera.
   */
  function patchCameraToOrthographic() {
    const graph3d = getGraph3d();
    if (!graph3d || !containerRef.value) return;

    const camera = graph3d.camera();
    if (!camera) return;

    const aspect = containerRef.value.clientWidth / (containerRef.value.clientHeight || 1);

    camera.isPerspectiveCamera = false;
    camera.isOrthographicCamera = true;
    camera.type = 'OrthographicCamera';
    camera.zoom = 1;

    camera.left = -ORTHO_FRUSTUM_SIZE * aspect / 2;
    camera.right = ORTHO_FRUSTUM_SIZE * aspect / 2;
    camera.top = ORTHO_FRUSTUM_SIZE / 2;
    camera.bottom = -ORTHO_FRUSTUM_SIZE / 2;
    camera.near = 0.1;
    camera.far = 100000;

    camera.updateProjectionMatrix = function (this: THREE.Camera & {
      aspect: number; zoom: number;
      left: number; right: number; top: number; bottom: number;
      near: number; far: number;
      projectionMatrix: THREE.Matrix4; projectionMatrixInverse: THREE.Matrix4;
    }) {
      const a = this.aspect || 1;
      this.left = -ORTHO_FRUSTUM_SIZE * a / 2;
      this.right = ORTHO_FRUSTUM_SIZE * a / 2;
      this.top = ORTHO_FRUSTUM_SIZE / 2;
      this.bottom = -ORTHO_FRUSTUM_SIZE / 2;

      const dx = (this.right - this.left) / (2 * this.zoom);
      const dy = (this.top - this.bottom) / (2 * this.zoom);
      const cx = (this.right + this.left) / 2;
      const cy = (this.top + this.bottom) / 2;

      this.projectionMatrix.makeOrthographic(
        cx - dx, cx + dx,
        cy + dy, cy - dy,
        this.near, this.far
      );
      this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    };

    camera.updateProjectionMatrix();
  }

  /**
   * Lock camera for 2D mode: top-down view looking along -Z, rotation disabled.
   */
  function lock2DCamera() {
    const graph3d = getGraph3d();
    if (!graph3d) return;

    const controls = graph3d.controls();
    if (controls) {
      // TrackballControls uses `noRotate`, OrbitControls uses `enableRotate`
      controls.noRotate = true;
      controls.enableRotate = false;
    }

    const camera = graph3d.camera();
    if (camera) {
      camera.position.set(0, 0, 1000);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
    }

    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
  }

  /**
   * Restore 3D camera: re-enable rotation.
   */
  function unlock3DCamera() {
    const graph3d = getGraph3d();
    if (!graph3d) return;

    const controls = graph3d.controls();
    if (controls) {
      controls.noRotate = false;
      controls.enableRotate = true;
    }
  }

  function startCameraTracking() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    setTimeout(() => {
      const graph3d = getGraph3d();
      const camera = graph3d?.camera();
      if (!camera) return;

      lastCameraPosition = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
      lastCameraUp = { x: camera.up.x, y: camera.up.y, z: camera.up.z };
      lastCameraZoom = camera.zoom ?? 1;

      function checkCameraMovement() {
        const graph3d = getGraph3d();
        if (!graph3d) {
          animationFrameId = requestAnimationFrame(checkCameraMovement);
          return;
        }
        const camera = graph3d.camera();
        if (!camera) {
          animationFrameId = requestAnimationFrame(checkCameraMovement);
          return;
        }

        const pos = camera.position;
        const positionMoved =
          Math.abs(pos.x - lastCameraPosition.x) > 0.1 ||
          Math.abs(pos.y - lastCameraPosition.y) > 0.1 ||
          Math.abs(pos.z - lastCameraPosition.z) > 0.1;
        const up = camera.up;
        const upChanged =
          Math.abs(up.x - lastCameraUp.x) > 0.001 ||
          Math.abs(up.y - lastCameraUp.y) > 0.001 ||
          Math.abs(up.z - lastCameraUp.z) > 0.001;
        const currentZoom = camera.zoom ?? 1;
        const zoomChanged = Math.abs(currentZoom - lastCameraZoom) > 0.001;

        if (positionMoved || zoomChanged || upChanged) {
          isCameraMoving = true;
          if (initialLayoutDone.value && graphStore.behaviors.hideLabelsOnCameraMove) {
            callbacks.setLabelsVisible(false);
            callbacks.setIconsVisible(false);
          }
          if (initialLayoutDone.value && graphStore.behaviors.hideSelfEdgesOnCameraMove) {
            callbacks.setSelfEdgesVisible(false);
          }

          lastCameraPosition = { x: pos.x, y: pos.y, z: pos.z };
          lastCameraUp = { x: up.x, y: up.y, z: up.z };
          lastCameraZoom = currentZoom;

          if (cameraIdleTimeout) clearTimeout(cameraIdleTimeout);
          cameraIdleTimeout = setTimeout(() => {
            isCameraMoving = false;
            // Recalculate labels with frustum culling for new camera position
            callbacks.updateLabels();
            if (initialLayoutDone.value && graphStore.behaviors.hideLabelsOnCameraMove) {
              callbacks.setLabelsVisible(true);
              callbacks.setIconsVisible(true);
            }
            if (initialLayoutDone.value && graphStore.behaviors.hideSelfEdgesOnCameraMove) {
              callbacks.setSelfEdgesVisible(true);
            }
            if (graphStore.behaviors.edgeLensMode !== 'off') {
              // Always sync visuals when camera stops — hover may have changed
              // to null while camera was moving, but the watcher skipped the
              // visual update because getIsCameraMoving() was true.
              callbacks.updateVisuals();
            }
          }, 300);
        }

        animationFrameId = requestAnimationFrame(checkCameraMovement);
      }

      animationFrameId = requestAnimationFrame(checkCameraMovement);
    }, 100);
  }

  function zoomToFit() {
    const graph3d = getGraph3d();
    if (!graph3d) return;

    const camera = graph3d.camera();
    if (camera?.isOrthographicCamera) {
      const bbox = graph3d.getGraphBbox();
      if (!bbox) return;

      const xSize = bbox.x[1] - bbox.x[0];
      const ySize = bbox.y[1] - bbox.y[0];
      const maxSize = Math.max(xSize, ySize);
      if (maxSize <= 0) return;

      const padding = 1.3;
      camera.zoom = ORTHO_FRUSTUM_SIZE / (maxSize * padding);
      camera.updateProjectionMatrix();

      const cx = (bbox.x[0] + bbox.x[1]) / 2;
      const cy = (bbox.y[0] + bbox.y[1]) / 2;
      const cz = (bbox.z[0] + bbox.z[1]) / 2;
      graph3d.cameraPosition(
        { x: cx, y: cy, z: camera.position.z },
        { x: cx, y: cy, z: cz },
        0
      );
    } else {
      graph3d.zoomToFit(400);
    }
  }

  function centerOnBestMatch(targetNodeId?: string) {
    const graph3d = getGraph3d();
    if (!graph3d) return;

    let nodeId = targetNodeId;
    if (!nodeId) {
      const matchedIds = graphStore.searchMatchedNodeIds;
      if (!matchedIds || matchedIds.size === 0) return;
      nodeId = matchedIds.values().next().value;
    }
    if (!nodeId) return;

    const currentData = graph3d.graphData();
    const targetNode = currentData.nodes.find((n: GraphNode) => n.id === nodeId);
    if (!targetNode || targetNode.x === undefined || targetNode.y === undefined || targetNode.z === undefined) return;

    const camera = graph3d.camera();
    const duration = 1000;

    // Compute rendered node radius: 3d-force-graph uses cbrt(nodeVal) * nodeRelSize
    const nodeVal = targetNode.size ?? 1;
    const nodeRelSize = graph3d.nodeRelSize() ?? 4;
    const nodeRadius = Math.cbrt(nodeVal) * nodeRelSize;
    // We want the visible area to be ~10x the node diameter
    const visibleSpan = Math.max(nodeRadius * 20, 40);

    if (camera?.isOrthographicCamera) {
      // Orthographic: animate position, lookAt and zoom in a single rAF loop
      // (can't use graph3d.cameraPosition for zoom — it only tweens position)
      const startZoom = camera.zoom;
      const targetZoom = ORTHO_FRUSTUM_SIZE / visibleSpan;

      const startPos = { x: camera.position.x, y: camera.position.y };
      const controls = graph3d.controls();
      const startTarget = controls
        ? { x: controls.target.x, y: controls.target.y, z: controls.target.z }
        : { x: startPos.x, y: startPos.y, z: 0 };

      const startTime = performance.now();
      const animate = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        // Quadratic ease-out — same as 3d-force-graph's TWEEN default
        const e = t * (2 - t);

        camera.position.x = startPos.x + (targetNode.x - startPos.x) * e;
        camera.position.y = startPos.y + (targetNode.y - startPos.y) * e;
        camera.zoom = startZoom + (targetZoom - startZoom) * e;
        camera.updateProjectionMatrix();

        if (controls) {
          controls.target.x = startTarget.x + (targetNode.x - startTarget.x) * e;
          controls.target.y = startTarget.y + (targetNode.y - startTarget.y) * e;
          controls.target.z = startTarget.z + (targetNode.z - startTarget.z) * e;
          controls.update();
        }

        if (t < 1) requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
    } else {
      // Perspective: move camera close — distance proportional to node size
      const closeUpDistance = Math.max(visibleSpan, 30);
      graph3d.cameraPosition(
        { x: targetNode.x, y: targetNode.y, z: targetNode.z + closeUpDistance },
        { x: targetNode.x, y: targetNode.y, z: targetNode.z },
        duration
      );
    }
  }

  function focusOnNode(nodeId: string) {
    centerOnBestMatch(nodeId);
  }

  function getIsCameraMoving() {
    return isCameraMoving;
  }

  /**
   * Reset camera orientation to default and zoom to fit.
   * In 2D: resets up vector to (0,1,0) and re-centers.
   * In 3D: resets up vector to (0,1,0) and zooms to fit.
   */
  function resetView() {
    const graph3d = getGraph3d();
    if (!graph3d) return;

    const camera = graph3d.camera();
    const controls = graph3d.controls();
    if (!camera) return;

    // Reset orientation
    camera.up.set(0, 1, 0);

    if (graphStore.behaviors.viewMode === '2d-proj') {
      // 2D: reset position to top-down view
      camera.position.set(0, 0, 1000);
      camera.lookAt(0, 0, 0);
      if (controls) {
        controls.target.set(0, 0, 0);
        controls.update();
      }
    } else if (controls) {
      camera.lookAt(controls.target);
      controls.update();
    }

    zoomToFit();
  }

  function dispose() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (cameraIdleTimeout) {
      clearTimeout(cameraIdleTimeout);
      cameraIdleTimeout = null;
    }
  }

  return {
    patchCameraToOrthographic,
    lock2DCamera,
    unlock3DCamera,
    startCameraTracking,
    zoomToFit,
    resetView,
    centerOnBestMatch,
    focusOnNode,
    getIsCameraMoving,
    dispose,
  };
}
