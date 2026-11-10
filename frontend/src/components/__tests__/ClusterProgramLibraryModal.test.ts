import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import ClusterProgramLibraryModal from '@/components/ClusterProgramLibraryModal.vue'
import { useClusterStore } from '@/stores/cluster'
import * as confirm from '@/composables/useConfirm'
import * as portable from '@/utils/portableExport'

const stubs = {
  ClusterProgramEditorModal: { props: ['program'], template: '<div data-testid="editor-stub">{{ program ? program.program_name : "new" }}</div>' },
  ClusterProgramRunModal: { props: ['program'], template: '<div data-testid="run-stub">{{ program.program_name }}</div>' },
  ClusterProgramSkillModal: { props: ['modelValue'], template: '<div v-if="modelValue" data-testid="skill-stub" />' },
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function q<T extends Element>(selector: string): T | null {
  return document.body.querySelector(selector) as T | null
}

function mount() {
  return render(ClusterProgramLibraryModal, { global: { stubs } })
}

describe('ClusterProgramLibraryModal', () => {
  it('lists programs and opens the editor for New and Edit', async () => {
    const store = useClusterStore()
    const p = store.createProgram({ program_name: 'Mine', code: 'return []', scope: 'exploration' })
    mount()
    expect(q(`[data-testid="cluster-program-${p.program_id}"]`)?.textContent).toContain('Mine')

    await fireEvent.click(q('[data-testid="cluster-program-new"]')!)
    expect(q('[data-testid="editor-stub"]')?.textContent).toBe('new')

    await fireEvent.click(q(`[data-testid="cluster-program-edit-${p.program_id}"]`)!)
    expect(q('[data-testid="editor-stub"]')?.textContent).toBe('Mine')
  })

  it('Use emits the program id and closes', async () => {
    const store = useClusterStore()
    const p = store.createProgram({ program_name: 'Mine', code: 'return []', scope: 'exploration' })
    const { emitted } = mount()
    await fireEvent.click(q(`[data-testid="cluster-program-use-${p.program_id}"]`)!)
    expect(emitted().use).toEqual([[p.program_id]])
    expect(emitted().close).toHaveLength(1)
  })

  it('Run opens the parameter dialog when the program declares parameters, else executes', async () => {
    const store = useClusterStore()
    const withParams = store.createProgram({
      program_name: 'P', code: 'return []', scope: 'exploration',
      parameters: [{ id: 'k', type: 'text', required: true }],
    })
    const plain = store.createProgram({ program_name: 'Q', code: 'return []', scope: 'exploration' })
    const exec = vi.spyOn(store, 'executeProgram').mockResolvedValue({ success: true, clusters: [], duration_ms: 1 } as never)
    mount()
    await fireEvent.click(q(`[data-testid="cluster-program-run-${withParams.program_id}"]`)!)
    expect(q('[data-testid="run-stub"]')?.textContent).toBe('P')
    expect(exec).not.toHaveBeenCalled()

    await fireEvent.click(q(`[data-testid="cluster-program-run-${plain.program_id}"]`)!)
    expect(exec).toHaveBeenCalledWith(plain.program_id)
  })

  it('deletes after confirmation; built-ins have no delete button', async () => {
    const store = useClusterStore()
    store.createProgram({ program_id: 'default-group-by-node-type', program_name: 'Built', code: 'return []' })
    const p = store.createProgram({ program_name: 'Mine', code: 'return []', scope: 'exploration' })
    vi.spyOn(confirm, 'confirmAction').mockResolvedValue(true)
    mount()
    expect(q('[data-testid="cluster-program-delete-default-group-by-node-type"]')).toBeNull()
    await fireEvent.click(q(`[data-testid="cluster-program-delete-${p.program_id}"]`)!)
    await Promise.resolve()
    expect(store.programs.some(x => x.program_id === p.program_id)).toBe(false)
  })

  it('imports several programs at once, with their parameters', async () => {
    const store = useClusterStore()
    mount()
    await fireEvent.click(q('[data-testid="cluster-program-library-import"]')!)
    const text = q<HTMLTextAreaElement>('[data-testid="cluster-program-library-import-text"]')!
    await fireEvent.update(text, JSON.stringify([
      { program_name: 'A', code: 'return []', parameters: [{ id: 'n', type: 'number', default: 2 }] },
      { program_name: 'B', code: 'return []' },
    ]))
    const apply = q<HTMLButtonElement>('[data-testid="cluster-program-library-import-apply"]')!
    expect(apply.textContent).toContain('Add 2 programs')
    await fireEvent.click(apply)
    const added = store.programs.slice(-2)
    expect(added.map(p => p.program_name)).toEqual(['A', 'B'])
    expect(added[0].parameters).toEqual([{ id: 'n', type: 'number', default: 2, required: true }])
  })

  it('shows the parse error and keeps Add disabled on bad JSON', async () => {
    mount()
    await fireEvent.click(q('[data-testid="cluster-program-library-import"]')!)
    await fireEvent.update(q<HTMLTextAreaElement>('[data-testid="cluster-program-library-import-text"]')!, '{"code": "x"}')
    expect(q('[data-testid="cluster-program-library-import-error"]')?.textContent).toContain('missing "program_name"')
    expect(q<HTMLButtonElement>('[data-testid="cluster-program-library-import-apply"]')!.disabled).toBe(true)
  })

  it('exports the user programs (not built-ins) as a portable envelope', async () => {
    const store = useClusterStore()
    store.createProgram({ program_id: 'default-group-by-node-type', program_name: 'Built', code: 'return []' })
    store.createProgram({ program_name: 'Mine', code: 'return 1', scope: 'exploration' })
    const download = vi.spyOn(portable, 'downloadJson').mockImplementation(() => {})
    mount()
    await fireEvent.click(q('[data-testid="cluster-program-library-export"]')!)
    const payload = download.mock.calls[0][1] as { graphlagoon_export: string; programs: { program_name: string }[] }
    expect(payload.graphlagoon_export).toBe('cluster-programs')
    expect(payload.programs).toEqual([{ program_name: 'Mine', code: 'return 1' }])
  })

  it('opens the Ask-AI prompt', async () => {
    mount()
    await fireEvent.click(q('[data-testid="cluster-skill-help"]')!)
    expect(q('[data-testid="skill-stub"]')).not.toBeNull()
  })
})
