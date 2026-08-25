/**
 * Label Formatter Utility
 *
 * Provides secure template-based label formatting for nodes and edges.
 * Uses a parser-based approach (NO eval/Function) for safety.
 *
 * Template Syntax:
 * - Basic placeholders: {prop:name}, {node_type}, {relationship_type}, {src}, {dst}, {node_id}, {edge_id}
 * - With modifiers, chainable left-to-right: {prop:name|upper}, {prop:url|split:/:2|upper}
 * - Extraction: {node_id|split:_:0}, {prop:code|slice:0:5}, {prop:email|match:/@(.+)$/:1}
 * - Conditionals: {if:prop:x>10|High|Low}, {if:prop:status==active|Active|Inactive}
 * - Regex conditionals: {if:prop:code|matches:/^BR/|Brasil|Outro}
 * - Date formatting: {date:prop:created_at|DD/MM/YYYY}
 * - Date conditionals: {if:prop:date|daysAgo:<7|Recent|Old}
 * - Line break: {br} — renders the label on multiple lines
 *
 * Escaping inside {...}: a backslash escapes the next character, so `\:` `\|`
 * `\{` `\}` are literals in modifier args. Regex args are slash-delimited
 * (`match:/re/i`); inside them `\/` is a literal slash and only balanced
 * braces (quantifiers like {2}) may appear unescaped.
 *
 * Modifier behavior/metadata lives in the MODIFIER_REGISTRY (labelModifiers.ts)
 * so runtime, autocomplete, validation, and the generated AI prompt can't drift.
 */

import type { Node, Edge, TextFormatRule, TextFormatConditionOperator } from '@/types/graph';
import {
  MODIFIER_REGISTRY,
  REGEX_ARG_MODIFIERS,
  REGEX_SEGMENT_WORDS,
  MAX_REGEX_LENGTH,
  ALLOWED_REGEX_FLAGS,
  type ModifierDef,
} from './labelModifiers';

// ============================================================================
// Types
// ============================================================================

interface ParsedModifier {
  /** Registry name; unknown names are kept (render no-ops, validate warns) */
  name: string;
  /** Raw args; a regex arg is stored at its position as the bare pattern (no slashes/flags) */
  args: string[];
  /** Regex modifiers only: compiled at parse time, null = failed to compile */
  regex?: RegExp | null;
  /** Regex modifiers only: why compilation was rejected (drives validateTemplate) */
  regexError?: string;
}

interface ParsedToken {
  type: 'text' | 'placeholder' | 'conditional' | 'date';
  value: string;
  property?: string;
  /**
   * True when the token was written with the `prop:` prefix. These resolve
   * from `item.properties` first, so a literal table column named e.g.
   * `node_id` is reachable even though a built-in of the same name exists.
   */
  fromProps?: boolean;
  /** Ordered modifier chain, applied left-to-right */
  modifiers?: ParsedModifier[];
  condition?: ParsedCondition;
  trueValue?: string;
  falseValue?: string;
  dateFormat?: string;
}

interface ParsedCondition {
  property: string;
  operator: TextFormatConditionOperator;
  value: string | number;
  value2?: string; // For dateBetween
  /** `matches` operator only: compiled at parse time, null = failed to compile */
  regex?: RegExp | null;
  regexError?: string;
}

type FormatContext = {
  target: 'node' | 'edge';
  item: Node | Edge;
};

// ============================================================================
// Date Utilities
// ============================================================================

function parseDate(value: string): Date | null {
  if (!value) return null;

  // Try parsing as ISO date or timestamp
  const date = new Date(value);
  if (!isNaN(date.getTime())) return date;

  // Try parsing as Unix timestamp (seconds or milliseconds)
  const num = parseFloat(value);
  if (!isNaN(num)) {
    // If it looks like seconds (before year 3000 in seconds)
    if (num < 32503680000) {
      return new Date(num * 1000);
    }
    return new Date(num);
  }

  return null;
}

function formatDate(date: Date, format: string): string {
  const pad = (n: number) => n.toString().padStart(2, '0');

  const replacements: Record<string, string> = {
    'YYYY': date.getFullYear().toString(),
    'YY': date.getFullYear().toString().slice(-2),
    'MM': pad(date.getMonth() + 1),
    'M': (date.getMonth() + 1).toString(),
    'DD': pad(date.getDate()),
    'D': date.getDate().toString(),
    'HH': pad(date.getHours()),
    'H': date.getHours().toString(),
    'mm': pad(date.getMinutes()),
    'm': date.getMinutes().toString(),
    'ss': pad(date.getSeconds()),
    's': date.getSeconds().toString(),
  };

  let result = format;
  // Sort by length descending to replace longer patterns first
  const patterns = Object.keys(replacements).sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    result = result.replace(new RegExp(pattern, 'g'), replacements[pattern]);
  }

  return result;
}

function getDaysAgo(date: Date): number {
  const now = new Date();
  const diffTime = now.getTime() - date.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

// ============================================================================
// Condition Evaluation
// ============================================================================

function evaluateCondition(condition: ParsedCondition, value: string): boolean {
  const { operator, value: compareValue, value2 } = condition;

  // Handle date-specific operators
  if (['daysAgo', 'dateAfter', 'dateBefore', 'dateBetween'].includes(operator)) {
    const date = parseDate(value);
    if (!date) return false;

    switch (operator) {
      case 'daysAgo': {
        const days = getDaysAgo(date);
        const compareNum = parseFloat(String(compareValue).replace(/[<>]=?/, ''));
        const op = String(compareValue).match(/^[<>]=?/)?.[0] || '<';
        switch (op) {
          case '<': return days < compareNum;
          case '<=': return days <= compareNum;
          case '>': return days > compareNum;
          case '>=': return days >= compareNum;
          default: return days < compareNum;
        }
      }
      case 'dateAfter': {
        const compareDate = parseDate(String(compareValue));
        return compareDate ? date > compareDate : false;
      }
      case 'dateBefore': {
        const compareDate = parseDate(String(compareValue));
        return compareDate ? date < compareDate : false;
      }
      case 'dateBetween': {
        const startDate = parseDate(String(compareValue));
        const endDate = value2 ? parseDate(value2) : null;
        return startDate && endDate ? date >= startDate && date <= endDate : false;
      }
    }
  }

  // Numeric comparison
  const numValue = parseFloat(value);
  const numCompare = parseFloat(String(compareValue));
  const isNumeric = !isNaN(numValue) && !isNaN(numCompare);

  switch (operator) {
    case '==':
      return isNumeric ? numValue === numCompare : value === String(compareValue);
    case '!=':
      return isNumeric ? numValue !== numCompare : value !== String(compareValue);
    case '>':
      return isNumeric ? numValue > numCompare : value > String(compareValue);
    case '<':
      return isNumeric ? numValue < numCompare : value < String(compareValue);
    case '>=':
      return isNumeric ? numValue >= numCompare : value >= String(compareValue);
    case '<=':
      return isNumeric ? numValue <= numCompare : value <= String(compareValue);
    case 'contains':
      return value.toLowerCase().includes(String(compareValue).toLowerCase());
    case 'startsWith':
      return value.toLowerCase().startsWith(String(compareValue).toLowerCase());
    case 'endsWith':
      return value.toLowerCase().endsWith(String(compareValue).toLowerCase());
    case 'matches':
      return condition.regex ? condition.regex.test(value) : false;
    default:
      return false;
  }
}

// ============================================================================
// Template Parser
// ============================================================================

function parseConditionExpression(expr: string): ParsedCondition | null {
  // Match patterns like: prop:field>10, prop:field==value, prop:date|daysAgo:<7

  // Pipe-form operators: prop:field|daysAgo:<7, prop:field|matches:/^BR/i,
  // prop:field|contains:text (string ops accept both pipe and inline forms)
  const pipeMatch = expr.match(
    /^prop:([^|]+)\|(daysAgo|dateAfter|dateBefore|dateBetween|matches|contains|startsWith|endsWith):(.+)$/,
  );
  if (pipeMatch) {
    const [, property, operator, value] = pipeMatch;
    if (operator === 'dateBetween') {
      const [v1, v2] = value.split(':');
      return { property, operator: operator as TextFormatConditionOperator, value: v1, value2: v2 };
    }
    if (operator === 'matches') {
      const condition: ParsedCondition = { property, operator, value };
      if (!value.startsWith('/')) {
        condition.regex = null;
        condition.regexError = 'matches: pattern must be slash-delimited, e.g. matches:/pattern/';
      } else {
        const span = consumeRegexSpan(value, 0);
        if (span.end < value.length) {
          condition.regexError = 'matches: unexpected characters after regex';
        }
        compileModifierRegex(condition, span, false);
      }
      return condition;
    }
    return { property, operator: operator as TextFormatConditionOperator, value };
  }

  // Standard operators
  const opMatch = expr.match(/^prop:([^=!<>]+)(==|!=|>=|<=|>|<|contains|startsWith|endsWith)(.+)$/);
  if (opMatch) {
    const [, property, operator, value] = opMatch;
    return { property, operator: operator as TextFormatConditionOperator, value };
  }

  return null;
}

/**
 * Consume a slash-delimited regex span starting at `s[start]` (which must be
 * `/`). Handles `\`-escapes (so `\/` stays inside the pattern) and collects
 * trailing flag letters. The pattern is returned raw — regex escapes are
 * meaningful to `new RegExp` and must not be unescaped.
 */
function consumeRegexSpan(s: string, start: number): {
  pattern: string;
  flags: string;
  end: number;
  terminated: boolean;
} {
  let i = start + 1;
  let pattern = '';
  let terminated = false;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      pattern += s[i] + s[i + 1];
      i += 2;
      continue;
    }
    if (s[i] === '/') {
      terminated = true;
      i++;
      break;
    }
    pattern += s[i];
    i++;
  }
  let flags = '';
  while (i < s.length && /[a-zA-Z]/.test(s[i])) {
    flags += s[i];
    i++;
  }
  return { pattern, flags, end: i, terminated };
}

/**
 * Split a string by top-level `|`, respecting nested `{...}` pairs,
 * `\`-escapes, and slash-delimited regex spans (`match:/a|b/` never splits at
 * the alternation). A span is only recognized right after `<word>:` where
 * word is a regex-carrying name (match/replace/matches), so `split:/:2` — a
 * literal `/` delimiter — is untouched.
 * e.g. "prop:x==1|{prop:y|upper}|default" → ["prop:x==1", "{prop:y|upper}", "default"]
 */
function splitByPipeRespectingBraces(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let segHasSpan = false;
  let i = 0;

  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      current += ch + s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === '/' && depth === 0 && !segHasSpan && i > 0 && s[i - 1] === ':') {
      const colonIdx = current.indexOf(':');
      const word = colonIdx === -1 ? current : current.slice(0, colonIdx);
      if (REGEX_SEGMENT_WORDS.has(word)) {
        const span = consumeRegexSpan(s, i);
        current += s.slice(i, span.end);
        segHasSpan = true;
        i = span.end;
        continue;
      }
    }
    if (ch === '|' && depth === 0) {
      parts.push(current);
      current = '';
      segHasSpan = false;
    } else {
      current += ch;
    }
    i++;
  }
  parts.push(current);
  return parts;
}

/**
 * Find the matching closing `}` for a `{` at position `start`, respecting
 * nested brace pairs and `\`-escapes (`\}` inside a regex arg is a literal).
 * Returns the index of the matching `}`, or -1 if not found.
 */
function findMatchingBrace(template: string, start: number): number {
  let depth = 1;
  for (let j = start + 1; j < template.length; j++) {
    if (template[j] === '\\') {
      j++;
      continue;
    }
    if (template[j] === '{') depth++;
    if (template[j] === '}') depth--;
    if (depth === 0) return j;
  }
  return -1;
}

/**
 * Split modifier args on `:` with backslash unescaping (`\:` → literal `:`,
 * `\|` → `|`, `\\` → `\`). Used for non-regex args only — regex patterns keep
 * their escapes.
 */
function splitArgsUnescaping(s: string): string[] {
  const args: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      current += s[i + 1];
      i++;
      continue;
    }
    if (ch === ':') {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current);
  return args;
}

/**
 * Parse one pipe segment of a modifier chain (`truncate:20:...`,
 * `match:/@(.+)$/:1`) into a ParsedModifier. Regex-arg modifiers get their
 * pattern compiled here, once — the compiled RegExp rides the template cache.
 */
function parseModifierSegment(seg: string): ParsedModifier {
  const colonIdx = seg.indexOf(':');
  const name = colonIdx === -1 ? seg : seg.slice(0, colonIdx);
  const rest = colonIdx === -1 ? '' : seg.slice(colonIdx + 1);
  const mod: ParsedModifier = { name, args: [] };

  if (REGEX_ARG_MODIFIERS.has(name)) {
    if (!rest.startsWith('/')) {
      mod.regex = null;
      mod.regexError = `${name}: pattern must be slash-delimited, e.g. ${name}:/pattern/`;
      return mod;
    }
    const span = consumeRegexSpan(rest, 0);
    mod.args.push(span.pattern);
    if (span.end < rest.length) {
      if (rest[span.end] === ':') {
        mod.args.push(...splitArgsUnescaping(rest.slice(span.end + 1)));
      } else {
        mod.regexError = `${name}: unexpected characters after regex`;
      }
    }
    compileModifierRegex(mod, span, MODIFIER_REGISTRY[name as keyof typeof MODIFIER_REGISTRY]?.regexGlobal === true);
    return mod;
  }

  if (rest !== '') {
    mod.args = splitArgsUnescaping(rest);
  }
  return mod;
}

/** Shared regex compile policy: termination, length cap, flag allowlist, try/catch. */
function compileModifierRegex(
  target: { regex?: RegExp | null; regexError?: string },
  span: { pattern: string; flags: string; terminated: boolean },
  global: boolean,
): void {
  if (target.regexError) {
    target.regex = null;
    return;
  }
  if (!span.terminated) {
    target.regex = null;
    target.regexError = 'Unterminated regex (missing closing /)';
    return;
  }
  if (span.pattern.length > MAX_REGEX_LENGTH) {
    target.regex = null;
    target.regexError = `Regex pattern too long (max ${MAX_REGEX_LENGTH} chars)`;
    return;
  }
  const badFlags = span.flags.split('').filter((f) => !ALLOWED_REGEX_FLAGS.includes(f));
  if (badFlags.length > 0) {
    target.regex = null;
    target.regexError = `Unsupported regex flag(s): ${badFlags.join('')} (allowed: ${ALLOWED_REGEX_FLAGS})`;
    return;
  }
  try {
    target.regex = new RegExp(span.pattern, span.flags + (global ? 'g' : ''));
  } catch (e) {
    target.regex = null;
    target.regexError = `Invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function parseTokenContent(content: string): ParsedToken {
  // Line break: {br} — the 3D label renderer treats '\n' as a line break
  if (content === 'br') {
    return { type: 'text', value: '\n' };
  }

  // Date formatting: date:prop:field|format
  if (content.startsWith('date:')) {
    const dateMatch = content.match(/^date:prop:([^|]+)\|?(.*)$/);
    if (dateMatch) {
      return {
        type: 'date',
        value: content,
        property: dateMatch[1],
        fromProps: true,
        dateFormat: dateMatch[2] || 'YYYY-MM-DD',
      };
    }
  }

  // Conditional: if:condition|trueVal|falseVal (brace/regex-aware split).
  // Pipe-form operators arrive split across the first two parts
  // (['prop:date', 'daysAgo:<7', 'Recent', 'Old']) — re-join and retry.
  if (content.startsWith('if:')) {
    const parts = splitByPipeRespectingBraces(content.slice(3));
    if (parts.length >= 2) {
      let condition = parseConditionExpression(parts[0]);
      let branchStart = 1;
      if (
        !condition &&
        parts.length >= 3 &&
        /^(daysAgo|dateAfter|dateBefore|dateBetween|matches|contains|startsWith|endsWith):/.test(parts[1])
      ) {
        condition = parseConditionExpression(parts[0] + '|' + parts[1]);
        if (condition) branchStart = 2;
      }
      return {
        type: 'conditional',
        value: content,
        condition: condition || undefined,
        trueValue: parts[branchStart],
        falseValue: parts[branchStart + 1] || '',
      };
    }
  }

  // Property placeholder: prop:name, prop:name|modifier, chains allowed
  if (content.startsWith('prop:')) {
    const parts = splitByPipeRespectingBraces(content.slice(5));
    return {
      type: 'placeholder',
      value: content,
      property: parts[0],
      fromProps: true,
      modifiers: parts.length > 1 ? parts.slice(1).map(parseModifierSegment) : undefined,
    };
  }

  // Built-in placeholders: node_type, relationship_type, src, dst, node_id, edge_id
  const parts = splitByPipeRespectingBraces(content);
  return {
    type: 'placeholder',
    value: content,
    property: parts[0],
    modifiers: parts.length > 1 ? parts.slice(1).map(parseModifierSegment) : undefined,
  };
}

function parseTemplate(template: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  let i = 0;

  while (i < template.length) {
    if (template[i] === '{') {
      const closeIdx = findMatchingBrace(template, i);
      if (closeIdx !== -1) {
        const content = template.slice(i + 1, closeIdx);
        tokens.push(parseTokenContent(content));
        i = closeIdx + 1;
      } else {
        // Unbalanced brace — treat as literal text
        tokens.push({ type: 'text', value: '{' });
        i++;
      }
    } else {
      // Collect text until next `{`
      let j = i;
      while (j < template.length && template[j] !== '{') j++;
      tokens.push({ type: 'text', value: template.slice(i, j) });
      i = j;
    }
  }

  return tokens;
}

// ============================================================================
// Value Resolution
// ============================================================================

function getPropertyValue(ctx: FormatContext, property: string, fromProps = false): string {
  const { target, item } = ctx;

  // `prop:`-prefixed tokens read the raw table column first, so a literal
  // column named like a built-in (e.g. `node_id` when the configured id
  // column is `id_hash`) is not shadowed. Falls through to the built-ins
  // when no such property exists (backward compatible).
  if (fromProps && item.properties && property in item.properties) {
    const val = item.properties[property];
    return val != null ? String(val) : '';
  }

  // Built-in properties
  if (property === 'node_type' && target === 'node') {
    return (item as Node).node_type || '';
  }
  if (property === 'node_id' && target === 'node') {
    return (item as Node).node_id || '';
  }
  if (property === 'relationship_type' && target === 'edge') {
    return (item as Edge).relationship_type || '';
  }
  if (property === 'edge_id' && target === 'edge') {
    return (item as Edge).edge_id || '';
  }
  if (property === 'src' && target === 'edge') {
    return (item as Edge).src || '';
  }
  if (property === 'dst' && target === 'edge') {
    return (item as Edge).dst || '';
  }

  // Custom properties from item.properties
  if (item.properties && property in item.properties) {
    const val = item.properties[property];
    return val != null ? String(val) : '';
  }

  return '';
}

function applyModifierChain(value: string, chain?: ParsedModifier[]): string {
  if (!chain) return value;
  let result = value;
  for (const mod of chain) {
    const def: ModifierDef | undefined = MODIFIER_REGISTRY[mod.name as keyof typeof MODIFIER_REGISTRY];
    if (!def) continue; // unknown modifier — lenient at render, warned by validateTemplate
    result = def.apply(result, mod.args, mod.regex);
  }
  return result;
}

// ============================================================================
// Main Formatter
// ============================================================================

function formatWithTokens(tokens: ParsedToken[], ctx: FormatContext): string {
  return tokens.map(token => {
    switch (token.type) {
      case 'text':
        return token.value;

      case 'placeholder': {
        const value = getPropertyValue(ctx, token.property || '', token.fromProps);
        const hasDefault = token.modifiers?.some((m) => m.name === 'default');
        if (value === '' && token.value?.startsWith('prop:') && !hasDefault) {
          return `[${token.property}]`; // Fallback for missing props
        }
        return applyModifierChain(value, token.modifiers);
      }

      case 'conditional': {
        if (!token.condition) return '';
        // Conditions are always written as `prop:field...`
        const propValue = getPropertyValue(ctx, token.condition.property, true);
        const result = evaluateCondition(token.condition, propValue);
        const valueToFormat = result ? (token.trueValue || '') : (token.falseValue || '');
        const innerTokens = parseTemplate(valueToFormat);
        return formatWithTokens(innerTokens, ctx);
      }

      case 'date': {
        const value = getPropertyValue(ctx, token.property || '', token.fromProps);
        const date = parseDate(value);
        if (!date) return value || `[${token.property}]`;
        return formatDate(date, token.dateFormat || 'YYYY-MM-DD');
      }

      default:
        return '';
    }
  }).join('');
}

// Template cache for performance
const templateCache = new Map<string, ParsedToken[]>();

/**
 * Format a label using a template string
 */
export function formatLabel(template: string, target: 'node' | 'edge', item: Node | Edge): string {
  if (!template) {
    // Default fallback
    if (target === 'node') {
      return (item as Node).node_id || '';
    }
    return (item as Edge).relationship_type || '';
  }

  // Check cache
  let tokens = templateCache.get(template);
  if (!tokens) {
    tokens = parseTemplate(template);
    templateCache.set(template, tokens);
    // Limit cache size
    if (templateCache.size > 1000) {
      const firstKey = templateCache.keys().next().value;
      if (firstKey) templateCache.delete(firstKey);
    }
  }

  return formatWithTokens(tokens, { target, item });
}

/**
 * Find the matching rule for an item
 */
export function findMatchingRule(
  rules: TextFormatRule[],
  target: 'node' | 'edge',
  itemType: string
): TextFormatRule | null {
  // Filter rules by target and enabled status
  const applicableRules = rules
    .filter(r => r.enabled && r.target === target)
    .filter(r => r.types.length === 0 || r.types.includes(itemType))
    .sort((a, b) => {
      // Primary sort: by priority (higher first)
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      // Tie-breaker: more specific rules (with types) win over generic rules (empty types)
      const aHasTypes = a.types.length > 0 ? 1 : 0;
      const bHasTypes = b.types.length > 0 ? 1 : 0;
      return bHasTypes - aHasTypes;
    });

  return applicableRules[0] || null;
}

/**
 * Format a node label using the appropriate rule
 */
export function formatNodeLabel(
  node: Node,
  rules: TextFormatRule[],
  defaultTemplate: string
): string {
  const rule = findMatchingRule(rules, 'node', node.node_type);
  const template = rule?.template || defaultTemplate;
  return formatLabel(template, 'node', node);
}

/**
 * Format an edge label using the appropriate rule
 */
export function formatEdgeLabel(
  edge: Edge,
  rules: TextFormatRule[],
  defaultTemplate: string
): string {
  const rule = findMatchingRule(rules, 'edge', edge.relationship_type);
  const template = rule?.template || defaultTemplate;
  return formatLabel(template, 'edge', edge);
}

/** Check one parsed modifier against its registry spec. */
function validateModifier(
  mod: ParsedModifier,
  errors: string[],
  warnings: string[],
): void {
  const def: ModifierDef | undefined = MODIFIER_REGISTRY[mod.name as keyof typeof MODIFIER_REGISTRY];
  if (!def) {
    warnings.push(`Unknown modifier "${mod.name}" (ignored at render)`);
    return;
  }
  if (mod.regexError) {
    errors.push(
      mod.regexError.startsWith(`${mod.name}:`) ? mod.regexError : `${mod.name}: ${mod.regexError}`,
    );
    return;
  }
  def.args.forEach((spec, i) => {
    const present = mod.args.length > i && (spec.kind !== 'int' || mod.args[i] !== '');
    if (spec.required && !present) {
      errors.push(`${mod.name}: missing required argument "${spec.name}"`);
      return;
    }
    if (present && spec.kind === 'int' && !/^-?\d+$/.test(mod.args[i])) {
      errors.push(`${mod.name}: argument "${spec.name}" must be an integer, got "${mod.args[i]}"`);
    }
  });
}

/**
 * Validate a template string. `errors` block rendering correctness (invalid
 * regex, bad args, unbalanced braces); `warnings` are survivable (unknown
 * modifier no-ops at render). `valid` reflects errors only.
 */
export function validateTemplate(template: string): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for balanced braces (backslash-escaped braces are literals)
  let braceCount = 0;
  for (let i = 0; i < template.length; i++) {
    const char = template[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '{') braceCount++;
    if (char === '}') braceCount--;
    if (braceCount < 0) {
      errors.push('Unbalanced braces: found } without matching {');
      break;
    }
  }
  if (braceCount > 0) {
    errors.push('Unbalanced braces: found { without matching }');
  }

  // Parse and check tokens (recursing into conditional branches)
  function walk(tmpl: string) {
    for (const token of parseTemplate(tmpl)) {
      if (token.type === 'conditional') {
        if (!token.condition) {
          errors.push(`Invalid condition syntax in: ${token.value}`);
        } else if (token.condition.regexError) {
          errors.push(token.condition.regexError);
        }
        if (token.trueValue) walk(token.trueValue);
        if (token.falseValue) walk(token.falseValue);
      }
      if (token.type === 'placeholder' && token.modifiers) {
        for (const mod of token.modifiers) {
          validateModifier(mod, errors, warnings);
        }
      }
    }
  }

  try {
    walk(template);
  } catch (e) {
    errors.push(`Parse error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Extract every real property-column name a template references — i.e.
 * `{prop:x}` and `{if:prop:x>10|...}`, NOT built-ins like `{node_type}`.
 *
 * Built on the same `parseTemplate` the renderer uses, so this can never
 * disagree with what the label actually resolves — the point of building the
 * exploration-reference validator (contextReferences.ts) on top of it rather
 * than a fresh regex.
 */
export function extractTemplateProperties(template: string): string[] {
  const properties = new Set<string>();

  function walk(tmpl: string) {
    for (const token of parseTemplate(tmpl)) {
      if ((token.type === 'placeholder' || token.type === 'date') && token.fromProps && token.property) {
        properties.add(token.property);
      }
      if (token.type === 'conditional') {
        // parseConditionExpression only ever matches a `prop:`-prefixed
        // expression, so a present condition.property is always a real column.
        if (token.condition?.property) properties.add(token.condition.property);
        // trueValue/falseValue are themselves template strings and may nest
        // further placeholders, e.g. {if:prop:x>10|{prop:y|upper}|-}.
        if (token.trueValue) walk(token.trueValue);
        if (token.falseValue) walk(token.falseValue);
      }
    }
  }

  walk(template);
  return [...properties];
}

/**
 * Get available placeholders for autocomplete
 */
export function getAvailablePlaceholders(
  target: 'node' | 'edge',
  properties: string[]
): { placeholder: string; description: string }[] {
  const result: { placeholder: string; description: string }[] = [];

  // Built-in placeholders (structural fields from the context's configured columns)
  if (target === 'node') {
    result.push(
      { placeholder: '{node_id}', description: 'Node identifier (configured ID column)' },
      { placeholder: '{node_type}', description: 'Node type/label' },
    );
  } else {
    result.push(
      { placeholder: '{edge_id}', description: 'Edge identifier (configured ID column)' },
      { placeholder: '{relationship_type}', description: 'Edge relationship type' },
      { placeholder: '{src}', description: 'Source node ID' },
      { placeholder: '{dst}', description: 'Destination node ID' },
    );
  }

  result.push({ placeholder: '{br}', description: 'Line break (multi-line label)' });

  // Property placeholders (raw table columns — take precedence over
  // same-named built-ins when written with the `prop:` prefix)
  for (const prop of properties) {
    result.push({ placeholder: `{prop:${prop}}`, description: `Property: ${prop}` });
  }

  return result;
}

/**
 * Get available modifiers for autocomplete (driven by the registry)
 */
export function getAvailableModifiers(): { modifier: string; description: string; example: string }[] {
  return Object.values(MODIFIER_REGISTRY).map((def) => ({
    modifier: def.name,
    description: def.description,
    example: def.example,
  }));
}

/**
 * Clear the template cache (useful when templates change frequently)
 */
export function clearTemplateCache(): void {
  templateCache.clear();
}
