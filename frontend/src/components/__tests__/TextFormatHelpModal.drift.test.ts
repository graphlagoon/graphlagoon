import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MODIFIER_REGISTRY } from '@/utils/labelModifiers'
import { validateTemplate } from '@/utils/labelFormatter'

/**
 * Drift guards between the hand-written help slides and the modifier registry:
 * every registered modifier must be demonstrated in at least one slide, and
 * every slide template must actually validate against the real parser.
 */

const sfcSource = readFileSync(
  resolve(__dirname, '../TextFormatHelpModal.vue'),
  'utf-8',
)

describe('TextFormatHelpModal drift guards', () => {
  it('demonstrates every registry modifier in at least one slide', () => {
    for (const name of Object.keys(MODIFIER_REGISTRY)) {
      expect(sfcSource, `modifier "${name}" missing from help slides`).toContain(`|${name}`)
    }
  })

  it('every slide template string validates against the real parser', () => {
    // Slide templates are single-quoted `template: '...'` entries in the SFC
    const templates = [...sfcSource.matchAll(/template: '((?:[^'\\]|\\.)*)'/g)]
      // Unescape the JS string literal ('\\{' in source → '\{' at runtime)
      .map((m) => m[1].replace(/\\(.)/g, '$1'))
    expect(templates.length).toBeGreaterThan(20)
    for (const template of templates) {
      const result = validateTemplate(template)
      expect(result.errors, `template "${template}" has errors`).toEqual([])
      expect(result.warnings, `template "${template}" has warnings`).toEqual([])
    }
  })

  it('slide templates avoid non-ASCII characters (canvas font limitation)', () => {
    const templates = [...sfcSource.matchAll(/template: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
    for (const template of templates) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7e]*$/.test(template), `template "${template}" contains non-ASCII`).toBe(true)
    }
  })
})
