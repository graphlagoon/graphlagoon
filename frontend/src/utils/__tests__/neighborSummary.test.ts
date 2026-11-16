import { describe, it, expect } from 'vitest'
import { leafCollections, membersNoLongerLeaves, neighborRowLabel, summarizeNeighbors } from '../neighborSummary'

const e = (src: string, dst: string, relationship_type = 'SOCIO_DE') => ({ src, dst, relationship_type })
const typeOf = (id: string) => (id.startsWith('c') ? 'Company' : 'Person')

describe('summarizeNeighbors', () => {
  const edges = [
    ...Array.from({ length: 6 }, (_, i) => e(`p${i}`, 'hub')),
    e('c1', 'hub'),
    e('hub', 'c2', 'OWNS'),
    e('p0', 'c9'), // p0 has another link
    e('p1', 'hub', 'ADMINISTRA'), // p1 twice to the hub: still a leaf
    e('hub', 'hub', 'SELF'),
  ]
  const s = summarizeNeighbors('hub', edges, typeOf)

  it('rows per (type, direction, neighbour type), largest first; distinct neighbours', () => {
    expect(s.edges).toBe(10)
    expect(s.neighbors).toBe(8)
    expect(s.rows.map((r) => [neighborRowLabel(r), r.nodeIds.length])).toEqual([
      ['SOCIO_DE <- Person', 6],
      ['ADMINISTRA <- Person', 1],
      ['OWNS -> Company', 1],
      ['SOCIO_DE <- Company', 1],
    ])
  })

  it('leaves vs neighbours with another link', () => {
    expect(s.linkedIds).toEqual(['p0'])
    expect(s.leafIds).toHaveLength(7)
    expect(s.rows[0].leafIds).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
  })

  it('leafCollections keeps rows with enough leaves', () => {
    expect(leafCollections(s, 5).map((r) => r.key)).toEqual([s.rows[0].key])
    expect(leafCollections(s, 6)).toEqual([])
  })

  it('membersNoLongerLeaves: gained another link, or no longer touch the hub', () => {
    expect(membersNoLongerLeaves('hub', ['p0', 'p2', 'gone'], edges)).toEqual(['p0', 'gone'])
  })
})
