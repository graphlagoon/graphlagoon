import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import SeenInOtherCases from '@/components/investigation/SeenInOtherCases.vue'

const api = vi.hoisted(() => ({ getEntityCases: vi.fn() }))
vi.mock('@/services/api', () => ({ api }))

const row = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  investigation_id: id, title, status: 'analysis', case_type: 'fraud_ring', case_type_label: 'Fraud ring', present: true,
  roles: [], tags: [], groups: [], tasks: [], decisions: [], ...over,
})
const stubs = { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SeenInOtherCases (06 P7)', () => {
  it('counts the other cases and lists what each says about the entity', async () => {
    api.getEntityCases.mockResolvedValue([
      row('aaaaaaaa-1', 'Ring A'),
      row('bbbbbbbb-2', 'Earlier review', { status: 'closed', present: false, roles: ['mule'], decisions: [{ id: 'd1', outcome_label: 'Offboard', decided_at: '2026-01-01', closes_case: true }] }),
      row('cccccccc-3', 'Refunds', { tags: ['needs KYC'] }),
    ])
    const { getByTestId } = render(SeenInOtherCases, { props: { uid: 'Device:dev-1', currentId: 'aaaaaaaa-1' }, global: { stubs } })
    await flushPromises()
    expect(api.getEntityCases).toHaveBeenCalledWith('Device:dev-1')
    expect(getByTestId('seen-chip').textContent).toContain('Seen in 2 other cases') // not the current one
    await fireEvent.click(getByTestId('seen-chip'))
    const early = getByTestId('seen-case-bbbbbbbb-2')
    expect(early.querySelector('a')!.getAttribute('href')).toBe('/investigations/bbbbbbbb-2')
    expect(early.textContent).toContain('Closed · not on its graph')
    expect(early.textContent).toContain('role mule · decided “Offboard”')
  })

  it('hides itself when the entity is only in this case or the lookup fails', async () => {
    api.getEntityCases.mockResolvedValueOnce([row('aaaaaaaa-1', 'Ring A')])
    const one = render(SeenInOtherCases, { props: { uid: 'Phone:1', currentId: 'aaaaaaaa-1' }, global: { stubs } })
    await flushPromises()
    expect(one.queryByTestId('seen-in-other-cases')).toBeNull()
    api.getEntityCases.mockRejectedValueOnce(new Error('offline'))
    const failed = render(SeenInOtherCases, { props: { uid: 'Phone:2', currentId: null }, global: { stubs } })
    await flushPromises()
    expect(failed.queryByTestId('seen-in-other-cases')).toBeNull()
  })
})
