/**
 * Shared error extraction for API failures (technical debt #7).
 *
 * The backend error envelope is:
 *   { detail: { error: { code, message, details: { query, transpiled_sql,
 *     exception_type, traceback, hint, unresolved_name, context_id } } } }
 * and sometimes just { detail: "plain string" }.
 *
 * Before this module, four near-identical extractors (graph store, query
 * console store, StylePresetModal, PrecomputedGraphPanel) plus ~25 inline
 * `e instanceof Error ? e.message : '...'` sites each unpacked it their own
 * way — most of them discarding the structured message and showing the
 * generic axios "Request failed with status code 500" instead.
 */

/** Structured details pulled from the backend error envelope. */
export interface ApiErrorDetails {
  message: string;
  code?: string;
  query?: string;
  transpiledSql?: string;
  exceptionType?: string;
  traceback?: string[];
  hint?: string;
  unresolvedName?: string;
  contextId?: string;
}

interface ErrorEnvelope {
  error?: {
    message?: string;
    code?: string;
    details?: {
      query?: string;
      transpiled_sql?: string;
      exception_type?: string;
      traceback?: string[];
      hint?: string;
      unresolved_name?: string;
      context_id?: string;
    };
  };
}

/**
 * Extract structured error details from an axios error, a plain Error, or
 * anything else. Never throws; always returns at least a message.
 */
export function extractErrorDetails(e: unknown, fallbackMessage: string): ApiErrorDetails {
  if (e && typeof e === 'object' && 'response' in e) {
    const detail = (e as { response?: { data?: { detail?: unknown } } })
      .response?.data?.detail;

    if (typeof detail === 'string') {
      return { message: detail };
    }

    if (detail && typeof detail === 'object' && 'error' in detail) {
      const error = (detail as ErrorEnvelope).error;
      return {
        message: error?.message || fallbackMessage,
        code: error?.code,
        query: error?.details?.query,
        transpiledSql: error?.details?.transpiled_sql,
        exceptionType: error?.details?.exception_type,
        traceback: error?.details?.traceback,
        hint: error?.details?.hint,
        unresolvedName: error?.details?.unresolved_name,
        contextId: error?.details?.context_id,
      };
    }
  }

  if (e instanceof Error) {
    return { message: e.message };
  }

  return { message: fallbackMessage };
}

/**
 * Human-readable message for an error, preferring the backend's structured
 * message over axios's generic "Request failed with status code N".
 */
export function getErrorMessage(e: unknown, fallbackMessage: string): string {
  return extractErrorDetails(e, fallbackMessage).message;
}
