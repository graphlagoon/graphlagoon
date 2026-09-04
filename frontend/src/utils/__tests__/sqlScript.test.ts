import { describe, it, expect } from 'vitest';
import { isSqlScript } from '@/utils/sqlScript';

describe('isSqlScript', () => {
  it('detects a BEGIN…END compound script', () => {
    expect(isSqlScript('BEGIN\n  SELECT 1;\nEND')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isSqlScript('  begin\n select 1;\n end  ')).toBe(true);
  });

  it('tolerates a trailing semicolon', () => {
    expect(isSqlScript('BEGIN SELECT 1; END;')).toBe(true);
  });

  it('rejects a plain SELECT', () => {
    expect(isSqlScript('SELECT * FROM t LIMIT 10')).toBe(false);
  });

  it('rejects a query merely containing BEGIN', () => {
    expect(isSqlScript("SELECT * FROM t WHERE name = 'BEGIN'")).toBe(false);
  });

  it('rejects a BEGIN without the closing END', () => {
    expect(isSqlScript('BEGIN SELECT 1')).toBe(false);
  });
});
