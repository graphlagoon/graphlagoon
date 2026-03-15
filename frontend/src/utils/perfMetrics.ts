/**
 * Performance Metrics Collector (dev-only)
 *
 * Accumulates timing entries in `window.__PERF_METRICS__` so they can be
 * harvested by Playwright scripts or read by Claude Code via `make perf-report`.
 *
 * In production builds every export is a no-op and tree-shaken away.
 */

export interface PerfEntry {
  label: string
  ms: number
  ts: number
  extra?: Record<string, number>
}

export interface PerfMetricsHandle {
  entries: PerfEntry[]
  get: () => PerfEntry[]
  clear: () => void
  summary: () => PerfSummary[]
}

export interface PerfSummary {
  label: string
  count: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
  lastMs: number
}

const MAX_ENTRIES = 1000

// Ring-buffer of entries (dev only)
const entries: PerfEntry[] = []

/**
 * Record a performance measurement. No-op in production.
 */
export function recordPerf(label: string, ms: number, extra?: Record<string, number>): void {
  if (import.meta.env.PROD) return
  entries.push({ label, ms, ts: Date.now(), extra })
  if (entries.length > MAX_ENTRIES) entries.shift()
}

/**
 * Get all recorded entries.
 */
export function getPerfEntries(): PerfEntry[] {
  return entries
}

/**
 * Clear all entries.
 */
export function clearPerfEntries(): void {
  entries.length = 0
}

/**
 * Aggregate entries by label into a summary.
 */
export function getPerfSummary(): PerfSummary[] {
  const byLabel = new Map<string, PerfEntry[]>()
  for (const e of entries) {
    const arr = byLabel.get(e.label)
    if (arr) arr.push(e)
    else byLabel.set(e.label, [e])
  }

  const summaries: PerfSummary[] = []
  for (const [label, group] of byLabel) {
    const times = group.map(e => e.ms)
    summaries.push({
      label,
      count: group.length,
      totalMs: times.reduce((a, b) => a + b, 0),
      avgMs: times.reduce((a, b) => a + b, 0) / times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
      lastMs: times[times.length - 1],
    })
  }

  return summaries.sort((a, b) => b.totalMs - a.totalMs)
}

// ---------------------------------------------------------------------------
// Expose on window (dev only)
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const handle: PerfMetricsHandle = {
    entries,
    get: getPerfEntries,
    clear: clearPerfEntries,
    summary: getPerfSummary,
  }
  ;(window as any).__PERF_METRICS__ = handle

  /**
   * Console helper: type `perf()` in browser console to see a formatted summary table.
   */
  ;(window as any).perf = () => {
    const s = getPerfSummary()
    if (s.length === 0) {
      console.log('[perf] No entries yet.')
      return
    }
    console.table(s.map(r => ({
      label: r.label,
      count: r.count,
      'avg (ms)': +r.avgMs.toFixed(2),
      'min (ms)': +r.minMs.toFixed(2),
      'max (ms)': +r.maxMs.toFixed(2),
      'total (ms)': +r.totalMs.toFixed(1),
      'last (ms)': +r.lastMs.toFixed(2),
    })))
    return s
  }
}
