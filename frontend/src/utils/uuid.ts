/** A UUID as the API writes it (any version). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `value` when it is a UUID, else null. For ids that come from the URL
 * (`?case=`) and go into an API path: anything else could add segments
 * (`<id>/items/<x>/confirm?`) and turn a save into another request.
 */
export function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}
