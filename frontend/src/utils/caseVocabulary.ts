/**
 * A case's vocabulary (05 §4b, 06 §1): the roles, tags and link attributes it
 * offers, copied from its case type at creation and editable in the case's
 * settings; nothing is imposed (anything typed is accepted).
 */

export interface CaseVocabulary {
  roles: string[];
  tags: string[];
  /** Attributes the links analysis offers first: property names or attribute node types. */
  link_attributes: string[];
}

/** The case's vocabulary from its settings (empty lists when it has none). */
export function vocabularyOf(settings: Record<string, unknown> | undefined): CaseVocabulary {
  const own = (settings?.vocabularies ?? {}) as Partial<CaseVocabulary>;
  return { roles: own.roles ?? [], tags: own.tags ?? [], link_attributes: own.link_attributes ?? [] };
}

/** The 8 group colors (05 §5). */
export const GROUP_COLORS = ['#0f766e', '#2563eb', '#db2777', '#ea580c', '#65a30d', '#8b5cf6', '#0891b2', '#a16207'];

export function groupColor(color: string | number | undefined, index = 0): string {
  if (typeof color === 'string' && color) return color;
  const i = typeof color === 'number' ? color : index;
  return GROUP_COLORS[((i % GROUP_COLORS.length) + GROUP_COLORS.length) % GROUP_COLORS.length];
}

/** What the agent writes as "suggested" (05 §6); the rest applies directly. */
// The server's `suggest_kinds` (GET /api/org/authoring); kept equal by caseVocabulary.test.ts.
export const SUGGEST_KINDS = [
  'role', 'tag', 'hypothesis_status', 'same_as', 'status_change', 'task',
  'group', 'hypothesis', 'note', 'document', 'table', 'query', 'graph',
] as const;
export const DEFAULT_SUGGEST_KINDS = ['role', 'tag', 'hypothesis_status', 'same_as', 'status_change', 'task'];
