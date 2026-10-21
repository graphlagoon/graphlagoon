import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import MappingStep from '@/components/investigation/MappingStep.vue';
import type { FileEnrichmentSpec } from '@/types/investigation';

const spec: FileEnrichmentSpec = {
  name: 'risk', input: { delimiter: ',', header: true }, key_column: 'id', columns: ['risk'],
  match_node_types: [], match_source: 'node_id', target: 'nodes',
};
const props = {
  role: 'enrichment' as const, texts: { 'risk.csv': 'id,risk\nn1,high\n' }, fileNames: ['risk.csv'],
  detected: null, specText: '', enrichment: spec, title: '',
};

describe('MappingStep — help (BYOD-2)', () => {
  it('explains each enrichment setting in a popover', async () => {
    const { getByTestId, queryByTestId } = render(MappingStep, { props });
    for (const id of ['enrich-target', 'enrich-key', 'enrich-columns', 'enrich-node-types', 'enrich-match-prop', 'enrich-normalize', 'enrich-digits', 'enrich-overwrite']) {
      expect(getByTestId(`help-${id}`)).toBeTruthy();
    }
    expect(queryByTestId('help-enrich-normalize-text')).toBeNull();
    await fireEvent.click(getByTestId('help-enrich-normalize'));
    expect(getByTestId('help-enrich-normalize-text').textContent).toContain('14155550100');
  });

  it('explains how edges are found when the file is about edges', () => {
    const { getByTestId } = render(MappingStep, { props: { ...props, enrichment: { ...spec, target: 'edges', edge_key: { by: 'endpoints', source_column: 'id', target_column: 'risk' } } } });
    expect(getByTestId('help-enrich-edge-key')).toBeTruthy();
    expect(getByTestId('help-enrich-edge-types')).toBeTruthy();
  });

  it('keeps the case-only cards out of an exploration layer', () => {
    const { queryByText } = render(MappingStep, { props: { ...props, forLayer: true } });
    expect(queryByText(/Chain of custody/)).toBeNull();
    expect(queryByText(/Save this mapping as/)).toBeNull();
  });
});
