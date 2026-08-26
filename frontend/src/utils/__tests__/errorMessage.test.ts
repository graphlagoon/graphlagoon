import { describe, it, expect } from 'vitest';
import { extractErrorDetails, getErrorMessage } from '../errorMessage';

function axiosLike(detail: unknown) {
  return { response: { data: { detail } }, message: 'Request failed with status code 500' };
}

describe('extractErrorDetails', () => {
  it('unpacks the full structured envelope', () => {
    const e = axiosLike({
      error: {
        code: 'QUERY_FAILED',
        message: 'Table not found',
        details: {
          query: 'SELECT 1',
          transpiled_sql: 'SELECT 1 -- sql',
          exception_type: 'AnalysisException',
          traceback: ['line 1', 'line 2'],
          hint: 'Check the catalog',
          unresolved_name: 'my_table',
          context_id: 'ctx-1',
        },
      },
    });

    expect(extractErrorDetails(e, 'fallback')).toEqual({
      message: 'Table not found',
      code: 'QUERY_FAILED',
      query: 'SELECT 1',
      transpiledSql: 'SELECT 1 -- sql',
      exceptionType: 'AnalysisException',
      traceback: ['line 1', 'line 2'],
      hint: 'Check the catalog',
      unresolvedName: 'my_table',
      contextId: 'ctx-1',
    });
  });

  it('handles a plain-string detail', () => {
    expect(extractErrorDetails(axiosLike('Context not found'), 'fb'))
      .toEqual({ message: 'Context not found' });
  });

  it('falls back when the envelope has no message', () => {
    const d = extractErrorDetails(axiosLike({ error: { code: 'X' } }), 'Save failed');
    expect(d.message).toBe('Save failed');
    expect(d.code).toBe('X');
  });

  it('uses the Error message for non-axios errors', () => {
    expect(extractErrorDetails(new Error('boom'), 'fb')).toEqual({ message: 'boom' });
  });

  it('uses the fallback for unknown throwables', () => {
    expect(extractErrorDetails('a string', 'fb')).toEqual({ message: 'fb' });
    expect(extractErrorDetails(undefined, 'fb')).toEqual({ message: 'fb' });
    expect(extractErrorDetails({ some: 'object' }, 'fb')).toEqual({ message: 'fb' });
  });

  it('uses the fallback for an axios error with no usable detail', () => {
    expect(extractErrorDetails({ response: { data: {} } }, 'fb'))
      .toEqual({ message: 'fb' });
  });
});

describe('getErrorMessage', () => {
  it('prefers the structured backend message over the axios message', () => {
    const e = axiosLike({ error: { message: 'Access denied to context' } });
    expect(getErrorMessage(e, 'fb')).toBe('Access denied to context');
  });

  it('returns the fallback for opaque errors', () => {
    expect(getErrorMessage(null, 'Delete failed')).toBe('Delete failed');
  });
});
