/**
 * FastIconRenderer - High-performance 3D node icons using InstancedMesh + billboard shaders.
 *
 * Renders ALL node icons in 1 draw call via GPU instancing.
 * Each icon is a billboard quad (always faces camera) with a colored circle background
 * and a white/dark icon on top (auto-contrast).
 *
 * Modeled on FastLabelRenderer but much simpler: 1 instance per node (no per-char expansion).
 */

import * as THREE from 'three';
import type { IconAtlas } from './IconAtlas';

export interface IconInstanceData {
  position: THREE.Vector3;
  iconName: string;
  bgColor: THREE.Color;
  iconColor: THREE.Color;
  scale: number;
  alpha: number;
  visible: boolean;
}

// Vertex shader with billboarding (same technique as FastLabelRenderer)
const vertexShader = `
  precision highp float;

  attribute vec3 instancePosition;
  attribute vec4 instanceUvOffset;   // u, v, w, h in atlas
  attribute float instanceScale;
  attribute float instanceVisible;
  attribute vec3 instanceBgColor;
  attribute vec3 instanceIconColor;
  attribute float instanceAlpha;

  uniform float globalVisible;

  varying vec2 vLocalUv;
  varying vec2 vAtlasUv;
  varying float vVisible;
  varying vec3 vBgColor;
  varying vec3 vIconColor;
  varying float vAlpha;

  void main() {
    vVisible = instanceVisible * globalVisible;
    vBgColor = instanceBgColor;
    vIconColor = instanceIconColor;
    vAlpha = instanceAlpha;

    // Local UV for circle shape (0..1 range)
    vLocalUv = uv;

    // Atlas UV for icon texture (flip V to correct orientation)
    vAtlasUv = vec2(
      instanceUvOffset.x + uv.x * instanceUvOffset.z,
      instanceUvOffset.y + (1.0 - uv.y) * instanceUvOffset.w
    );

    // Billboard: always face camera
    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    float scale = instanceScale;

    // position.x, position.y are in range [-0.5, 0.5] (PlaneGeometry)
    vec3 vertexPosition = instancePosition
      + cameraRight * position.x * scale
      + cameraUp * position.y * scale;

    gl_Position = projectionMatrix * viewMatrix * vec4(vertexPosition, 1.0);
  }
`;

// Fragment shader: colored circle bg + icon texture overlay
const fragmentShader = `
  precision highp float;

  uniform sampler2D iconAtlas;

  varying vec2 vLocalUv;
  varying vec2 vAtlasUv;
  varying float vVisible;
  varying vec3 vBgColor;
  varying vec3 vIconColor;
  varying float vAlpha;

  void main() {
    if (vVisible < 0.5) discard;

    // Circle mask from local UV
    float dist = length(vLocalUv - 0.5);
    float circle = smoothstep(0.5, 0.47, dist);

    // Sample icon from atlas (white strokes on transparent)
    vec4 iconTex = texture2D(iconAtlas, vAtlasUv);

    // Composite: bg color with icon color on top
    vec3 color = mix(vBgColor, vIconColor, iconTex.a);

    float alpha = circle * vAlpha;
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

export class FastIconRenderer {
  private scene: THREE.Scene;
  private atlas: IconAtlas;
  private mesh: THREE.InstancedMesh | null = null;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.PlaneGeometry;

  // Icon management
  private icons: Map<string, IconInstanceData> = new Map();
  private maxInstances: number;
  private instanceCount: number = 0;

  // Instance attributes
  private instancePositions: Float32Array;
  private instanceUvOffsets: Float32Array;
  private instanceScales: Float32Array;
  private instanceVisibles: Float32Array;
  private instanceBgColors: Float32Array;
  private instanceIconColors: Float32Array;
  private instanceAlphas: Float32Array;

  // Attribute references
  private positionAttr: THREE.InstancedBufferAttribute | null = null;
  private uvOffsetAttr: THREE.InstancedBufferAttribute | null = null;
  private scaleAttr: THREE.InstancedBufferAttribute | null = null;
  private visibleAttr: THREE.InstancedBufferAttribute | null = null;
  private bgColorAttr: THREE.InstancedBufferAttribute | null = null;
  private iconColorAttr: THREE.InstancedBufferAttribute | null = null;
  private alphaAttr: THREE.InstancedBufferAttribute | null = null;

  constructor(scene: THREE.Scene, atlas: IconAtlas, maxInstances: number = 100000) {
    this.scene = scene;
    this.atlas = atlas;
    this.maxInstances = maxInstances;

    // Initialize arrays
    this.instancePositions = new Float32Array(maxInstances * 3);
    this.instanceUvOffsets = new Float32Array(maxInstances * 4);
    this.instanceScales = new Float32Array(maxInstances);
    this.instanceVisibles = new Float32Array(maxInstances);
    this.instanceBgColors = new Float32Array(maxInstances * 3);
    this.instanceIconColors = new Float32Array(maxInstances * 3);
    this.instanceAlphas = new Float32Array(maxInstances);

    // Defaults
    this.instanceScales.fill(1);
    this.instanceVisibles.fill(1);
    this.instanceAlphas.fill(1);
    this.instanceBgColors.fill(0.5);
    this.instanceIconColors.fill(1);

    // Single quad per icon
    this.geometry = new THREE.PlaneGeometry(1, 1);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        iconAtlas: { value: atlas.texture },
        globalVisible: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.createMesh();
  }

  private createMesh(): void {
    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      this.maxInstances,
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 500; // Between nodes (default) and labels (999)
    this.mesh.count = 0;

    // Create instance attributes
    this.positionAttr = new THREE.InstancedBufferAttribute(this.instancePositions, 3);
    this.uvOffsetAttr = new THREE.InstancedBufferAttribute(this.instanceUvOffsets, 4);
    this.scaleAttr = new THREE.InstancedBufferAttribute(this.instanceScales, 1);
    this.visibleAttr = new THREE.InstancedBufferAttribute(this.instanceVisibles, 1);
    this.bgColorAttr = new THREE.InstancedBufferAttribute(this.instanceBgColors, 3);
    this.iconColorAttr = new THREE.InstancedBufferAttribute(this.instanceIconColors, 3);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.instanceAlphas, 1);

    this.geometry.setAttribute('instancePosition', this.positionAttr);
    this.geometry.setAttribute('instanceUvOffset', this.uvOffsetAttr);
    this.geometry.setAttribute('instanceScale', this.scaleAttr);
    this.geometry.setAttribute('instanceVisible', this.visibleAttr);
    this.geometry.setAttribute('instanceBgColor', this.bgColorAttr);
    this.geometry.setAttribute('instanceIconColor', this.iconColorAttr);
    this.geometry.setAttribute('instanceAlpha', this.alphaAttr);

    this.scene.add(this.mesh);
  }

  /**
   * Set icon for a node (add or update)
   */
  setIcon(nodeId: string, data: IconInstanceData): void {
    this.icons.set(nodeId, data);
  }

  /**
   * Remove icon for a node
   */
  removeIcon(nodeId: string): void {
    this.icons.delete(nodeId);
  }

  /**
   * Update position only (called per-frame during layout)
   */
  updatePosition(nodeId: string, position: THREE.Vector3): void {
    const icon = this.icons.get(nodeId);
    if (icon) {
      icon.position.copy(position);
    }
  }

  /**
   * Toggle global visibility (instant, no rebuild)
   */
  setGlobalVisible(visible: boolean): void {
    this.material.uniforms.globalVisible.value = visible ? 1.0 : 0.0;
    if (this.mesh) {
      this.mesh.visible = visible;
    }
  }

  /**
   * Rebuild GPU buffers from icon data. Call after add/remove/update.
   */
  updateMesh(): void {
    if (!this.mesh) return;

    let idx = 0;

    for (const icon of this.icons.values()) {
      if (!icon.visible) continue;
      if (idx >= this.maxInstances) break;

      const atlasEntry = this.atlas.entries.get(icon.iconName);
      if (!atlasEntry) continue;

      const i3 = idx * 3;
      const i4 = idx * 4;

      // Position
      this.instancePositions[i3] = icon.position.x;
      this.instancePositions[i3 + 1] = icon.position.y;
      this.instancePositions[i3 + 2] = icon.position.z;

      // UV offset in atlas
      this.instanceUvOffsets[i4] = atlasEntry.u;
      this.instanceUvOffsets[i4 + 1] = atlasEntry.v;
      this.instanceUvOffsets[i4 + 2] = atlasEntry.w;
      this.instanceUvOffsets[i4 + 3] = atlasEntry.h;

      // Scale (diameter of the icon circle in world units)
      this.instanceScales[idx] = icon.scale;

      // Visibility
      this.instanceVisibles[idx] = 1;

      // Colors
      this.instanceBgColors[i3] = icon.bgColor.r;
      this.instanceBgColors[i3 + 1] = icon.bgColor.g;
      this.instanceBgColors[i3 + 2] = icon.bgColor.b;

      this.instanceIconColors[i3] = icon.iconColor.r;
      this.instanceIconColors[i3 + 1] = icon.iconColor.g;
      this.instanceIconColors[i3 + 2] = icon.iconColor.b;

      // Alpha (for dimming)
      this.instanceAlphas[idx] = icon.alpha;

      idx++;
    }

    this.instanceCount = idx;
    this.mesh.count = idx;

    // Mark all attributes dirty
    if (this.positionAttr) this.positionAttr.needsUpdate = true;
    if (this.uvOffsetAttr) this.uvOffsetAttr.needsUpdate = true;
    if (this.scaleAttr) this.scaleAttr.needsUpdate = true;
    if (this.visibleAttr) this.visibleAttr.needsUpdate = true;
    if (this.bgColorAttr) this.bgColorAttr.needsUpdate = true;
    if (this.iconColorAttr) this.iconColorAttr.needsUpdate = true;
    if (this.alphaAttr) this.alphaAttr.needsUpdate = true;
  }

  /**
   * Clear all icons
   */
  clear(): void {
    this.icons.clear();
    this.instanceCount = 0;
    if (this.mesh) this.mesh.count = 0;
  }

  /**
   * Get current icon count
   */
  get count(): number {
    return this.instanceCount;
  }

  /**
   * Dispose all GPU resources
   */
  dispose(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.material.dispose();
    this.icons.clear();
  }
}
