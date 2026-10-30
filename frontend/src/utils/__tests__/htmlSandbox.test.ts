import { afterEach, describe, it, expect } from 'vitest'
import { htmlCsp, htmlScriptsMode, sandboxHtml, HTML_SCRIPT_CDNS } from '@/utils/htmlSandbox'

const parse = (srcdoc: string) => new DOMParser().parseFromString(srcdoc, 'text/html')
const policy = (srcdoc: string) => parse(srcdoc).head.firstElementChild

afterEach(() => {
  delete (window as { __GRAPH_LAGOON_CONFIG__?: unknown }).__GRAPH_LAGOON_CONFIG__
})

describe('sandboxHtml', () => {
  it('never gives the document the app origin, and never lets it navigate, pop up or post', () => {
    for (const mode of ['none', 'inline', 'cdn'] as const) {
      const { sandbox } = sandboxHtml('<p>x</p>', mode)
      expect(sandbox).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals/)
    }
    expect(sandboxHtml('<p>x</p>', 'none').sandbox).toBe('')
    expect(sandboxHtml('<p>x</p>', 'inline').sandbox).toBe('allow-scripts')
    expect(sandboxHtml('<p>x</p>', 'cdn').sandbox).toBe('allow-scripts')
  })

  it('puts the policy first in <head>, before a script the document had above its head', () => {
    const { srcdoc } = sandboxHtml('<script>fetch("https://evil.example")</script><head><title>r</title></head><body><p>ok</p></body>', 'inline')
    expect(srcdoc.startsWith('<!doctype html>')).toBe(true)
    const meta = policy(srcdoc)!
    expect(meta.tagName).toBe('META')
    expect(meta.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(meta.getAttribute('content')).toBe(htmlCsp('inline'))
    expect(parse(srcdoc).body.textContent).toContain('ok')
  })

  it("keeps the document's own policy (it can only add restrictions)", () => {
    const own = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head><body></body></html>'
    const metas = [...parse(sandboxHtml(own, 'cdn').srcdoc).head.querySelectorAll('meta[http-equiv]')].map((m) => m.getAttribute('content'))
    expect(metas).toEqual([htmlCsp('cdn'), "script-src 'none'"])
  })
})

describe('htmlCsp', () => {
  it('no network in any mode: requests, frames, forms and base are closed; images only inline', () => {
    for (const mode of ['none', 'inline', 'cdn'] as const) {
      const csp = htmlCsp(mode)
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("connect-src 'none'")
      expect(csp).toContain("frame-src 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).toContain("base-uri 'none'")
      expect(csp).toContain('img-src data: blob:;')
    }
  })

  it('scripts: none has no script-src, inline only its own, cdn also the known CDNs', () => {
    expect(htmlCsp('none')).not.toContain('script-src')
    expect(htmlCsp('inline')).toContain("script-src 'unsafe-inline' 'unsafe-eval';")
    expect(htmlCsp('inline')).not.toContain('https://')
    const cdn = htmlCsp('cdn')
    expect(cdn).toContain(`script-src 'unsafe-inline' 'unsafe-eval' ${HTML_SCRIPT_CDNS.join(' ')};`)
    expect(cdn).toContain('https://fonts.googleapis.com')
    expect(cdn).toContain('https://fonts.gstatic.com')
  })
})

describe('htmlScriptsMode', () => {
  it("reads the server's mode; a server that does not say gets none", () => {
    expect(htmlScriptsMode()).toBe('none')
    window.__GRAPH_LAGOON_CONFIG__ = { investigation_html_scripts: 'cdn' } as any
    expect(htmlScriptsMode()).toBe('cdn')
    window.__GRAPH_LAGOON_CONFIG__ = { investigation_html_scripts: 'bogus' } as any
    expect(htmlScriptsMode()).toBe('none')
  })
})
