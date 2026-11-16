import { describe, it, expect } from 'vitest'
import font from '@/assets/fonts/Roboto-Regular.json'

// The canvas label atlas (scripts/gen-label-font.cjs): Portuguese and Spanish
// names must draw with their accents, and the symbols labels use must exist.
describe('label font atlas', () => {
  const chars = new Set((font as { chars: { char: string }[] }).chars.map((c) => c.char))
  it('covers ASCII, Latin-1 letters and the symbols captions use', () => {
    for (let c = 32; c <= 126; c++) expect(chars.has(String.fromCharCode(c))).toBe(true)
    for (const ch of 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇñÑºª·×–—…€') expect(chars.has(ch), ch).toBe(true)
  })
})
