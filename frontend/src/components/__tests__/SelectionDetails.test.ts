/**
 * The shared properties view of a selected node or edge: used by the explorer's
 * side panel and the case inspector, so an edge reads the same on both.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import SelectionDetails from '@/components/SelectionDetails.vue';
import { useGraphStore } from '@/stores/graph';

const stubs = { JsonValueViewer: true };

const node = { node_id: 'n1', node_type: 'Person', properties: { name: 'Alice', nick: null, score: 0 } } as never;
const edge = { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'KNOWS', properties: { since: 2020, note: '' } } as never;

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('SelectionDetails', () => {
  it('a node: identity rows, properties without the empty ones, and a way to reveal them', async () => {
    const { container, getByTestId } = render(SelectionDetails, { props: { item: { type: 'node', data: node } }, global: { stubs } });
    expect(container.textContent).toContain('n1');
    expect(container.textContent).toContain('Person');
    expect(container.textContent).toContain('name');
    expect(container.textContent).toContain('score');
    expect(container.textContent).not.toContain('nick');
    await fireEvent.click(getByTestId('empty-values-hint').querySelector('button')!);
    expect(container.textContent).toContain('nick');
  });

  it('honours the property allowlist', () => {
    const store = useGraphStore();
    store.setPropertyVisibility('node', ['score']);
    const { container, getByTestId } = render(SelectionDetails, { props: { item: { type: 'node', data: node } }, global: { stubs } });
    expect(container.textContent).not.toContain('Alice');
    expect(getByTestId('property-visibility-hint').textContent).toContain('1 of 3');
  });

  it('an edge with labelOf: the endpoints are readable buttons that select the node', async () => {
    const { getByTestId, emitted } = render(SelectionDetails, {
      props: { item: { type: 'edge', data: edge }, labelOf: (id: string) => (id === 'n1' ? 'Alice' : 'Bob') },
      global: { stubs },
    });
    expect(getByTestId('selection-details-src').textContent).toBe('Alice');
    expect(getByTestId('selection-details-dst').textContent).toBe('Bob');
    await fireEvent.click(getByTestId('selection-details-dst'));
    expect(emitted('select-node')?.[0]).toEqual(['n2']);
  });

  it('shows what other sources disagree on, and can hide the identity rows', () => {
    const { container, queryByText } = render(SelectionDetails, {
      props: { item: { type: 'node', data: node }, showIdentity: false, conflicts: { name: [{ value: 'Alicia', sourceId: 's2' }] } },
      global: { stubs },
    });
    expect(container.querySelector('.conflict')?.textContent).toContain('Alicia');
    expect(queryByText('Person')).toBeNull();
  });
});
