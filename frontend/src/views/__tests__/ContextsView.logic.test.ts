/**
 * Tests for pure logic functions extracted from ContextsView.vue.
 * These functions are tested directly without mounting the component.
 */
import { describe, it, expect } from 'vitest'

// The functions below mirror the logic in ContextsView.vue.
// We redefine them here since they're not exported from the SFC.

function fuzzyMatch(text: string, query: string): boolean {
  const textLower = text.toLowerCase()
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every(term => textLower.includes(term))
}

function parseTag(tag: string): { name: string; value: string } | null {
  const colonIndex = tag.indexOf(':')
  if (colonIndex > 0) {
    return {
      name: tag.substring(0, colonIndex).trim(),
      value: tag.substring(colonIndex + 1).trim(),
    }
  }
  return null
}

function parseTableName(fullName: string): { catalog: string; database: string; table: string } | null {
  const parts = fullName.split('.')
  if (parts.length === 2) {
    return { catalog: 'spark_catalog', database: parts[0], table: parts[1] }
  } else if (parts.length === 3) {
    return { catalog: parts[0], database: parts[1], table: parts[2] }
  }
  return null
}

describe('fuzzyMatch', () => {
  it('matches single term', () => {
    expect(fuzzyMatch('Hello World', 'hello')).toBe(true)
  })

  it('matches multiple terms in any order', () => {
    expect(fuzzyMatch('Hello World', 'world hello')).toBe(true)
  })

  it('is case insensitive', () => {
    expect(fuzzyMatch('Hello World', 'HELLO')).toBe(true)
  })

  it('fails when a term is missing', () => {
    expect(fuzzyMatch('Hello World', 'hello foo')).toBe(false)
  })

  it('empty query matches everything', () => {
    expect(fuzzyMatch('anything', '')).toBe(true)
  })

  it('whitespace-only query matches everything', () => {
    expect(fuzzyMatch('anything', '   ')).toBe(true)
  })

  it('handles partial matches within words', () => {
    expect(fuzzyMatch('production-database', 'prod data')).toBe(true)
  })
})

describe('parseTag', () => {
  it('parses name:value format', () => {
    expect(parseTag('env:prod')).toEqual({ name: 'env', value: 'prod' })
  })

  it('trims whitespace around parts', () => {
    expect(parseTag('team : data-eng')).toEqual({ name: 'team', value: 'data-eng' })
  })

  it('returns null for tag without colon', () => {
    expect(parseTag('simple-tag')).toBeNull()
  })

  it('returns null when colon is at position 0', () => {
    expect(parseTag(':value')).toBeNull()
  })

  it('handles multiple colons (uses first)', () => {
    const result = parseTag('url:http://example.com:8080')
    expect(result).toEqual({ name: 'url', value: 'http://example.com:8080' })
  })
})

describe('parseTableName', () => {
  it('parses 2-part name (database.table)', () => {
    const result = parseTableName('mydb.users')
    expect(result).toEqual({
      catalog: 'spark_catalog',
      database: 'mydb',
      table: 'users',
    })
  })

  it('parses 3-part name (catalog.database.table)', () => {
    const result = parseTableName('unity_catalog.graphs.edges')
    expect(result).toEqual({
      catalog: 'unity_catalog',
      database: 'graphs',
      table: 'edges',
    })
  })

  it('returns null for single name', () => {
    expect(parseTableName('justatable')).toBeNull()
  })

  it('returns null for 4+ parts', () => {
    expect(parseTableName('a.b.c.d')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseTableName('')).toBeNull()
  })
})
