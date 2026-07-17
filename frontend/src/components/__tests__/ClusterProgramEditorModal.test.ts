import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import ClusterProgramEditorModal from '@/components/ClusterProgramEditorModal.vue'
import { useClusterStore } from '@/stores/cluster'
import { useGraphStore } from '@/stores/graph'
import type { GraphContext } from '@/types/graph'
import { createClusterProgram, createClusterProgramParameter } from '@/__tests__/fixtures/clusters'

// JavaScriptEditor embeds CodeMirror, which doesn't render in happy-dom —
// stub it with a plain textarea wired to v-model.
const stubs = {
  JavaScriptEditor: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: `<textarea data-testid="code-stub" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
  },
}

function renderModal(program: Parameters<typeof createClusterProgram>[0] | null = null) {
  return render(ClusterProgramEditorModal, {
    props: { program: program ? createClusterProgram(program) : null },
    global: { stubs },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach(el => el.remove())
})

function q<T extends Element>(selector: string): T {
  return document.body.querySelector(selector) as T
}

describe('ClusterProgramEditorModal', () => {
  it('create mode saves a new program with declared parameters', async () => {
    const store = useClusterStore()
    const initialCount = store.programs.length
    const { emitted } = renderModal(null)

    await fireEvent.update(q<HTMLInputElement>('[data-testid="program-name-input"]'), 'My Program')
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="add-parameter"]'))

    // Fill the parameter card: id + type number
    const paramCard = q<HTMLElement>('.param-card')
    const idInput = paramCard.querySelector('input[placeholder="threshold"]') as HTMLInputElement
    await fireEvent.update(idInput, 'limit')
    const typeSelect = paramCard.querySelector('select') as HTMLSelectElement
    await fireEvent.update(typeSelect, 'number')

    await fireEvent.click(q<HTMLButtonElement>('[data-testid="save-program"]'))

    expect(store.programs).toHaveLength(initialCount + 1)
    const created = store.programs[store.programs.length - 1]
    expect(created.program_name).toBe('My Program')
    expect(created.parameters).toHaveLength(1)
    expect(created.parameters?.[0].id).toBe('limit')
    expect(created.parameters?.[0].type).toBe('number')
    expect(emitted().close).toBeTruthy()
  })

  it('edit mode pre-fills fields and saves changes', async () => {
    const store = useClusterStore()
    const program = store.createProgram({
      program_name: 'Original',
      code: 'return []',
      parameters: [createClusterProgramParameter({ id: 'depth', type: 'number', default: 2 })],
    })

    renderModal(program)

    const nameInput = q<HTMLInputElement>('[data-testid="program-name-input"]')
    expect(nameInput.value).toBe('Original')
    // Existing parameter card is rendered
    expect(document.body.querySelectorAll('.param-card')).toHaveLength(1)

    await fireEvent.update(nameInput, 'Renamed')
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="save-program"]'))

    expect(store.getProgram(program.program_id)?.program_name).toBe('Renamed')
    expect(store.getProgram(program.program_id)?.parameters?.[0].id).toBe('depth')
  })

  it('invalid parameter id disables save', async () => {
    renderModal(null)

    await fireEvent.update(q<HTMLInputElement>('[data-testid="program-name-input"]'), 'X')
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="add-parameter"]'))

    const idInput = q<HTMLElement>('.param-card').querySelector('input[placeholder="threshold"]') as HTMLInputElement
    await fireEvent.update(idInput, '1-invalid id')

    expect(q<HTMLButtonElement>('[data-testid="save-program"]').disabled).toBe(true)
  })

  it('duplicate parameter ids disable save', async () => {
    renderModal(null)

    await fireEvent.update(q<HTMLInputElement>('[data-testid="program-name-input"]'), 'X')
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="add-parameter"]'))
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="add-parameter"]'))

    const idInputs = Array.from(
      document.body.querySelectorAll('.param-card input[placeholder="threshold"]')
    ) as HTMLInputElement[]
    await fireEvent.update(idInputs[0], 'same')
    await fireEvent.update(idInputs[1], 'same')

    expect(q<HTMLButtonElement>('[data-testid="save-program"]').disabled).toBe(true)
  })

  it('select parameter without options disables save', async () => {
    renderModal(null)

    await fireEvent.update(q<HTMLInputElement>('[data-testid="program-name-input"]'), 'X')
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="add-parameter"]'))

    const paramCard = q<HTMLElement>('.param-card')
    const idInput = paramCard.querySelector('input[placeholder="threshold"]') as HTMLInputElement
    await fireEvent.update(idInput, 'mode')
    const typeSelect = paramCard.querySelector('select') as HTMLSelectElement
    await fireEvent.update(typeSelect, 'select')

    expect(q<HTMLButtonElement>('[data-testid="save-program"]').disabled).toBe(true)

    // Filling options re-enables save
    const optionsTextarea = document.body.querySelector('.options-textarea') as HTMLTextAreaElement
    await fireEvent.update(optionsTextarea, 'a\nb')
    expect(q<HTMLButtonElement>('[data-testid="save-program"]').disabled).toBe(false)
  })

  it('pre-fills context-menu flag and node binding in edit mode, and saves changes', async () => {
    const store = useClusterStore()
    const program = store.createProgram({
      program_name: 'Bound',
      code: 'return []',
      show_in_context_menu: true,
      parameters: [
        createClusterProgramParameter({ id: 'start', type: 'text', node_binding: 'prop:id_simples' }),
      ],
    })

    renderModal(program)

    const flag = q<HTMLInputElement>('[data-testid="show-in-context-menu"]')
    expect(flag.checked).toBe(true)

    // Binding select shows 'prop' and the property-name input shows the name
    const paramCard = q<HTMLElement>('.param-card')
    const selects = Array.from(paramCard.querySelectorAll('select')) as HTMLSelectElement[]
    const bindingSelect = selects[selects.length - 1]
    expect(bindingSelect.value).toBe('prop')
    const propInput = paramCard.querySelector('input[placeholder="e.g. id_simples"]') as HTMLInputElement
    expect(propInput.value).toBe('id_simples')

    await fireEvent.click(q<HTMLButtonElement>('[data-testid="save-program"]'))
    const saved = store.getProgram(program.program_id)!
    expect(saved.show_in_context_menu).toBe(true)
    expect(saved.parameters?.[0].node_binding).toBe('prop:id_simples')
  })

  it('prop binding with empty property name disables save; None clears the binding', async () => {
    const store = useClusterStore()
    const program = store.createProgram({
      program_name: 'Bound',
      code: 'return []',
      parameters: [createClusterProgramParameter({ id: 'p', type: 'text' })],
    })

    renderModal(program)

    const paramCard = q<HTMLElement>('.param-card')
    const selects = Array.from(paramCard.querySelectorAll('select')) as HTMLSelectElement[]
    const bindingSelect = selects[selects.length - 1]

    // Property… with empty name blocks save
    await fireEvent.update(bindingSelect, 'prop')
    expect(q<HTMLButtonElement>('[data-testid="save-program"]').disabled).toBe(true)

    // Filling the name re-enables and round-trips
    const propInput = paramCard.querySelector('input[placeholder="e.g. id_simples"]') as HTMLInputElement
    await fireEvent.update(propInput, 'score')
    expect(q<HTMLButtonElement>('[data-testid="save-program"]').disabled).toBe(false)

    // Back to None clears node_binding on save
    await fireEvent.update(bindingSelect, '')
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="save-program"]'))
    expect(store.getProgram(program.program_id)?.parameters?.[0].node_binding).toBeUndefined()
  })

  it('node_id binding round-trips through save', async () => {
    const store = useClusterStore()
    renderModal(null)

    await fireEvent.update(q<HTMLInputElement>('[data-testid="program-name-input"]'), 'WithBinding')
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="show-in-context-menu"]'))
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="add-parameter"]'))

    const paramCard = q<HTMLElement>('.param-card')
    const idInput = paramCard.querySelector('input[placeholder="threshold"]') as HTMLInputElement
    await fireEvent.update(idInput, 'start')
    const selects = Array.from(paramCard.querySelectorAll('select')) as HTMLSelectElement[]
    await fireEvent.update(selects[selects.length - 1], 'node_id')

    await fireEvent.click(q<HTMLButtonElement>('[data-testid="save-program"]'))

    const created = store.programs[store.programs.length - 1]
    expect(created.show_in_context_menu).toBe(true)
    expect(created.parameters?.[0].node_binding).toBe('node_id')
  })

  it('program without parameters saves parameters as undefined', async () => {
    const store = useClusterStore()
    renderModal(null)

    await fireEvent.update(q<HTMLInputElement>('[data-testid="program-name-input"]'), 'Plain')
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="save-program"]'))

    const created = store.programs[store.programs.length - 1]
    expect(created.program_name).toBe('Plain')
    expect(created.parameters).toBeUndefined()
  })

  describe('scope selector', () => {
    function setContext(has_write_access: boolean) {
      useGraphStore().currentContext = {
        id: 'ctx-1',
        title: 'ctx',
        tags: [],
        edge_table_name: 'e',
        node_table_name: 'n',
        edge_structure: {
          edge_id_col: 'edge_id',
          src_col: 'src',
          dst_col: 'dst',
          relationship_type_col: 'relationship_type',
        },
        node_structure: { node_id_col: 'node_id', node_type_col: 'node_type' },
        edge_properties: [],
        node_properties: [],
        node_types: [],
        relationship_types: [],
        owner_email: 'a@b.com',
        shared_with: [],
        has_write_access,
        created_at: '',
        updated_at: '',
      } as GraphContext
    }

    it('is visible with context write access and defaults to context scope', async () => {
      setContext(true)
      const store = useClusterStore()
      renderModal(null)

      expect(q('[data-testid="program-scope-group"]')).toBeTruthy()
      expect(q<HTMLInputElement>('[data-testid="program-scope-context"]').checked).toBe(true)

      await fireEvent.update(q<HTMLInputElement>('[data-testid="program-name-input"]'), 'Shared')
      await fireEvent.click(q<HTMLButtonElement>('[data-testid="save-program"]'))

      expect(store.programs[store.programs.length - 1].scope).toBe('context')
    })

    it('saves as exploration-scoped when that radio is selected', async () => {
      setContext(true)
      const store = useClusterStore()
      renderModal(null)

      await fireEvent.click(q<HTMLInputElement>('[data-testid="program-scope-exploration"]'))
      await fireEvent.update(q<HTMLInputElement>('[data-testid="program-name-input"]'), 'Local')
      await fireEvent.click(q<HTMLButtonElement>('[data-testid="save-program"]'))

      expect(store.programs[store.programs.length - 1].scope).toBe('exploration')
    })

    it('is hidden without context write access and forces exploration scope', async () => {
      setContext(false)
      const store = useClusterStore()
      renderModal(null)

      expect(q('[data-testid="program-scope-group"]')).toBeNull()

      await fireEvent.update(q<HTMLInputElement>('[data-testid="program-name-input"]'), 'Forced')
      await fireEvent.click(q<HTMLButtonElement>('[data-testid="save-program"]'))

      expect(store.programs[store.programs.length - 1].scope).toBe('exploration')
    })
  })
})
