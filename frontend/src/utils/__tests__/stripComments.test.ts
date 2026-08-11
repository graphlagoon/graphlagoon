import { describe, it, expect } from 'vitest';
import { stripComments } from '../stripComments';

// Mirrors api/tests/test_sql_validation.py::TestStripSqlComments — the two
// implementations must agree, or the frontend gates and the backend disagree
// about whether a query starts with MATCH/SELECT/WITH.
describe('stripComments', () => {
  describe('removes comments', () => {
    it('strips a leading line comment', () => {
      expect(stripComments('-- note\nSELECT 1').trim()).toBe('SELECT 1');
    });

    it('strips a trailing line comment', () => {
      const result = stripComments('SELECT 1 -- note\nFROM t');
      expect(result).not.toContain('note');
      expect(result).toContain('SELECT 1');
      expect(result).toContain('FROM t');
    });

    it('strips a line comment with no trailing newline', () => {
      expect(stripComments('SELECT 1 -- note').trim()).toBe('SELECT 1');
    });

    it('strips a block comment', () => {
      const result = stripComments('SELECT /* note */ 1 FROM t');
      expect(result).not.toContain('note');
      expect(result).toContain('FROM t');
    });

    it('drops the remainder of an unterminated block comment', () => {
      expect(stripComments('SELECT 1 /* oops').trim()).toBe('SELECT 1');
    });

    it('strips Cypher // comments with the // marker', () => {
      const result = stripComments('// note\nMATCH (s)-[r]->(d) RETURN r', '//');
      expect(result.trim()).toBe('MATCH (s)-[r]->(d) RETURN r');
    });

    it('leaves // alone under the SQL marker', () => {
      expect(stripComments('SELECT 1 // not a comment\n')).toContain('//');
    });
  });

  describe('preserves string literals', () => {
    it('keeps a line marker inside a literal', () => {
      const sql = "SELECT * FROM t WHERE name = 'a -- not a comment' LIMIT 5";
      expect(stripComments(sql)).toBe(sql);
    });

    it('keeps a block marker inside a literal', () => {
      const sql = "SELECT * FROM t WHERE s = 'has /* fake */ text'";
      expect(stripComments(sql)).toBe(sql);
    });

    it('handles doubled-quote escapes', () => {
      const sql = "SELECT 'it''s -- fine' FROM t";
      expect(stripComments(sql)).toBe(sql);
    });

    it('handles backslash escapes inside a literal', () => {
      const sql = "SELECT 'a\\' -- x' FROM t";
      expect(stripComments(sql)).toBe(sql);
    });

    it('handles double-quoted literals', () => {
      const sql = 'SELECT * FROM t WHERE s = "a -- b"';
      expect(stripComments(sql)).toBe(sql);
    });

    it('handles backtick identifiers', () => {
      const sql = 'SELECT `col--x` FROM t';
      expect(stripComments(sql)).toBe(sql);
    });
  });

  describe('preserves structure', () => {
    it('keeps the newline so tokens do not merge', () => {
      const result = stripComments('-- note\nWITH x AS (SELECT 1) SELECT 1');
      expect(result.trim().toUpperCase().startsWith('WITH')).toBe(true);
    });

    it('leaves a comment-free query untouched', () => {
      const sql = 'SELECT * FROM t WHERE x = 1 LIMIT 10';
      expect(stripComments(sql)).toBe(sql);
    });

    it('handles an empty string', () => {
      expect(stripComments('')).toBe('');
    });

    it('reduces a comment-only query to blank', () => {
      expect(stripComments('-- just a note').trim()).toBe('');
    });
  });
});
