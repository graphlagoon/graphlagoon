import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/vue'
import { setActivePinia, createPinia } from 'pinia'
import ClusterProgramRunModal from '@/components/ClusterProgramRunModal.vue'
import { useClusterStore } from '@/stores/cluster'
import { useGraphStore } from '@/stores/graph'
import { createClusterProgramParameter } from '@/__tests__/fixtures/clusters'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(window, 'alert').mockImplementation(() => {})
})

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach(el => el.remove())
  vi.restoreAllMocks()
})

function seedGraph() {
  const graphStore = useGraphStore()
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Person' },
    { node_id: 'n2', node_type: 'Person' },
  ]
  graphStore.edges = []
}

function q<T extends Element>(selector: string): T {
  return document.body.querySelector(selector) as T
}

describe('ClusterProgramRunModal', () => {
  it('seeds inputs from declared defaults', () => {
    const store = useClusterStore()
    const program = store.createProgram({
      program_name: 'P',
      code: 'return []',
      parameters: [createClusterProgramParameter({ id: 'count', type: 'number', default: 3 })],
    })

    render(ClusterProgramRunModal, { props: { program } })

    const input = q<HTMLInputElement>('#cp-param-count')
    expect(input.value).toBe('3')
  })

  it('disables Run while required params are missing', async () => {
    const store = useClusterStore()
    const program = store.createProgram({
      program_name: 'P',
      code: 'return []',
      parameters: [
        createClusterProgramParameter({ id: 'name', type: 'text', required: true, default: undefined }),
      ],
    })

    render(ClusterProgramRunModal, { props: { program } })

    const runBtn = q<HTMLButtonElement>('[data-testid="run-program"]')
    expect(runBtn.disabled).toBe(true)
    expect(document.body.textContent).toContain('Required:')

    await fireEvent.update(q<HTMLInputElement>('#cp-param-name'), 'value')
    expect(runBtn.disabled).toBe(false)
  })

  it('runs the program with the filled values and closes on success', async () => {
    seedGraph()
    const store = useClusterStore()
    const program = store.createProgram({
      program_name: 'P',
      code: `return [{ cluster_name: 'c-' + params.suffix, node_ids: ['n1'] }]`,
      parameters: [
        createClusterProgramParameter({ id: 'suffix', type: 'text', required: true, default: undefined }),
      ],
    })
    const executeSpy = vi.spyOn(store, 'executeProgram')

    const { emitted } = render(ClusterProgramRunModal, { props: { program } })

    await fireEvent.update(q<HTMLInputElement>('#cp-param-suffix'), 'abc')
    await fireEvent.click(q<HTMLButtonElement>('[data-testid="run-program"]'))

    expect(executeSpy).toHaveBeenCalledWith(program.program_id, { suffix: 'abc' })
    await waitFor(() => expect(emitted().close).toBeTruthy())
    expect(store.clusters.some(c => c.cluster_name === 'c-abc')).toBe(true)
  })

  it('shows the error inline and stays open on failure', async () => {
    seedGraph()
    const store = useClusterStore()
    const program = store.createProgram({
      program_name: 'Broken',
      code: 'throw new Error("boom")',
      parameters: [createClusterProgramParameter({ id: 'x', type: 'number', default: 1 })],
    })

    const { emitted } = render(ClusterProgramRunModal, { props: { program } })

    await fireEvent.click(q<HTMLButtonElement>('[data-testid="run-program"]'))

    await waitFor(() =>
      expect(document.body.querySelector('.error-msg')?.textContent).toContain('boom')
    )
    expect(emitted().close).toBeFalsy()
  })
})
