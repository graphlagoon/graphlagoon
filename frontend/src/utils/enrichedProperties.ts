/**
 * Properties as the "Ask an AI" prompts list them: the columns the context declares plus
 * the ones enrichment wrote on the loaded graph, which no schema declares.
 */
import type { SkillProperty } from '@/utils/clusterProgramSkill';

function typeOf(value: unknown): string {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean' ? t : 'unknown';
}

/**
 * `declared` plus each key of `enrichedColumns` (property → enrichment label → items it wrote)
 * that is not declared, typed by its first non-null value on `items`.
 */
export function withEnrichedProperties(
  declared: SkillProperty[],
  items: { properties?: Record<string, unknown> | null }[],
  enrichedColumns: Map<string, Map<string, number>>,
): SkillProperty[] {
  const names = new Set(declared.map((p) => p.name));
  const out = [...declared];
  for (const [name, byLabel] of enrichedColumns) {
    if (names.has(name)) continue;
    const sample = items.find((i) => i.properties?.[name] != null)?.properties?.[name];
    out.push({
      name,
      data_type: typeOf(sample),
      description: `added by enrichment ${[...byLabel.keys()].join(', ')}`,
    });
  }
  return out;
}
