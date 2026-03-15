/**
 * Label Formatter Utility
 *
 * Provides secure template-based label formatting for nodes and edges.
 * Uses a parser-based approach (NO eval/Function) for safety.
 *
 * Template Syntax:
 * - Basic placeholders: {prop:name}, {node_type}, {relationship_type}, {src}, {dst}, {node_id}, {edge_id}
 * - With modifiers: {prop:name|upper}, {prop:name|truncate:20:...}
 * - Conditionals: {if:prop:x>10|High|Low}, {if:prop:status==active|Active|Inactive}
 * - Date formatting: {date:prop:created_at|DD/MM/YYYY}
 * - Date conditionals: {if:prop:date|daysAgo:<7|Recent|Old}
 */

import type { Node, Edge, TextFormatRule, TextFormatModifier, TextFormatConditionOperator } from '@/types/graph';

// ============================================================================
// Types
// ============================================================================

interface ParsedToken {
  type: 'text' | 'placeholder' | 'conditional' | 'date';
  value: string;
  property?: string;
  modifier?: TextFormatModifier;
  modifierArgs?: string[];
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
}

type FormatContext = {
  target: 'node' | 'edge';
  item: Node | Edge;
};

// ============================================================================
// Modifier Functions
// ============================================================================

const modifiers: Record<TextFormatModifier, (value: string, args?: string[]) => string> = {
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  capitalize: (v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(),
  truncate: (v, args) => {
    const maxLen = parseInt(args?.[0] || '20', 10);
    const suffix = args?.[1] || '...';
    return v.length > maxLen ? v.slice(0, maxLen - suffix.length) + suffix : v;
  },
  number: (v) => {
    const num = parseFloat(v);
    return isNaN(num) ? v : num.toLocaleString();
  },
  currency: (v, args) => {
    const num = parseFloat(v);
    if (isNaN(num)) return v;
    const currency = args?.[0] || 'USD';
    try {
      return num.toLocaleString(undefined, { style: 'currency', currency });
    } catch {
      return `${currency} ${num.toFixed(2)}`;
    }
  },
  percent: (v) => {
    const num = parseFloat(v);
    return isNaN(num) ? v : `${(num * 100).toFixed(1)}%`;
  },
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
    default:
      return false;
  }
}

// ============================================================================
// Template Parser
// ============================================================================

function parseConditionExpression(expr: string): ParsedCondition | null {
  // Match patterns like: prop:field>10, prop:field==value, prop:date|daysAgo:<7

  // Date operators: prop:field|daysAgo:<7, prop:field|dateAfter:2024-01-01
  const dateMatch = expr.match(/^prop:([^|]+)\|(daysAgo|dateAfter|dateBefore|dateBetween):(.+)$/);
  if (dateMatch) {
    const [, property, operator, value] = dateMatch;
    if (operator === 'dateBetween') {
      const [v1, v2] = value.split(':');
      return { property, operator: operator as TextFormatConditionOperator, value: v1, value2: v2 };
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
 * Split a string by `|` but respecting nested `{...}` pairs.
 * e.g. "prop:x==1|{prop:y|upper}|default" → ["prop:x==1", "{prop:y|upper}", "default"]
 */
function splitByPipeRespectingBraces(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of s) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === '|' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Find the matching closing `}` for a `{` at position `start`,
 * respecting nested brace pairs. Returns the index of the matching `}`,
 * or -1 if not found.
 */
function findMatchingBrace(template: string, start: number): number {
  let depth = 1;
  for (let j = start + 1; j < template.length; j++) {
    if (template[j] === '{') depth++;
    if (template[j] === '}') depth--;
    if (depth === 0) return j;
  }
  return -1;
}

function parseTokenContent(content: string): ParsedToken {
  // Date formatting: date:prop:field|format
  if (content.startsWith('date:')) {
    const dateMatch = content.match(/^date:prop:([^|]+)\|?(.*)$/);
    if (dateMatch) {
      return {
        type: 'date',
        value: content,
        property: dateMatch[1],
        dateFormat: dateMatch[2] || 'YYYY-MM-DD',
      };
    }
  }

  // Conditional: if:condition|trueVal|falseVal (brace-aware split)
  if (content.startsWith('if:')) {
    const parts = splitByPipeRespectingBraces(content.slice(3));
    if (parts.length >= 2) {
      const condition = parseConditionExpression(parts[0]);
      return {
        type: 'conditional',
        value: content,
        condition: condition || undefined,
        trueValue: parts[1],
        falseValue: parts[2] || '',
      };
    }
  }

  // Property placeholder: prop:name or prop:name|modifier
  if (content.startsWith('prop:')) {
    const parts = content.slice(5).split('|');
    const property = parts[0];
    let modifier: TextFormatModifier | undefined;
    let modifierArgs: string[] | undefined;

    if (parts[1]) {
      const modParts = parts[1].split(':');
      modifier = modParts[0] as TextFormatModifier;
      modifierArgs = modParts.slice(1);
    }

    return {
      type: 'placeholder',
      value: content,
      property,
      modifier,
      modifierArgs,
    };
  }

  // Built-in placeholders: node_type, relationship_type, src, dst, node_id, edge_id
  const parts = content.split('|');
  const property = parts[0];
  let modifier: TextFormatModifier | undefined;
  let modifierArgs: string[] | undefined;

  if (parts[1]) {
    const modParts = parts[1].split(':');
    modifier = modParts[0] as TextFormatModifier;
    modifierArgs = modParts.slice(1);
  }

  return {
    type: 'placeholder',
    value: content,
    property,
    modifier,
    modifierArgs,
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

function getPropertyValue(ctx: FormatContext, property: string): string {
  const { target, item } = ctx;

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

function applyModifier(value: string, modifier?: TextFormatModifier, args?: string[]): string {
  if (!modifier || !modifiers[modifier]) return value;
  return modifiers[modifier](value, args);
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
        const value = getPropertyValue(ctx, token.property || '');
        if (value === '' && token.value?.startsWith('prop:')) {
          return `[${token.property}]`; // Fallback for missing props
        }
        return applyModifier(value, token.modifier, token.modifierArgs);
      }

      case 'conditional': {
        if (!token.condition) return '';
        const propValue = getPropertyValue(ctx, token.condition.property);
        const result = evaluateCondition(token.condition, propValue);
        const valueToFormat = result ? (token.trueValue || '') : (token.falseValue || '');
        const innerTokens = parseTemplate(valueToFormat);
        return formatWithTokens(innerTokens, ctx);
      }

      case 'date': {
        const value = getPropertyValue(ctx, token.property || '');
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

/**
 * Validate a template string and return errors if any
 */
export function validateTemplate(template: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for balanced braces
  let braceCount = 0;
  for (const char of template) {
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

  // Parse and check tokens
  try {
    const tokens = parseTemplate(template);
    for (const token of tokens) {
      if (token.type === 'conditional' && !token.condition) {
        errors.push(`Invalid condition syntax in: ${token.value}`);
      }
    }
  } catch (e) {
    errors.push(`Parse error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get available placeholders for autocomplete
 */
export function getAvailablePlaceholders(
  target: 'node' | 'edge',
  properties: string[]
): { placeholder: string; description: string }[] {
  const result: { placeholder: string; description: string }[] = [];

  // Built-in placeholders
  if (target === 'node') {
    result.push(
      { placeholder: '{node_id}', description: 'Node identifier' },
      { placeholder: '{node_type}', description: 'Node type/label' },
    );
  } else {
    result.push(
      { placeholder: '{edge_id}', description: 'Edge identifier' },
      { placeholder: '{relationship_type}', description: 'Edge relationship type' },
      { placeholder: '{src}', description: 'Source node ID' },
      { placeholder: '{dst}', description: 'Destination node ID' },
    );
  }

  // Property placeholders
  for (const prop of properties) {
    result.push({ placeholder: `{prop:${prop}}`, description: `Property: ${prop}` });
  }

  return result;
}

/**
 * Get available modifiers for autocomplete
 */
export function getAvailableModifiers(): { modifier: string; description: string; example: string }[] {
  return [
    { modifier: 'upper', description: 'Convert to uppercase', example: '{prop:name|upper}' },
    { modifier: 'lower', description: 'Convert to lowercase', example: '{prop:name|lower}' },
    { modifier: 'capitalize', description: 'Capitalize first letter', example: '{prop:name|capitalize}' },
    { modifier: 'truncate', description: 'Truncate with ellipsis', example: '{prop:name|truncate:20:...}' },
    { modifier: 'number', description: 'Format as number', example: '{prop:count|number}' },
    { modifier: 'currency', description: 'Format as currency', example: '{prop:amount|currency:BRL}' },
    { modifier: 'percent', description: 'Format as percentage', example: '{prop:rate|percent}' },
  ];
}

/**
 * Clear the template cache (useful when templates change frequently)
 */
export function clearTemplateCache(): void {
  templateCache.clear();
}
