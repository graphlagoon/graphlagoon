import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'fs'
import { join } from 'path'
import EnrichmentTab from '@/components/investigation/EnrichmentTab.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { QSA_ENRICHMENT } from '@/utils/fileMappingPresets'
import { enrichmentTargets, fileEnrichmentKey } from '@/utils/enrichment'
import { unifyGraph } from '@/utils/unifyGraph'

vi.mock('@/services/api', () => ({
  api: { getInvestigationItemContent: vi.fn(), lookupEnrichment: vi.fn() },
}))

import { api } from '@/services/api'

const QSA = readFileSync(join(__dirname, '../../../__tests__/fixtures/fileMapping/qsa-mini/qsa-mini.csv'))
const contexts = { c1: { identity_keys: [], enrichment_tables: [] } }
const { nodes } = unifyGraph(
  [{
    id: 's1', contextId: 'c1', edges: [],
    nodes: [
      { node_id: 'l1', node_type: 'Lojista', properties: { cnpj: '12.345.678/0001-90' } },
      { node_id: 'p1', node_type: 'Pessoa', properties: { cnpj: '12345678000190' } },
    ],
  }],
  contexts,
)
const lojista = nodes.find((n) => n.node_type === 'Lojista')!
const pessoa = nodes.find((n) => n.node_type === 'Pessoa')!

let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  const store = useInvestigationStore()
  store.current = { id: 'inv' } as any
  store.contexts = contexts as any
  store.items = [{ id: 'f1', kind: 'table', subkind: 'csv', title: 'qsa.csv', mapping: { as: 'enrichment', spec: QSA_ENRICHMENT }, current_version: 1, pinned: [], provenance: { filename: 'qsa.csv' } } as any]
  vi.mocked(api.getInvestigationItemContent).mockResolvedValue(QSA.buffer.slice(QSA.byteOffset, QSA.byteOffset + QSA.byteLength) as ArrayBuffer)
})

describe('case table as enrichment', () => {
  it('the QSA mini enriches a merchant by CNPJ', async () => {
    const { getByTestId } = render(EnrichmentTab, { props: { node: lojista, canEdit: true }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(api.getInvestigationItemContent).toHaveBeenCalledWith('inv', 'f1')
    const rows = getByTestId('enrichment-file-rows').textContent!
    expect(rows).toContain('ANA SILVA')
    expect(rows).toContain('HOLDING XYZ LTDA')
    expect(rows).not.toContain('BRUNO COSTA') // partner of another company
    expect(api.lookupEnrichment).not.toHaveBeenCalled()
  })

  it('stays in the case: never a context table, never a type it does not enrich', async () => {
    expect(fileEnrichmentKey(lojista, QSA_ENRICHMENT)).toBe('12345678')
    expect(fileEnrichmentKey(pessoa, QSA_ENRICHMENT)).toBeNull()
    expect(enrichmentTargets(lojista, contexts)).toEqual([])
    const { queryByTestId } = render(EnrichmentTab, { props: { node: pessoa, canEdit: true }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(queryByTestId('enrichment-file-card')).toBeNull()
    expect(api.getInvestigationItemContent).not.toHaveBeenCalled()
  })
})
