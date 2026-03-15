/**
 * Minimal YAML parser for query template specs.
 *
 * Supports only the subset used by template definitions:
 *   - Top-level string key-value pairs
 *   - Block literal scalars (query: |)
 *   - A single list of mappings (parameters:)
 */

export interface ParsedTemplateSpec {
  name: string;
  description: string;
  query_type: 'cypher' | 'sql';
  query: string;
  parameters: ParsedParameter[];
}

export interface ParsedParameter {
  id: string;
  type: 'input';
  label: string;
  description?: string;
  placeholder?: string;
  default?: string;
  required: boolean;
}

export interface ParseResult {
  spec: ParsedTemplateSpec | null;
  error: string | null;
}

// Unquote a YAML scalar value: remove surrounding quotes if present
function unquote(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function parseTemplateYaml(text: string): ParseResult {
  const lines = text.split('\n');

  const top: Record<string, string | null> = {};
  const rawParams: Array<Record<string, string>> = [];

  let i = 0;
  let inQuery = false;
  let inParams = false;
  let currentParam: Record<string, string> | null = null;
  let queryIndent = 0;
  let queryLines: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();

    // Skip empty lines and comments at top level
    if (!stripped || stripped.startsWith('#')) {
      if (inQuery) {
        // Blank lines inside block scalar are always kept
        queryLines.push('');
      }
      i++;
      continue;
    }

    // Detect indentation level (normalize tabs to spaces for counting)
    const rawIndentStr = line.match(/^(\s*)/)?.[1] ?? '';
    const indent = rawIndentStr.replace(/\t/g, '  ').length;

    if (inQuery) {
      if (queryIndent === -1) {
        // First non-empty content line — detect actual indent of the block
        queryIndent = indent;
      }
      if (indent >= queryIndent) {
        // Part of block scalar — strip the block indent prefix
        queryLines.push(line.replace(/\t/g, '  ').substring(queryIndent));
        i++;
        continue;
      } else {
        // Block scalar ended
        inQuery = false;
        top['query'] = queryLines.join('\n').trimEnd();
        queryLines = [];
      }
    }

    if (inParams) {
      if (indent === 0 && !stripped.startsWith('-')) {
        // Left params section
        inParams = false;
        if (currentParam) {
          rawParams.push(currentParam);
          currentParam = null;
        }
      } else if (stripped.startsWith('- ')) {
        // New parameter item
        if (currentParam) rawParams.push(currentParam);
        currentParam = {};
        const rest = stripped.slice(2).trim();
        const colonIdx = rest.indexOf(':');
        if (colonIdx !== -1) {
          const key = rest.slice(0, colonIdx).trim();
          const val = unquote(rest.slice(colonIdx + 1).trim());
          currentParam[key] = val;
        }
        i++;
        continue;
      } else if (currentParam !== null && indent > 0) {
        // Key-value inside a parameter
        const colonIdx = stripped.indexOf(':');
        if (colonIdx !== -1) {
          const key = stripped.slice(0, colonIdx).trim();
          const val = unquote(stripped.slice(colonIdx + 1).trim());
          currentParam[key] = val;
        }
        i++;
        continue;
      }
    }

    // Top-level key-value parsing
    const colonIdx = stripped.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = stripped.slice(0, colonIdx).trim();
    const rest = stripped.slice(colonIdx + 1).trim();

    if (key === 'parameters') {
      if (currentParam) { rawParams.push(currentParam); currentParam = null; }
      inParams = true;
      inQuery = false;
    } else if (rest === '|') {
      // Block literal scalar — detect actual indent from the first content line
      inQuery = true;
      queryIndent = -1; // will be set when first non-empty line is seen
      top[key] = null; // Will be filled when block ends
    } else {
      top[key] = unquote(rest);
    }

    i++;
  }

  // Flush any open blocks
  if (inQuery && queryLines.length > 0) {
    top['query'] = queryLines.join('\n').trimEnd();
  }
  if (currentParam) rawParams.push(currentParam);

  // Validate required top-level fields
  const name = (top['name'] ?? '').trim();
  if (!name) return { spec: null, error: '"name" is required' };

  const queryType = (top['query_type'] ?? '').toLowerCase();
  if (queryType !== 'cypher' && queryType !== 'sql') {
    return { spec: null, error: '"query_type" must be "cypher" or "sql"' };
  }

  const query = (top['query'] ?? '').trim();
  if (!query) return { spec: null, error: '"query" is required' };

  // Parse parameters
  const parameters: ParsedParameter[] = [];
  for (let pi = 0; pi < rawParams.length; pi++) {
    const p = rawParams[pi];
    if (!p['id']) return { spec: null, error: `Parameter ${pi + 1}: "id" is required` };
    if (!p['label']) return { spec: null, error: `Parameter ${pi + 1}: "label" is required` };
    parameters.push({
      id: p['id'],
      type: 'input',
      label: p['label'],
      description: p['description'] || undefined,
      placeholder: p['placeholder'] || undefined,
      default: p['default'] !== undefined ? p['default'] : undefined,
      required: p['required'] !== 'false',
    });
  }

  return {
    spec: {
      name,
      description: (top['description'] ?? '').trim(),
      query_type: queryType as 'cypher' | 'sql',
      query,
      parameters,
    },
    error: null,
  };
}

export function buildTemplateYaml(spec: {
  name: string;
  description?: string;
  query_type: string;
  query: string;
  parameters: ParsedParameter[];
}): string {
  const lines: string[] = [
    `name: ${spec.name}`,
    `description: ${spec.description || ''}`,
    `query_type: ${spec.query_type}`,
    `query: |`,
    ...spec.query.split('\n').map((l) => `  ${l}`),
    `parameters:`,
  ];

  if (spec.parameters.length === 0) {
    lines.push('  []');
  } else {
    for (const p of spec.parameters) {
      lines.push(`  - id: ${p.id}`);
      lines.push(`    type: input`);
      lines.push(`    label: ${p.label}`);
      if (p.description) lines.push(`    description: ${p.description}`);
      if (p.placeholder) lines.push(`    placeholder: "${p.placeholder}"`);
      if (p.default !== undefined && p.default !== '') lines.push(`    default: "${p.default}"`);
      lines.push(`    required: ${p.required}`);
    }
  }

  return lines.join('\n') + '\n';
}
