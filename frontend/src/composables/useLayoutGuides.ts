/**
 * Composable that draws the presentational guides for the layout modes:
 * - Ego: concentric hop rings (+ dashed "unreachable" ring) and a focus halo
 * - Hive: axis lines with category labels
 *
 * Geometry math lives in utils/layoutModes.ts (computeRingGuideSpec /
 * computeHiveAxesSpec) — this composable only turns specs into THREE objects.
 * Scene is resolved lazily on every show* call so guides survive initGraph
 * re-creating the graph (the caller re-applies the layout mode after re-init).
 */
import * as THREE from 'three';
import { FastLabelRenderer } from '@/utils/FastLabelRenderer';
import type { RingGuideSpec, HiveAxesSpec } from '@/utils/layoutModes';

const GUIDE_COLOR = 0x888888;
const FOCUS_HALO_COLOR = 0xf59e0b;
const CIRCLE_SEGMENTS = 128;
const GUIDE_RENDER_ORDER = 998; // under the rotation axis line (999), over the graph
const LABEL_SCALE = 1.4;
const LABEL_COLOR = new THREE.Color(0.55, 0.55, 0.55);

function circlePoints(radius: number, segments = CIRCLE_SEGMENTS): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * 2 * Math.PI;
    points.push(new THREE.Vector3(radius * Math.cos(angle), radius * Math.sin(angle), 0));
  }
  return points;
}

export function useLayoutGuides(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGraph3d: () => any,
) {
  let cachedScene: THREE.Scene | null = null;
  let objects: THREE.Object3D[] = [];
  let labelRenderer: FastLabelRenderer | null = null;
  let labelIds: string[] = [];

  /** Resolve the current scene; when it changed (re-init), drop stale refs. */
  function resolveScene(): THREE.Scene | null {
    const graph3d = getGraph3d();
    const scene: THREE.Scene | null = graph3d?.scene?.() ?? null;
    if (scene !== cachedScene) {
      // Old scene (and everything we added to it) is gone — drop references
      objects = [];
      labelIds = [];
      labelRenderer?.dispose();
      labelRenderer = null;
      cachedScene = scene;
    }
    return scene;
  }

  function ensureLabelRenderer(scene: THREE.Scene): FastLabelRenderer {
    if (!labelRenderer) {
      // Small instance budget — guides carry a dozen short labels, not 50k
      labelRenderer = new FastLabelRenderer(scene, 512);
    }
    return labelRenderer;
  }

  function addLine(scene: THREE.Scene, points: THREE.Vector3[], opts: { dashed?: boolean; color?: number; opacity?: number; loop?: boolean }) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = opts.dashed
      ? new THREE.LineDashedMaterial({
          color: opts.color ?? GUIDE_COLOR,
          dashSize: 8,
          gapSize: 6,
          transparent: true,
          opacity: opts.opacity ?? 0.35,
          depthTest: false,
        })
      : new THREE.LineBasicMaterial({
          color: opts.color ?? GUIDE_COLOR,
          transparent: true,
          opacity: opts.opacity ?? 0.35,
          depthTest: false,
        });
    const line = opts.loop ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
    if (opts.dashed) line.computeLineDistances(); // required for dashed materials
    line.renderOrder = GUIDE_RENDER_ORDER;
    scene.add(line);
    objects.push(line);
    return line;
  }

  function addLabel(scene: THREE.Scene, id: string, text: string, x: number, y: number, textAlign: 'left' | 'right' | 'center' = 'left') {
    const renderer = ensureLabelRenderer(scene);
    renderer.addLabel({
      id,
      text,
      position: new THREE.Vector3(x, y, 0),
      color: LABEL_COLOR.clone(),
      scale: LABEL_SCALE,
      textAlign,
    });
    labelIds.push(id);
  }

  function clear() {
    const scene = resolveScene();
    for (const obj of objects) {
      scene?.remove(obj);
      (obj as THREE.Line).geometry?.dispose();
      ((obj as THREE.Line).material as THREE.Material)?.dispose();
    }
    objects = [];
    if (labelRenderer) {
      for (const id of labelIds) labelRenderer.removeLabel(id);
      labelRenderer.updateMesh();
    }
    labelIds = [];
  }

  /** Concentric hop rings + optional focus halo at the origin (where forceRadial settles the focus). */
  function showEgoRings(spec: RingGuideSpec, opts: { focusHalo: boolean; ringSpacing: number }) {
    const scene = resolveScene();
    if (!scene) return;
    clear();

    for (const ring of spec.rings) {
      addLine(scene, circlePoints(ring.radius), { dashed: ring.dashed, loop: true });
      addLabel(scene, `ego-ring-${ring.hop}`, ring.label, ring.radius + 6, 6);
    }

    if (opts.focusHalo) {
      addLine(scene, circlePoints(Math.max(8, 0.35 * opts.ringSpacing), 64), {
        loop: true,
        color: FOCUS_HALO_COLOR,
        opacity: 0.9,
      });
    }

    labelRenderer?.updateMesh();
  }

  /**
   * Faint level lines for the layered (hierarchical) layout. Each line spans
   * the layout extent perpendicular to the level axis, with a level label.
   */
  function showLayerLines(spec: {
    layers: { offset: number; label: string; dashed: boolean }[];
    /** 'td': levels grow downward (lines are horizontal); 'lr': rightward (vertical) */
    direction: 'td' | 'lr';
    /** Extent of the layout along the slot axis */
    extent: { min: number; max: number };
  }) {
    const scene = resolveScene();
    if (!scene) return;
    clear();

    const pad = 40;
    const from = spec.extent.min - pad;
    const to = spec.extent.max + pad;

    for (const [i, layer] of spec.layers.entries()) {
      const points = spec.direction === 'td'
        ? [new THREE.Vector3(from, -layer.offset, 0), new THREE.Vector3(to, -layer.offset, 0)]
        : [new THREE.Vector3(layer.offset, from, 0), new THREE.Vector3(layer.offset, to, 0)];
      addLine(scene, points, { dashed: layer.dashed, opacity: 0.25 });
      const labelPos = spec.direction === 'td'
        ? { x: to + 8, y: -layer.offset }
        : { x: layer.offset, y: to + 12 };
      addLabel(scene, `layer-${i}`, layer.label, labelPos.x, labelPos.y, spec.direction === 'td' ? 'left' : 'center');
    }

    labelRenderer?.updateMesh();
  }

  /** Axis lines with category labels just beyond the outer radius. */
  function showHiveAxes(spec: HiveAxesSpec) {
    const scene = resolveScene();
    if (!scene) return;
    clear();

    spec.axes.forEach((axis, i) => {
      addLine(
        scene,
        [
          new THREE.Vector3(axis.inner.x, axis.inner.y, 0),
          new THREE.Vector3(axis.outer.x, axis.outer.y, 0),
        ],
        { opacity: 0.5 }
      );
      addLabel(scene, `hive-axis-${i}`, axis.label, axis.labelPos.x, axis.labelPos.y, axis.textAlign);
    });

    labelRenderer?.updateMesh();
  }

  function dispose() {
    clear();
    labelRenderer?.dispose();
    labelRenderer = null;
    cachedScene = null;
  }

  return { showEgoRings, showHiveAxes, showLayerLines, clear, dispose };
}
