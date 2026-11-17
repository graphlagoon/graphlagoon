import { describe, it, expect } from 'vitest';
import { regionLabelSide } from '@/composables/useHubLeafRegions';

describe('regionLabelSide', () => {
  it('a crown (centred on the hub) is labelled on top', () => {
    expect(regionLabelSide(0, 0)).toEqual({ ux: 0, uy: 1, align: 'center' });
  });

  it('a petal under the hub is labelled under itself, not on the hub', () => {
    const side = regionLabelSide(0, -100);
    expect(side.uy).toBeCloseTo(-1);
    expect(side.align).toBe('center');
  });

  it('petals to the side are labelled away from the hub', () => {
    expect(regionLabelSide(100, 10).align).toBe('left');
    expect(regionLabelSide(-100, 10).align).toBe('right');
  });
});
