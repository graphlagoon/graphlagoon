import { describe, it, expect } from 'vitest';
import { paramBounds, paramHint, paramLines, paramProblem, paramText, paramValues } from '@/utils/providerParams';
import type { ProviderParamInfo } from '@/types/graph';

const spec = (over: Partial<ProviderParamInfo>): ProviderParamInfo => ({
  name: 'p', type: 'str', required: false, default: null, description: '', choices: null, min: null, max: null, ...over,
});
const days = spec({ name: 'days', type: 'int', default: 30, min: 1, max: 365, description: 'Window' });
const source = spec({ name: 'source', choices: ['bureau', 'internal'], default: 'internal' });

describe('providerParams', () => {
  it('says what a value must be', () => {
    expect(paramBounds(days)).toBe('int, 1 to 365');
    expect(paramHint(days)).toBe('Window (int, 1 to 365)');
    expect(paramHint(source)).toBe('one of bureau, internal');
    expect(paramHint(spec({ type: 'float', min: 0 }))).toBe('float, at least 0');
    expect(paramHint(spec({ description: 'Free text' }))).toBe('Free text');
  });

  it('catches a value the server would refuse; an empty one is "not set"', () => {
    expect(paramProblem(days, '')).toBe('');
    expect(paramProblem(days, '90')).toBe('');
    expect(paramProblem(days, '1.5')).toBe('must be a whole number');
    expect(paramProblem(days, '1e3')).toBe('must be a plain number');
    expect(paramProblem(days, '0')).toBe('must be at least 1');
    expect(paramProblem(days, '999')).toBe('must be at most 365');
    expect(paramProblem(source, 'other')).toBe('must be one of bureau, internal');
    expect(paramProblem(spec({ type: 'bool' }), 'yes')).toBe('must be true or false');
  });

  it('types the values it sends and drops what is empty or not declared', () => {
    const specs = [days, source, spec({ name: 'strict', type: 'bool' })];
    expect(paramValues(specs, { days: ' 90 ', source: 'bureau', strict: 'true', gone: 'x', empty: '' })).toEqual({
      days: 90, source: 'bureau', strict: true,
    });
    // A provider not registered here: nothing to check against, the text is kept.
    expect(paramValues(undefined, { days: '90' })).toEqual({ days: '90' });
    expect(paramText(true)).toBe('true');
    expect(paramText(null)).toBe('');
  });

  it('lists parameters for an AI prompt', () => {
    expect(paramLines([days, spec({ name: 'tenant', required: true })], '')).toBe(
      '- `days` (int, default 30, min 1, max 365): Window\n- `tenant` (str, required)',
    );
    expect(paramLines([], '')).toBe('(no parameters)');
  });
});
