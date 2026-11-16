import { describe, it, expect } from 'vitest'
import {
  AUTO_REVEAL_MIN_LEAVES,
  chooseEgoOrdering,
  EGO_CROWDED_RING,
  resolveHubLeavesMode,
  revealRegions,
} from '../autoAdjust'
import type { HubLeafRegion } from '../hubLeaves'

const region = (hub: string, count: number): HubLeafRegion => ({ hub, key: 'k', count, dx: 0, dy: 0, radius: 1, members: [] })

describe('resolveHubLeavesMode', () => {
  it("'auto' follows the master switch; fixed values ignore it", () => {
    expect(resolveHubLeavesMode({ hubLeaves: 'auto', autoAdjust: true })).toBe('auto')
    expect(resolveHubLeavesMode({ hubLeaves: 'auto', autoAdjust: false })).toBe('free')
    expect(resolveHubLeavesMode({ hubLeaves: 'petals', autoAdjust: false })).toBe('petals')
    expect(resolveHubLeavesMode({ hubLeaves: 'free', autoAdjust: true })).toBe('free')
  })
})

describe('revealRegions', () => {
  // big: two petals that together reach the threshold; small: just under it
  const regions = [region('big', AUTO_REVEAL_MIN_LEAVES - 500), region('big', 500), region('small', AUTO_REVEAL_MIN_LEAVES - 1)]

  it("'auto' applies per hub, by its total leaves", () => {
    expect(revealRegions(regions, 'auto', true)).toEqual([true, true, false])
  })

  it("'on' applies to every hub, 'off' to none; the master switch turns 'auto' off but not 'on'", () => {
    expect(revealRegions(regions, 'on', true)).toEqual([true, true, true])
    expect(revealRegions(regions, 'off', true)).toEqual([false, false, false])
    expect(revealRegions(regions, 'auto', false)).toEqual([false, false, false])
    expect(revealRegions(regions, 'on', false)).toEqual([true, true, true])
  })
})

describe('chooseEgoOrdering', () => {
  const roles = ['Socio', 'Administrador', 'Diretor', 'Conselheiro']
  const ring = (n: number, props: (i: number) => Record<string, unknown>, type: (i: number) => string = () => 'Person') =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nodeType: type(i), properties: props(i) }))
  const all = (r: { id: string }[]) => new Set(r.map((x) => x.id))

  it('a crowded ring of leaves is sectored by the property that splits it best', () => {
    const ring1 = ring(200, (i) => ({ qualificacao: roles[i % 4], name: `n${i}` }))
    expect(chooseEgoOrdering({ ring1, leafIds: all(ring1) })).toMatchObject({ ordering: 'property', key: 'qualificacao' })
  })

  it('node type wins when it is the better split', () => {
    const ring1 = ring(200, () => ({ uf: 'SP' }), (i) => (i % 2 ? 'Person' : 'Company'))
    expect(chooseEgoOrdering({ ring1, leafIds: all(ring1) }).ordering).toBe('node-type')
  })

  it('falls back to fewest crossings: small ring, few leaves, or nothing splits the ring', () => {
    const small = ring(EGO_CROWDED_RING - 1, (i) => ({ qualificacao: roles[i % 4] }))
    expect(chooseEgoOrdering({ ring1: small, leafIds: all(small) }).ordering).toBe('barycenter')

    const linked = ring(200, (i) => ({ qualificacao: roles[i % 4] }))
    expect(chooseEgoOrdering({ ring1: linked, leafIds: new Set(linked.slice(0, 50).map((x) => x.id)) }).ordering).toBe('barycenter')

    const uniform = ring(200, (i) => ({ name: `n${i}`, uf: 'SP' }))
    const r = chooseEgoOrdering({ ring1: uniform, leafIds: all(uniform) })
    expect(r.ordering).toBe('barycenter')
    expect(r.reason).toContain('no type or property splits')
  })

  it('is deterministic whatever the order of the ring', () => {
    const ring1 = ring(120, (i) => ({ a: roles[i % 4], b: roles[i % 4] }))
    const x = chooseEgoOrdering({ ring1, leafIds: all(ring1) })
    const y = chooseEgoOrdering({ ring1: [...ring1].reverse(), leafIds: all(ring1) })
    expect(x).toEqual(y)
    expect(x).toMatchObject({ ordering: 'property', key: 'a' }) // a tie goes to the first key by name
  })
})
