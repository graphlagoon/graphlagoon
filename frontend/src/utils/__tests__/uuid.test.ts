import { describe, expect, it } from 'vitest'
import { uuidOrNull } from '@/utils/uuid'

describe('uuidOrNull', () => {
  it('keeps a UUID and refuses anything that could add path segments', () => {
    const id = '0d6f8c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f'
    expect(uuidOrNull(id)).toBe(id)
    expect(uuidOrNull(id.toUpperCase())).toBe(id.toUpperCase())
    expect(uuidOrNull(`${id}/items/${id}/confirm?`)).toBeNull()
    expect(uuidOrNull('../admin')).toBeNull()
    expect(uuidOrNull([id])).toBeNull()
    expect(uuidOrNull(undefined)).toBeNull()
  })
})
