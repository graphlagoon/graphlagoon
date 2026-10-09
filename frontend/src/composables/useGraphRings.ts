/**
 * Provenance rings (investigation workspace, T2): one colored ring per source
 * around each node of a unified graph. Colors come from
 * `graphStore.investigationMode.rings` (see `provenanceRingColors`).
 *
 * shortcut: one THREE.Sprite per ring (sprites billboard for free); move to an
 * instanced billboard like FastIconRenderer if case graphs reach tens of thousands of nodes.
 */
import * as THREE from 'three';
import { useGraphStore } from '@/stores/graph';
import type { GraphNode } from '@/types/graph3d';

const RING_GAP = 0.3;

function ringTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  return new THREE.CanvasTexture(canvas);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useGraphRings(getGraph3d: () => any) {
  const graphStore = useGraphStore();
  let group: THREE.Group | null = null;
  let texture: THREE.Texture | null = null;
  const materials = new Map<string, THREE.SpriteMaterial>();
  const pool: THREE.Sprite[] = [];

  function initRenderer(scene: THREE.Scene) {
    dispose();
    group = new THREE.Group();
    scene.add(group);
    texture = ringTexture();
  }

  function material(color: string): THREE.SpriteMaterial {
    let m = materials.get(color);
    if (!m) {
      m = new THREE.SpriteMaterial({ map: texture, color: new THREE.Color(color), depthWrite: false, transparent: true });
      materials.set(color, m);
    }
    return m;
  }

  function updateRings() {
    const graph3d = getGraph3d();
    if (!graph3d || !group) return;
    const rings = graphStore.investigationMode?.rings;
    let used = 0;
    if (rings && rings.size > 0) {
      const relSize = graphStore.aesthetics.nodeSize / 2;
      for (const node of graph3d.graphData().nodes as GraphNode[]) {
        if (node.hidden) continue;
        const colors = rings.get(node.id);
        if (!colors) continue;
        const diameter = Math.cbrt(node.size || 1) * relSize * 2;
        colors.forEach((color, i) => {
          let sprite = pool[used];
          if (!sprite) {
            sprite = new THREE.Sprite(material(color));
            pool.push(sprite);
            group!.add(sprite);
          }
          sprite.material = material(color);
          sprite.position.set(node.x || 0, node.y || 0, node.z || 0);
          const s = diameter * (1.35 + RING_GAP * i);
          sprite.scale.set(s, s, 1);
          sprite.visible = true;
          used++;
        });
      }
    }
    for (let i = used; i < pool.length; i++) pool[i].visible = false;
  }

  function dispose() {
    if (group) {
      group.parent?.remove(group);
      group = null;
    }
    pool.length = 0;
    materials.forEach((m) => m.dispose());
    materials.clear();
    texture?.dispose();
    texture = null;
  }

  return { initRenderer, updateRings, dispose };
}
