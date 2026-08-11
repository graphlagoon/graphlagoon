/**
 * Tests for the pure logic functions used by ContextsView.vue and
 * GraphContextFormModal.vue.
 *
 * These import the REAL functions from utils/contextForm.ts — previously this
 * file re-declared copies of them because the SFC didn't export them, which
 * meant it was testing copies rather than the actual logic.
 */
import { describe, it, expect } from 'vitest'
import { fuzzyMatch, parseTag, parseTableName } from '@/utils/contextForm'

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
