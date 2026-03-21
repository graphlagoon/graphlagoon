/**
 * Composable for 3D graph node icon rendering.
 *
 * Manages the FastIconRenderer lifecycle and bridges store state to GPU.
 * Icons replace spheres for node types that have an icon assigned.
 * Respects all visibility states: hidden, filtered, dimmed.
 */
import * as THREE from 'three';
import type { Ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { IconAtlas } from '@/utils/IconAtlas';
import { FastIconRenderer } from '@/utils/FastIconRenderer';
import type { GraphNode } from '@/types/graph3d';

// Reusable objects (avoid GC pressure)
const _bgColor = new THREE.Color();
const _iconColor = new THREE.Color();
const _position = new THREE.Vector3();

// Regex for rgba(r,g,b,a) strings
const RGBA_RE = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/;

/**
 * Parse a color string (hex or rgba) into RGB components (0..1) and alpha.
 * For hex like '#42b883', alpha defaults to 1.
 * For rgba like 'rgba(204,204,204,0.3)', extracts alpha.
 */
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
  // Hex color
  const c = new THREE.Color(colorStr);
  return { r: c.r, g: c.g, b: c.b, alpha: 1 };
}

/**
 * Compute auto-contrast icon color: white on dark bg, dark on light bg.
 */
function contrastIconColor(bgR: number, bgG: number, bgB: number): THREE.Color {
  // Relative luminance (simplified sRGB)
  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  return luminance > 0.5
    ? _iconColor.setRGB(0.1, 0.1, 0.1)
    : _iconColor.setRGB(1, 1, 1);
}

export function useGraphIcons(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGraph3d: () => any,
  initialLayoutDone: Ref<boolean>,
) {
  const graphStore = useGraphStore();
  let iconRenderer: FastIconRenderer | null = null;
  let atlas: IconAtlas | null = null;

  function initRenderer(scene: THREE.Scene) {
    if (iconRenderer) iconRenderer.dispose();
    if (atlas) atlas.dispose();

    atlas = new IconAtlas();
    iconRenderer = new FastIconRenderer(scene, atlas);
  }

  function updateIcons() {
    const graph3d = getGraph3d();
    if (!graph3d || !iconRenderer || !atlas) return;

    const nodeTypeIcons = graphStore.nodeTypeIcons;

    // Fast path: no icons assigned
    if (nodeTypeIcons.size === 0) {
      iconRenderer.clear();
      iconRenderer.updateMesh();
      return;
    }

    if (!initialLayoutDone.value) return;

    const currentData = graph3d.graphData();
    const aesthetics = graphStore.aesthetics;
    const nodeRelSize = aesthetics.nodeSize / 2;

    // Clear and rebuild all icons
    iconRenderer.clear();

    for (const node of currentData.nodes as GraphNode[]) {
      // Skip hidden nodes (respects type filters, search, lens hide)
      if (node.hidden) continue;
      // Skip cluster nodes (they have custom geometry)
      if (node.isCluster) continue;

      const iconName = nodeTypeIcons.get(node.nodeType);
      if (!iconName) continue;
      if (!atlas.entries.has(iconName)) continue;

      // Read the preserved appearance color (with dimming info)
      const colorStr = node.__iconColor || node.color;
      const { r, g, b, alpha } = parseColorAndAlpha(colorStr);

      _bgColor.setRGB(r, g, b);
      const iconColor = contrastIconColor(r, g, b);

      // Match sphere size: radius = cbrt(val) * relSize, diameter = radius * 2
      const radius = Math.cbrt(node.size || 1) * nodeRelSize;
      const diameter = radius * 2;

      _position.set(node.x || 0, node.y || 0, node.z || 0);

      iconRenderer.setIcon(node.id, {
        position: _position.clone(),
        iconName,
        bgColor: _bgColor.clone(),
        iconColor: iconColor.clone(),
        scale: diameter,
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
    if (atlas) {
      atlas.dispose();
      atlas = null;
    }
  }

  return {
    initRenderer,
    updateIcons,
    setIconsVisible,
    dispose,
  };
}
