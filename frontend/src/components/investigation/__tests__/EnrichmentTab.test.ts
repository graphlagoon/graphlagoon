import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'fs'
import { join } from 'path'
import EnrichmentTab from '@/components/investigation/EnrichmentTab.vue'
import { useInvestigationStore } from '@/stores/investigation'
import registry from '@/__tests__/fixtures/fileMapping/company-registry/spec.json'
import type { FileEnrichmentSpec } from '@/types/investigation'
import { enrichmentTargets, fileEnrichmentKey } from '@/utils/enrichment'
import { unifyGraph } from '@/utils/unifyGraph'

vi.mock('@/services/api', () => ({
  api: { getInvestigationItemContent: vi.fn(), lookupEnrichment: vi.fn() },
}))

import { api } from '@/services/api'

const REGISTRY = readFileSync(join(__dirname, '../../../__tests__/fixtures/fileMapping/company-registry/company-registry.csv'))
// The registry's partners as a side table of the case, keyed by the first 8 digits of a company id.
const PARTNERS: FileEnrichmentSpec = {
  name: 'Company registry (partners)',
  input: { delimiter: ';', header: false, columns: registry.inputs.reg.columns, encoding: 'latin-1' },
  key_column: 'COMPANY_ID',
  columns: ['PARTNER_NAME', 'PARTNER_ID', 'ROLE_CODE', 'SINCE'],
  match_node_types: ['Merchant', 'Company'],
  match_source: { kind: 'prop', name: 'registry_id' },
  key_digits: 8,
}
const contexts = { c1: { identity_keys: [], enrichment_tables: [] } }
const { nodes } = unifyGraph(
  [{
    id: 's1', contextId: 'c1', edges: [],
    nodes: [
      { node_id: 'l1', node_type: 'Merchant', properties: { registry_id: '12.345.678/0001-90' } },
      { node_id: 'p1', node_type: 'Person', properties: { registry_id: '12345678000190' } },
    ],
  }],
  contexts,
)
const merchant = nodes.find((n) => n.node_type === 'Merchant')!
const person = nodes.find((n) => n.node_type === 'Person')!

let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  const store = useInvestigationStore()
  store.current = { id: 'inv' } as any
  store.contexts = contexts as any
  store.items = [{ id: 'f1', kind: 'table', subkind: 'csv', title: 'registry.csv', mapping: { as: 'enrichment', spec: PARTNERS }, current_version: 1, accessible: true, latest: { content_type: 'text/csv' }, pinned: [], provenance: { filename: 'registry.csv' } } as any]
  vi.mocked(api.getInvestigationItemContent).mockResolvedValue(REGISTRY.buffer.slice(REGISTRY.byteOffset, REGISTRY.byteOffset + REGISTRY.byteLength) as ArrayBuffer)
})

describe('case table as enrichment', () => {
  it('the registry enriches a merchant by its company id prefix', async () => {
    // The store reads each enrichment file once (the workspace load); the tab shows its rows.
    await useInvestigationStore().loadEnrichments()
    expect(api.getInvestigationItemContent).toHaveBeenCalledWith('inv', 'f1')
    const { getByTestId } = render(EnrichmentTab, { props: { node: merchant, canEdit: true }, global: { plugins: [pinia] } })
    await flushPromises()
    const rows = getByTestId('enrichment-file-rows').textContent!
    expect(rows).toContain('ANA SILVA')
    expect(rows).toContain('HOLDING XYZ LTD')
    expect(rows).not.toContain('BRUNO COSTA') // partner of another company
    expect(api.lookupEnrichment).not.toHaveBeenCalled()
  })

  it('stays in the case: never a context table, never a type it does not enrich', async () => {
    expect(fileEnrichmentKey(merchant, PARTNERS)).toBe('12345678')
    expect(fileEnrichmentKey(person, PARTNERS)).toBeNull()
    expect(enrichmentTargets(merchant, contexts)).toEqual([])
    const { queryByTestId } = render(EnrichmentTab, { props: { node: person, canEdit: true }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(queryByTestId('enrichment-file-card')).toBeNull()
    expect(api.getInvestigationItemContent).not.toHaveBeenCalled()
  })
})
