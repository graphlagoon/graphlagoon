import { describe, it, expect } from 'vitest';
import { isAllowedEnrichmentSource, removedTablesReadBy } from '@/utils/enrichmentSources';

const sources = ['main.graphs', 'main.kyc', 'ext.risk.scores'];

describe('isAllowedEnrichmentSource', () => {
  it('takes a table inside an allowed schema or listed by itself', () => {
    expect(isAllowedEnrichmentSource('main.kyc.people', sources)).toBe(true);
    expect(isAllowedEnrichmentSource('`EXT`.risk.Scores', sources)).toBe(true);
  });

  it('refuses a neighbour of a listed table and a schema nobody allowed', () => {
    expect(isAllowedEnrichmentSource('ext.risk.other', sources)).toBe(false);
    expect(isAllowedEnrichmentSource('hr.private.salaries', sources)).toBe(false);
  });

  it("always takes the context's own tables", () => {
    expect(isAllowedEnrichmentSource('legacy.zone.e', sources, ['legacy.zone.e'])).toBe(true);
  });

  it('leaves unknown cases to the server', () => {
    expect(isAllowedEnrichmentSource('hr.private.salaries', null)).toBe(true);
    expect(isAllowedEnrichmentSource('private.salaries', sources)).toBe(true);
  });
});

describe('removedTablesReadBy', () => {
  const sql = 'SELECT e.edge_id FROM graph_edges e JOIN `Main`.fraud.channels c ON c.id = e.src';
  it('finds a removed table the query names, quoted or not', () => {
    expect(removedTablesReadBy(sql, ['main.fraud.channels', 'main.kyc.people'])).toEqual(['main.fraud.channels']);
  });
  it('does not match a longer name', () => {
    expect(removedTablesReadBy(sql, ['main.fraud.chan'])).toEqual([]);
  });
});
