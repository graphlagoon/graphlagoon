import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { interpretMapping, suggestPresets, validateSpec, MappingError } from '@/utils/fileMapping'
import { FILE_MAPPING_PRESETS, QSA_RECEITA, SIMBA_V31 } from '@/utils/fileMappingPresets'

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

  it('presets equal their fixture specs', () => {
    expect(SIMBA_V31).toEqual(load('simba-mini').spec)
    expect(QSA_RECEITA).toEqual(load('qsa-mini').spec)
  })

  it('suggests a preset when the headers match', () => {
    expect(suggestPresets(load('simba-mini').files, FILE_MAPPING_PRESETS)).toEqual(['simba_v31'])
    expect(suggestPresets(load('qsa-mini').files, FILE_MAPPING_PRESETS)).toEqual(['qsa_receita'])
    expect(suggestPresets(load('generico').files, FILE_MAPPING_PRESETS)).toEqual([])
  })

  it('rejects unknown operators', () => {
    const spec = load('generico').spec
    spec.nodes[0].id = { col: 't.origem', convert: 'rot13' }
    expect(() => validateSpec(spec)).toThrow(MappingError)
    expect(() => validateSpec({ ...load('generico').spec, nodes: [{ ...spec.nodes[1], when: { gt: ['t.valor', '1'] } }] })).toThrow(
      /unknown key 'gt'/,
    )
  })
})
