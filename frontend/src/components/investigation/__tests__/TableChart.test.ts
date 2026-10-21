import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/vue'
import TableChart from '@/components/investigation/TableChart.vue'

const columns = ['day', 'tpv', 'cb', 'note']
const rows = [
  ['2026-10-01', 1000, 10, 'a'],
  ['2026-10-02', '1500', null, 'b'],
  ['2026-10-03', 900, 30, 'c'],
]

describe('TableChart (06 §2b AQ2)', () => {
  it('draws one line per series over the x column, broken where a value is missing', () => {
    const { getByTestId } = render(TableChart, { props: { columns, rows, chart: { type: 'line', x: 'day', series: ['tpv', 'cb'] } } })
    expect(getByTestId('table-chart').dataset.type).toBe('line')
    expect(getByTestId('chart-series-tpv').querySelectorAll('polyline')).toHaveLength(1)
    expect(getByTestId('chart-series-tpv').querySelectorAll('circle')).toHaveLength(3) // "1500" is a number
    expect(getByTestId('chart-series-cb').querySelectorAll('polyline')).toHaveLength(2) // the gap splits it
    expect(getByTestId('table-chart').textContent).toContain('2026-10-01')
    expect(getByTestId('table-chart').querySelector('figcaption')!.textContent).toContain('by day')
  })

  it('draws grouped bars; unknown columns are left out', () => {
    const { getByTestId, queryByTestId } = render(TableChart, { props: { columns, rows, chart: { type: 'bar', x: 'day', series: ['tpv', 'cb', 'nope'] } } })
    expect(getByTestId('chart-series-tpv').querySelectorAll('rect')).toHaveLength(3)
    expect(getByTestId('chart-series-cb').querySelectorAll('rect')).toHaveLength(2)
    expect(queryByTestId('chart-series-nope')).toBeNull()
    expect(getByTestId('chart-series-tpv').querySelector('title')!.textContent).toContain('tpv · 2026-10-01: 1,000')
  })
})
