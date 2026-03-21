/**
 * Composable for 3D graph edge icon rendering.
 *
 * Manages a FastIconRenderer for edge type icons, sharing the IconAtlas
 * with the node icon renderer. Icons are positioned at the edge midpoint
 * with a camera-up offset so they sit above the edge label.
 */
import * as THREE from 'three';
import type { Ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import type { IconAtlas } from '@/utils/IconAtlas';
import { FastIconRenderer } from '@/utils/FastIconRenderer';
import type { GraphLink, GraphNode } from '@/types/graph3d';

// Reusable objects (avoid GC pressure)
const _bgColor = new THREE.Color();
const _iconColor = new THREE.Color();
const _position = new THREE.Vector3();

// Regex for rgba(r,g,b,a) strings
const RGBA_RE = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/;

function parseColorAndAlpha(colorStr: string): { r: number; g: number; b: number; alpha: number } {
  const rgbaMatch = colorStr.match(RGBA_RE);
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1]) / 255,
      g: parseInt(rgbaMatch[2]) / 255,
      b: parseInt(rgbaMatch[3]) / 255,
      alpha: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
    };
  }
  const c = new THREE.Color(colorStr);
  return { r: c.r, g: c.g, b: c.b, alpha: 1 };
}

function contrastIconColor(bgR: number, bgG: number, bgB: number): THREE.Color {
  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  return luminance > 0.5
    ? _iconColor.setRGB(0.1, 0.1, 0.1)
    : _iconColor.setRGB(1, 1, 1);
}

export function useGraphEdgeIcons(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGraph3d: () => any,
  initialLayoutDone: Ref<boolean>,
) {
  const graphStore = useGraphStore();
  let iconRenderer: FastIconRenderer | null = null;
  let sharedAtlas: IconAtlas | null = null;

  function initRenderer(scene: THREE.Scene, atlas: IconAtlas) {
    if (iconRenderer) iconRenderer.dispose();
    sharedAtlas = atlas;
    iconRenderer = new FastIconRenderer(scene, atlas);
  }

  function updateIcons() {
    const graph3d = getGraph3d();
    if (!graph3d || !iconRenderer || !sharedAtlas) return;

    const edgeTypeIcons = graphStore.edgeTypeIcons;
    const aesthetics = graphStore.aesthetics;

    // Fast path: no icons assigned or edge labels hidden
    if (edgeTypeIcons.size === 0 || !aesthetics.showEdgeLabels3D) {
      iconRenderer.clear();
      iconRenderer.updateMesh();
      return;
    }

    if (!initialLayoutDone.value) return;

    const currentData = graph3d.graphData();
    const edgeIconSize = (aesthetics as any).edgeIconSize3D ?? 3;
    const baseEdgeLabelScale = aesthetics.edgeLabelSize3D / 3;

    // Get camera up vector for offset
    const camera = graph3d.camera();
    const e = camera.matrixWorld.elements;
    const upX = e[4], upY = e[5], upZ = e[6];

    // Dimming state
    const focusFilter = graphStore.focusedNodeIds;
    const edgeLensMode = graphStore.behaviors.edgeLensMode ?? 'off';
    const edgeLensDimOpacity = graphStore.behaviors.edgeLensDimOpacity ?? 0.08;
    const hubs = graphStore.hubNodeIds;
    const dimAlpha = graphStore.behaviors.degreeDimOpacity ?? 0.2;

    iconRenderer.clear();

    for (const link of currentData.links as GraphLink[]) {
      if (link.hidden) continue;

      const iconName = edgeTypeIcons.get(link.relationshipType);
      if (!iconName) continue;
      if (!sharedAtlas.entries.has(iconName)) continue;

      const source = typeof link.source === 'object' ? link.source : null;
      const target = typeof link.target === 'object' ? link.target : null;
      if (!source || !target) continue;
      if (source.x === undefined || source.y === undefined || source.z === undefined) continue;
      if (target.x === undefined || target.y === undefined || target.z === undefined) continue;

      // Position at edge midpoint
      const curveMid = link.__curve?.getPoint(0.5);
      const midX = curveMid ? curveMid.x : (source.x + target.x) / 2;
      const midY = curveMid ? curveMid.y : (source.y + target.y) / 2;
      const midZ = curveMid ? curveMid.z : (source.z + target.z) / 2;

      const iconScale = edgeIconSize;
      // Offset along camera up vector: half the icon diameter + half label height + small gap
      const offsetDist = iconScale * 0.5 + baseEdgeLabelScale * 0.5 + 0.3;
      _position.set(
        midX + upX * offsetDist,
        midY + upY * offsetDist,
        midZ + upZ * offsetDist,
      );

      // Edge type color as background
      const colorStr = link.color || graphStore.getEdgeTypeColor(link.relationshipType);
      const { r, g, b, alpha: colorAlpha } = parseColorAndAlpha(colorStr);
      _bgColor.setRGB(r, g, b);
      const iconColor = contrastIconColor(r, g, b);

      // Compute alpha (dimming from hubs, edge lens)
      let alpha = colorAlpha;
      const sourceId = typeof link.source === 'string' ? link.source : (link.source as GraphNode).id;
      const targetId = typeof link.target === 'string' ? link.target : (link.target as GraphNode).id;

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

      iconRenderer.setIcon(link.id, {
        position: _position.clone(),
        iconName,
        bgColor: _bgColor.clone(),
        iconColor: iconColor.clone(),
        scale: iconScale,
        alpha,
        visible: true,
      });
    }

    iconRenderer.updateMesh();
  }

  function setIconsVisible(visible: boolean) {
    if (iconRenderer) {
      iconRenderer.setGlobalVisible(visible);
    }
  }

  function dispose() {
    if (iconRenderer) {
      iconRenderer.dispose();
      iconRenderer = null;
    }
    // Don't dispose sharedAtlas — owned by useGraphIcons
    sharedAtlas = null;
  }

  return {
    initRenderer,
    updateIcons,
    setIconsVisible,
    dispose,
  };
}
