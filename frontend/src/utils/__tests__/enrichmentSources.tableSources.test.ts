import { describe, it, expect } from 'vitest';
import { actionTableSource, contextTableSources } from '@/utils/enrichmentSources';
import type { TableProviderInfo } from '@/types/graph';

const providers: TableProviderInfo[] = [{
  name: 'tx-history', label: 'Transactions (ledger)', description: 'Registered description', targets: ['node'], columns: ['at'],
  params: [
    { name: 'account', type: 'str', required: true, default: null, description: '', choices: null, min: null, max: null },
    { name: 'days', type: 'int', required: false, default: 90, description: '', choices: null, min: 1, max: 365 },
    { name: 'tenant', type: 'str', required: false, default: 'br', description: '', choices: null, min: null, max: null },
  ],
}];
const tables = [
  { name: 'devices', label: 'Devices', table: 'main.risk.devices' },
  { name: 'kyc', label: 'KYC', provider: { name: 'kyc' } },
  { name: 'tx_history', label: 'Transactions', table_provider: { name: 'tx-history', params: { tenant: 'pt' }, runtime_params: ['account'] } },
  { name: 'gone', label: 'Gone', description: 'Its own words', table_provider: { name: 'removed' } },
];

describe('contextTableSources', () => {
  it('joins what the context declares with what the server registered', () => {
    const sources = contextTableSources(tables, providers);
    expect(sources.map((s) => s.name)).toEqual(['tx_history', 'gone']);
    expect(sources[0]).toMatchObject({
      provider: 'tx-history', registered: true, targets: ['node'], columns: ['at'], description: 'Registered description',
    });
    // Open: what a caller sets. Locked: the context's value, else the provider's default.
    expect(sources[0].params.map((p) => p.name)).toEqual(['account']);
    expect(sources[0].locked).toEqual([{ name: 'days', value: '90' }, { name: 'tenant', value: 'pt' }]);
    expect(sources[1]).toMatchObject({ registered: false, targets: [], params: [], locked: [], description: 'Its own words' });
    expect(contextTableSources(undefined, providers)).toEqual([]);
  });

  it('finds the source of an action by name, or by provider for an action older than sources', () => {
    const sources = contextTableSources(tables, providers);
    expect(actionTableSource({ source: 'tx_history' }, sources)?.name).toBe('tx_history');
    expect(actionTableSource({ source: '', provider: 'tx-history' }, sources)?.name).toBe('tx_history');
    expect(actionTableSource({ source: 'nope' }, sources)).toBeUndefined();
  });
});
