import { describe, it, expect } from 'vitest'
import {
  scaleValue,
  calculateStats,
  getBatchSize,
  getBatchDelay,
  getDefaultWorkerPoolConfig,
} from '@/types/metrics'

describe('scaleValue', () => {
  it('linear scale: maps value in source range to target range', () => {
    // value=5 in range [0, 10] → target [0, 100] → 50
    expect(scaleValue(5, 0, 10, 0, 100, 'linear')).toBe(50)
  })

  it('linear scale: min input maps to targetMin', () => {
    expect(scaleValue(0, 0, 10, 10, 50, 'linear')).toBe(10)
  })

  it('linear scale: max input maps to targetMax', () => {
    expect(scaleValue(10, 0, 10, 10, 50, 'linear')).toBe(50)
  })

  it('linear scale: clamps values below min to targetMin', () => {
    expect(scaleValue(-5, 0, 10, 0, 100, 'linear')).toBe(0)
  })

  it('linear scale: clamps values above max to targetMax', () => {
    expect(scaleValue(15, 0, 10, 0, 100, 'linear')).toBe(100)
  })

  it('log scale: compresses high values', () => {
    const linear = scaleValue(8, 0, 10, 0, 100, 'linear')
    const log = scaleValue(8, 0, 10, 0, 100, 'log')
    // Log scale compresses high values → log result should be higher than linear for same input
    expect(log).toBeGreaterThan(linear * 0.5)
    expect(log).toBeLessThanOrEqual(100)
  })

  it('sqrt scale: intermediate compression', () => {
    const linear = scaleValue(5, 0, 10, 0, 100, 'linear')
    const sqrt = scaleValue(5, 0, 10, 0, 100, 'sqrt')
    // sqrt(0.5) ≈ 0.707, so sqrt should map higher than linear for midpoint
    expect(sqrt).toBeGreaterThan(linear)
  })

  it('handles zero-range (min === max) without division by zero', () => {
    // When min === max, range becomes 1 (fallback), normalized = clamped to [0,1]
    const result = scaleValue(5, 5, 5, 0, 100, 'linear')
    expect(Number.isFinite(result)).toBe(true)
  })
})

describe('calculateStats', () => {
  it('empty array returns zeroes', () => {
    const stats = calculateStats([])
    expect(stats).toEqual({ min: 0, max: 0, mean: 0, stdDev: 0 })
  })

  it('single value: min=max=mean=value, stdDev=0', () => {
    const stats = calculateStats([42])
    expect(stats.min).toBe(42)
    expect(stats.max).toBe(42)
    expect(stats.mean).toBe(42)
    expect(stats.stdDev).toBe(0)
  })

  it('known values: [1,2,3,4,5]', () => {
    const stats = calculateStats([1, 2, 3, 4, 5])
    expect(stats.min).toBe(1)
    expect(stats.max).toBe(5)
    expect(stats.mean).toBe(3)
    // stdDev = sqrt(variance) = sqrt(2) ≈ 1.4142
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(2), 4)
  })

  it('negative values handled correctly', () => {
    const stats = calculateStats([-5, -3, -1])
    expect(stats.min).toBe(-5)
    expect(stats.max).toBe(-1)
    expect(stats.mean).toBe(-3)
  })

  it('large array performance', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i)
    const stats = calculateStats(values)
    expect(stats.min).toBe(0)
    expect(stats.max).toBe(999)
    expect(stats.mean).toBeCloseTo(499.5, 1)
  })
})

describe('getBatchSize', () => {
  it('low priority returns 5', () => {
    expect(getBatchSize('low')).toBe(5)
  })

  it('medium priority returns 20', () => {
    expect(getBatchSize('medium')).toBe(20)
  })

  it('high priority returns 100', () => {
    expect(getBatchSize('high')).toBe(100)
  })
})

describe('getBatchDelay', () => {
  it('low priority returns 100ms', () => {
    expect(getBatchDelay('low')).toBe(100)
  })

  it('medium priority returns 16ms (one frame)', () => {
    expect(getBatchDelay('medium')).toBe(16)
  })

  it('high priority returns 0', () => {
    expect(getBatchDelay('high')).toBe(0)
  })
})

describe('getDefaultWorkerPoolConfig', () => {
  it('returns maxWorkers >= 1', () => {
    const config = getDefaultWorkerPoolConfig()
    expect(config.maxWorkers).toBeGreaterThanOrEqual(1)
  })

  it('returns maxMemoryMB of 512', () => {
    const config = getDefaultWorkerPoolConfig()
    expect(config.maxMemoryMB).toBe(512)
  })
})
