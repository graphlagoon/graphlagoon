/**
 * FastLabelRenderer - High-performance 3D text labels using InstancedMesh + MSDF
 *
 * Instead of creating individual sprites for each label (like three-spritetext),
 * this renders ALL labels in 1-2 draw calls using GPU instancing.
 *
 * Show/hide is instantaneous via a uniform (no object recreation).
 */

import * as THREE from 'three';

// Import font data
import fontData from '@/assets/fonts/Roboto-Regular.json';
import fontAtlasUrl from '@/assets/fonts/roboto-msdf.png';

interface FontChar {
  id: number;
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  xoffset: number;
  yoffset: number;
  xadvance: number;
}

interface FontData {
  pages: string[];
  chars: FontChar[];
  common: {
    lineHeight: number;
    base: number;
    scaleW: number;
    scaleH: number;
  };
}

interface LabelData {
  id: string;
  text: string;  // May contain '\n' — rendered as a line break
  position: THREE.Vector3;
  color?: THREE.Color;
  scale?: number;
  visible?: boolean;
  alpha?: number;  // Per-label opacity (0..1), default 1
  textAlign?: 'center' | 'left' | 'right'; // Horizontal anchor: center (default), left, right
  /**
   * Vertical anchor of the text block relative to the label origin.
   * 'center' (default): block is centered on the origin — identical to the old
   * single-line baseline for one-line labels. 'bottom': the LAST line's
   * baseline sits at the origin, so extra lines grow upward (use for labels
   * placed above a node).
   */
  verticalAnchor?: 'center' | 'bottom';
}

// Vertex shader with billboarding
const vertexShader = `
  precision highp float;

  // Per-instance attributes
  attribute vec3 instancePosition;
  attribute vec4 instanceUvOffset;  // x, y, width, height in UV space
  attribute vec2 instanceCharOffset; // x, y offset within label (normalized)
  attribute vec2 instanceCharSize;  // width, height of char (normalized)
  attribute float instanceScale;
  attribute float instanceVisible;
  attribute vec3 instanceColor;
  attribute float instanceAlpha;

  // Uniforms
  uniform float globalVisible;
  uniform float baseScale;

  varying vec2 vUv;
  varying float vVisible;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vVisible = instanceVisible * globalVisible;
    vColor = instanceColor;
    vAlpha = instanceAlpha;

    // Calculate UV for this character
    // Only flip V (vertical) to correct orientation
    vUv = vec2(
      instanceUvOffset.x + uv.x * instanceUvOffset.z,
      instanceUvOffset.y + (1.0 - uv.y) * instanceUvOffset.w
    );

    // Billboard: always face camera
    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    float scale = instanceScale * baseScale;

    // Quad vertex position scaled by character size
    // position.x, position.y are in range [-0.5, 0.5]
    float localX = position.x * instanceCharSize.x + instanceCharOffset.x;
    float localY = position.y * instanceCharSize.y + instanceCharOffset.y;

    // Position vertex relative to instance position with billboarding
    vec3 vertexPosition = instancePosition
      + cameraRight * localX * scale
      + cameraUp * localY * scale;

    gl_Position = projectionMatrix * viewMatrix * vec4(vertexPosition, 1.0);
  }
`;

// Fragment shader with MSDF rendering
const fragmentShader = `
  precision highp float;

  uniform sampler2D msdfAtlas;
  uniform float screenPxRange;

  varying vec2 vUv;
  varying float vVisible;
  varying vec3 vColor;
  varying float vAlpha;

  float median(float r, float g, float b) {
    return max(min(r, g), min(max(r, g), b));
  }

  void main() {
    if (vVisible < 0.5) discard;

    vec3 msd = texture2D(msdfAtlas, vUv).rgb;
    float sd = median(msd.r, msd.g, msd.b);
    float screenPxDistance = screenPxRange * (sd - 0.5);
    float opacity = clamp(screenPxDistance + 0.5, 0.0, 1.0) * vAlpha;

    if (opacity < 0.01) discard;

    gl_FragColor = vec4(vColor, opacity);
  }
`;

export class FastLabelRenderer {
  private scene: THREE.Scene;
  private mesh: THREE.InstancedMesh | null = null;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.PlaneGeometry;
  private atlas: THREE.Texture | null = null;
  private fontData: FontData;

  // Label management
  private labels: Map<string, LabelData> = new Map();
  private maxInstances: number;
  private instanceCount: number = 0;

  // Instance attributes
  private instancePositions: Float32Array;
  private instanceUvOffsets: Float32Array;
  private instanceCharOffsets: Float32Array;  // Now vec2 (x, y)
  private instanceCharSizes: Float32Array;
  private instanceScales: Float32Array;
  private instanceVisibles: Float32Array;
  private instanceColors: Float32Array;
  private instanceAlphas: Float32Array;

  // Attribute references for updates
  private positionAttr: THREE.InstancedBufferAttribute | null = null;
  private uvOffsetAttr: THREE.InstancedBufferAttribute | null = null;
  private charOffsetAttr: THREE.InstancedBufferAttribute | null = null;
  private charSizeAttr: THREE.InstancedBufferAttribute | null = null;
  private scaleAttr: THREE.InstancedBufferAttribute | null = null;
  private visibleAttr: THREE.InstancedBufferAttribute | null = null;
  private colorAttr: THREE.InstancedBufferAttribute | null = null;
  private alphaAttr: THREE.InstancedBufferAttribute | null = null;

  private ready: boolean = false;
  private pendingLabels: LabelData[] = [];

  constructor(scene: THREE.Scene, maxInstances: number = 50000) {
    this.scene = scene;
    this.maxInstances = maxInstances;
    this.fontData = fontData as FontData;

    // Initialize arrays
    this.instancePositions = new Float32Array(maxInstances * 3);
    this.instanceUvOffsets = new Float32Array(maxInstances * 4);
    this.instanceCharOffsets = new Float32Array(maxInstances * 2);  // vec2
    this.instanceCharSizes = new Float32Array(maxInstances * 2);
    this.instanceScales = new Float32Array(maxInstances);
    this.instanceVisibles = new Float32Array(maxInstances);
    this.instanceColors = new Float32Array(maxInstances * 3);
    this.instanceAlphas = new Float32Array(maxInstances);

    // Fill with defaults
    this.instanceCharSizes.fill(1);
    this.instanceScales.fill(1);
    this.instanceVisibles.fill(1);
    this.instanceColors.fill(0.2); // Dark gray default
    this.instanceAlphas.fill(1);

    // Create geometry (single quad for each character)
    this.geometry = new THREE.PlaneGeometry(1, 1);

    // Create material
    //
    // Label depth strategy (Sigma.js-style: labels always on top):
    //   Option 1 (chosen): depthTest=false + renderOrder=999
    //     Labels always render on top of nodes/edges, like Sigma.js's 2D canvas overlay.
    //     Density culling already limits visible labels, so "behind" labels are rare.
    //   Option 2: depthTest=true (default)
    //     Labels can be occluded by geometry. More "correct" in 3D but worse UX:
    //     labels get partially cut by nearby nodes.
    //   Option 3: depthTest=true + polygonOffset bias
    //     Labels render slightly in front of their z-position. Labels near their node
    //     appear above it, but far-away geometry still occludes. More complex to tune.
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        msdfAtlas: { value: null },
        screenPxRange: { value: 4.0 },
        globalVisible: { value: 1.0 },
        baseScale: { value: 5.0 }, // Base text height in world units
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,  // Option 1: always on top (see comment above)
      side: THREE.DoubleSide,
    });

    // Load atlas texture
    this.loadAtlas();
  }

  private async loadAtlas(): Promise<void> {
    const loader = new THREE.TextureLoader();

    try {
      this.atlas = await loader.loadAsync(fontAtlasUrl);
      this.atlas.flipY = false; // Don't flip - atlas Y=0 is top, matches font coordinates
      this.atlas.minFilter = THREE.LinearFilter;
      this.atlas.magFilter = THREE.LinearFilter;
      this.material.uniforms.msdfAtlas.value = this.atlas;

      this.createMesh();
      this.ready = true;

      // Process pending labels
      for (const label of this.pendingLabels) {
        this.addLabel(label);
      }
      this.pendingLabels = [];
      this.updateMesh();
    } catch (error) {
      console.error('Failed to load MSDF atlas:', error);
    }
  }

  private createMesh(): void {
    // Create instanced mesh
    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      this.maxInstances
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999; // Render after all geometry (pairs with depthTest=false)
    this.mesh.count = 0;

    // Add instance attributes
    this.positionAttr = new THREE.InstancedBufferAttribute(this.instancePositions, 3);
    this.uvOffsetAttr = new THREE.InstancedBufferAttribute(this.instanceUvOffsets, 4);
    this.charOffsetAttr = new THREE.InstancedBufferAttribute(this.instanceCharOffsets, 2);  // vec2
    this.charSizeAttr = new THREE.InstancedBufferAttribute(this.instanceCharSizes, 2);
    this.scaleAttr = new THREE.InstancedBufferAttribute(this.instanceScales, 1);
    this.visibleAttr = new THREE.InstancedBufferAttribute(this.instanceVisibles, 1);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.instanceColors, 3);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.instanceAlphas, 1);

    this.geometry.setAttribute('instancePosition', this.positionAttr);
    this.geometry.setAttribute('instanceUvOffset', this.uvOffsetAttr);
    this.geometry.setAttribute('instanceCharOffset', this.charOffsetAttr);
    this.geometry.setAttribute('instanceCharSize', this.charSizeAttr);
    this.geometry.setAttribute('instanceScale', this.scaleAttr);
    this.geometry.setAttribute('instanceVisible', this.visibleAttr);
    this.geometry.setAttribute('instanceColor', this.colorAttr);
    this.geometry.setAttribute('instanceAlpha', this.alphaAttr);

    this.scene.add(this.mesh);
  }

  /**
   * Add or update a label
   */
  addLabel(data: LabelData): void {
    if (!this.ready) {
      this.pendingLabels.push(data);
      return;
    }

    this.labels.set(data.id, {
      ...data,
      color: data.color || new THREE.Color(0.2, 0.2, 0.2),
      scale: data.scale || 1,
      visible: data.visible !== false,
      alpha: data.alpha ?? 1,
      textAlign: data.textAlign ?? 'center',
      verticalAnchor: data.verticalAnchor ?? 'center',
    });
  }

  /**
   * Remove a label
   */
  removeLabel(id: string): void {
    this.labels.delete(id);
  }

  /**
   * Update label position
   */
  updatePosition(id: string, position: THREE.Vector3): void {
    const label = this.labels.get(id);
    if (label) {
      label.position.copy(position);
    }
  }

  /**
   * Set global visibility (instant, no object recreation)
   */
  setGlobalVisible(visible: boolean): void {
    this.material.uniforms.globalVisible.value = visible ? 1.0 : 0.0;
    // Also toggle mesh.visible for reliable Three.js render-loop skipping
    if (this.mesh) {
      this.mesh.visible = visible;
    }
  }

  /**
   * Set base scale for all labels
   */
  setBaseScale(scale: number): void {
    this.material.uniforms.baseScale.value = scale;
  }

  /**
   * Rebuild instance data from labels - call after adding/removing labels
   */
  updateMesh(): void {
    if (!this.ready || !this.mesh) return;

    const atlasWidth = this.fontData.common?.scaleW || 512;
    const atlasHeight = this.fontData.common?.scaleH || 512;
    const lineHeight = this.fontData.common?.lineHeight || 63;
    const base = this.fontData.common?.base || 50;

    let instanceIdx = 0;
    let capacityExceeded = false;

    for (const label of this.labels.values()) {
      if (capacityExceeded) break;
      if (!label.visible) continue;

      const lines = label.text.split('\n');
      const lineCount = lines.length;

      // Per-line widths (normalized by lineHeight) for horizontal alignment
      const lineWidths: number[] = new Array(lineCount);
      for (let li = 0; li < lineCount; li++) {
        let w = 0;
        for (const char of lines[li]) {
          const charData = resolveCharData(char);
          if (charData) w += charData.xadvance / lineHeight;
        }
        lineWidths[li] = w;
      }

      const align = label.textAlign ?? 'center';
      // Baseline of line 0 (topmost). 'center' keeps the block centered on the
      // origin — for a single line this is baseline 0, exactly the old layout.
      // 'bottom' pins the LAST baseline at 0 so extra lines grow upward.
      const firstBaselineY = (label.verticalAnchor ?? 'center') === 'bottom'
        ? lineCount - 1
        : (lineCount - 1) / 2;

      for (let li = 0; li < lineCount && !capacityExceeded; li++) {
        const baselineY = firstBaselineY - li;
        const lineWidth = lineWidths[li];

        // Cursor position based on text alignment
        let cursorX = align === 'center' ? -lineWidth / 2
          : align === 'left' ? 0
          : -lineWidth;

        for (const char of lines[li]) {
          if (instanceIdx >= this.maxInstances) {
            console.warn(`[FastLabelRenderer] Max instances (${this.maxInstances}) reached. Some labels may not be visible.`);
            capacityExceeded = true;
            break;
          }

          const charData = resolveCharData(char);
          if (!charData) continue;

          // Skip space (no visual, just advance cursor)
          if (char === ' ') {
            cursorX += charData.xadvance / lineHeight;
            continue;
          }

          const idx = instanceIdx;
          const idx2 = idx * 2;
          const idx3 = idx * 3;
          const idx4 = idx * 4;

          // Position (label origin)
          this.instancePositions[idx3] = label.position.x;
          this.instancePositions[idx3 + 1] = label.position.y;
          this.instancePositions[idx3 + 2] = label.position.z;

          // UV offset (normalized coordinates in atlas)
          this.instanceUvOffsets[idx4] = charData.x / atlasWidth;
          this.instanceUvOffsets[idx4 + 1] = charData.y / atlasHeight;
          this.instanceUvOffsets[idx4 + 2] = charData.width / atlasWidth;
          this.instanceUvOffsets[idx4 + 3] = charData.height / atlasHeight;

          // Character size (normalized by lineHeight)
          const charWidth = charData.width / lineHeight;
          const charHeight = charData.height / lineHeight;
          this.instanceCharSizes[idx2] = charWidth;
          this.instanceCharSizes[idx2 + 1] = charHeight;

          // Character offset (x, y) - position of character center relative to label origin
          // x: cursor + xoffset + width/2 (center)
          const charCenterX = cursorX + (charData.xoffset + charData.width / 2) / lineHeight;
          // y: In font data, yoffset is from TOP of cell. We want Y-up with baseline at ~0.
          // base = pixels from top to baseline
          // yoffset = pixels from top to glyph top
          // So glyph top is at: base - yoffset (positive = above baseline)
          // Glyph bottom is at: base - yoffset - height
          // Glyph center is at: base - yoffset - height/2
          // baselineY shifts the whole glyph to its line (one lineHeight per line).
          const charCenterY = baselineY + (base - charData.yoffset - charData.height / 2) / lineHeight;
          this.instanceCharOffsets[idx2] = charCenterX;
          this.instanceCharOffsets[idx2 + 1] = charCenterY;

          // Scale (user-defined label scale)
          this.instanceScales[idx] = label.scale!;

          // Visible
          this.instanceVisibles[idx] = 1;

          // Alpha (per-label opacity)
          this.instanceAlphas[idx] = label.alpha ?? 1;

          // Color
          this.instanceColors[idx3] = label.color!.r;
          this.instanceColors[idx3 + 1] = label.color!.g;
          this.instanceColors[idx3 + 2] = label.color!.b;

          cursorX += charData.xadvance / lineHeight;
          instanceIdx++;
        }
      }
    }

    this.instanceCount = instanceIdx;
    this.mesh.count = instanceIdx;

    // Mark attributes for update
    if (this.positionAttr) this.positionAttr.needsUpdate = true;
    if (this.uvOffsetAttr) this.uvOffsetAttr.needsUpdate = true;
    if (this.charOffsetAttr) this.charOffsetAttr.needsUpdate = true;
    if (this.charSizeAttr) this.charSizeAttr.needsUpdate = true;
    if (this.scaleAttr) this.scaleAttr.needsUpdate = true;
    if (this.visibleAttr) this.visibleAttr.needsUpdate = true;
    if (this.colorAttr) this.colorAttr.needsUpdate = true;
    if (this.alphaAttr) this.alphaAttr.needsUpdate = true;
  }

  /**
   * Clear all labels
   */
  clear(): void {
    this.labels.clear();
    if (this.mesh) {
      this.mesh.count = 0;
    }
    this.instanceCount = 0;
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.material.dispose();
      if (this.atlas) {
        this.atlas.dispose();
      }
    }
  }

  /**
   * Get instance count (for debugging)
   */
  getInstanceCount(): number {
    return this.instanceCount;
  }

  /**
   * Check if ready
   */
  isReady(): boolean {
    return this.ready;
  }
}

// ============================================================================
// Glyph resolution + text metrics (shared by the renderer and the AABB filter)
// ============================================================================

const _fontData = fontData as FontData;
const _lineHeight = _fontData.common?.lineHeight || 63;
const _charDataMap = new Map<string, FontChar>();
for (const c of _fontData.chars) {
  _charDataMap.set(c.char, c);
}
const _fallbackCharData = _charDataMap.get('?') ?? null;

// Per-char resolution cache — normalize() runs once per distinct character.
const _resolvedCharCache = new Map<string, FontChar | null>();

/**
 * Resolve glyph data for a character. The atlas only covers ASCII 32–126, so
 * unknown characters fall back to their de-accented base ('é' → 'e') and
 * finally to '?' — instead of silently vanishing. Control characters ('\n' is
 * handled by the line splitter before reaching here) resolve to '?' too.
 */
function resolveCharData(char: string): FontChar | null {
  let data = _resolvedCharCache.get(char);
  if (data !== undefined) return data;
  data = _charDataMap.get(char) ?? null;
  if (!data) {
    const base = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    data = _charDataMap.get(base) ?? _fallbackCharData;
  }
  _resolvedCharCache.set(char, data);
  return data;
}

export interface NormalizedTextMetrics {
  /** Width of the widest line, in lineHeight-normalized units. */
  width: number;
  /** Total height (lineCount lineHeights), in lineHeight-normalized units. */
  height: number;
  lineCount: number;
}

/**
 * Compute normalized text metrics using the actual font metrics, honoring
 * '\n' line breaks exactly like updateMesh's layout does.
 * Multiply by labelScale * LABEL_BASE_SCALE to get world units.
 */
export function computeNormalizedTextMetrics(text: string): NormalizedTextMetrics {
  let maxWidth = 0;
  let lineWidth = 0;
  let lineCount = 1;
  for (const ch of text) {
    if (ch === '\n') {
      if (lineWidth > maxWidth) maxWidth = lineWidth;
      lineWidth = 0;
      lineCount++;
      continue;
    }
    const data = resolveCharData(ch);
    if (data) lineWidth += data.xadvance / _lineHeight;
  }
  if (lineWidth > maxWidth) maxWidth = lineWidth;
  return { width: maxWidth, height: lineCount, lineCount };
}

/** Base scale used in the MSDF shader (world units per text height). */
export const LABEL_BASE_SCALE = 5.0;

// Export singleton-like factory for use with 3d-force-graph
let globalRenderer: FastLabelRenderer | null = null;

export function getOrCreateLabelRenderer(scene: THREE.Scene): FastLabelRenderer {
  if (!globalRenderer) {
    globalRenderer = new FastLabelRenderer(scene);
  }
  return globalRenderer;
}

export function disposeLabelRenderer(): void {
  if (globalRenderer) {
    globalRenderer.dispose();
    globalRenderer = null;
  }
}
