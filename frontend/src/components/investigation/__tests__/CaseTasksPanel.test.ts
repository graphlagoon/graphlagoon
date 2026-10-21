import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CaseTasksPanel from '@/components/investigation/CaseTasksPanel.vue'
import { useInvestigationStore } from '@/stores/investigation'
import { useAuthStore } from '@/stores/auth'

const api = vi.hoisted(() => ({
  updateInvestigationAnnotation: vi.fn(async () => ({})),
  createInvestigationAnnotation: vi.fn(async (_id: string, body: any) => ({ id: 'new', status: 'confirmed', ...body })),
  setInvestigationAnnotationStatus: vi.fn(async () => ({})),
  getInvestigationAnnotations: vi.fn(async () => TASKS),
  getInvestigationEvents: vi.fn(async () => []),
  getInvestigation: vi.fn(async () => CASE),
}))
vi.mock('@/services/api', () => ({ api }))

const CASE = { id: 'inv-1', status: 'closed', has_write_access: true, settings: {}, state: {}, decisions: [{ id: 'd1' }], shared_with: [], tags: [] }
const task = (id: string, value: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id, kind: 'task', targets: [], status: 'confirmed', author_kind: 'human', author_email: 'me@x.com', created_at: `2026-10-19T0${id.length}:00:00`,
  value: { state: 'open', assignee_kind: 'human', ...value }, ...over,
})
const TASKS = [
  task('t1', { title: 'Hold settlement', due_at: '2020-01-01T00:00:00', decision_id: 'd1', action: 'hold' }),
  task('t2', { title: 'Trace the next layer', assignee_kind: 'agent', agent_name: 'claude' }),
  task('t3', { title: 'Call the client', assignee: 'me@x.com', due_at: '2999-01-01T00:00:00' }),
  task('t4', { title: 'Old', state: 'done' }),
  task('t5', { title: 'Ask who opened 8812-7', assignee: 'me@x.com' }, { status: 'suggested', author_kind: 'agent' }),
]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const store = useInvestigationStore()
  store.current = structuredClone(CASE) as any
  store.annotations = structuredClone(TASKS) as any
  useAuthStore().email = 'me@x.com'
})

const titles = (el: HTMLElement) => [...el.querySelectorAll('.title')].map((t) => t.textContent)

describe('CaseTasksPanel', () => {
  it('lists open tasks due first, with who, deadline and the decision they came from; filters', async () => {
    const { getByTestId } = render(CaseTasksPanel)
    const panel = getByTestId('tasks-panel')
    expect(titles(panel)).toEqual(['Hold settlement', 'Call the client', 'Trace the next layer', 'Ask who opened 8812-7'])
    expect(getByTestId('task-t1').textContent).toContain('from D1')
    expect(getByTestId('task-t1').querySelector('[data-testid="task-due"]')!.classList).toContain('late')
    expect(getByTestId('task-t2').textContent).toContain('agent claude')
    expect(getByTestId('task-t5').textContent).toContain('suggested by the agent')
    await fireEvent.click(getByTestId('tasks-filter-mine'))
    expect(titles(panel)).toEqual(['Call the client', 'Ask who opened 8812-7'])
    await fireEvent.click(getByTestId('tasks-filter-agents'))
    expect(titles(panel)).toEqual(['Trace the next layer'])
    await fireEvent.click(getByTestId('tasks-filter-overdue'))
    expect(titles(panel)).toEqual(['Hold settlement'])
    await fireEvent.click(getByTestId('tasks-filter-all'))
    await fireEvent.click(getByTestId('tasks-show-done'))
    expect(titles(panel)).toContain('Old')
  })

  it('completes a task on a closed case, confirms an agent suggestion and adds one for an agent', async () => {
    const { getByTestId } = render(CaseTasksPanel)
    await fireEvent.click(getByTestId('task-done-t1'))
    await flushPromises()
    expect(api.updateInvestigationAnnotation).toHaveBeenCalledWith('inv-1', 't1', { value: { state: 'done' } })
    expect((getByTestId('task-done-t5') as HTMLInputElement).disabled).toBe(true) // a suggestion is confirmed first
    await fireEvent.click(getByTestId('task-confirm-t5'))
    await flushPromises()
    expect(api.setInvestigationAnnotationStatus).toHaveBeenCalledWith('inv-1', 't5', 'confirmed')

    await fireEvent.update(getByTestId('task-title'), ' Pull 90 days of statements ')
    await fireEvent.update(getByTestId('task-for'), 'agent')
    await fireEvent.update(getByTestId('task-agent'), 'claude')
    await fireEvent.click(getByTestId('task-add'))
    await flushPromises()
    expect(api.createInvestigationAnnotation).toHaveBeenCalledWith('inv-1', {
      kind: 'task', targets: [], value: { state: 'open', assignee_kind: 'agent', title: 'Pull 90 days of statements', agent_name: 'claude' },
    })
  })

  it('compact: open tasks only, no form; read-only without write access', () => {
    useInvestigationStore().current = { ...CASE, has_write_access: false } as any
    const { queryByTestId, getByTestId } = render(CaseTasksPanel, { props: { compact: true } })
    expect(queryByTestId('task-form')).toBeNull()
    expect(queryByTestId('tasks-filter-all')).toBeNull()
    expect((getByTestId('task-done-t1') as HTMLInputElement).disabled).toBe(true)
    expect(queryByTestId('task-confirm-t5')).toBeNull()
  })
})
