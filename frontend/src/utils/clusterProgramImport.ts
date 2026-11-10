/**
 * Parser/validator for cluster-program JSON — the return leg of the Ask-AI
 * prompt (clusterProgramSkill.ts) and the import side of "Export JSON".
 *
 * Accepts, in order of what people actually paste:
 *   - the bare object an LLM answers with:
 *     { program_name, description?, code, parameters?, show_in_context_menu? }
 *   - an array of such objects
 *   - the portable envelope written by Export JSON
 *     ({ graphlagoon_export: 'cluster-programs', programs: [...] })
 *   - an LLM answer wrapped in a ```json fence
 *
 * Lenient where safe (`name` accepted for `program_name`, code given as an
 * array of lines, a param `label` defaulting to nothing), strict where it
 * matters (name, code, parameter ids/types/options/bindings — the same rules
 * the editor enforces). Never trusts the input shape. Ids, scope and
 * timestamps are not imported: the store assigns them on create.
 */
import type {
  ClusterProgram,
  ClusterProgramParameter,
  ClusterProgramParameterType,
} from '@/types/cluster';
import type { PortableSourceSchema } from '@/types/portable';

/** What an import yields per program — the editable fields, no identity. */
export interface ImportedClusterProgram {
  program_name: string;
  description?: string;
  code: string;
  parameters?: ClusterProgramParameter[];
  show_in_context_menu?: boolean;
}

export type ClusterProgramImportResult =
  | { ok: true; programs: ImportedClusterProgram[]; source?: PortableSourceSchema }
  | { ok: false; error: string };

const PARAM_TYPES: ClusterProgramParameterType[] = ['text', 'number', 'boolean', 'select'];
const PARAM_ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_NAME = 200;
const MAX_CODE = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function optionalSource(value: unknown): PortableSourceSchema | undefined {
  if (!isRecord(value)) return undefined;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    context_title: typeof value.context_title === 'string' ? value.context_title : undefined,
    node_types: list(value.node_types),
    relationship_types: list(value.relationship_types),
    node_properties: list(value.node_properties),
    edge_properties: list(value.edge_properties),
  };
}

/** Strip a ```json … ``` fence an LLM may wrap its answer in. */
function unfence(text: string): string {
  const m = /^\s*```(?:json|javascript|js)?\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(text);
  return m ? m[1] : text;
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined | Error {
  const v = raw[key];
  if (v == null) return undefined;
  if (typeof v !== 'string') return new Error(`"${key}" must be a string`);
  return v.trim() || undefined;
}

function parseParam(raw: unknown, label: string): ClusterProgramParameter | string {
  if (!isRecord(raw)) return `${label}not an object`;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!PARAM_ID.test(id)) return `${label}"id" must be a JavaScript identifier (e.g. threshold)`;

  const type = raw.type ?? 'text';
  if (typeof type !== 'string' || !(PARAM_TYPES as string[]).includes(type)) {
    return `${label}"type" must be one of ${PARAM_TYPES.join(', ')}`;
  }
  const param: ClusterProgramParameter = {
    id,
    type: type as ClusterProgramParameterType,
    required: type === 'boolean' ? false : raw.required !== false,
  };

  for (const key of ['label', 'description', 'placeholder'] as const) {
    const v = optionalString(raw, key);
    if (v instanceof Error) return `${label}${v.message}`;
    if (v) param[key] = v;
  }

  if (type === 'select') {
    if (!Array.isArray(raw.options)) return `${label}a "select" parameter needs "options" (an array of strings)`;
    const options = raw.options.map((o) => (typeof o === 'number' ? String(o) : o));
    if (!options.every((o): o is string => typeof o === 'string' && o.trim() !== '')) {
      return `${label}"options" must be non-empty strings`;
    }
    if (options.length === 0) return `${label}"options" must not be empty`;
    param.options = options.map((o) => o.trim());
  }

  if (raw.default != null && raw.default !== '') {
    const d = raw.default;
    if (type === 'number') {
      const n = typeof d === 'number' ? d : Number(d);
      if (!Number.isFinite(n)) return `${label}"default" must be a number`;
      param.default = n;
    } else if (type === 'boolean') {
      if (typeof d !== 'boolean') return `${label}"default" must be true or false`;
      param.default = d;
    } else {
      if (typeof d !== 'string' && typeof d !== 'number') return `${label}"default" must be a string`;
      param.default = String(d);
      if (type === 'select' && !param.options!.includes(param.default)) {
        return `${label}"default" must be one of its options`;
      }
    }
  } else if (type === 'boolean') {
    param.default = false;
  }

  const binding = raw.node_binding ?? raw.nodeBinding;
  if (binding != null && binding !== '') {
    if (typeof binding !== 'string') return `${label}"node_binding" must be a string`;
    const ok =
      binding === 'node_id' ||
      binding === 'node_type' ||
      (binding.startsWith('prop:') && binding.length > 5) ||
      (binding.startsWith('metric:') && binding.length > 7);
    if (!ok) return `${label}"node_binding" must be node_id, node_type, prop:<name> or metric:<name>`;
    param.node_binding = binding as ClusterProgramParameter['node_binding'];
  }
  return param;
}

function parseOne(raw: unknown, index: number, total: number): ImportedClusterProgram | string {
  const label = total > 1 ? `Program ${index + 1}: ` : '';
  if (!isRecord(raw)) return `${label}not an object`;

  const nameRaw = raw.program_name ?? raw.name;
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!name) return `${label}missing "program_name"`;
  if (name.length > MAX_NAME) return `${label}"program_name" must be at most ${MAX_NAME} characters`;

  // An LLM sometimes answers with an array of lines for readability.
  const code = Array.isArray(raw.code)
    ? raw.code.filter((l): l is string => typeof l === 'string').join('\n')
    : raw.code;
  if (typeof code !== 'string' || code.trim() === '') return `${label}missing "code"`;
  if (code.length > MAX_CODE) return `${label}"code" must be at most ${MAX_CODE} characters`;

  const description = optionalString(raw, 'description');
  if (description instanceof Error) return `${label}${description.message}`;

  const menu = raw.show_in_context_menu ?? raw.showInContextMenu;
  if (menu !== undefined && typeof menu !== 'boolean') return `${label}"show_in_context_menu" must be a boolean`;

  let parameters: ClusterProgramParameter[] | undefined;
  if (raw.parameters != null) {
    if (!Array.isArray(raw.parameters)) return `${label}"parameters" must be an array`;
    parameters = [];
    const ids = new Set<string>();
    for (let i = 0; i < raw.parameters.length; i++) {
      const p = parseParam(raw.parameters[i], `${label}parameter ${i + 1}: `);
      if (typeof p === 'string') return p;
      if (ids.has(p.id)) return `${label}duplicate parameter id "${p.id}"`;
      ids.add(p.id);
      parameters.push(p);
    }
  }

  const program: ImportedClusterProgram = { program_name: name, code };
  if (description) program.description = description;
  if (parameters && parameters.length > 0) program.parameters = parameters;
  if (menu === true) program.show_in_context_menu = true;
  return program;
}

export function parseImportedClusterPrograms(json: string): ClusterProgramImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(json));
  } catch {
    return { ok: false, error: 'Not valid JSON' };
  }

  let source: PortableSourceSchema | undefined;
  if (isRecord(parsed) && parsed.graphlagoon_export != null) {
    if (parsed.graphlagoon_export !== 'cluster-programs') {
      return {
        ok: false,
        error: `This file is a "${String(parsed.graphlagoon_export)}" export, not cluster programs`,
      };
    }
    if (!Array.isArray(parsed.programs)) return { ok: false, error: '"programs" must be an array' };
    source = optionalSource(parsed.source);
    parsed = parsed.programs;
  }

  const rawList = Array.isArray(parsed) ? parsed : [parsed];
  if (rawList.length === 0) return { ok: false, error: 'Empty list' };

  const programs: ImportedClusterProgram[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const p = parseOne(rawList[i], i, rawList.length);
    if (typeof p === 'string') return { ok: false, error: p };
    programs.push(p);
  }
  return { ok: true, programs, source };
}

/** The portable shape of a program: its editable fields, no id/scope/timestamps. */
export function portableClusterProgram(program: Pick<ClusterProgram, 'program_name' | 'code'> & Partial<ClusterProgram>): ImportedClusterProgram {
  const out: ImportedClusterProgram = { program_name: program.program_name, code: program.code };
  if (program.description) out.description = program.description;
  if (program.parameters && program.parameters.length > 0) {
    out.parameters = program.parameters.map((p) => ({ ...p, options: p.options ? [...p.options] : undefined }))
      .map((p) => {
        if (p.options === undefined) delete p.options;
        return p;
      });
  }
  if (program.show_in_context_menu) out.show_in_context_menu = true;
  return out;
}
