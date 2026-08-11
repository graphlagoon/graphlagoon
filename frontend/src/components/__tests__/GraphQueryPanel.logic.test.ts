import { describe, it, expect } from 'vitest';
import { stripComments } from '@/utils/stripComments';

// GraphQueryPanel.vue is an SFC, so its pure gate functions can't be imported.
// They're redefined here verbatim (same convention as ContextsView.logic.test.ts)
// to test the behavior directly — keep in sync with the component.

function validateCypherQuery(query: string): { valid: boolean; error: string | null } {
  const trimmed = stripComments(query, '//').trim();
  if (!trimmed) {
    return { valid: false, error: null };
  }
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('MATCH')) {
    return { valid: false, error: 'Query must start with MATCH' };
  }
  if (!/\bRETURN\s+(?:DISTINCT\s+)?r\b/i.test(trimmed)) {
    return { valid: false, error: 'Must have RETURN r (or RETURN DISTINCT r)' };
  }
  return { valid: true, error: null };
}

/** Mode routing from the graphStore.graphQuery watcher. */
function detectQueryMode(query: string): 'cypher' | 'sql' | null {
  if (stripComments(query, '//').trim().toUpperCase().startsWith('MATCH')) return 'cypher';
  if (stripComments(query, '--').trim().toUpperCase().startsWith('SELECT')) return 'sql';
  return null;
}

describe('GraphQueryPanel cypher validation', () => {
  it('accepts a query with a leading // comment', () => {
    // Regression: this used to fail the MATCH gate, disabling the Run button
    // with no way for the user to proceed.
    const result = validateCypherQuery('// find neighbours\nMATCH (s)-[r]->(d) RETURN r');
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it('accepts a query with a trailing // comment', () => {
    expect(validateCypherQuery('MATCH (s)-[r]->(d) RETURN r // note').valid).toBe(true);
  });

  it('accepts a query with a leading block comment', () => {
    expect(validateCypherQuery('/* header */ MATCH (s)-[r]->(d) RETURN r').valid).toBe(true);
  });

  it('still accepts a plain query', () => {
    expect(validateCypherQuery('MATCH (s)-[r]->(d) RETURN r').valid).toBe(true);
  });

  it('still accepts RETURN DISTINCT r', () => {
    expect(validateCypherQuery('MATCH (s)-[r]->(d) RETURN DISTINCT r').valid).toBe(true);
  });

  it('rejects a query whose MATCH is commented out', () => {
    const result = validateCypherQuery('// MATCH (s)-[r]->(d) RETURN r');
    expect(result.valid).toBe(false);
  });

  it('does not accept a RETURN r that only appears in a comment', () => {
    const result = validateCypherQuery('MATCH (s)-[r]->(d) // RETURN r');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Must have RETURN r (or RETURN DISTINCT r)');
  });

  it('rejects a non-MATCH query', () => {
    const result = validateCypherQuery('CREATE (n:Person) RETURN n');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Query must start with MATCH');
  });

  it('reports no error for an empty query', () => {
    expect(validateCypherQuery('   ')).toEqual({ valid: false, error: null });
  });

  it('reports no error for a comment-only query', () => {
    expect(validateCypherQuery('// just a note')).toEqual({ valid: false, error: null });
  });
});

describe('GraphQueryPanel mode routing', () => {
  it('detects cypher behind a leading comment', () => {
    // Regression: an exploration saved with a leading comment was not
    // recognized, so the editor was overwritten with the generated example.
    expect(detectQueryMode('// saved\nMATCH (s)-[r]->(d) RETURN r')).toBe('cypher');
  });

  it('detects sql behind a leading comment', () => {
    expect(detectQueryMode('-- saved\nSELECT * FROM t')).toBe('sql');
  });

  it('detects plain cypher and sql', () => {
    expect(detectQueryMode('MATCH (s)-[r]->(d) RETURN r')).toBe('cypher');
    expect(detectQueryMode('SELECT * FROM t')).toBe('sql');
  });

  it('returns null for an unrecognized query', () => {
    expect(detectQueryMode('SHOW TABLES')).toBeNull();
  });
});
