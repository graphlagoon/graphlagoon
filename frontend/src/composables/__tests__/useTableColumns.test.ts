import { describe, it, expect } from 'vitest';
import {
  buildGenericColumns,
  buildGenericRows,
  buildNodeColumns,
  flattenNodeRows,
  detectType,
  collectOptions,
  TYPE_SAMPLE_CAP,
  CATEGORICAL_THRESHOLD,
} from '@/composables/useTableColumns';
import { SEARCH_FIELD } from '@/utils/searchText';

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

describe('detectType — sampling on large datasets (>200k freeze fix)', () => {
  // Numeric/date inference is sampled to TYPE_SAMPLE_CAP; categorical detection
  // and option lists stay a full scan so nothing analysis-relevant is lost.

  it('detects numeric when the sampled prefix is numeric', () => {
    const items = Array.from({ length: TYPE_SAMPLE_CAP * 4 }, (_, i) => String(i));
    expect(detectType(items, v => v)).toBe('numeric');
  });

  it('detects date when the sampled prefix is dates', () => {
    const items = Array.from({ length: TYPE_SAMPLE_CAP * 3 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      return `2024-01-${day}`;
    });
    expect(detectType(items, v => v)).toBe('date');
  });

  it('only evaluates the expensive numeric/date check on the sampled prefix', () => {
    // A numeric prefix long enough to fill the sample, followed by text values
    // that are never numerically inspected → column still reads as numeric.
    const numeric = Array.from({ length: TYPE_SAMPLE_CAP }, (_, i) => String(i + 1));
    const trailingText = Array.from({ length: 1000 }, (_, i) => `tail-${i}`);
    const items = [...numeric, ...trailingText];
    expect(detectType(items, v => v)).toBe('numeric');
  });

  it('still classifies a high-cardinality column as text even when unique values appear only past the sample', () => {
    // First TYPE_SAMPLE_CAP values repeat a single token (would look categorical
    // if we sampled), but distinct values beyond the sample must force 'text'.
    const head = Array.from({ length: TYPE_SAMPLE_CAP }, () => 'same');
    const tail = Array.from({ length: CATEGORICAL_THRESHOLD + 5 }, (_, i) => `only-late-${i}`);
    expect(detectType([...head, ...tail], v => v)).toBe('text');
  });

  it('keeps a low-cardinality column categorical regardless of size', () => {
    const items = Array.from({ length: TYPE_SAMPLE_CAP * 2 }, (_, i) => (i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C'));
    expect(detectType(items, v => v)).toBe('categorical');
  });

  it('collectOptions returns every distinct value even beyond the sample window', () => {
    // Options are gathered by a full scan, so a categorical value that only
    // occurs after TYPE_SAMPLE_CAP rows is still selectable in the filter.
    const head = Array.from({ length: TYPE_SAMPLE_CAP }, () => 'A');
    const items = [...head, 'B', 'C'];
    const opts = collectOptions(items, v => v);
    expect(opts.map(o => o.value)).toEqual(['A', 'B', 'C']);
  });
});

describe('pre-built search field (fast global search)', () => {
  it('flattenNodeRows adds a lowercased __search field covering id, type and props', () => {
    const nodes = [
      { node_id: 'N1', node_type: 'Person', properties: { city: 'Berlin' } },
    ];
    const propKeys = ['city'];
    const cols = buildNodeColumns(nodes, propKeys);
    const rows = flattenNodeRows(nodes, propKeys, cols);

    const search = rows[0][SEARCH_FIELD] as string;
    expect(search).toContain('n1');       // node_id, lowercased
    expect(search).toContain('person');   // node_type
    expect(search).toContain('berlin');   // property value
    expect(search).toBe(search.toLowerCase());
  });

  it('buildGenericRows adds a __search field covering every column value', () => {
    const cols = buildGenericColumns(['name', 'city'], [['Alice', 'Berlin']]);
    const rows = buildGenericRows([['Alice', 'Berlin']], cols);
    const search = rows[0][SEARCH_FIELD] as string;
    expect(search).toContain('alice');
    expect(search).toContain('berlin');
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

describe('buildNodeColumns ID header disambiguation', () => {
  const nodes = [
    { node_id: 'hash123', node_type: 'Person', properties: { node_id: 'legacy-42' } },
  ];

  it('shows the configured id column name when it differs from node_id', () => {
    const cols = buildNodeColumns(nodes, ['node_id'], 'id_hash');
    expect(cols[0].field).toBe('node_id');
    expect(cols[0].header).toBe('ID (id_hash)');
    // The literal node_id table column stays its own prop_ column.
    const propCol = cols.find(c => c.field === 'prop_node_id');
    expect(propCol?.header).toBe('node_id');
  });

  it('keeps the plain ID header when the configured column is literally node_id', () => {
    const cols = buildNodeColumns(nodes, [], 'node_id');
    expect(cols[0].header).toBe('ID');
  });

  it('keeps the plain ID header when no column name is given', () => {
    const cols = buildNodeColumns(nodes, []);
    expect(cols[0].header).toBe('ID');
  });

  it('prop_node_id rows carry the literal property value, ID rows the configured id', () => {
    const propKeys = ['node_id'];
    const cols = buildNodeColumns(nodes, propKeys, 'id_hash');
    const rows = flattenNodeRows(nodes, propKeys, cols);
    expect(rows[0].node_id).toBe('hash123');
    expect(rows[0].prop_node_id).toBe('legacy-42');
  });
});
