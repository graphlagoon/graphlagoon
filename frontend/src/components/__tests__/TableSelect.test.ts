import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import TableSelect from '@/components/TableSelect.vue';

const TABLES = [
  'prod.graph.people_edges',
  'prod.graph.people_nodes',
  'prod.fraud.ring_edges',
  'staging.graph.people_edges',
];

function open(container: Element) {
  return fireEvent.click(container.querySelector('[data-testid="t"]') as HTMLElement);
}

function optionLabels(container: Element) {
  return Array.from(container.querySelectorAll('.ts-option')).map((el) => el.textContent!.trim());
}

function groupLabels(container: Element) {
  return Array.from(container.querySelectorAll('.ts-group-header')).map((el) =>
    el.textContent!.trim(),
  );
}

describe('TableSelect', () => {
  it('groups by catalog.schema and shows only the table name in each row', async () => {
    const { container } = render(TableSelect, {
      props: { modelValue: '', tables: TABLES, testid: 't' },
    });
    await open(container);

    expect(groupLabels(container)).toEqual(['prod.graph', 'prod.fraud', 'staging.graph']);
    // The repeated qualified prefix is what made the old flat list unreadable.
    expect(optionLabels(container)).toEqual([
      'people_edges',
      'people_nodes',
      'ring_edges',
      'people_edges',
    ]);
  });

  it('filters on any part of the qualified name', async () => {
    const { container } = render(TableSelect, {
      props: { modelValue: '', tables: TABLES, testid: 't' },
    });
    await open(container);

    const search = container.querySelector('[data-testid="t-search"]') as HTMLInputElement;
    await fireEvent.update(search, 'staging');
    expect(optionLabels(container)).toEqual(['people_edges']);
    expect(groupLabels(container)).toEqual(['staging.graph']);

    await fireEvent.update(search, 'fraud');
    expect(groupLabels(container)).toEqual(['prod.fraud']);

    await fireEvent.update(search, 'nothing-here');
    expect(optionLabels(container)).toEqual([]);
    expect(container.querySelector('.ts-empty')!.textContent).toContain('Nothing matches');
  });

  it('emits the fully-qualified name when a row is chosen', async () => {
    const { container, emitted } = render(TableSelect, {
      props: { modelValue: '', tables: TABLES, testid: 't' },
    });
    await open(container);
    await fireEvent.click(container.querySelector('[data-testid="table-option-prod.fraud.ring_edges"]')!);

    expect(emitted()['update:modelValue']).toEqual([['prod.fraud.ring_edges']]);
    expect(container.querySelector('.ts-menu')).toBeNull();
  });

  it('walks the list with the arrow keys and picks with Enter', async () => {
    const { container, emitted } = render(TableSelect, {
      props: { modelValue: '', tables: TABLES, testid: 't' },
    });
    await open(container);

    const root = container.querySelector('.table-select')!;
    await fireEvent.keyDown(root, { key: 'ArrowDown' });
    await fireEvent.keyDown(root, { key: 'ArrowDown' });
    await fireEvent.keyDown(root, { key: 'Enter' });

    expect(emitted()['update:modelValue']).toEqual([['prod.fraud.ring_edges']]);
  });

  it('accepts a name that is not in the list at all', async () => {
    // The warehouse only lists tables named *edge*/*node*, so this is the only
    // way to reach a table called `transacoes`.
    const { container, emitted } = render(TableSelect, {
      props: { modelValue: '', tables: TABLES, testid: 't' },
    });
    await open(container);

    await fireEvent.click(container.querySelector('[data-testid="t-manual"]')!);
    const input = container.querySelector('[data-testid="t-manual-input"]') as HTMLInputElement;
    await fireEvent.update(input, '  prod.fraude.transacoes  ');
    await fireEvent.click(container.querySelector('[data-testid="t-manual-use"]')!);

    expect(emitted()['update:modelValue']).toEqual([['prod.fraude.transacoes']]);
  });

  it('shows the table name and its path separately once selected', () => {
    const { container } = render(TableSelect, {
      props: { modelValue: 'prod.graph.people_edges', tables: TABLES, testid: 't' },
    });
    expect(container.querySelector('.ts-leaf')!.textContent).toBe('people_edges');
    expect(container.querySelector('.ts-group')!.textContent).toBe('prod.graph');
  });

  it('carries the empty hint when the warehouse listed nothing', async () => {
    const { container } = render(TableSelect, {
      props: { modelValue: '', tables: [], testid: 't', emptyHint: 'No edge tables available.' },
    });
    await open(container);
    expect(container.querySelector('.ts-empty')!.textContent).toContain('No edge tables available.');
  });

  it('cannot be opened while disabled', async () => {
    const { container } = render(TableSelect, {
      props: { modelValue: '', tables: TABLES, testid: 't', disabled: true },
    });
    await open(container);
    expect(container.querySelector('.ts-menu')).toBeNull();
  });
});
