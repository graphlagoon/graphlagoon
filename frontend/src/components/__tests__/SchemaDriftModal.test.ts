import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import SchemaDriftModal from '@/components/SchemaDriftModal.vue'
import { useSchemaDrift } from '@/composables/useSchemaDrift'
import { createSchemaDrift, createSchemaDriftFinding } from '@/__tests__/fixtures/schemaDrift'

vi.mock('@/services/api', () => ({
  api: {
    getSchemaDrift: vi.fn(),
    updateGraphContext: vi.fn(),
    getExplorations: vi.fn(),
  },
}))

import { api } from '@/services/api'

async function flush() {
  // Several sequential awaits chain here (check() -> getSchemaDrift, then
  // getExplorations) — more ticks than a single-await flow needs.
  for (let i = 0; i < 15; i++) await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  useSchemaDrift().clear('ctx-1')
  vi.mocked(api.getExplorations).mockResolvedValue([])
})

describe('SchemaDriftModal', () => {
  it('fetches drift when opened without a cached result, types included', async () => {
    vi.mocked(api.getSchemaDrift).mockResolvedValue(createSchemaDrift({ context_id: 'ctx-1' }))
    render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
    await flush()
    expect(api.getSchemaDrift).toHaveBeenCalledWith('ctx-1', { checkTypes: true })
  })

  it('shows a clean-state message when status is ok', async () => {
    vi.mocked(api.getSchemaDrift).mockResolvedValue(createSchemaDrift({ context_id: 'ctx-1', status: 'ok' }))
    const { container } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
    await flush()
    expect(container.textContent).toContain('Nothing to fix')
  })

  it('builds the apply payload from proposed properties', async () => {
    const drift = createSchemaDrift({
      context_id: 'ctx-1',
      status: 'error',
      findings: [
        createSchemaDriftFinding({ code: 'PROPERTY_COLUMN_MISSING', side: 'node', name: 'email' }),
      ],
      proposed: {
        node_properties: [{ name: 'name', data_type: 'string' }],
        edge_properties: [],
        node_types: null,
        relationship_types: null,
      },
    })
    vi.mocked(api.getSchemaDrift).mockResolvedValue(drift)
    vi.mocked(api.updateGraphContext).mockResolvedValue({} as any)

    const { getByTestId } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
    await flush()

    await fireEvent.click(getByTestId('schema-drift-apply'))
    await flush()

    expect(api.updateGraphContext).toHaveBeenCalledTimes(1)
    const [id, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
    expect(id).toBe('ctx-1')
    expect(payload.node_properties).toEqual([{ name: 'name', data_type: 'string' }])
  })

  it('a deselected missing-property finding keeps the stale column instead of dropping it', async () => {
    const drift = createSchemaDrift({
      context_id: 'ctx-1',
      status: 'error',
      findings: [
        createSchemaDriftFinding({
          code: 'PROPERTY_COLUMN_MISSING',
          side: 'node',
          name: 'email',
          stored: { data_type: 'string', display_name: 'E-mail' },
        }),
      ],
      proposed: {
        node_properties: [{ name: 'name', data_type: 'string' }],
        edge_properties: [],
        node_types: null,
        relationship_types: null,
      },
    })
    vi.mocked(api.getSchemaDrift).mockResolvedValue(drift)
    vi.mocked(api.updateGraphContext).mockResolvedValue({} as any)

    const { getByTestId, container } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
    await flush()

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    await fireEvent.click(checkbox) // deselect -> keep the stale column

    await fireEvent.click(getByTestId('schema-drift-apply'))
    await flush()

    const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
    expect(payload.node_properties).toEqual(
      expect.arrayContaining([
        { name: 'name', data_type: 'string' },
        { name: 'email', data_type: 'string', display_name: 'E-mail', description: undefined },
      ]),
    )
  })

  it('a rename mapping carries display_name across and drops both findings from the list', async () => {
    const drift = createSchemaDrift({
      context_id: 'ctx-1',
      status: 'error',
      findings: [
        createSchemaDriftFinding({
          code: 'PROPERTY_COLUMN_MISSING',
          side: 'node',
          name: 'email',
          severity: 'error',
          stored: { data_type: 'string', display_name: 'E-mail' },
        }),
        createSchemaDriftFinding({
          code: 'PROPERTY_COLUMN_ADDED',
          side: 'node',
          name: 'email_address',
          severity: 'info',
          stored: null,
          live: { data_type: 'string' },
        }),
      ],
      proposed: {
        node_properties: [{ name: 'email_address', data_type: 'string' }],
        edge_properties: [],
        node_types: null,
        relationship_types: null,
      },
    })
    vi.mocked(api.getSchemaDrift).mockResolvedValue(drift)
    vi.mocked(api.updateGraphContext).mockResolvedValue({} as any)

    const { getByTestId, container } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
    await flush()

    const select = container.querySelector('.rename-row select') as HTMLSelectElement
    expect(select).not.toBeNull()
    await fireEvent.update(select, 'email_address')
    await flush()

    // Both findings suppressed from the visible list once mapped.
    expect(container.querySelectorAll('.finding-row').length).toBe(0)

    await fireEvent.click(getByTestId('schema-drift-apply'))
    await flush()

    const [, payload] = vi.mocked(api.updateGraphContext).mock.calls[0]
    expect(payload.node_properties).toEqual([
      { name: 'email_address', data_type: 'string', display_name: 'E-mail', description: undefined },
    ])
  })

  it('disables Apply without write access', async () => {
    vi.mocked(api.getSchemaDrift).mockResolvedValue(
      createSchemaDrift({
        context_id: 'ctx-1',
        status: 'error',
        findings: [createSchemaDriftFinding()],
      }),
    )
    const { getByTestId } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: false } })
    await flush()

    expect((getByTestId('schema-drift-apply') as HTMLButtonElement).disabled).toBe(true)
  })

  it('hides Apply entirely when the table is not found', async () => {
    vi.mocked(api.getSchemaDrift).mockResolvedValue(
      createSchemaDrift({
        context_id: 'ctx-1',
        status: 'error',
        findings: [
          createSchemaDriftFinding({ code: 'TABLE_NOT_FOUND', side: 'node', kind: 'table', auto_fixable: false }),
        ],
      }),
    )
    const { queryByTestId } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
    await flush()

    expect(queryByTestId('schema-drift-apply')).toBeNull()
  })

  // types_checked comes back false only when discovery actually FAILED — the
  // request always asks for it now — so the modal surfaces a retry, not an opt-in.
  it('surfaces a retry when type discovery failed', async () => {
    vi.mocked(api.getSchemaDrift).mockResolvedValue(
      createSchemaDrift({ context_id: 'ctx-1', status: 'ok', types_checked: false }),
    )
    const { getByTestId } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
    await flush()

    expect(getByTestId('schema-drift-types-failed').textContent).toContain('discovery failed')

    await fireEvent.click(getByTestId('schema-drift-check-types'))
    await flush()

    expect(api.getSchemaDrift).toHaveBeenNthCalledWith(2, 'ctx-1', { checkTypes: true })
  })

  it('reports types as included when discovery succeeded, with no retry offered', async () => {
    vi.mocked(api.getSchemaDrift).mockResolvedValue(
      createSchemaDrift({ context_id: 'ctx-1', status: 'ok', types_checked: true }),
    )
    const { queryByTestId } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
    await flush()

    expect(queryByTestId('schema-drift-types-failed')).toBeNull()
    expect(queryByTestId('schema-drift-check-types')).toBeNull()
  })

  describe('dangling references', () => {
    const DRIFT_DROPS_EMAIL = createSchemaDrift({
      context_id: 'ctx-1',
      status: 'error',
      findings: [
        createSchemaDriftFinding({ code: 'PROPERTY_COLUMN_MISSING', side: 'node', name: 'email' }),
      ],
      proposed: {
        node_properties: [{ name: 'name', data_type: 'string' }],
        edge_properties: [],
        node_types: null,
        relationship_types: null,
      },
    })

    function explorationReferencing(propertyRef: string) {
      return {
        id: 'exp-1',
        graph_context_id: 'ctx-1',
        title: 'My Exploration',
        owner_email: 'a@b.com',
        shared_with: [],
        has_write_access: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        state: {
          nodes: [],
          edges: [],
          filters: { node_types: [], edge_types: [], nodePropertyFilters: [], edgePropertyFilters: [] },
          viewport: { zoom: 1, center_x: 0, center_y: 0 },
          layout_algorithm: 'force' as const,
          textFormat: {
            rules: [
              { id: 'r1', name: 'r', target: 'node' as const, types: [], priority: 0, enabled: true, scope: 'exploration' as const, template: `{prop:${propertyRef}}` },
            ],
            defaults: { nodeTemplate: '', edgeTemplate: '' },
          },
        },
      }
    }

    it('shows the dangling panel when a saved exploration references a dropped column', async () => {
      vi.mocked(api.getSchemaDrift).mockResolvedValue(DRIFT_DROPS_EMAIL)
      vi.mocked(api.getExplorations).mockResolvedValue([explorationReferencing('email')] as any)

      const { getByTestId } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
      await flush()

      expect(getByTestId('schema-drift-dangling-panel')).toBeTruthy()
      expect(getByTestId('schema-drift-dangling-panel').textContent).toContain('My Exploration')
      expect(getByTestId('schema-drift-dangling-panel').textContent).toContain('email')
    })

    it('does not show the panel when no exploration references the dropped column', async () => {
      vi.mocked(api.getSchemaDrift).mockResolvedValue(DRIFT_DROPS_EMAIL)
      vi.mocked(api.getExplorations).mockResolvedValue([explorationReferencing('name')] as any)

      const { queryByTestId } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
      await flush()

      expect(queryByTestId('schema-drift-dangling-panel')).toBeNull()
    })

    it('requires the acknowledgement checkbox before Apply is enabled', async () => {
      vi.mocked(api.getSchemaDrift).mockResolvedValue(DRIFT_DROPS_EMAIL)
      vi.mocked(api.getExplorations).mockResolvedValue([explorationReferencing('email')] as any)
      vi.mocked(api.updateGraphContext).mockResolvedValue({} as any)

      const { getByTestId } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
      await flush()

      expect((getByTestId('schema-drift-apply') as HTMLButtonElement).disabled).toBe(true)

      await fireEvent.click(getByTestId('schema-drift-acknowledge'))
      await flush()
      expect((getByTestId('schema-drift-apply') as HTMLButtonElement).disabled).toBe(false)

      await fireEvent.click(getByTestId('schema-drift-apply'))
      await flush()
      expect(api.updateGraphContext).toHaveBeenCalledTimes(1)
    })

    it('never touches the saved exploration itself', async () => {
      vi.mocked(api.getSchemaDrift).mockResolvedValue(DRIFT_DROPS_EMAIL)
      const exploration = explorationReferencing('email')
      vi.mocked(api.getExplorations).mockResolvedValue([exploration] as any)
      vi.mocked(api.updateGraphContext).mockResolvedValue({} as any)

      const { getByTestId } = render(SchemaDriftModal, { props: { open: true, contextId: 'ctx-1', hasWriteAccess: true } })
      await flush()
      await fireEvent.click(getByTestId('schema-drift-acknowledge'))
      await fireEvent.click(getByTestId('schema-drift-apply'))
      await flush()

      // No exploration-update API was ever called from this component.
      expect((api as any).updateExploration).toBeUndefined()
      expect(exploration.state.textFormat!.rules[0].template).toBe('{prop:email}')
    })
  })
})
