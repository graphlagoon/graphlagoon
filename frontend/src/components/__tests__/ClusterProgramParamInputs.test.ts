import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/vue'
import ClusterProgramParamInputs from '@/components/ClusterProgramParamInputs.vue'
import { createClusterProgramParameter } from '@/__tests__/fixtures/clusters'

describe('ClusterProgramParamInputs', () => {
  it('renders the right control per parameter type', () => {
    const { container } = render(ClusterProgramParamInputs, {
      props: {
        parameters: [
          createClusterProgramParameter({ id: 'num', type: 'number' }),
          createClusterProgramParameter({ id: 'txt', type: 'text', default: undefined }),
          createClusterProgramParameter({ id: 'flag', type: 'boolean', default: undefined }),
          createClusterProgramParameter({ id: 'mode', type: 'select', options: ['a', 'b'], default: undefined }),
        ],
        modelValue: {},
      },
    })

    expect(container.querySelector('#cp-param-num')?.getAttribute('type')).toBe('number')
    expect(container.querySelector('#cp-param-txt')?.getAttribute('type')).toBe('text')
    expect(container.querySelector('#cp-param-flag')?.getAttribute('type')).toBe('checkbox')
    expect(container.querySelector('select#cp-param-mode')).not.toBeNull()
    // select options include the empty choice + declared options
    const options = Array.from(container.querySelectorAll('#cp-param-mode option')).map(o => o.textContent)
    expect(options).toContain('a')
    expect(options).toContain('b')
  })

  it('emits update:modelValue with a coerced number on number input', async () => {
    const { container, emitted } = render(ClusterProgramParamInputs, {
      props: {
        parameters: [createClusterProgramParameter({ id: 'num', type: 'number' })],
        modelValue: { num: 1 },
      },
    })

    const input = container.querySelector('#cp-param-num') as HTMLInputElement
    await fireEvent.update(input, '42')

    const events = emitted()['update:modelValue'] as unknown[][]
    expect(events.at(-1)?.[0]).toEqual({ num: 42 })
  })

  it('emits boolean values from the checkbox', async () => {
    const { container, emitted } = render(ClusterProgramParamInputs, {
      props: {
        parameters: [createClusterProgramParameter({ id: 'flag', type: 'boolean', default: undefined })],
        modelValue: { flag: false },
      },
    })

    const checkbox = container.querySelector('#cp-param-flag') as HTMLInputElement
    await fireEvent.click(checkbox)

    const events = emitted()['update:modelValue'] as unknown[][]
    expect(events.at(-1)?.[0]).toEqual({ flag: true })
  })

  it('emits a new object instead of mutating the prop', async () => {
    const modelValue = { txt: 'before' }
    const { container, emitted } = render(ClusterProgramParamInputs, {
      props: {
        parameters: [createClusterProgramParameter({ id: 'txt', type: 'text', default: undefined })],
        modelValue,
      },
    })

    const input = container.querySelector('#cp-param-txt') as HTMLInputElement
    await fireEvent.update(input, 'after')

    expect(modelValue.txt).toBe('before')
    const events = emitted()['update:modelValue'] as unknown[][]
    expect(events.at(-1)?.[0]).toEqual({ txt: 'after' })
  })

  it('marks required params with no value as missing', () => {
    const { container } = render(ClusterProgramParamInputs, {
      props: {
        parameters: [
          createClusterProgramParameter({ id: 'req', type: 'text', required: true, default: undefined }),
          createClusterProgramParameter({ id: 'opt', type: 'text', required: false, default: undefined }),
        ],
        modelValue: {},
      },
    })

    expect(container.querySelector('#cp-param-req')?.classList.contains('missing')).toBe(true)
    expect(container.querySelector('#cp-param-opt')?.classList.contains('missing')).toBe(false)
  })

  it('shows label fallback to id and description text', () => {
    const { container } = render(ClusterProgramParamInputs, {
      props: {
        parameters: [
          createClusterProgramParameter({ id: 'no_label', type: 'text', label: undefined, description: 'helper text', default: undefined }),
        ],
        modelValue: {},
      },
    })

    expect(container.textContent).toContain('no_label')
    expect(container.textContent).toContain('helper text')
  })
})
