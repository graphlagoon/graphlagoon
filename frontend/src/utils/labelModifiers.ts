/**
 * Label Template Modifier Registry
 *
 * Single source of truth for every template modifier: runtime behavior,
 * argument specs (validation), and the description/example metadata that
 * drives the panel autocomplete and the generated "Ask AI" skill prompt
 * (labelTemplateSkill.ts). Adding a modifier here is the whole story —
 * autocomplete, validation, and docs pick it up automatically.
 *
 * Regex-arg modifiers (`match`, `replace`) receive their pattern pre-compiled
 * by the template parser (labelFormatter.ts), which owns the slash-span
 * syntax, flag policy, and length cap defined by the constants below.
 */

import type { TextFormatModifier } from '@/types/graph';

/** Version of the template mini-language. v2 = modifier chaining + extraction/regex modifiers. */
export const LABEL_TEMPLATE_SYNTAX_VERSION = 2;

/** Hard cap on user-supplied regex pattern length (chars, without delimiters). */
export const MAX_REGEX_LENGTH = 200;

/** Regex flags users may write after the closing slash. Everything else is rejected. */
export const ALLOWED_REGEX_FLAGS = 'i';

export type ModifierArgKind = 'string' | 'int' | 'regex';

export interface ModifierArgSpec {
  /** Doc label shown in validation messages and generated docs */
  name: string;
  kind: ModifierArgKind;
  required: boolean;
}

export interface ModifierDef {
  name: TextFormatModifier;
  /**
   * Transform the value. `compiled` is only passed for regex-arg modifiers:
   * the parser-compiled RegExp, or null when the pattern failed to compile
   * (render stays lenient — return the value unchanged).
   */
  apply: (value: string, args: string[], compiled?: RegExp | null) => string;
  args: ModifierArgSpec[];
  description: string;
  example: string;
  docCategory: 'text' | 'number' | 'extract' | 'regex';
  /** Regex-arg modifiers only: compile the pattern with the global flag */
  regexGlobal?: boolean;
}

export const MODIFIER_REGISTRY: Record<TextFormatModifier, ModifierDef> = {
  upper: {
    name: 'upper',
    apply: (v) => v.toUpperCase(),
    args: [],
    description: 'Convert to uppercase',
    example: '{prop:name|upper}',
    docCategory: 'text',
  },
  lower: {
    name: 'lower',
    apply: (v) => v.toLowerCase(),
    args: [],
    description: 'Convert to lowercase',
    example: '{prop:name|lower}',
    docCategory: 'text',
  },
  capitalize: {
    name: 'capitalize',
    apply: (v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(),
    args: [],
    description: 'Capitalize first letter',
    example: '{prop:name|capitalize}',
    docCategory: 'text',
  },
  truncate: {
    name: 'truncate',
    apply: (v, args) => {
      const maxLen = parseInt(args?.[0] || '20', 10);
      const suffix = args?.[1] || '...';
      return v.length > maxLen ? v.slice(0, maxLen - suffix.length) + suffix : v;
    },
    args: [
      { name: 'maxLength', kind: 'int', required: false },
      { name: 'suffix', kind: 'string', required: false },
    ],
    description: 'Truncate with ellipsis',
    example: '{prop:name|truncate:20:...}',
    docCategory: 'text',
  },
  number: {
    name: 'number',
    apply: (v) => {
      const num = parseFloat(v);
      return isNaN(num) ? v : num.toLocaleString();
    },
    args: [],
    description: 'Format as number',
    example: '{prop:count|number}',
    docCategory: 'number',
  },
  currency: {
    name: 'currency',
    apply: (v, args) => {
      const num = parseFloat(v);
      if (isNaN(num)) return v;
      const currency = args?.[0] || 'USD';
      try {
        return num.toLocaleString(undefined, { style: 'currency', currency });
      } catch {
        return `${currency} ${num.toFixed(2)}`;
      }
    },
    args: [{ name: 'currencyCode', kind: 'string', required: false }],
    description: 'Format as currency',
    example: '{prop:amount|currency:BRL}',
    docCategory: 'number',
  },
  percent: {
    name: 'percent',
    apply: (v) => {
      const num = parseFloat(v);
      return isNaN(num) ? v : `${(num * 100).toFixed(1)}%`;
    },
    args: [],
    description: 'Format as percentage',
    example: '{prop:rate|percent}',
    docCategory: 'number',
  },
  split: {
    name: 'split',
    apply: (v, args) => {
      if (args.length < 2) return v;
      const parts = v.split(args[0]);
      const idx = parseInt(args[1], 10);
      if (isNaN(idx)) return v;
      const part = idx < 0 ? parts[parts.length + idx] : parts[idx];
      return part ?? '';
    },
    args: [
      { name: 'delimiter', kind: 'string', required: true },
      { name: 'index', kind: 'int', required: true },
    ],
    description: 'Split by delimiter and keep one part (negative index counts from the end)',
    example: '{node_id|split:_:0}',
    docCategory: 'extract',
  },
  slice: {
    name: 'slice',
    apply: (v, args) => {
      const start = parseInt(args[0], 10);
      if (isNaN(start)) return v;
      const rawEnd = args[1] !== undefined && args[1] !== '' ? parseInt(args[1], 10) : NaN;
      return v.slice(start, isNaN(rawEnd) ? undefined : rawEnd);
    },
    args: [
      { name: 'start', kind: 'int', required: true },
      { name: 'end', kind: 'int', required: false },
    ],
    description: 'Substring by position (JS slice semantics, negatives from the end)',
    example: '{prop:code|slice:0:5}',
    docCategory: 'extract',
  },
  trim: {
    name: 'trim',
    apply: (v) => v.trim(),
    args: [],
    description: 'Remove surrounding whitespace',
    example: '{prop:name|trim}',
    docCategory: 'extract',
  },
  default: {
    name: 'default',
    apply: (v, args) => (v === '' ? (args[0] ?? '') : v),
    args: [{ name: 'fallback', kind: 'string', required: true }],
    description: 'Fallback text when the value is empty (also suppresses the [prop] placeholder)',
    example: '{prop:nickname|default:anonymous}',
    docCategory: 'extract',
  },
  match: {
    name: 'match',
    apply: (v, args, compiled) => {
      if (!compiled) return v;
      const m = v.match(compiled);
      if (!m) return '';
      const rawGroup = args[1] !== undefined ? parseInt(args[1], 10) : 0;
      return m[isNaN(rawGroup) ? 0 : rawGroup] ?? '';
    },
    args: [
      { name: 'pattern', kind: 'regex', required: true },
      { name: 'group', kind: 'int', required: false },
    ],
    description: 'Extract via regex capture group (no match → empty, chain |default: after it)',
    example: '{prop:email|match:/@(.+)$/:1}',
    docCategory: 'regex',
  },
  replace: {
    name: 'replace',
    apply: (v, args, compiled) => (compiled ? v.replace(compiled, args[1] ?? '') : v),
    args: [
      { name: 'pattern', kind: 'regex', required: true },
      { name: 'replacement', kind: 'string', required: false },
    ],
    description: 'Regex replace, all occurrences (empty replacement removes the match)',
    example: '{node_id|replace:/_CNPJ_RAIZ/:}',
    docCategory: 'regex',
    regexGlobal: true,
  },
};

/** Modifier names whose first argument is a slash-delimited regex. */
export const REGEX_ARG_MODIFIERS: ReadonlySet<string> = new Set(
  Object.values(MODIFIER_REGISTRY)
    .filter((d) => d.args[0]?.kind === 'regex')
    .map((d) => d.name),
);

/**
 * Segment leading-words the pipe/arg scanners treat as regex-carrying —
 * the regex modifiers plus the `matches` condition operator.
 */
export const REGEX_SEGMENT_WORDS: ReadonlySet<string> = new Set([...REGEX_ARG_MODIFIERS, 'matches']);
