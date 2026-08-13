/**
 * Query panel affordances that only exist for a SQL-backed datasource.
 *
 * These are the user-visible payoff of the capability matrix: a Neptune context
 * must not be offered a SQL tab, a transpile review, or a CTE pre-filter — the
 * API rejects all three.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import GraphQueryPanel from '@/components/GraphQueryPanel.vue'
import { useGraphStore } from '@/stores/graph'
import {
  createGraphContext,
  createNeptuneGraphContext,
} from '@/__tests__/fixtures/contexts'
import type { GraphContext } from '@/types/graph'

vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    executeCypherQuery: vi.fn(),
    transpileCypher: vi.fn(),
  },
}))

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

async function renderPanelFor(context: GraphContext) {
  const graphStore = useGraphStore()
  graphStore.currentContext = context
  await nextTick()
  const rendered = render(GraphQueryPanel, { props: {} as any })
  await flush()
  return rendered
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('warehouse context', () => {
  it('offers the SQL mode toggle', async () => {
    const { container } = await renderPanelFor(createGraphContext())
    expect(
      container.querySelector('[data-testid="graph-query-mode-sql"]'),
    ).not.toBeNull()
  })

  it('offers the transpile settings', async () => {
    const { container } = await renderPanelFor(createGraphContext())
    expect(
      container.querySelector('[data-testid="graph-query-settings"]'),
    ).not.toBeNull()
  })

  it('offers the CTE pre-filter', async () => {
    const { container } = await renderPanelFor(createGraphContext())
    expect(container.textContent).toContain('Pre-filter edges (CTE)')
  })
})

describe('native graph context', () => {
  it('hides the SQL mode toggle', async () => {
    const { container } = await renderPanelFor(createNeptuneGraphContext())
    expect(container.querySelector('[data-testid="graph-query-mode-sql"]')).toBeNull()
  })

  it('hides the transpile settings — there is no SQL to configure', async () => {
    const { container } = await renderPanelFor(createNeptuneGraphContext())
    expect(container.querySelector('[data-testid="graph-query-settings"]')).toBeNull()
  })

  it('hides the CTE pre-filter and the trust-transpiled-SQL toggle', async () => {
    const { container } = await renderPanelFor(createNeptuneGraphContext())
    expect(container.textContent).not.toContain('Pre-filter edges (CTE)')
    expect(container.textContent).not.toContain('Trust transpiled SQL')
  })

  it('always runs the query directly rather than offering a review step', async () => {
    const { container } = await renderPanelFor(createNeptuneGraphContext())
    const run = container.querySelector(
      '[data-testid="graph-query-run"]',
    ) as HTMLButtonElement
    // Never "Transpile to SQL": that two-step does not exist here.
    expect(run.textContent?.trim()).toBe('Run Query')
  })
})
