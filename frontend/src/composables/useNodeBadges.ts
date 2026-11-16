/**
 * Short text under a node that stays readable at any zoom, e.g. "120 of 380
 * loaded" after a cut expand (hubs-densos F3). Unlike node labels these are
 * never thinned out by the label grid: each one is a warning that something
 * is not on the canvas.
 *
 * `update()` follows the nodes and runs on every engine tick (a handful of
 * labels, cheap).
 */
import * as THREE from 'three';
import { FastLabelRenderer } from '@/utils/FastLabelRenderer';

const LABEL_COLOR = new THREE.Color(0.75, 0.35, 0.05);
const LABEL_SCALE = 28;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useNodeBadges(getGraph3d: () => any, radiusOf: (node: { id: string; size?: number }) => number) {
  let scene: THREE.Scene | null = null;
  let labels: FastLabelRenderer | null = null;
  let capacity = 0;
  let shown = new Map<string, string>(); // node id → text
  let zoom = 1;
  const _pos = new THREE.Vector3();

  function drop() {
    labels?.dispose();
    labels = null;
    capacity = 0;
  }

  function clear() {
    const current: THREE.Scene | null = getGraph3d()?.scene?.() ?? null;
    for (const id of shown.keys()) labels?.removeLabel(`badge-${id}`);
    shown = new Map();
    if (current !== scene) {
      drop();
      scene = current;
    } else {
      labels?.updateMesh();
    }
  }

  /** Replace every badge; same map as shown → nothing to do. */
  function show(badges: Map<string, string>) {
    if (badges.size === shown.size && [...badges].every(([id, t]) => shown.get(id) === t)) {
      const current = getGraph3d()?.scene?.() ?? null;
      if (current === scene) return;
    }
    clear();
    if (!scene || badges.size === 0) return;
    const glyphs = [...badges.values()].reduce((n, t) => n + t.length, 0);
    if (labels && capacity < glyphs) drop();
    if (!labels) {
      capacity = Math.max(512, Math.ceil(glyphs * 1.5));
      labels = new FastLabelRenderer(scene, capacity);
    }
    for (const [id, text] of badges) {
      labels.addLabel({
        id: `badge-${id}`,
        text,
        position: new THREE.Vector3(0, 0, 0),
        color: LABEL_COLOR.clone(),
        scale: 1,
        textAlign: 'center',
      });
    }
    shown = new Map(badges);
    rescale();
    update();
  }

  function update() {
    if (!labels || shown.size === 0) return;
    const nodes = getGraph3d()?.graphData?.()?.nodes ?? [];
    for (const n of nodes) {
      if (!shown.has(n.id) || n.x === undefined || n.y === undefined) continue;
      // Below the node, a fixed gap on screen.
      const gap = radiusOf(n) + 18 / zoom;
      labels.updatePosition(`badge-${n.id}`, _pos.set(n.x, n.y - gap, n.z ?? 0));
    }
    labels.updateMesh();
  }

  /** Constant size on screen. */
  function rescale() {
    const graph3d = getGraph3d();
    const cam = graph3d?.camera?.() as (THREE.Camera & { zoom?: number; isOrthographicCamera?: boolean }) | undefined;
    if (!cam) return;
    if (cam.isOrthographicCamera && cam.zoom) zoom = cam.zoom;
    else {
      const target = graph3d.controls?.()?.target;
      zoom = target ? Math.max(0.1, 1000 / cam.position.distanceTo(target)) : 1;
    }
    labels?.setBaseScale(LABEL_SCALE / zoom);
    update();
  }

  function dispose() {
    clear();
    drop();
    scene = null;
  }

  return { show, update, rescale, clear, dispose };
}
