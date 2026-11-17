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
import { pixelsPerWorldUnit } from '@/utils/screenScale';

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
  text: string;
  /** Unit vector from the hub to the region: the label sits outside the region, on that side. */
  ux: number;
  uy: number;
  align: 'center' | 'left' | 'right';
}

/** One label for all of a hub's petals, used when they are too small on screen for one label each. */
interface HubSummary {
  labelId: string;
  text: string;
  /** Distance from the hub to the outer edge of its arrangement. */
  outer: number;
  /** Largest petal radius: below COMPACT_BELOW_PX on screen the petal labels would overlap. */
  largest: number;
}

/** A petal narrower than this on screen (radius) cannot hold its own label without overlapping its neighbours'. */
const COMPACT_BELOW_PX = 30;
/** Gap between a region's circle and its label, on screen. */
const LABEL_GAP_PX = 4;
/** Region label text height on screen at camera zoom 1 (LABEL_SCALE). */
const LABEL_TEXT_PX = 13;
/** A region this far sideways from its hub gets a label aligned away from it (left/right), else centred. */
const SIDE_ALIGN = 0.35;

/**
 * Where a region's label goes: outside the region, on the side away from the
 * hub. Above the top edge, as before, put the label of a petal under the hub
 * on the hub's own name.
 */
export function regionLabelSide(dx: number, dy: number): { ux: number; uy: number; align: 'center' | 'left' | 'right' } {
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { ux: 0, uy: 1, align: 'center' }; // crown: around the hub, label on top
  const ux = dx / d;
  const uy = dy / d;
  return { ux, uy, align: ux > SIDE_ALIGN ? 'left' : ux < -SIDE_ALIGN ? 'right' : 'center' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useHubLeafRegions(getGraph3d: () => any) {
  let scene: THREE.Scene | null = null;
  let labels: FastLabelRenderer | null = null;
  /** Glyph instances the label renderer was sized for (it counts glyphs, not labels). */
  let labelCapacity = 0;
  let drawn: DrawnRegion[] = [];
  let summaries = new Map<string, HubSummary>();
  /** Hubs currently labelled by their summary instead of per petal. */
  let compact = new Set<string>();
  /** Screen pixels per world unit and label text height on screen, from the last rescale(). */
  let ppu = 1;
  let textPx = LABEL_TEXT_PX;
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
    for (const s of summaries.values()) labels?.removeLabel(s.labelId);
    drawn = [];
    summaries = new Map();
    compact = new Set();
    if (current !== scene) {
      dropLabels();
      scene = current;
    } else {
      labels?.updateMesh();
    }
  }

  /** hiddenByRegion: leaves reveal-on-zoom hides, per region (the "+N hidden" mark). */
  function show(regions: HubLeafRegion[], hiddenByRegion: number[] = []) {
    clear();
    if (!scene || regions.length === 0) return;
    const texts = regions.map((r, i) => regionLabel(r, hiddenByRegion[i] ?? 0));
    // Hubs with several petals also get a summary label, for far zoom.
    const byHub = new Map<string, { leaves: number; groups: number; hidden: number; outer: number; largest: number }>();
    regions.forEach((r, i) => {
      const h = byHub.get(r.hub) ?? { leaves: 0, groups: 0, hidden: 0, outer: 0, largest: 0 };
      h.leaves += r.count;
      h.groups++;
      h.hidden += hiddenByRegion[i] ?? 0;
      h.outer = Math.max(h.outer, Math.hypot(r.dx, r.dy) + r.radius);
      h.largest = Math.max(h.largest, r.radius);
      byHub.set(r.hub, h);
    });
    for (const [hub, h] of byHub) {
      if (h.groups < 2) continue;
      const text = `${h.leaves} leaves, ${h.groups} groups${h.hidden ? ` +${h.hidden} hidden` : ''}`;
      summaries.set(hub, { labelId: `hub-summary-${hub}`, text, outer: h.outer, largest: h.largest });
    }
    const glyphs = texts.reduce((n, t) => n + t.length, 0) + [...summaries.values()].reduce((n, s) => n + s.text.length, 0);
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
      const side = regionLabelSide(region.dx, region.dy);
      addText(labelId, texts[i], side.align);
      drawn.push({ region, line, labelId, text: texts[i], ...side });
    });
    rescale();
    update();
  }

  function addText(id: string, text: string, textAlign: 'center' | 'left' | 'right' = 'center') {
    labels!.addLabel({
      id,
      text,
      position: new THREE.Vector3(0, 0, 0),
      color: LABEL_COLOR.clone(),
      scale: 1,
      textAlign,
    });
  }

  /** Per-petal labels when they fit on screen, else one summary per hub. */
  function syncCompact(ppu: number) {
    if (!labels || summaries.size === 0) return;
    const next = new Set<string>();
    for (const [hub, s] of summaries) if (s.largest * ppu < COMPACT_BELOW_PX) next.add(hub);
    if (next.size === compact.size && [...next].every((h) => compact.has(h))) return;
    for (const d of drawn) {
      const was = compact.has(d.region.hub);
      const now = next.has(d.region.hub);
      if (was === now) continue;
      if (now) labels.removeLabel(d.labelId);
      else addText(d.labelId, d.text, d.align);
    }
    for (const [hub, s] of summaries) {
      const was = compact.has(hub);
      const now = next.has(hub);
      if (was === now) continue;
      if (now) addText(s.labelId, s.text);
      else labels.removeLabel(s.labelId);
    }
    compact = next;
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
      // Outside the circle, away from the hub; half the text height more
      // vertically so a centred label clears the circle above or below it.
      if (!compact.has(d.region.hub)) {
        const out = d.region.radius + LABEL_GAP_PX / ppu;
        const lift = (textPx / 2 / ppu) * d.uy;
        labels?.updatePosition(d.labelId, _pos.set(cx + d.ux * out, cy + d.uy * out + lift, 0));
      }
    }
    for (const hub of compact) {
      const h = hubs.get(hub);
      const s = summaries.get(hub);
      if (h && s) labels?.updatePosition(s.labelId, _pos.set(h.x, h.y + s.outer + 6, 0));
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
    ppu = Math.max(1e-6, pixelsPerWorldUnit(graph3d));
    textPx = LABEL_TEXT_PX * (zoom >= 1 ? Math.pow(zoom, 0.25) : 1);
    syncCompact(ppu);
    update();
  }

  function dispose() {
    clear();
    dropLabels();
    scene = null;
  }

  return { show, update, rescale, clear, dispose };
}
