/**
 * Parameters a registered provider declares (enrichment providers and table providers,
 * /api/config `enrichment_providers[].params` and `table_providers[].params`). The server
 * coerces and bounds every value; these helpers only describe a parameter to whoever fills
 * it and catch the obvious mistakes before a save or a run. Pure.
 */
import type { ProviderParamInfo } from '@/types/graph';

export type ParamValue = string | number | boolean;

/** What a value must be, in a few words: "int, 1 to 365", "one of a, b". */
export function paramBounds(p: ProviderParamInfo): string {
  const parts: string[] = [];
  if (p.type !== 'str') parts.push(p.type);
  if (p.choices?.length) parts.push(`one of ${p.choices.join(', ')}`);
  if (p.min != null && p.max != null) parts.push(`${p.min} to ${p.max}`);
  else if (p.min != null) parts.push(`at least ${p.min}`);
  else if (p.max != null) parts.push(`at most ${p.max}`);
  return parts.join(', ');
}

/** The declared description with the bounds: what a person reads next to the field. */
export function paramHint(p: ProviderParamInfo): string {
  const bounds = paramBounds(p);
  const said = (p.description ?? '').trim();
  return said && bounds ? `${said} (${bounds})` : said || bounds;
}

/** A value as the text an input shows ('' for none). */
export function paramText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
}

/** Why `text` is not a value for `p`, or '' (an empty text is "not set", never a problem here). */
export function paramProblem(p: ProviderParamInfo, text: string): string {
  const v = text.trim();
  if (!v) return '';
  if (p.type === 'bool') return ['true', 'false', '1', '0'].includes(v.toLowerCase()) ? '' : 'must be true or false';
  if (p.type === 'int' || p.type === 'float') {
    if (!/^-?\d+(\.\d+)?$/.test(v)) return 'must be a plain number';
    if (p.type === 'int' && v.includes('.')) return 'must be a whole number';
    const n = Number(v);
    if (p.min != null && n < p.min) return `must be at least ${p.min}`;
    if (p.max != null && n > p.max) return `must be at most ${p.max}`;
    return '';
  }
  if (p.choices?.length && !p.choices.includes(v)) return `must be one of ${p.choices.join(', ')}`;
  return '';
}

/** The text typed for `p` as the value the server stores (numbers and booleans typed). */
export function paramValue(p: ProviderParamInfo | undefined, text: string): ParamValue {
  const v = text.trim();
  if (!p || paramProblem(p, v)) return v;
  if (p.type === 'bool') return ['true', '1'].includes(v.toLowerCase());
  if (p.type === 'int' || p.type === 'float') return Number(v);
  return v;
}

/**
 * The typed values of the non-empty texts. Names the provider does not declare are kept as
 * text when `specs` is undefined (a provider not registered here: nothing to check against).
 */
export function paramValues(specs: ProviderParamInfo[] | undefined, texts: Record<string, string>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [name, text] of Object.entries(texts)) {
    if (!text.trim()) continue;
    const spec = specs?.find((p) => p.name === name);
    if (specs && !spec) continue;
    out[name] = paramValue(spec, text);
  }
  return out;
}

/** One line per parameter for an AI prompt: name, type, bounds, default, what it is. */
export function paramLines(params: ProviderParamInfo[] | undefined, indent = '    '): string {
  if (!params?.length) return `${indent}(no parameters)`;
  return params
    .map((p) => {
      const facts = [p.type, p.required ? 'required' : `default ${p.default === null || p.default === undefined ? 'none' : JSON.stringify(p.default)}`];
      if (p.choices?.length) facts.push(`one of ${p.choices.map((c) => JSON.stringify(c)).join(' | ')}`);
      if (p.min != null) facts.push(`min ${p.min}`);
      if (p.max != null) facts.push(`max ${p.max}`);
      return `${indent}- \`${p.name}\` (${facts.join(', ')})${p.description ? `: ${p.description}` : ''}`;
    })
    .join('\n');
}
