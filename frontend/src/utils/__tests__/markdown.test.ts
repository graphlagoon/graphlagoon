import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/utils/markdown'

describe('renderMarkdown (UX-1)', () => {
  it('renders the subset: headings, paragraphs with breaks, lists, code, emphasis, tables, links', () => {
    const html = renderMarkdown([
      '# Summary',
      'First line',
      'second **bold** and *it* and `x < 1`',
      '',
      '- one',
      '- two',
      '',
      '1. a',
      '2. b',
      '',
      '| col | n |',
      '|---|---|',
      '| a | 1 |',
      '',
      '```',
      '<b>raw</b>',
      '```',
      '> quoted',
      '---',
      'see [the doc](https://example.com/a?b=1&c=2) or https://example.org/x.',
    ].join('\n'))
    expect(html).toContain('<h3>Summary</h3>')
    expect(html).toContain('<p>First line<br>second <strong>bold</strong> and <em>it</em> and <code>x &lt; 1</code></p>')
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(html).toContain('<ol><li>a</li><li>b</li></ol>')
    expect(html).toContain('<table><thead><tr><th>col</th><th>n</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>')
    expect(html).toContain('<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>')
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<hr>')
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the doc</a>')
    expect(html).toContain('<a href="https://example.org/x" target="_blank" rel="noopener noreferrer">https://example.org/x</a>.')
  })

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](https://a.com" onclick="alert(1))',
    '<a href="javascript:alert(1)">x</a>',
    '`<svg onload=alert(1)>`',
    '| <b onmouseover=x> |\n|---|\n| y |',
    '&lt;script&gt;',
  ])('never lets markup or a script URL through: %s', (input) => {
    const html = renderMarkdown(input)
    expect(html).not.toMatch(/<(script|img|svg|b )/i)
    expect(html).not.toMatch(/href="(?!https?:|mailto:)/i)
    expect(html).not.toMatch(/<[^>]*\son\w+=/i)
  })

  it('keeps an unsafe link as text', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>')
  })
})
