import { describe, it, expect } from 'vitest'
import { withEnrichedProperties } from '@/utils/enrichedProperties'

const columns = (entries: [string, string[]][]) =>
  new Map(entries.map(([key, labels]) => [key, new Map(labels.map((l) => [l, 1]))]))

describe('withEnrichedProperties', () => {
  const declared = [{ name: 'name', data_type: 'string', description: 'Full name' }]
  const items = [
    { properties: { name: 'Ana', risk: null } },
    { properties: { name: 'Bo', risk: 0.7, vip: true, city: 'Recife', tags: ['a'] } },
    {},
  ]

  it('adds the enriched keys after the declared ones, typed by their first value', () => {
    const out = withEnrichedProperties(declared, items, columns([['risk', ['Risk']], ['vip', ['KYC']], ['city', ['KYC']]]))
    expect(out).toEqual([
      declared[0],
      { name: 'risk', data_type: 'number', description: 'added by enrichment Risk' },
      { name: 'vip', data_type: 'boolean', description: 'added by enrichment KYC' },
      { name: 'city', data_type: 'string', description: 'added by enrichment KYC' },
    ])
  })

  it('keeps a declared property as declared and names every enrichment that wrote a key', () => {
    const out = withEnrichedProperties(declared, items, columns([['name', ['KYC']], ['risk', ['Risk', 'Audit']]]))
    expect(out).toEqual([declared[0], { name: 'risk', data_type: 'number', description: 'added by enrichment Risk, Audit' }])
  })

  it('says unknown for a value that is not a scalar or is on no item', () => {
    const out = withEnrichedProperties([], items, columns([['tags', ['T']], ['gone', ['T']]]))
    expect(out.map((p) => p.data_type)).toEqual(['unknown', 'unknown'])
  })

  it('returns the declared list when nothing was enriched', () => {
    expect(withEnrichedProperties(declared, items, new Map())).toEqual(declared)
  })
})
