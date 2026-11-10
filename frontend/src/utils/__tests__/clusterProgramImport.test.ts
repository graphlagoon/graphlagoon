import { describe, it, expect } from 'vitest'
import { parseImportedClusterPrograms, portableClusterProgram } from '@/utils/clusterProgramImport'

const answer = {
  program_name: 'Same city',
  description: 'Nodes that share a city',
  code: 'return []',
  show_in_context_menu: true,
  parameters: [
    { id: 'city', type: 'text', label: 'City', node_binding: 'prop:city' },
    { id: 'minSize', type: 'number', default: '3', required: false },
    { id: 'mode', type: 'select', options: ['a', 'b'], default: 'b' },
    { id: 'strict', type: 'boolean' },
  ],
}

describe('parseImportedClusterPrograms', () => {
  it('reads the bare object an AI answers with, parameters included', () => {
    const r = parseImportedClusterPrograms(JSON.stringify(answer))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [p] = r.programs
    expect(p.program_name).toBe('Same city')
    expect(p.show_in_context_menu).toBe(true)
    expect(p.parameters).toEqual([
      { id: 'city', type: 'text', label: 'City', required: true, node_binding: 'prop:city' },
      { id: 'minSize', type: 'number', default: 3, required: false },
      { id: 'mode', type: 'select', options: ['a', 'b'], default: 'b', required: true },
      { id: 'strict', type: 'boolean', default: false, required: false },
    ])
  })

  it('strips a ```json fence and accepts code as an array of lines and `name`', () => {
    const text = '```json\n' + JSON.stringify({ name: 'X', code: ['const a = 1', 'return []'] }) + '\n```'
    const r = parseImportedClusterPrograms(text)
    expect(r.ok && r.programs[0]).toMatchObject({ program_name: 'X', code: 'const a = 1\nreturn []' })
  })

  it('reads arrays and the export envelope, refusing other export kinds', () => {
    const arr = parseImportedClusterPrograms(JSON.stringify([answer, { ...answer, program_name: 'Two' }]))
    expect(arr.ok && arr.programs.map((p) => p.program_name)).toEqual(['Same city', 'Two'])

    const env = parseImportedClusterPrograms(JSON.stringify({
      graphlagoon_export: 'cluster-programs', export_version: 1,
      source: { context_title: 'Social', node_types: ['Person'] }, programs: [answer],
    }))
    expect(env.ok && env.source?.context_title).toBe('Social')

    const other = parseImportedClusterPrograms(JSON.stringify({ graphlagoon_export: 'custom-metrics', metrics: [] }))
    expect(other).toEqual({ ok: false, error: 'This file is a "custom-metrics" export, not cluster programs' })
  })

  it.each([
    [{ code: 'return []' }, 'missing "program_name"'],
    [{ program_name: 'a' }, 'missing "code"'],
    [{ program_name: 'a', code: 'x', parameters: {} }, '"parameters" must be an array'],
    [{ program_name: 'a', code: 'x', parameters: [{ id: '1bad' }] }, 'JavaScript identifier'],
    [{ program_name: 'a', code: 'x', parameters: [{ id: 'a', type: 'date' }] }, '"type" must be one of'],
    [{ program_name: 'a', code: 'x', parameters: [{ id: 'a', type: 'select' }] }, 'needs "options"'],
    [{ program_name: 'a', code: 'x', parameters: [{ id: 'a', type: 'select', options: ['x'], default: 'y' }] }, 'one of its options'],
    [{ program_name: 'a', code: 'x', parameters: [{ id: 'a', type: 'number', default: 'abc' }] }, 'must be a number'],
    [{ program_name: 'a', code: 'x', parameters: [{ id: 'a', node_binding: 'prop:' }] }, '"node_binding" must be'],
    [{ program_name: 'a', code: 'x', parameters: [{ id: 'a' }, { id: 'a' }] }, 'duplicate parameter id "a"'],
  ])('rejects %j', (raw, msg) => {
    const r = parseImportedClusterPrograms(JSON.stringify(raw))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })

  it('rejects text that is not JSON', () => {
    expect(parseImportedClusterPrograms('nope')).toEqual({ ok: false, error: 'Not valid JSON' })
  })

  it('round-trips through the portable shape without ids, scope or timestamps', () => {
    const portable = portableClusterProgram({
      program_id: 'p1', program_name: 'P', code: 'return []', scope: 'context',
      created_at: 'x', updated_at: 'y',
      parameters: [{ id: 'k', type: 'text', required: true }],
    })
    expect(portable).toEqual({ program_name: 'P', code: 'return []', parameters: [{ id: 'k', type: 'text', required: true }] })
    const r = parseImportedClusterPrograms(JSON.stringify(portable))
    expect(r.ok && r.programs[0]).toEqual(portable)
  })
})
