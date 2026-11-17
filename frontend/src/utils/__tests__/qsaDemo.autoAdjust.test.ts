/**
 * The automatic adjustments on the QSA demo graph (api/graphlagoon/dev/qsa_demo.py,
 * fixture kept identical by api/tests/test_qsa_demo.py): what someone opening
 * `make dev-seed-qsa`'s context sees, decided without a canvas.
 */
import { describe, it, expect } from 'vitest'
import qsa from '@/__tests__/fixtures/qsa-demo.json'
import { computeHubLeavesPlan, type HubLeavesKeyCandidate } from '../hubLeaves'
import { AUTO_HUB_MIN_LEAVES, chooseEgoOrdering, revealRegions } from '../autoAdjust'
import { connectorGroups, summarizeNeighbors } from '../neighborSummary'

type N = { node_id: string; node_type: string; properties: Record<string, unknown> }
type E = { edge_id: string; src: string; dst: string; relationship_type: string; properties: Record<string, unknown> }
const nodes = qsa.nodes as N[]
const edges = qsa.edges as E[]
const byId = new Map(nodes.map((n) => [n.node_id, n]))
const links = edges.map((e) => ({ id: e.edge_id, source: e.src, target: e.dst }))
const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v))
const candidates: HubLeavesKeyCandidate[] = [
  { name: 'node type', keyOf: (l) => str(byId.get(l)?.node_type) },
  { name: 'qualificacao', keyOf: (l) => str(byId.get(l)?.properties.qualificacao) },
  { name: 'uf', keyOf: (l) => str(byId.get(l)?.properties.uf) },
]
const plan = (minLeaves = AUTO_HUB_MIN_LEAVES) =>
  computeHubLeavesPlan(links, { mode: 'auto', minLeaves, spacing: 14, hubRadiusOf: () => 20, keyCandidates: candidates })

describe('QSA demo, automatic adjustments', () => {
  it('both companies are hubs, arranged in petals by role; the 24 linked partners stay free', () => {
    const p = plan()
    expect(Object.fromEntries(p.shapeByHub)).toEqual({ aurora: 'petals', boreal: 'petals' })
    expect(Object.fromEntries(p.keyByHub)).toEqual({ aurora: 'qualificacao', boreal: 'qualificacao' })
    expect(p.offsets.size).toBe(356 + 95)
    expect(p.regions.filter((r) => r.hub === 'aurora').map((r) => [r.key, r.count])).toEqual([
      ['Socio', 131], ['Acionista', 112], ['Conselheiro', 38], ['Diretor', 38], ['Procurador', 37],
    ])
    for (const id of ['p3', 'p23', 'p375']) expect(p.offsets.has(id)).toBe(false)
  })

  it('reveal on zoom stays off: no hub reaches the automatic threshold', () => {
    expect(revealRegions(plan().regions, 'auto', true).some(Boolean)).toBe(false)
  })

  it('ego on Aurora: ring 1 is sectored by role', () => {
    const s = summarizeNeighbors('aurora', edges, (id) => byId.get(id)?.node_type ?? '')
    const ring1 = s.rows.flatMap((r) => r.nodeIds).map((id) => ({ id, nodeType: byId.get(id)!.node_type, properties: byId.get(id)!.properties }))
    const choice = chooseEgoOrdering({ ring1, leafIds: new Set(s.leafIds) })
    expect(choice).toMatchObject({ ordering: 'property', key: 'qualificacao' })
    expect(choice.reason).toBe('ring 1 has 380 nodes, 356 of them leaves')
  })

  it('the neighbour summary answers the investigator: 356 leaves, 24 with another link', () => {
    const s = summarizeNeighbors('aurora', edges, (id) => byId.get(id)?.node_type ?? '')
    expect([s.neighbors, s.leafIds.length, s.linkedIds.length]).toEqual([380, 356, 24])
  })

  it('connector groups: the 24 linked partners fall into 4 groups by what else they hold', () => {
    const groups = connectorGroups('aurora', edges)
    expect(groups.map((g) => [g.sharedIds.join('+'), g.memberIds.length])).toEqual([
      ['h3', 7], ['h1', 6], ['h5', 6], ['boreal', 5],
    ])
  })
})
