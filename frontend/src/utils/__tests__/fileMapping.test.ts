import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { interpretMapping, suggestPresets, validateSpec, MappingError } from '@/utils/fileMapping'

// Golden fixtures shared with api/tests/test_file_mapping.py (parity).
const ROOT = join(__dirname, '../../__tests__/fixtures/fileMapping')
const CASES = readdirSync(ROOT)

function load(name: string) {
  const dir = join(ROOT, name)
  const files: Record<string, string> = {}
  for (const f of readdirSync(dir)) if (!f.endsWith('.json')) files[f] = readFileSync(join(dir, f), 'utf-8')
  const json = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf-8'))
  return { files, spec: json('spec.json'), expected: json('expected.json') }
}

describe('fileMapping golden fixtures', () => {
  it.each(CASES)('%s matches expected.json', (name) => {
    const { files, spec, expected } = load(name)
    expect(interpretMapping(spec, files)).toEqual(expected)
  })

  it('suggests a saved mapping when its inputs match the files', () => {
    const specs = { 'bank-statements': load('bank-statements').spec, 'company-registry': load('company-registry').spec }
    expect(suggestPresets(load('bank-statements').files, specs)).toEqual(['bank-statements'])
    expect(suggestPresets(load('generic').files, specs)).toEqual([])
  })

  it('checks fixed-width inputs and suggests them when the lines reach the last column', () => {
    const { spec, files } = load('fixed-width')
    const inp = spec.inputs.s
    expect(() => validateSpec({ ...spec, inputs: { s: { ...inp, delimiter: ';' } } })).toThrow(/not both/)
    expect(() => validateSpec({ ...spec, inputs: { s: { ...inp, widths: [8, 0] } } })).toThrow(/positive integers/)
    expect(() => validateSpec({ ...spec, inputs: { s: { ...inp, widths: [8, 10] } } })).toThrow(/one width per column/)
    expect(suggestPresets(files, { settlement: spec })).toEqual(['settlement'])
    expect(suggestPresets({ 'SETTLEMENT_1.TXT': 'M0001234\n' }, { settlement: spec })).toEqual([])
  })

  it('rejects unknown operators', () => {
    const spec = load('generic').spec
    spec.nodes[0].id = { col: 't.source', convert: 'rot13' }
    expect(() => validateSpec(spec)).toThrow(MappingError)
    expect(() => validateSpec({ ...load('generic').spec, nodes: [{ ...spec.nodes[1], when: { gt: ['t.amount', '1'] } }] })).toThrow(
      /unknown key 'gt'/,
    )
  })
})
