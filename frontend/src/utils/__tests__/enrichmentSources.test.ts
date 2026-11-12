import { describe, it, expect } from 'vitest';
import { isAllowedEnrichmentSource } from '@/utils/enrichmentSources';

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
