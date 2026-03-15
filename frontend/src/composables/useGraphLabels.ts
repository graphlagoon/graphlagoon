/**
 * Composable for 3D graph label rendering.
 *
 * Manages the FastLabelRenderer lifecycle, label updates, and visibility toggling.
 * Uses screen-space density culling (LabelGrid) to limit label overcrowding,
 * then applies greedy AABB overlap detection to prevent depth-based stacking.
 */
import * as THREE from 'three';
import type { Ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { FastLabelRenderer, computeNormalizedTextWidth, LABEL_BASE_SCALE, NORMALIZED_TEXT_HEIGHT } from '@/utils/FastLabelRenderer';
import { LabelGrid, ScreenAABBFilter } from '@/utils/LabelGrid';
import type { GraphNode, GraphLink } from '@/types/graph3d';

const nodeLabelColor = new THREE.Color(0.15, 0.15, 0.15);
const edgeLabelColor = new THREE.Color(0.1, 0.3, 0.6);

// Reusable objects (avoid GC pressure)
const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _point = new THREE.Vector3();
// Scratch vector for label positions (avoids new THREE.Vector3 per node per frame)
const _labelPos = new THREE.Vector3();

/** Inline screen projection. Returns false if behind camera.
 *  Writes to outSx, outSy, outSz via the out object to avoid allocation. */
interface ScreenCoords { sx: number; sy: number; sz: number }
const _screenCoords: ScreenCoords = { sx: 0, sy: 0, sz: 0 };

function projectToScreenInline(
  x: number, y: number, z: number,
  camera: THREE.Camera,
  halfW: number, halfH: number,
  out: ScreenCoords,
): boolean {
  _point.set(x, y, z);
  _point.project(camera);
  if (_point.z > 1) return false;
  out.sx = (_point.x + 1) * halfW;
  out.sy = (1 - _point.y) * halfH;
  out.sz = _point.z;
  return true;
}

/** Estimate screen-space pixel size of 1 world unit at a given NDC depth.
 *  For perspective: closer objects are larger. For ortho: constant. */
function pixelsPerUnitAtDepth(
  ndcZ: number,
  camera: THREE.Camera,
  halfH: number,
): number {
  const cam = camera as THREE.Camera & {
    isOrthographicCamera?: boolean;
    isPerspectiveCamera?: boolean;
    zoom?: number; fov?: number;
    near?: number; far?: number;
  };
  if (cam.isOrthographicCamera && cam.zoom) {
    // Ortho: constant regardless of depth
    return halfH * 2 * cam.zoom / 2000;
  }
  // Perspective: reconstruct distance from NDC depth
  const near = cam.near ?? 0.1;
  const far = cam.far ?? 10000;
  // NDC z → linear depth (inverse of perspective projection)
  const linearDepth = (2 * near * far) / (far + near - ndcZ * (far - near));
  if (cam.fov) {
    const halfFovRad = (cam.fov / 2) * Math.PI / 180;
    return halfH / (linearDepth * Math.tan(halfFovRad));
  }
  return 1;
}

export function useGraphLabels(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGraph3d: () => any,
  initialLayoutDone: Ref<boolean>,
  degreeDimmedNodeIds: Ref<Set<string> | null>,
  focusedNodeIds: Ref<Set<string> | null>,
) {
  const graphStore = useGraphStore();
  let labelRenderer: FastLabelRenderer | null = null;
  const labelGrid = new LabelGrid();
  const aabbFilter = new ScreenAABBFilter(20); // reused across frames
  let _clippingPlane: THREE.Plane | null = null;

  // Pre-allocated candidate buffer — grows as needed, never shrinks (avoids GC)
  let candidatePositions: Float64Array = new Float64Array(0); // [x,y,z, x,y,z, ...]
  interface NodeLabelCandidate {
    id: string;
    text: string;
    posIdx: number;  // index into candidatePositions (i*3)
    textAlign: 'center' | 'left' | 'right';
    labelScale: number;
    alpha: number;
    nodeSize: number;
    screenSx: number;
    screenSy: number;
    screenSz: number; // NDC depth for priority
    forced: boolean;
    normalizedWidth: number; // pre-computed text width
  }
  let candidates: NodeLabelCandidate[] = [];

  function initRenderer(scene: THREE.Scene) {
    if (labelRenderer) labelRenderer.dispose();
    labelRenderer = new FastLabelRenderer(scene);
  }

  function updateLabels() {
    const graph3d = getGraph3d();
    if (!graph3d || !labelRenderer) return;

    const aesthetics = graphStore.aesthetics;
    const currentData = graph3d.graphData();

    labelRenderer.clear();

    const canShowLabels = initialLayoutDone.value;
    const hubs = graphStore.hubNodeIds;
    const dimmedByDegree = degreeDimmedNodeIds.value;
    const dimAlpha = graphStore.behaviors.degreeDimOpacity;
    const focusFilter = focusedNodeIds.value;
    const { edgeLensMode, edgeLensDimOpacity } = graphStore.behaviors;

    // Camera setup for frustum culling + screen projection
    const camera = graph3d.camera() as THREE.Camera | null;
    let useFrustum = false;
    if (camera) {
      camera.updateMatrixWorld();
      _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreenMatrix);
      useFrustum = true;
    }

    // Density culling setup
    const {
      labelDensityCulling,
      labelDensity,
      labelGridCellSize,
      labelSizeThreshold,
      labelOverlapThreshold,
    } = graphStore.behaviors;

    let allowedLabels: Set<string> | null = null;

    // Compute pixels-per-world-unit for size threshold (global approximation for Phase 1)
    const ORTHO_FRUSTUM = 2000;
    let pixelsPerUnit = 1;
    let vw = 800;
    let vh = 600;
    let zoomFactor = 1;

    if (labelDensityCulling && camera) {
      const renderer = graph3d.renderer?.() as THREE.WebGLRenderer | null;
      vw = renderer ? renderer.domElement.clientWidth : 800;
      vh = renderer ? renderer.domElement.clientHeight : 600;
      const halfW = vw / 2;
      const halfH = vh / 2;

      labelGrid.resize(vw, vh, labelGridCellSize);

      const cam = camera as THREE.Camera & {
        zoom?: number; isOrthographicCamera?: boolean;
        isPerspectiveCamera?: boolean; fov?: number;
      };
      if (cam.isOrthographicCamera && cam.zoom) {
        zoomFactor = cam.zoom;
        pixelsPerUnit = vh * cam.zoom / ORTHO_FRUSTUM;
      } else {
        const controls = graph3d.controls?.();
        if (controls?.target) {
          const dist = camera.position.distanceTo(controls.target);
          zoomFactor = Math.max(0.1, 1000 / dist);
          if (cam.fov) {
            const halfFovRad = (cam.fov / 2) * Math.PI / 180;
            pixelsPerUnit = halfH / (dist * Math.tan(halfFovRad));
          }
        }
      }

      const relSize = aesthetics.nodeSize / 2;

      // Force-show labels for selected/hovered nodes
      const forcedNodeIds = new Set<string>();
      for (const id of graphStore.selectedNodeIds) forcedNodeIds.add(id);
      if (graphStore.hoveredNodeId) forcedNodeIds.add(graphStore.hoveredNodeId);

      // Phase 1: populate grid with visible node labels
      if (aesthetics.showNodeLabels3D && canShowLabels) {
        currentData.nodes.forEach((node: GraphNode) => {
          if (node.hidden) return;
          if (node.x === undefined || node.y === undefined || node.z === undefined) return;
          if (_clippingPlane) {
            _point.set(node.x, node.y, node.z);
            if (_clippingPlane.distanceToPoint(_point) < 0) return;
          }
          if (useFrustum) {
            _point.set(node.x, node.y, node.z);
            if (!_frustum.containsPoint(_point)) return;
          }
          if (forcedNodeIds.has(node.id)) return;

          const worldRadius = Math.cbrt(node.size ?? 1) * relSize;
          const screenRadius = worldRadius * pixelsPerUnit;
          if (screenRadius < labelSizeThreshold) return;

          if (!projectToScreenInline(node.x, node.y, node.z, camera, halfW, halfH, _screenCoords)) return;
          labelGrid.add(`node-${node.id}`, node.size ?? 1, _screenCoords.sx, _screenCoords.sy);
        });
      }

      // Phase 1b: populate grid with visible edge labels
      if (aesthetics.showEdgeLabels3D && canShowLabels) {
        currentData.links.forEach((link: GraphLink) => {
          if (link.hidden) return;
          const source = typeof link.source === 'object' ? link.source : null;
          const target = typeof link.target === 'object' ? link.target : null;
          if (!source || !target) return;
          if (source.x === undefined || source.y === undefined || source.z === undefined) return;
          if (target.x === undefined || target.y === undefined || target.z === undefined) return;
          const curveMid = link.__curve?.getPoint(0.5);
          const midX = curveMid ? curveMid.x : (source.x + target.x) / 2;
          const midY = curveMid ? curveMid.y : (source.y + target.y) / 2;
          const midZ = curveMid ? curveMid.z : (source.z + target.z) / 2;
          if (_clippingPlane) {
            _point.set(midX, midY, midZ);
            if (_clippingPlane.distanceToPoint(_point) < 0) return;
          }
          if (useFrustum) {
            _point.set(midX, midY, midZ);
            if (!_frustum.containsPoint(_point)) return;
          }
          if (!projectToScreenInline(midX, midY, midZ, camera, halfW, halfH, _screenCoords)) return;
          labelGrid.add(`edge-${link.id}`, 0.5, _screenCoords.sx, _screenCoords.sy);
        });
      }

      labelGrid.organize();
      allowedLabels = labelGrid.getLabelsToDisplay(zoomFactor, labelDensity);

      for (const id of forcedNodeIds) {
        allowedLabels.add(`node-${id}`);
      }
    }

    // Zoom compensation
    let zoomCompensation = 1;
    if (labelDensityCulling && camera) {
      const cam = camera as THREE.Camera & { zoom?: number; isOrthographicCamera?: boolean; fov?: number };
      let zf = 1;
      if (cam.isOrthographicCamera && cam.zoom) {
        zf = cam.zoom;
      } else {
        const controls = graph3d.controls?.();
        if (controls?.target) {
          const dist = camera.position.distanceTo(controls.target);
          zf = Math.max(0.1, 1000 / dist);
        }
      }
      zoomCompensation = Math.min(4, Math.max(0.3, 1 / Math.sqrt(zf)));
    }

    // Node labels
    if (aesthetics.showNodeLabels3D && canShowLabels) {
      const labelOffset = aesthetics.nodeLabelOffsetY3D ?? 2;
      const labelPosition = aesthetics.nodeLabelPosition3D ?? 'right';
      const relSize = aesthetics.nodeSize / 2;
      const baseLabelScale = aesthetics.nodeLabelSize3D / 3;

      // Camera right vector for right/left positioning
      const cameraRight = new THREE.Vector3();
      if (labelPosition !== 'top' && camera) {
        const e = camera.matrixWorld.elements;
        cameraRight.set(e[0], e[1], e[2]).normalize();
      }

      const halfW = vw / 2;
      const halfH = vh / 2;

      // Ensure position buffer is large enough
      const nodeCount = currentData.nodes.length;
      if (candidatePositions.length < nodeCount * 3) {
        candidatePositions = new Float64Array(nodeCount * 3);
      }
      // Reuse candidates array (clear length, keep capacity)
      candidates.length = 0;

      let candidateIdx = 0;
      currentData.nodes.forEach((node: GraphNode) => {
        if (node.hidden) return;
        if (node.x !== undefined && node.y !== undefined && node.z !== undefined) {
          if (_clippingPlane) {
            _point.set(node.x, node.y, node.z);
            if (_clippingPlane.distanceToPoint(_point) < 0) return;
          }
          if (useFrustum) {
            _point.set(node.x, node.y, node.z);
            if (!_frustum.containsPoint(_point)) return;
          }

          const isForced = graphStore.selectedNodeIds.has(node.id) ||
            graphStore.hoveredNodeId === node.id;
          if (!isForced && allowedLabels && !allowedLabels.has(`node-${node.id}`)) return;

          let alpha = 1.0;
          if (dimmedByDegree?.has(node.id)) alpha = Math.min(alpha, dimAlpha);
          if (edgeLensMode === 'dim' && focusFilter !== null && !focusFilter.has(node.id)) {
            alpha = Math.min(alpha, edgeLensDimOpacity);
          }
          const visualRadius = Math.cbrt(node.size) * relSize;
          const scaledOffset = labelOffset + visualRadius * 0.15;

          const importance = labelDensityCulling
            ? Math.pow(node.size ?? 1, 1 / 6)
            : 1;
          const labelScale = baseLabelScale * zoomCompensation * importance;

          // Compute label position into scratch vector
          let textAlign: 'center' | 'left' | 'right';
          if (labelPosition === 'right') {
            _labelPos.set(
              node.x + cameraRight.x * (visualRadius + scaledOffset),
              node.y + cameraRight.y * (visualRadius + scaledOffset),
              node.z + cameraRight.z * (visualRadius + scaledOffset),
            );
            textAlign = 'left';
          } else if (labelPosition === 'left') {
            _labelPos.set(
              node.x - cameraRight.x * (visualRadius + scaledOffset),
              node.y - cameraRight.y * (visualRadius + scaledOffset),
              node.z - cameraRight.z * (visualRadius + scaledOffset),
            );
            textAlign = 'right';
          } else {
            _labelPos.set(node.x, node.y + visualRadius + scaledOffset, node.z);
            textAlign = 'center';
          }

          // Store position in flat buffer
          const posIdx = candidateIdx * 3;
          candidatePositions[posIdx] = _labelPos.x;
          candidatePositions[posIdx + 1] = _labelPos.y;
          candidatePositions[posIdx + 2] = _labelPos.z;

          // Single projection — cached for both depth sorting and AABB placement
          let screenSx = 0, screenSy = 0, screenSz = 1;
          if (camera) {
            if (projectToScreenInline(_labelPos.x, _labelPos.y, _labelPos.z, camera, halfW, halfH, _screenCoords)) {
              screenSx = _screenCoords.sx;
              screenSy = _screenCoords.sy;
              screenSz = _screenCoords.sz;
            }
          }

          candidates.push({
            id: `node-${node.id}`,
            text: node.label,
            posIdx,
            textAlign,
            labelScale,
            alpha,
            nodeSize: node.size ?? 1,
            screenSx,
            screenSy,
            screenSz,
            forced: isForced,
            normalizedWidth: computeNormalizedTextWidth(node.label),
          });
          candidateIdx++;
        }
      });

      // Sort by priority: forced first, larger nodes, closer to camera, deterministic tiebreak
      candidates.sort((a, b) => {
        if (a.forced !== b.forced) return a.forced ? -1 : 1;
        if (a.nodeSize !== b.nodeSize) return b.nodeSize - a.nodeSize;
        if (a.screenSz !== b.screenSz) return a.screenSz - b.screenSz;
        // Deterministic tiebreak by id to prevent flickering
        return a.id < b.id ? -1 : 1;
      });

      // Phase 2.5: Greedy AABB overlap filtering
      const useAABB = labelDensityCulling && camera;
      if (useAABB) {
        aabbFilter.reset(vw, vh);
      }

      for (const c of candidates) {
        if (useAABB) {
          // Per-label screen size using actual depth (perspective-correct)
          const ppu = pixelsPerUnitAtDepth(c.screenSz, camera!, halfH);
          const worldScale = c.labelScale * LABEL_BASE_SCALE;
          const screenWidth = c.normalizedWidth * worldScale * ppu;
          const screenHeight = NORMALIZED_TEXT_HEIGHT * worldScale * ppu;

          if (c.forced) {
            // Forced labels always render but MUST occupy space
            aabbFilter.tryPlace(c.screenSx, c.screenSy, screenWidth, screenHeight, c.textAlign, 1.0);
          } else {
            if (!aabbFilter.tryPlace(c.screenSx, c.screenSy, screenWidth, screenHeight, c.textAlign, labelOverlapThreshold)) {
              continue;
            }
          }
        }

        // Read position back from flat buffer
        const pi = c.posIdx;
        labelRenderer!.addLabel({
          id: c.id,
          text: c.text,
          position: new THREE.Vector3(candidatePositions[pi], candidatePositions[pi + 1], candidatePositions[pi + 2]),
          color: nodeLabelColor,
          scale: c.labelScale,
          alpha: c.alpha,
          textAlign: c.textAlign,
        });
      }
    }

    // Edge labels
    if (aesthetics.showEdgeLabels3D && canShowLabels) {
      const baseEdgeLabelScale = aesthetics.edgeLabelSize3D / 3;
      const edgeLabelScale = baseEdgeLabelScale * zoomCompensation;
      currentData.links.forEach((link: GraphLink) => {
        if (link.hidden) return;
        const source = typeof link.source === 'object' ? link.source : null;
        const target = typeof link.target === 'object' ? link.target : null;
        if (source && target &&
            source.x !== undefined && source.y !== undefined && source.z !== undefined &&
            target.x !== undefined && target.y !== undefined && target.z !== undefined) {
          const curveMid = link.__curve?.getPoint(0.5);
          const midX = curveMid ? curveMid.x : (source.x + target.x) / 2;
          const midY = curveMid ? curveMid.y : (source.y + target.y) / 2;
          const midZ = curveMid ? curveMid.z : (source.z + target.z) / 2;

          if (_clippingPlane) {
            _point.set(midX, midY, midZ);
            if (_clippingPlane.distanceToPoint(_point) < 0) return;
          }
          if (useFrustum) {
            _point.set(midX, midY, midZ);
            if (!_frustum.containsPoint(_point)) return;
          }
          if (allowedLabels && !allowedLabels.has(`edge-${link.id}`)) return;

          const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
          const targetId = typeof link.target === 'string' ? link.target : link.target.id;
          let alpha = 1.0;
          if (hubs !== null) {
            const srcIsHub = hubs.has(sourceId);
            const dstIsHub = hubs.has(targetId);
            if ((srcIsHub && !dstIsHub) || (!srcIsHub && dstIsHub)) {
              alpha = Math.min(alpha, dimAlpha);
            }
          }
          if (edgeLensMode === 'dim' && focusFilter !== null) {
            if (!focusFilter.has(sourceId) || !focusFilter.has(targetId)) {
              alpha = Math.min(alpha, edgeLensDimOpacity);
            }
          }

          labelRenderer!.addLabel({
            id: `edge-${link.id}`,
            text: link.label,
            position: new THREE.Vector3(midX, midY, midZ),
            color: edgeLabelColor,
            scale: edgeLabelScale,
            alpha,
          });
        }
      });
    }

    labelRenderer.updateMesh();
  }

  function setLabelsVisible(visible: boolean) {
    if (labelRenderer) {
      labelRenderer.setGlobalVisible(visible);
    }
  }

  function setClippingPlane(plane: THREE.Plane | null) {
    _clippingPlane = plane;
  }

  function dispose() {
    if (labelRenderer) {
      labelRenderer.dispose();
      labelRenderer = null;
    }
  }

  return {
    initRenderer,
    updateLabels,
    setLabelsVisible,
    setClippingPlane,
    dispose,
  };
}
