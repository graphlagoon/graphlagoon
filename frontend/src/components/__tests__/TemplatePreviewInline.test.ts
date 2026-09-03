import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import TemplatePreviewInline from '@/components/TemplatePreviewInline.vue'
import { useGraphStore } from '@/stores/graph'

function seedStore() {
  const graphStore = useGraphStore()
  graphStore.nodes = [
    { node_id: '12321_CNPJ_RAIZ', node_type: 'Empresa', properties: { name: 'Acme' } },
    { node_id: '0_CNPJ_RAIZ', node_type: 'Empresa', properties: { name: 'Beta' } },
    { node_id: 'p1', node_type: 'Person', properties: { name: 'alice' } },
    { node_id: 'p2', node_type: 'Person', properties: { name: 'bob' } },
  ]
  graphStore.edges = [
    { edge_id: 'e1', src: 'p1', dst: 'p2', relationship_type: 'KNOWS' },
  ]
  return graphStore
}

async function flushDebounce() {
  await vi.advanceTimersByTimeAsync(400)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TemplatePreviewInline', () => {
  it('renders formatted samples for the first matching nodes', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '{node_id|split:_:0}', target: 'node', types: ['Empresa'] },
    })
    await flushDebounce()

    const samples = container.querySelectorAll('[data-testid="preview-sample"]')
    expect(samples).toHaveLength(2)
    expect(samples[0].textContent?.trim()).toBe('12321')
    expect(samples[1].textContent?.trim()).toBe('0')
  })

  it('caps samples at 3', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '{node_id}', target: 'node' },
    })
    await flushDebounce()
    expect(container.querySelectorAll('[data-testid="preview-sample"]')).toHaveLength(3)
  })

  it('formats edge samples for edge target', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '{src} -> {dst}', target: 'edge' },
    })
    await flushDebounce()
    const samples = container.querySelectorAll('[data-testid="preview-sample"]')
    expect(samples).toHaveLength(1)
    expect(samples[0].textContent?.trim()).toBe('p1 -> p2')
  })

  it('shows errors for invalid templates instead of samples', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '{prop:name|match:/(bad/}', target: 'node' },
    })
    await flushDebounce()
    expect(container.querySelectorAll('[data-testid="preview-error"]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-testid="preview-sample"]')).toHaveLength(0)
  })

  it('shows warnings for unknown modifiers but still previews', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '{prop:name|nonsense}', target: 'node' },
    })
    await flushDebounce()
    expect(container.querySelectorAll('[data-testid="preview-warning"]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-testid="preview-sample"]').length).toBeGreaterThan(0)
  })

  it('shows an empty hint when no items match', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '{node_id}', target: 'node', types: ['Inexistente'] },
    })
    await flushDebounce()
    expect(container.querySelector('[data-testid="preview-empty"]')).not.toBeNull()
  })

  it('renders nothing at all for an empty template', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '   ', target: 'node' },
    })
    await flushDebounce()
    expect(container.querySelector('[data-testid="template-preview"]')).toBeNull()
  })

  it('debounces template changes by 400ms', async () => {
    seedStore()
    const { container, rerender } = render(TemplatePreviewInline, {
      props: { template: '{node_id}', target: 'node', types: ['Person'] },
    })
    await flushDebounce()
    expect(container.querySelector('[data-testid="preview-sample"]')?.textContent?.trim()).toBe('p1')

    await rerender({ template: '{node_id|upper}', target: 'node', types: ['Person'] })
    // Before the debounce fires, still the old preview
    await vi.advanceTimersByTimeAsync(200)
    expect(container.querySelector('[data-testid="preview-sample"]')?.textContent?.trim()).toBe('p1')
    await vi.advanceTimersByTimeAsync(200)
    expect(container.querySelector('[data-testid="preview-sample"]')?.textContent?.trim()).toBe('P1')
  })
})

describe('TemplatePreviewInline — tooltip chrome and empty fallback', () => {
  it('renders nothing for an empty template without a fallback (unchanged)', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '', target: 'node' },
    })
    await flushDebounce()

    expect(container.querySelector('[data-testid="template-preview"]')).toBeNull()
  })

  it('an empty template with a fallback previews the inherited template with a badge', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: {
        template: '',
        target: 'node',
        types: ['Person'],
        emptyFallback: { template: '{prop:name|upper}', badge: '= label' },
      },
    })
    await flushDebounce()

    expect(container.querySelector('[data-testid="preview-fallback-badge"]')?.textContent?.trim()).toBe(
      '= label'
    )
    const bodies = [...container.querySelectorAll('[data-testid="preview-sample"]')].map(
      (el) => el.textContent
    )
    expect(bodies).toEqual(['ALICE', 'BOB'])
  })

  it('typing a template hides the badge and previews the template itself', async () => {
    seedStore()
    const { container, rerender } = render(TemplatePreviewInline, {
      props: {
        template: '',
        target: 'node',
        types: ['Person'],
        emptyFallback: { template: '{prop:name}', badge: '= label' },
      },
    })
    await flushDebounce()
    await rerender({ template: '{node_id}' })
    await flushDebounce()

    expect(container.querySelector('[data-testid="preview-fallback-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-sample"]')?.textContent).toBe('p1')
  })

  it('tooltip chrome wraps each sample in a box with the type chip', async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '{prop:name}', target: 'node', types: ['Person'], chrome: 'tooltip' },
    })
    await flushDebounce()

    const boxes = container.querySelectorAll('[data-testid="preview-tooltip-chrome"]')
    expect(boxes.length).toBe(2)
    expect(boxes[0].querySelector('.preview-tooltip-type')?.textContent).toBe('Person')
  })

  it("edge samples get the literal 'Edge' chip", async () => {
    seedStore()
    const { container } = render(TemplatePreviewInline, {
      props: { template: '{src} -> {dst}', target: 'edge', chrome: 'tooltip' },
    })
    await flushDebounce()

    expect(container.querySelector('.preview-tooltip-type')?.textContent).toBe('Edge')
  })
})
