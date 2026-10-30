import { describe, it, expect } from 'vitest'
import { buildPreview, itemFileName, viewerItems, PREVIEW_MAX_ROWS, PREVIEW_MAX_ROWS_FULL } from '@/utils/itemPreview'

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('buildPreview', () => {
  it('reads CSV and SIMBA-style tab-separated text as a table', () => {
    expect(buildPreview(bytes('a;b\n1;2\n3;4'), 'text/csv')).toEqual({ kind: 'table', columns: ['a', 'b'], rows: [['1', '2'], ['3', '4']], total: 2 })
    const simba = buildPreview(bytes('CONTA\tVALOR\n109738-0\t3431900\n501677-1\t709100\n'), 'text/plain')
    expect(simba).toMatchObject({ kind: 'table', columns: ['CONTA', 'VALOR'], total: 2 })
  })

  it('reads JSON {columns, rows} with array rows, an array of records, and other JSON as text', () => {
    expect(buildPreview(bytes(JSON.stringify({ columns: ['id', 'n'], rows: [['x', 1]] })), 'application/json')).toEqual({ kind: 'table', columns: ['id', 'n'], rows: [['x', 1]], total: 1 })
    expect(buildPreview(bytes(JSON.stringify([{ cpf: '1', v: 2 }])), 'application/json')).toMatchObject({ kind: 'table', columns: ['cpf', 'v'], rows: [['1', 2]] })
    const text = buildPreview(bytes('{"nodes":[1]}'), 'application/json')
    expect(text.kind).toBe('text')
    expect(text.kind === 'text' && text.text).toContain('"nodes"')
  })

  it('caps rows but keeps the total', () => {
    const csv = ['k', ...Array.from({ length: PREVIEW_MAX_ROWS + 5 }, (_, i) => String(i))].join('\n')
    const p = buildPreview(bytes(csv), 'text/csv')
    expect(p.kind === 'table' && [p.rows.length, p.total]).toEqual([PREVIEW_MAX_ROWS, PREVIEW_MAX_ROWS + 5])
  })

  it('markdown is text, HTML is html, images and PDFs by type, binary is none', () => {
    expect(buildPreview(bytes('# Relatório'), 'text/markdown')).toEqual({ kind: 'text', text: '# Relatório', truncated: false })
    expect(buildPreview(bytes('<p>x</p>'), 'text/html')).toEqual({ kind: 'html', html: '<p>x</p>' })
    expect(buildPreview(bytes('x'), 'image/png').kind).toBe('image')
    expect(buildPreview(bytes('%PDF'), 'application/pdf').kind).toBe('pdf')
    expect(buildPreview(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]).buffer, 'application/zip').kind).toBe('none')
  })

  it('an SVG is never an image from a blob URL (its scripts would run in the app origin): it renders as sandboxed HTML', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    expect(buildPreview(bytes(svg), 'image/svg+xml')).toEqual({ kind: 'html', html: `<html><body style="margin:0">${svg}</body></html>` })
    expect(buildPreview(bytes('x'), 'image/jpeg; charset=binary').kind).toBe('image')
    expect(buildPreview(bytes('x'), 'image/webp').kind).toBe('image')
  })

  it('falls back to Windows-1252 for declared text that is not UTF-8', () => {
    const latin1 = new Uint8Array([0x4e, 0x4f, 0x4d, 0x45, 0x0a, 0x4a, 0x6f, 0xe3, 0x6f]).buffer // "NOME\nJoão"
    expect(buildPreview(latin1, 'text/plain')).toMatchObject({ kind: 'text', text: 'NOME\nJoão' })
  })
})

describe('itemFileName', () => {
  it('uses the uploaded name, else the title with an extension for the type', () => {
    const base = { title: 'Relatório', provenance: {}, latest: { content_type: 'text/markdown' } } as any
    expect(itemFileName({ ...base, provenance: { filename: 'CASO17_EXTRATO.TXT' } })).toBe('CASO17_EXTRATO.TXT')
    expect(itemFileName(base)).toBe('Relatório.md')
    expect(itemFileName({ ...base, latest: { content_type: 'application/x-unknown' } })).toBe('Relatório.bin')
  })

  it('the full-screen viewer asks for more rows', () => {
    const csv = ['n', ...Array.from({ length: 3000 }, (_, i) => String(i))].join('\n')
    expect(buildPreview(bytes(csv), 'text/csv')).toMatchObject({ total: 3000, rows: { length: PREVIEW_MAX_ROWS } })
    expect(buildPreview(bytes(csv), 'text/csv', PREVIEW_MAX_ROWS_FULL)).toMatchObject({ total: 3000, rows: { length: PREVIEW_MAX_ROWS_FULL } })
  })
})

describe('viewerItems', () => {
  it('steps through the material in its order: no graphs, no brief, nothing removed or without a version', () => {
    const it = (id: string, kind: string, extra: object = {}) => ({ id, kind, subkind: 'x', current_version: 1, ...extra }) as any
    const items = [
      it('n1', 'note'), it('g1', 'graph'), it('d1', 'document'), it('b', 'document', { subkind: 'brief' }),
      it('t1', 'table'), it('t0', 'table', { current_version: 0 }), it('q1', 'query'), it('d2', 'document', { deleted_at: '2026-10-01' }),
    ]
    expect(viewerItems(items).map((i) => i.id)).toEqual(['q1', 't1', 'd1', 'n1'])
  })
})
