/**
 * Running a saved template against each datasource.
 *
 * A template stores Cypher plus warehouse execution options. Both have to be
 * reinterpreted for a native graph backend: the Cypher runs directly instead of
 * being transpiled first, and the stored SQL-shaped options are dropped rather
 * than applied to a query that will never consult them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import TemplateExecuteModal from '@/components/TemplateExecuteModal.vue'
import TemplateEditorModal from '@/components/TemplateEditorModal.vue'
import { useGraphStore } from '@/stores/graph'
import {
  createGraphContext,
  createNeptuneGraphContext,
} from '@/__tests__/fixtures/contexts'
import type { GraphContext, QueryTemplate } from '@/types/graph'

vi.mock('@/services/api', () => ({
  api: {
    executeCypherQuery: vi.fn(),
    transpileCypher: vi.fn(),
    executeGraphQuery: vi.fn(),
  },
}))

function createTemplate(overrides: Partial<QueryTemplate> = {}): QueryTemplate {
  return {
    id: 'tpl-1',
    graph_context_id: 'ctx-1',
    owner_email: 'me@example.com',
    name: 'My template',
    query_type: 'cypher',
    query: 'MATCH (n)-[r]->(m) RETURN n, r, m',
    parameters: [],
    options: {
      procedural_bfs: true,
      large_results_mode: true,
      cte_prefilter: 'MY_FINAL_EDGES AS (SELECT * FROM __EDGES__)',
    },
    visibility: 'shared',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

async function runTemplateOn(context: GraphContext, template = createTemplate()) {
  const graphStore = useGraphStore()
  graphStore.currentContext = context
  const executeCypherQuery = vi
    .spyOn(graphStore, 'executeCypherQuery')
    .mockResolvedValue(null)
  const transpileCypher = vi.spyOn(graphStore, 'transpileCypher').mockResolvedValue(null)
  const executeGraphQuery = vi
    .spyOn(graphStore, 'executeGraphQuery')
    .mockResolvedValue(undefined as never)

  const { container } = render(TemplateExecuteModal, { props: { template } })
  await flush()

  const run = document.body.querySelector(
    '.execute-modal button.btn-primary',
  ) as HTMLButtonElement
  await fireEvent.click(run)
  await flush()

  return { graphStore, executeCypherQuery, transpileCypher, executeGraphQuery, container }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('warehouse context', () => {
  it('runs through the Cypher endpoint — the server transpiles', async () => {
    // Client-side transpile-then-POST-the-SQL is gone: procedural BEGIN…END
    // scripts are rejected by the raw-SQL endpoint (SCRIPT_NOT_ALLOWED), so
    // the Cypher endpoint owns transpilation and execution on every backend.
    const { transpileCypher, executeCypherQuery } = await runTemplateOn(
      createGraphContext(),
    )
    expect(executeCypherQuery).toHaveBeenCalledWith(
      'MATCH (n)-[r]->(m) RETURN n, r, m',
      { preserveGraphQuery: true },
    )
    expect(transpileCypher).not.toHaveBeenCalled()
  })

  it('applies the stored execution options', async () => {
    const { graphStore } = await runTemplateOn(createGraphContext())
    expect(graphStore.vlpRenderingMode).toBe('procedural')
    expect(graphStore.useExternalLinks).toBe(true)
    expect(graphStore.ctePrefilter).toContain('MY_FINAL_EDGES')
  })
})

describe('native graph context', () => {
  it('runs the Cypher directly — the transpile step would load nothing', async () => {
    const { executeCypherQuery, transpileCypher } = await runTemplateOn(
      createNeptuneGraphContext(),
    )
    expect(executeCypherQuery).toHaveBeenCalledWith(
      'MATCH (n)-[r]->(m) RETURN n, r, m',
      { preserveGraphQuery: true },
    )
    expect(transpileCypher).not.toHaveBeenCalled()
  })

  it('drops a stored CTE pre-filter instead of sending SQL the API rejects', async () => {
    const { graphStore } = await runTemplateOn(createNeptuneGraphContext())
    expect(graphStore.ctePrefilter).toBe('')
  })

  it('still substitutes parameters before running', async () => {
    const template = createTemplate({
      query: 'MATCH (n) WHERE id(n) = $node_id RETURN n',
      parameters: [
        {
          id: 'node_id',
          type: 'input',
          label: 'node_id',
          default: 'abc-123',
          required: true,
        },
      ],
    })
    const { executeCypherQuery } = await runTemplateOn(
      createNeptuneGraphContext(),
      template,
    )
    expect(executeCypherQuery).toHaveBeenCalledWith(
      'MATCH (n) WHERE id(n) = abc-123 RETURN n',
      { preserveGraphQuery: true },
    )
  })
})

describe('template editor', () => {
  async function renderEditor(context: GraphContext) {
    const graphStore = useGraphStore()
    graphStore.currentContext = context
    render(TemplateEditorModal, { props: { template: null } as any })
    await flush()
    return document.body
  }

  it('offers the warehouse execution options', async () => {
    const body = await renderEditor(createGraphContext())
    expect(body.querySelector('.execution-options')).not.toBeNull()
    expect(body.textContent).toContain('Procedural BFS')
  })

  it('hides them for a native graph context', async () => {
    const body = await renderEditor(createNeptuneGraphContext())
    // Transpilation strategy, result transport and CTE pre-filter are all
    // warehouse machinery — offering them would promise behaviour that cannot
    // happen.
    expect(body.querySelector('.execution-options')).toBeNull()
    expect(body.textContent).not.toContain('Pre-filter edges (CTE)')
    expect(body.textContent).not.toContain('Large results mode')
  })

  it('offers only Cypher as a query type for a native graph context', async () => {
    const body = await renderEditor(createNeptuneGraphContext())
    const types = Array.from(body.querySelectorAll('input[type="radio"]')).map(
      (el) => (el as HTMLInputElement).value,
    )
    expect(types).toContain('cypher')
    expect(types).not.toContain('sql')
  })
})
