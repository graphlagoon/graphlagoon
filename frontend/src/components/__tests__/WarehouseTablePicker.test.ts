import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import WarehouseTablePicker from '@/components/WarehouseTablePicker.vue';

const EDGE = [
  'prod.fraud.ring_edges',
  'prod.graph.people_edges',
  'staging.graph.people_edges',
];
const NODE = [
  'prod.fraud.ring_nodes',
  'prod.graph.people_nodes',
  'staging.graph.people_nodes',
];

function mount(props: Record<string, unknown> = {}) {
  return render(WarehouseTablePicker, {
    props: {
      tables: [...EDGE, ...NODE],
      edgeTables: EDGE,
      nodeTables: NODE,
      edgeValue: '',
      nodeValue: '',
      ...props,
    },
  });
}

const q = (c: Element, id: string) => c.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const rows = (c: Element) =>
  Array.from(c.querySelectorAll('.wtp-table-name')).map((el) => el.textContent!.trim());

describe('WarehouseTablePicker', () => {
  it('browses one schema at a time and lists only its tables', async () => {
    const { container } = mount();

    // The first location is opened for you, so the panel is never blank.
    expect(rows(container)).toEqual(['ring_edges', 'ring_nodes']);

    await fireEvent.click(q(container, 'catalog-staging')!);
    await fireEvent.click(q(container, 'schema-staging.graph')!);
    expect(rows(container)).toEqual(['people_edges', 'people_nodes']);
  });

  it('searching spans every catalog and schema', async () => {
    const { container } = mount();
    await fireEvent.update(q(container, 'table-search') as HTMLInputElement, 'people_edges');

    // Two catalogs hold a table of this name — the flat dropdown showed them
    // as two near-identical long strings.
    expect(rows(container).length).toBe(2);
    expect(container.textContent).toContain('prod.graph');
    expect(container.textContent).toContain('staging.graph');
  });

  it('assigns each role from the row, and clicking again clears it', async () => {
    const { container, emitted } = mount();
    await fireEvent.click(q(container, 'assign-edge-prod.fraud.ring_edges')!);
    expect(emitted()['update:edgeValue']).toEqual([['prod.fraud.ring_edges']]);

    const { container: c2, emitted: e2 } = mount({ edgeValue: 'prod.fraud.ring_edges' });
    await fireEvent.click(q(c2, 'assign-edge-prod.fraud.ring_edges')!);
    expect(e2()['update:edgeValue']).toEqual([['']]);
  });

  it('lets any listed table take either role', () => {
    // The warehouse's `%edge%`/`%node%` guess is a hint. Greying out a
    // legitimate choice because of a naming convention is worse than asking.
    const { container } = mount();
    expect((q(container, 'assign-node-prod.fraud.ring_edges') as HTMLButtonElement).disabled).toBe(false);
    expect((q(container, 'assign-edge-prod.fraud.ring_nodes') as HTMLButtonElement).disabled).toBe(false);
    // The guess still shows, as a nudge on the matching role.
    expect(q(container, 'assign-edge-prod.fraud.ring_edges')!.className).toContain('suggested');
    expect(q(container, 'assign-node-prod.fraud.ring_edges')!.className).not.toContain('suggested');
  });

  it('lists a table the name-based guess says nothing about', () => {
    const { container } = mount({
      tables: [...EDGE, ...NODE, 'prod.fraude.transacoes'],
    });
    // It sits in its own schema, so switch to it first.
    expect(container.querySelector('[data-testid="schema-prod.fraude"]')).not.toBeNull();
  });

  it('shows the shared location once when both tables agree', () => {
    const { container } = mount({
      edgeValue: 'prod.fraud.ring_edges',
      nodeValue: 'prod.fraud.ring_nodes',
    });
    expect(container.querySelector('.wtp-location')!.textContent).toBe('prod.fraud');
    expect(q(container, 'table-schema-mismatch')).toBeNull();
  });

  it('warns when the pair straddles two schemas — invisible with two dropdowns', () => {
    const { container } = mount({
      edgeValue: 'prod.fraud.ring_edges',
      nodeValue: 'staging.graph.people_nodes',
    });
    expect(q(container, 'table-schema-mismatch')).not.toBeNull();
    expect(container.querySelector('.wtp-location')).toBeNull();
  });

  it('says nodes are derived, and refuses the role, for a triple store', () => {
    const { container } = mount({ edgeValue: 'prod.fraud.ring_edges', nodeDisabled: true });
    expect(container.textContent).toContain('derived from the edge endpoints');
    expect((q(container, 'assign-node-prod.fraud.ring_nodes') as HTMLButtonElement).disabled).toBe(true);
  });

  it('still works against a backend that only returns the two guessed lists', () => {
    // Older API versions have no `tables` field; the union of the guesses is
    // the best available answer and must not leave the panel blank.
    const { container } = mount({ tables: [] });
    expect(rows(container).length).toBeGreaterThan(0);
    expect(q(container, 'table-picker-empty')).toBeNull();
  });

  it('says what to do when the warehouse listed nothing at all', () => {
    const { container } = mount({
      tables: [],
      edgeTables: [],
      nodeTables: [],
      emptyHint: 'The warehouse has no tables yet — generate a sample graph from the DEV page.',
    });
    const empty = q(container, 'table-picker-empty')!;
    expect(empty.textContent).toContain('generate a sample graph');
    // …and the way out is still offered.
    expect(empty.textContent).toContain('name one directly');
  });

  it('accepts a table the warehouse never listed', async () => {
    // Only names containing "edge"/"node" are listed, so `transacoes` is
    // unreachable any other way.
    const { container, emitted } = mount();
    await fireEvent.click(q(container, 'table-manual')!);
    await fireEvent.update(q(container, 'table-manual-input') as HTMLInputElement, ' prod.fraude.transacoes ');
    await fireEvent.click(q(container, 'table-manual-use')!);
    expect(emitted()['update:edgeValue']).toEqual([['prod.fraude.transacoes']]);
  });
});
