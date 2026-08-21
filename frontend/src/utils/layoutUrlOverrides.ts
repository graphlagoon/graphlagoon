/**
 * `?layout=` and `?layout.<mode>.<field>=` — URL overrides for the layout
 * parameters a style preset restored.
 *
 * A preset is a saved default; the query string is the specific instruction in
 * the link someone was sent. So the URL wins, field by field, and everything it
 * does not name keeps the preset's value — that is what makes
 * `?style=investigacao&layout.ego.focusNodeId=acct-9931` mean "that look, this
 * suspect" without saving a preset per suspect.
 *
 * Only SEMANTIC parameters are settable from a URL — the ones that change what
 * you are looking at, not how it is drawn. Appearance is the preset's job. The
 * allowlist is deliberate rather than an oversight; see LAYOUT_OVERRIDE_SCHEMA.
 *
 * Pure and schema-driven on purpose. Nothing here imports Vue, Pinia or the
 * router, so every rule is unit tested directly — which matters because
 * GraphVisualizationView, where this is used, has no unit test of its own.
 *
 * Nothing throws and nothing aborts halfway: every key is judged on its own, so
 * one typo does not discard the rest of the link. A malformed link must leave
 * the graph fully usable and merely explain itself — the same doctrine as a
 * missing `?style=`.
 */
import type {
  EgoLayoutConfig,
  HierarchicalLayoutConfig,
  HiveLayoutConfig,
  LayoutAlgorithm,
  LayoutModeConfig,
} from '@/types/graph';

/**
 * Algorithms this build can actually draw.
 *
 * Deliberately narrower than the store's KNOWN_LAYOUTS, which also lists
 * 'circular' and 'grid': those are members of the LayoutAlgorithm union with no
 * implementation, no UI entry and no branch in applyLayoutModeForces. Accepting
 * them here would hand someone a link that renders nothing and looks like a bug.
 * The `satisfies` keeps this list honest if the union is ever renamed.
 */
export const SUPPORTED_LAYOUTS = [
  'force',
  'ego',
  'hive',
  'hierarchical',
] as const satisfies readonly LayoutAlgorithm[];

export type SupportedLayout = (typeof SUPPORTED_LAYOUTS)[number];

export type LayoutModeKey = keyof LayoutModeConfig;

export type LayoutOverrideIssueCode =
  | 'malformed-key'
  | 'unknown-mode'
  | 'unknown-field'
  | 'field-not-url-settable'
  | 'unknown-algorithm'
  | 'not-a-number'
  | 'out-of-range'
  | 'not-an-integer'
  | 'unknown-enum'
  | 'empty-not-allowed'
  | 'conflicting-duplicate'
  /** Raised by the view once the graph is loaded, not by the parser. */
  | 'focus-node-not-found';

export interface LayoutOverrideIssue {
  code: LayoutOverrideIssueCode;
  /** The query key as written, e.g. 'layout.ego.maxHops'. */
  param: string;
  /** The offending value as written. Absent for malformed keys. */
  value?: string;
  /** One user-facing sentence, already in the product's voice. */
  message: string;
}

export interface ParsedLayoutOverrides {
  /** Set only when `?layout=` named a supported algorithm. */
  algorithm?: SupportedLayout;
  /**
   * Only the fields the URL actually set, so this is safe to hand straight to
   * `updateLayoutModeConfig` — everything else keeps the value it had.
   */
  modeConfig: {
    ego?: Partial<EgoLayoutConfig>;
    hive?: Partial<HiveLayoutConfig>;
    hierarchical?: Partial<HierarchicalLayoutConfig>;
  };
  issues: LayoutOverrideIssue[];
  /** True when the URL carried any layout param at all, valid or not. */
  present: boolean;
}

/** The query shape vue-router hands us: a key can repeat or arrive valueless. */
export type QueryLike = Record<
  string,
  string | (string | null)[] | null | undefined
>;

type FieldResult =
  | { ok: true; value: unknown }
  | { ok: false; code: LayoutOverrideIssueCode; detail: string };

interface FieldSpec {
  /** Human phrase completing "expected …", used in every rejection message. */
  expects: string;
  /** Never throws; reports through FieldResult instead. */
  parse(raw: string): FieldResult;
}

/**
 * An allowlist, so this is a Partial: a field absent here is not settable from a
 * URL even though it exists on the config type. Adding a field to the type does
 * NOT automatically expose it — that is the point. A test asserts every key here
 * still exists on the real config, so a rename cannot leave a dead entry behind.
 */
type ModeSchema<T> = { [K in keyof T]?: FieldSpec };

export interface LayoutOverrideSchema {
  ego: ModeSchema<EgoLayoutConfig>;
  hive: ModeSchema<HiveLayoutConfig>;
  hierarchical: ModeSchema<HierarchicalLayoutConfig>;
}

/**
 * Decimal only. `Number('')` is 0, `Number('0x10')` is 16 and `parseInt('3abc')`
 * is 3 — each would let a typo through as a plausible number. Same reasoning as
 * mergeForce3DSettings: a silently wrong number ruins a layout without a trace.
 */
function parseStrictNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function nullableStringField(): FieldSpec {
  return {
    expects: 'a value, or empty for none',
    parse: (raw) => ({ ok: true, value: raw.length > 0 ? raw : null }),
  };
}

function enumField<T extends string>(members: readonly T[]): FieldSpec {
  const expects = `one of ${members.join(', ')}`;
  return {
    expects,
    parse: (raw) =>
      (members as readonly string[]).includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, code: 'unknown-enum', detail: expects },
  };
}

interface NumberOpts {
  min: number;
  max: number;
  /** Empty value means null. Only for `number | null` fields. */
  nullable?: boolean;
}

function integerField({ min, max, nullable = false }: NumberOpts): FieldSpec {
  const expects =
    `a whole number from ${min} to ${max}` +
    (nullable ? ', or empty for none' : '');
  return {
    expects,
    parse: (raw) => {
      if (raw.length === 0) {
        return nullable
          ? { ok: true, value: null }
          : { ok: false, code: 'empty-not-allowed', detail: expects };
      }
      const value = parseStrictNumber(raw);
      if (value === null) return { ok: false, code: 'not-a-number', detail: expects };
      if (!Number.isInteger(value))
        return { ok: false, code: 'not-an-integer', detail: expects };
      if (value < min || value > max)
        return { ok: false, code: 'out-of-range', detail: expects };
      return { ok: true, value };
    },
  };
}

/**
 * Comma-separated, empty meaning null. Null and [] are the same graph to
 * buildAdjacency — "no restriction" — so only null is expressible, matching the
 * Layout panel's "all edge types" checkbox.
 */
function stringListField(): FieldSpec {
  return {
    expects: 'a comma-separated list, or empty for all',
    parse: (raw) => {
      const items = raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return { ok: true, value: items.length > 0 ? items : null };
    },
  };
}

/**
 * What a link may change: which node the rings radiate from, which way traversal
 * runs, how far it reaches, and which edges it follows.
 *
 * Everything else is intentionally absent:
 * - ringOrderingKey / hive.axisKey / hive.positionKey are free strings naming
 *   dataset properties. The parser cannot tell a typo from a real property, so a
 *   wrong one degrades the layout in silence — the exact failure this feature
 *   exists to prevent.
 * - crossingHeuristic gates sifting, which the store's own comment measures at
 *   ~440ms on a dense ring inside a 150ms debounce, "so strength is opt-in". A
 *   link must not spend that on the recipient's behalf.
 * - spacings, radii, ring ordering and arc routing are appearance. That is what
 *   a style preset is for; a URL that could set them would duplicate it badly.
 */
export const LAYOUT_OVERRIDE_SCHEMA: LayoutOverrideSchema = {
  ego: {
    focusNodeId: nullableStringField(),
    direction: enumField(['both', 'out', 'in'] as const),
    // The panel slider stops at 6, but the cutoff is semantic rather than
    // visual, so a link may ask for more. Past the graph's diameter it is a
    // no-op; 64 is a sanity ceiling, not a limit anyone should reach.
    maxHops: integerField({ min: 0, max: 64, nullable: true }),
    edgeTypes: stringListField(),
  },
  hive: {},
  hierarchical: {
    traversal: enumField(['both', 'out', 'in'] as const),
    direction: enumField(['td', 'lr'] as const),
    edgeTypes: stringListField(),
  },
};

const KEY_PREFIX = 'layout.';

function isLayoutKey(key: string): boolean {
  return key === 'layout' || key.startsWith(KEY_PREFIX);
}

function has(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Collapse vue-router's `string | string[] | null` into one string.
 *
 * Last occurrence wins, because appending `&layout.ego.maxHops=3` is how people
 * fix a link by hand. Identical repeats stay silent — that is a copy/paste
 * artifact, not a mistake worth reporting. A valueless `?layout.ego.maxHops`
 * arrives as null and reads as empty, which is how nullable fields say "none".
 */
function resolveValue(
  key: string,
  raw: string | (string | null)[] | null | undefined,
  issues: LayoutOverrideIssue[],
): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;

  const values = raw.map((value) => value ?? '');
  const last = values.length > 0 ? values[values.length - 1] : '';
  const conflicting = values.some((value) => value !== last);
  if (conflicting) {
    issues.push({
      code: 'conflicting-duplicate',
      param: key,
      value: last,
      message: `“${key}” was given more than once with different values; using “${last}”.`,
    });
  }
  return last;
}

/**
 * Read `?layout=` and `?layout.<mode>.<field>=` off a query object.
 *
 * Never throws. Every key is judged independently, so a link with one bad
 * parameter still applies the good ones and reports only what it dropped.
 */
export function parseLayoutOverrides(query: QueryLike): ParsedLayoutOverrides {
  const issues: LayoutOverrideIssue[] = [];
  const modeConfig: ParsedLayoutOverrides['modeConfig'] = {};
  let algorithm: SupportedLayout | undefined;
  let present = false;

  for (const key of Object.keys(query)) {
    if (!isLayoutKey(key)) continue;
    present = true;

    const raw = resolveValue(key, query[key], issues);

    if (key === 'layout') {
      if ((SUPPORTED_LAYOUTS as readonly string[]).includes(raw)) {
        algorithm = raw as SupportedLayout;
      } else {
        issues.push({
          code: 'unknown-algorithm',
          param: key,
          value: raw,
          message: `“${raw}” is not a layout — expected one of ${SUPPORTED_LAYOUTS.join(', ')}.`,
        });
      }
      continue;
    }

    const segments = key.slice(KEY_PREFIX.length).split('.');
    if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) {
      issues.push({
        code: 'malformed-key',
        param: key,
        message: `“${key}” is not a layout setting — expected layout.<mode>.<field>.`,
      });
      continue;
    }

    const [mode, field] = segments;
    if (!has(LAYOUT_OVERRIDE_SCHEMA, mode)) {
      issues.push({
        code: 'unknown-mode',
        param: key,
        message: `“${mode}” is not a layout mode — expected ego, hive or hierarchical.`,
      });
      continue;
    }

    // hasOwnProperty, not `in`: a key like layout.ego.__proto__ would otherwise
    // resolve through Object.prototype and write outside the schema.
    const modeSchema = LAYOUT_OVERRIDE_SCHEMA[mode as LayoutModeKey] as Record<
      string,
      FieldSpec
    >;
    if (!has(modeSchema, field)) {
      issues.push({
        code: settableFieldNames(mode as LayoutModeKey).length
          ? 'unknown-field'
          : 'field-not-url-settable',
        param: key,
        message: describeUnsettableField(mode as LayoutModeKey, field),
      });
      continue;
    }

    const result = modeSchema[field].parse(raw);
    if (!result.ok) {
      issues.push({
        code: result.code,
        param: key,
        value: raw,
        message: `“${key}=${raw}” was ignored — expected ${result.detail}.`,
      });
      continue;
    }

    const bucket = (modeConfig[mode as LayoutModeKey] ??= {}) as Record<
      string,
      unknown
    >;
    bucket[field] = result.value;
  }

  return { algorithm, modeConfig, issues, present };
}

/** Field names a URL may set for a mode, in schema order. */
export function settableFieldNames(mode: LayoutModeKey): string[] {
  return Object.keys(LAYOUT_OVERRIDE_SCHEMA[mode]);
}

/**
 * Say why a field was refused, distinguishing "no such setting" from "that
 * setting exists but belongs to a style preset" — the second is the far more
 * likely mistake, and telling someone to save a preset is more use than telling
 * them the name is wrong.
 */
function describeUnsettableField(mode: LayoutModeKey, field: string): string {
  const settable = settableFieldNames(mode);
  if (settable.length === 0) {
    return `The ${mode} layout has no settings a link can change — save a style preset instead.`;
  }
  return `“${field}” cannot be set from a link for the ${mode} layout — expected one of ${settable.join(
    ', ',
  )}. Other layout settings travel in a style preset.`;
}

/** Join every issue into one tooltip. */
export function summarizeLayoutIssues(issues: LayoutOverrideIssue[]): string {
  return issues.map((issue) => issue.message).join(' ');
}

/**
 * A stable key over just the layout params, for the route watcher.
 *
 * The keys are open-ended (`layout.<mode>.<field>`), so there is no single
 * `route.query.style`-style property to watch; and route.query is a fresh object
 * on every navigation, so watching it directly would re-run on unrelated query
 * changes. Sorting makes reordering a link a no-op.
 */
export function layoutQuerySignature(query: QueryLike): string {
  const entries: string[] = [];
  for (const key of Object.keys(query).sort()) {
    if (!isLayoutKey(key)) continue;
    const raw = query[key];
    const value =
      raw === null || raw === undefined
        ? ''
        : typeof raw === 'string'
          ? raw
          : raw.map((item) => item ?? '').join(',');
    entries.push(`${key}=${value}`);
  }
  return entries.join('&');
}
