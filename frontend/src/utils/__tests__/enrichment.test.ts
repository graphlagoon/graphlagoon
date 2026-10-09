import { describe, it, expect } from 'vitest'
import { enrichmentTargets, keyedNodes, promoteToNodes } from '@/utils/enrichment'
import { unifyGraph, type UnifySource } from '@/utils/unifyGraph'
import type { EnrichmentTable } from '@/types/graph'

const devices: EnrichmentTable = {
  name: 'devices',
  label: 'Login devices',
  table: 'main.risk.devices',
  key_column: 'account_id',
  match_node_types: ['Conta'],
  match_source: 'node_id',
  cardinality: 'many',
  columns: ['device_id', 'ip'],
  promote: { node_type: 'Dispositivo', id_column: 'device_id', edge_type: 'USOU' },
}
const contexts = { c1: { identity_keys: [], enrichment_tables: [devices] } }
const pix: UnifySource = {
  id: 's1',
  contextId: 'c1',
  nodes: [
    { node_id: '4471', node_type: 'Conta', properties: {} },
    { node_id: '8812', node_type: 'Conta', properties: {} },
    { node_id: 'p1', node_type: 'Pessoa', properties: {} },
  ],
  edges: [],
}

describe('enrichment', () => {
  it('applies a table only to the node types it matches', () => {
    const { nodes } = unifyGraph([pix], contexts)
    const conta = nodes.find((n) => n.node_id === '4471@c1')!
    const pessoa = nodes.find((n) => n.node_id === 'p1@c1')!
    expect(enrichmentTargets(conta, contexts).map((t) => t.table.name)).toEqual(['devices'])
    expect(enrichmentTargets(pessoa, contexts)).toEqual([])
  })

  it('promotes a shared device to one node linking both accounts', () => {
    const { nodes } = unifyGraph([pix], contexts)
    const [target] = enrichmentTargets(nodes[0], contexts)
    const keyed = keyedNodes(nodes, target)
    expect(keyed.map((k) => k.key)).toEqual(['4471', '8812'])

    const derived = promoteToNodes(target, keyed, {
      '4471': [{ device_id: 'a3f9', ip: '1' }, { device_id: '71c0', ip: '2' }],
      '8812': [{ device_id: 'a3f9', ip: '3' }],
    })
    expect(derived.id).toBe('derived:s1:devices')

    const graph = unifyGraph([pix, derived], contexts)
    const device = graph.nodes.find((n) => n.node_id === 'Dispositivo:a3f9@c1')!
    expect(device.node_type).toBe('Dispositivo')
    expect(device.properties?.__derived).toBe('enrichment:devices')
    const linked = graph.edges.filter((e) => e.dst === device.node_id).map((e) => e.src).sort()
    expect(linked).toEqual(['4471@c1', '8812@c1'])
    expect(graph.edges.every((e) => e.relationship_type === 'USOU' && e.properties?.__derived)).toBe(true)
    // The accounts merged back onto themselves: no duplicate nodes.
    expect(graph.nodes.filter((n) => n.node_type === 'Conta')).toHaveLength(2)
  })
})
