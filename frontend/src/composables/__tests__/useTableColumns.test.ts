import { describe, it, expect } from 'vitest';
import {
  buildGenericColumns,
  buildGenericRows,
} from '@/composables/useTableColumns';

describe('buildGenericColumns', () => {
  it('detects numeric, date and (low-cardinality) categorical columns', () => {
    const columns = ['name', 'age', 'when', 'kind'];
    const rows = [
      ['Alice', '30', '2024-01-15', 'A'],
      ['Bob', '25', '2024-02-20', 'B'],
      ['Carol', '41', '2024-03-01', 'A'],
    ];
    const cols = buildGenericColumns(columns, rows);

    // 'name' has few distinct values (< threshold) so it is categorical, like
    // the shared node/edge column detection.
    expect(cols.map(c => c.type)).toEqual(['categorical', 'numeric', 'date', 'categorical']);
  });

  it('classifies a high-cardinality string column as free text', () => {
    const rows = Array.from({ length: 40 }, (_, i) => [`value-${i}`]);
    const cols = buildGenericColumns(['label'], rows);
    expect(cols[0].type).toBe('text');
  });

  it('uses synthetic col_<i> field keys and keeps the original name as header', () => {
    // Column names with dots/spaces must not become PrimeVue nested-field paths.
    const columns = ['n.name', 'count(*)'];
    const rows = [['Alice', '3']];
    const cols = buildGenericColumns(columns, rows);

    expect(cols[0].field).toBe('col_0');
    expect(cols[0].header).toBe('n.name');
    expect(cols[1].field).toBe('col_1');
    expect(cols[1].header).toBe('count(*)');
  });

  it('collects options only for categorical columns', () => {
    const cols = buildGenericColumns(['kind'], [['A'], ['B'], ['A']]);
    expect(cols[0].type).toBe('categorical');
    expect(cols[0].options?.map(o => o.value)).toEqual(['A', 'B']);
  });
});

describe('buildGenericRows', () => {
  it('keys rows by col_<i> and coerces per detected type', () => {
    const columns = ['name', 'age', 'when'];
    const rows = [['Alice', '30', '2024-01-15']];
    const cols = buildGenericColumns(columns, rows);
    const built = buildGenericRows(rows, cols);

    expect(built).toHaveLength(1);
    const row = built[0];
    expect(row.col_0).toBe('Alice');
    expect(row.col_1).toBe(30); // numeric coerced to Number
    expect(row.col_1).not.toBe('30');
    expect(row.col_2).toBeInstanceOf(Date); // date coerced to Date
  });

  it('preserves null cells', () => {
    const columns = ['age'];
    const rows: (string | null)[][] = [['30'], [null]];
    const cols = buildGenericColumns(columns, rows);
    const built = buildGenericRows(rows, cols);

    expect(built[0].col_0).toBe(30);
    expect(built[1].col_0).toBeNull();
  });

  it('leaves non-numeric values in a numeric column as-is', () => {
    // Column is numeric (>=80% numeric) but has a stray text cell.
    const columns = ['mostlyNum'];
    const rows = [['1'], ['2'], ['3'], ['4'], ['oops']];
    const cols = buildGenericColumns(columns, rows);
    expect(cols[0].type).toBe('numeric');
    const built = buildGenericRows(rows, cols);
    expect(built[0].col_0).toBe(1);
    expect(built[4].col_0).toBe('oops');
  });
});
