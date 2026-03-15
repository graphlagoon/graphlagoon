/**
 * LabelGrid — screen-space density culling for 3D labels.
 *
 * Adapted from Sigma.js's LabelGrid algorithm:
 * Divides the viewport into a uniform 2D grid of cells and limits the number
 * of labels shown per cell based on zoom level. Labels are prioritized by
 * node size (larger nodes win). This prevents label overcrowding without
 * expensive bounding-box overlap detection.
 */

interface LabelCandidate {
  key: string;
  size: number;
}

function compareCandidates(a: LabelCandidate, b: LabelCandidate): number {
  if (a.size > b.size) return -1;
  if (a.size < b.size) return 1;
  // Deterministic tiebreak by key (prevents flickering)
  if (a.key > b.key) return 1;
  return -1;
}

export class LabelGrid {
  private cellSize: number;
  private columns = 0;
  private rows = 0;
  private cells: Map<number, LabelCandidate[]> = new Map();

  constructor(cellSize = 100) {
    this.cellSize = cellSize;
  }

  resize(width: number, height: number, cellSize?: number): void {
    if (cellSize !== undefined) this.cellSize = cellSize;
    this.columns = Math.ceil(width / this.cellSize) || 1;
    this.rows = Math.ceil(height / this.cellSize) || 1;
    this.cells.clear();
  }

  private getIndex(screenX: number, screenY: number): number {
    const col = Math.floor(screenX / this.cellSize);
    const row = Math.floor(screenY / this.cellSize);
    // Clamp to grid bounds
    const c = Math.max(0, Math.min(col, this.columns - 1));
    const r = Math.max(0, Math.min(row, this.rows - 1));
    return r * this.columns + c;
  }

  add(key: string, size: number, screenX: number, screenY: number): void {
    const idx = this.getIndex(screenX, screenY);
    let cell = this.cells.get(idx);
    if (!cell) {
      cell = [];
      this.cells.set(idx, cell);
    }
    cell.push({ key, size });
  }

  /** Sort each cell by size descending (call once after all add() calls). */
  organize(): void {
    for (const cell of this.cells.values()) {
      cell.sort(compareCandidates);
    }
  }

  /**
   * Return the set of label keys to display.
   *
   * @param zoomFactor — higher = more zoomed in. For ortho: camera.zoom.
   *                     For perspective: baseDist / currentDist.
   * @param density — base labels per cell at default zoom (default 1).
   */
  getLabelsToDisplay(zoomFactor: number, density = 1): Set<string> {
    // As zoom increases, allow more labels per cell (quadratic, like Sigma.js)
    const labelsPerCell = Math.max(1, Math.ceil(density * zoomFactor * zoomFactor));
    const result = new Set<string>();

    for (const cell of this.cells.values()) {
      const count = Math.min(labelsPerCell, cell.length);
      for (let i = 0; i < count; i++) {
        result.add(cell[i].key);
      }
    }

    return result;
  }
}

/**
 * ScreenAABBFilter — greedy screen-space overlap detection for labels.
 *
 * Uses a fine-grained occupation grid to track which screen regions are
 * already taken by placed labels. Labels are processed in priority order
 * (larger/closer first); a label is skipped if too much of its screen area
 * is already occupied by higher-priority labels.
 */
export class ScreenAABBFilter {
  private cells: Uint8Array;
  private cols: number;
  private rows: number;
  private cellSize: number;

  constructor(cellSize = 20) {
    this.cellSize = cellSize;
    this.cols = 1;
    this.rows = 1;
    this.cells = new Uint8Array(1);
  }

  /** Resize and clear the occupation grid. Re-uses the buffer if large enough. */
  reset(viewportWidth: number, viewportHeight: number): void {
    this.cols = Math.ceil(viewportWidth / this.cellSize) || 1;
    this.rows = Math.ceil(viewportHeight / this.cellSize) || 1;
    const needed = this.cols * this.rows;
    if (this.cells.length < needed) {
      this.cells = new Uint8Array(needed);
    } else {
      this.cells.fill(0, 0, needed);
    }
  }

  /**
   * Try to place a label. Returns true if overlap is below threshold
   * and marks cells as occupied. Returns false if too much overlap.
   *
   * @param sx - screen X of label anchor
   * @param sy - screen Y of label anchor
   * @param sw - label width in screen pixels
   * @param sh - label height in screen pixels
   * @param align - text alignment ('center' | 'left' | 'right')
   * @param threshold - max overlap ratio (0..1) before rejecting (default 0.5)
   */
  tryPlace(
    sx: number, sy: number,
    sw: number, sh: number,
    align: 'center' | 'left' | 'right',
    threshold: number,
  ): boolean {
    // Compute AABB based on text alignment relative to anchor
    let left: number;
    if (align === 'left') {
      left = sx;
    } else if (align === 'right') {
      left = sx - sw;
    } else {
      left = sx - sw / 2;
    }
    const top = sy - sh / 2;

    // Grid cell range
    const c0 = Math.max(0, Math.floor(left / this.cellSize));
    const c1 = Math.min(this.cols - 1, Math.floor((left + sw) / this.cellSize));
    const r0 = Math.max(0, Math.floor(top / this.cellSize));
    const r1 = Math.min(this.rows - 1, Math.floor((top + sh) / this.cellSize));

    // Check overlap ratio
    let total = 0;
    let occupied = 0;
    for (let r = r0; r <= r1; r++) {
      const rowBase = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        total++;
        if (this.cells[rowBase + c]) occupied++;
      }
    }

    const overlapRatio = total > 0 ? occupied / total : 0;
    if (overlapRatio > threshold) return false;

    // Mark cells as occupied
    for (let r = r0; r <= r1; r++) {
      const rowBase = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        this.cells[rowBase + c] = 1;
      }
    }
    return true;
  }
}
