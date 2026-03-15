import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useToolbarStore } from '@/stores/toolbar'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('toolbar store', () => {
  it('starts with no handlers', () => {
    const store = useToolbarStore()
    expect(store.handlers).toBeNull()
  })

  it('registerHandlers sets handlers', () => {
    const store = useToolbarStore()
    const handlers = {
      onToggleFilters: vi.fn(),
      onToggleBehaviors: vi.fn(),
      onToggleQuery: vi.fn(),
      onToggleMetrics: vi.fn(),
      onToggleAesthetics: vi.fn(),
      onToggleLabels: vi.fn(),
      onToggleClusterPrograms: vi.fn(),
      onToggleTemplates: vi.fn(),
      onExportPNG: vi.fn(),
    }

    store.registerHandlers(handlers)
    expect(store.handlers).not.toBeNull()
    expect(store.handlers!.onToggleFilters).toBe(handlers.onToggleFilters)
  })

  it('unregisterHandlers clears handlers', () => {
    const store = useToolbarStore()
    store.registerHandlers({
      onToggleFilters: vi.fn(),
      onToggleBehaviors: vi.fn(),
      onToggleQuery: vi.fn(),
      onToggleMetrics: vi.fn(),
      onToggleAesthetics: vi.fn(),
      onToggleLabels: vi.fn(),
      onToggleClusterPrograms: vi.fn(),
      onToggleTemplates: vi.fn(),
      onExportPNG: vi.fn(),
    })

    store.unregisterHandlers()
    expect(store.handlers).toBeNull()
  })

  it('handlers can be called through store', () => {
    const store = useToolbarStore()
    const onToggleFilters = vi.fn()
    store.registerHandlers({
      onToggleFilters,
      onToggleBehaviors: vi.fn(),
      onToggleQuery: vi.fn(),
      onToggleMetrics: vi.fn(),
      onToggleAesthetics: vi.fn(),
      onToggleLabels: vi.fn(),
      onToggleClusterPrograms: vi.fn(),
      onToggleTemplates: vi.fn(),
      onExportPNG: vi.fn(),
    })

    store.handlers!.onToggleFilters()
    expect(onToggleFilters).toHaveBeenCalledOnce()
  })

  it('updateCanvasDimensions sets width and height', () => {
    const store = useToolbarStore()
    expect(store.canvasWidth).toBe(0)
    expect(store.canvasHeight).toBe(0)

    store.updateCanvasDimensions(1920, 1080)
    expect(store.canvasWidth).toBe(1920)
    expect(store.canvasHeight).toBe(1080)
  })
})
