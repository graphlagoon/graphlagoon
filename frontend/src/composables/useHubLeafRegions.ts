/**
 * Draws the regions of a hub leaf arrangement (utils/hubLeaves.ts): a faint
 * circle around each crown or petal and a label with what it holds and how
 * many ("Person (114)"). The label is the count the canvas otherwise lacks,
 * so it is always shown, at any zoom.
 *
 * Regions are anchored to their hub, which the force layout moves, so
 * `update()` runs on every engine tick (a few objects, cheap).
 */
import * as THREE from 'three';
import { FastLabelRenderer } from '@/utils/FastLabelRenderer';
import { regionLabel, type HubLeafRegion } from '@/utils/hubLeaves';

const REGION_COLOR = 0x888888;
const LABEL_COLOR = new THREE.Color(0.4, 0.4, 0.4);
/** Region labels sit a little under a hub's own label and, like node labels, keep their size on screen. */
const LABEL_SCALE = 32; // ≈ 13 px of text at camera zoom 1 in the 2D (orthographic) view
const CIRCLE_SEGMENTS = 96;
const RENDER_ORDER = 997; // under the layout guides (998)

interface DrawnRegion {
  region: HubLeafRegion;
  line: THREE.LineLoop;
  labelId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useHubLeafRegions(getGraph3d: () => any) {
  let scene: THREE.Scene | null = null;
  let labels: FastLabelRenderer | null = null;
  /** Glyph instances the label renderer was sized for (it counts glyphs, not labels). */
  let labelCapacity = 0;
  let drawn: DrawnRegion[] = [];
  const _pos = new THREE.Vector3();

  function dropLabels() {
    labels?.dispose();
    labels = null;
    labelCapacity = 0;
  }

  /** Remove what is drawn; on a scene a re-init replaced, also let go of it and its renderer. */
  function clear() {
    const current: THREE.Scene | null = getGraph3d()?.scene?.() ?? null;
    for (const d of drawn) {
      scene?.remove(d.line);
      d.line.geometry.dispose();
      (d.line.material as THREE.Material).dispose();
      labels?.removeLabel(d.labelId);
    }
    drawn = [];
    if (current !== scene) {
      dropLabels();
      scene = current;
    } else {
      labels?.updateMesh();
    }
  }

  function show(regions: HubLeafRegion[]) {
    clear();
    if (!scene || regions.length === 0) return;
    const glyphs = regions.reduce((n, r) => n + regionLabel(r).length, 0);
    if (labels && labelCapacity < glyphs) dropLabels();
    if (!labels) {
      labelCapacity = Math.max(1024, Math.ceil(glyphs * 1.5));
      labels = new FastLabelRenderer(scene, labelCapacity);
    }

    regions.forEach((region, i) => {
      const points: THREE.Vector3[] = [];
      for (let s = 0; s < CIRCLE_SEGMENTS; s++) {
        const a = (s / CIRCLE_SEGMENTS) * 2 * Math.PI;
        points.push(new THREE.Vector3(region.radius * Math.cos(a), region.radius * Math.sin(a), 0));
      }
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: REGION_COLOR, transparent: true, opacity: 0.3, depthTest: false }),
      );
      line.renderOrder = RENDER_ORDER;
      scene!.add(line);
      const labelId = `hub-region-${i}`;
      labels!.addLabel({
        id: labelId,
        text: regionLabel(region),
        position: new THREE.Vector3(0, 0, 0),
        color: LABEL_COLOR.clone(),
        scale: 1,
        textAlign: 'center',
      });
      drawn.push({ region, line, labelId });
    });
    rescale();
    update();
  }

  /** Follow the hubs (call on engine tick). */
  function update() {
    if (drawn.length === 0) return;
    const wanted = new Set(drawn.map((d) => d.region.hub));
    const hubs = new Map<string, { x: number; y: number }>();
    const nodes = getGraph3d()?.graphData?.()?.nodes ?? [];
    for (const n of nodes) {
      if (wanted.has(n.id) && n.x !== undefined && n.y !== undefined) hubs.set(n.id, n);
    }
    for (const d of drawn) {
      const hub = hubs.get(d.region.hub);
      if (!hub) continue;
      const cx = hub.x + d.region.dx;
      const cy = hub.y + d.region.dy;
      d.line.position.set(cx, cy, 0);
      // Label just above the region's top edge.
      labels?.updatePosition(d.labelId, _pos.set(cx, cy + d.region.radius + 6, 0));
    }
    labels?.updateMesh();
  }

  /**
   * Zoomed in: grows slowly (zoom^0.25 on screen), so the text does not balloon.
   * Zoomed out: constant size on screen — a region's count is what a far view
   * is for, unlike node labels, which may fade into the picture.
   */
  function rescale() {
    if (!labels || drawn.length === 0) return;
    const graph3d = getGraph3d();
    const cam = graph3d?.camera?.() as (THREE.Camera & { zoom?: number; isOrthographicCamera?: boolean }) | undefined;
    if (!cam) return;
    let zoom = 1;
    if (cam.isOrthographicCamera && cam.zoom) zoom = cam.zoom;
    else {
      const target = graph3d.controls?.()?.target;
      if (target) zoom = Math.max(0.1, 1000 / cam.position.distanceTo(target));
    }
    labels.setBaseScale(LABEL_SCALE * (zoom >= 1 ? Math.pow(zoom, -0.75) : 1 / zoom));
  }

  function dispose() {
    clear();
    dropLabels();
    scene = null;
  }

  return { show, update, rescale, clear, dispose };
}
