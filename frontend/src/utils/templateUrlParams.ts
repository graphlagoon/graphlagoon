/**
 * `?template=<name>` and `?template.<paramId>=<value>` — run a saved query
 * template straight from a link.
 *
 * A template is addressed by name among the templates the viewer can see in
 * the context, and its parameter values travel under the `template.` prefix:
 * `?template=neighbors&template.node_id=acct-9931&template.depth=2`.
 *
 * Unlike `?layout.*`, which merely adjusts how a graph is drawn, these values
 * are spliced into a query that a warehouse will execute. So the rules are
 * fail-closed: ANY issue — a typo'd key, a missing required value, a character
 * that could escape a quoted literal — means nothing runs and one status chip
 * explains the whole link. A partially-applied query is not an answer.
 *
 * Two stages, both pure:
 *
 * - `parseTemplateUrl` judges the grammar and the value charset. It needs
 *   nothing but the query object.
 * - `resolveTemplateExecution` judges the link against the template it names:
 *   existence, ambiguity, declared parameters, required/default/select rules.
 *
 * A pure module, imported by GraphVisualizationView — no Vue, no Pinia, no
 * router — for the same reason layoutUrlOverrides is: the view has no unit
 * test of its own, so the logic that has to be right lives where it can be
 * tested.
 */
import type { QueryTemplate } from '@/types/graph';
import type { QueryLike } from './layoutUrlOverrides';

export const TEMPLATE_KEY = 'template';
export const TEMPLATE_PARAM_PREFIX = 'template.';

/**
 * What a parameter value may contain when it arrives by URL.
 *
 * Deliberately conservative: letters, digits, space, `_ . , : @ / -`. The
 * value lands inside the query text verbatim (substitution is a splice, not a
 * typed binding), so quotes, backslashes and backticks could escape a string
 * literal, `;` could try to chain a statement, and `$` + parentheses could
 * smuggle another `$param` or a `$hash()` macro call. The downstream read-only
 * validators are the authority — this is defense in depth at the one boundary
 * where the value comes from a link rather than from someone at the keyboard.
 * The execute modal stays permissive; a value that cannot travel in a link can
 * still be typed there.
 */
export const SAFE_VALUE_RE = /^[A-Za-z0-9 _.,:@/-]*$/;

export type TemplateUrlIssueCode =
  | 'malformed-key'
  | 'orphan-param'
  | 'unsafe-value'
  | 'conflicting-duplicate'
  | 'template-not-found'
  | 'template-ambiguous'
  | 'template-not-runnable'
  | 'template-not-linkable'
  /** Raised by the view when the template list cannot be fetched, not here. */
  | 'templates-load-failed'
  | 'unknown-param'
  | 'missing-required'
  | 'not-in-options';

export interface TemplateUrlIssue {
  code: TemplateUrlIssueCode;
  /** The query key as written, e.g. 'template.node_id' — or 'template'. */
  param: string;
  /** The offending value as written. Absent for malformed keys. */
  value?: string;
  /** One user-facing sentence, already in the product's voice. */
  message: string;
}

export interface ParsedTemplateUrl {
  /** Set only when `?template=` named something non-empty. */
  name?: string;
  /** Raw URL values keyed by paramId — everything after `template.`. */
  values: Record<string, string>;
  issues: TemplateUrlIssue[];
  /** True when the URL carried any template param at all, valid or not. */
  present: boolean;
}

export type TemplateResolution =
  | {
      ok: true;
      template: QueryTemplate;
      /** Effective value for every declared parameter: URL value or default. */
      values: Record<string, string>;
    }
  | { ok: false; issues: TemplateUrlIssue[] };

function isTemplateKey(key: string): boolean {
  return key === TEMPLATE_KEY || key.startsWith(TEMPLATE_PARAM_PREFIX);
}

/**
 * Collapse vue-router's `string | string[] | null` into one string.
 *
 * Last occurrence wins, matching resolveValue in layoutUrlOverrides — but a
 * repeat with DIFFERENT values is a blocking issue here rather than a warning:
 * two values for the same query parameter means two different queries, and
 * guessing which one to execute is not this module's call to make.
 */
function resolveValue(
  key: string,
  raw: string | (string | null)[] | null | undefined,
  issues: TemplateUrlIssue[],
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
      message: `“${key}” was given more than once with different values — the link is ambiguous, so nothing was run.`,
    });
  }
  return last;
}

/**
 * Read `?template=` and `?template.<paramId>=` off a query object.
 *
 * Never throws, and judges every key on its own so the status chip can explain
 * the whole link at once. The paramId is everything after `template.` taken
 * verbatim — a dotted id still matches by exact string, because splitting
 * further would invent structure the template editor never promised.
 */
export function parseTemplateUrl(query: QueryLike): ParsedTemplateUrl {
  const issues: TemplateUrlIssue[] = [];
  const values: Record<string, string> = {};
  let name: string | undefined;
  let present = false;

  for (const key of Object.keys(query)) {
    if (!isTemplateKey(key)) continue;
    present = true;

    const raw = resolveValue(key, query[key], issues);

    if (key === TEMPLATE_KEY) {
      if (raw === '') {
        issues.push({
          code: 'malformed-key',
          param: key,
          message: '“template=” names no template — expected ?template=<name>.',
        });
      } else {
        // The name is compared by equality against saved templates and never
        // substituted into a query, so it is exempt from SAFE_VALUE_RE — a
        // template legitimately named “João's report” must stay linkable.
        name = raw;
      }
      continue;
    }

    const paramId = key.slice(TEMPLATE_PARAM_PREFIX.length);
    if (paramId.length === 0) {
      issues.push({
        code: 'malformed-key',
        param: key,
        message: `“${key}” is not a template parameter — expected template.<paramId>=<value>.`,
      });
      continue;
    }
    // hasOwnProperty doctrine from parseLayoutOverrides: these keys come from
    // the URL and end up as object keys, so the prototype is off limits.
    if (paramId === '__proto__' || paramId === 'constructor' || paramId === 'prototype') {
      issues.push({
        code: 'malformed-key',
        param: key,
        message: `“${paramId}” is not a valid parameter name.`,
      });
      continue;
    }

    if (!SAFE_VALUE_RE.test(raw)) {
      issues.push({
        code: 'unsafe-value',
        param: key,
        value: raw,
        message: `The value of “${key}” contains characters that cannot travel in a link — run the template from the Templates panel instead.`,
      });
      continue;
    }

    values[paramId] = raw;
  }

  // Parameters without a name are nobody's: dropping them silently would make
  // a mistyped link (`?template.node_id=x` missing its `?template=`) look like
  // a working page that simply chose not to run anything.
  if (name === undefined && Object.keys(values).length > 0) {
    for (const paramId of Object.keys(values)) {
      issues.push({
        code: 'orphan-param',
        param: `${TEMPLATE_PARAM_PREFIX}${paramId}`,
        value: values[paramId],
        message: `“${TEMPLATE_PARAM_PREFIX}${paramId}” was given but the URL names no template — expected ?template=<name> alongside it.`,
      });
    }
  }

  return { name, values, issues, present };
}

/**
 * Judge a parsed link against the templates the viewer can actually see.
 *
 * Pure: the caller fetches the template list; this decides. Name matching is
 * exact-string over the (already visibility-filtered) list, and every rule the
 * execute modal enforces interactively is enforced here — plus the ones the
 * modal's UI makes impossible, like an unknown parameter or a select value
 * outside its options. Defaults are validated too: a stale default that no
 * longer appears in the options must not run just because nobody retyped it.
 */
export function resolveTemplateExecution(
  parsed: ParsedTemplateUrl,
  templates: QueryTemplate[],
  opts: { supportsSql: boolean },
): TemplateResolution {
  const issues: TemplateUrlIssue[] = [];

  if (parsed.name === undefined) {
    // The parser already explained this (malformed-key / orphan-param); this
    // guard only keeps a careless caller from executing a nameless link.
    return {
      ok: false,
      issues: parsed.issues.length > 0 ? parsed.issues : [
        {
          code: 'template-not-found',
          param: TEMPLATE_KEY,
          message: 'The URL names no template.',
        },
      ],
    };
  }

  const matches = templates.filter((template) => template.name === parsed.name);
  if (matches.length === 0) {
    issues.push({
      code: 'template-not-found',
      param: TEMPLATE_KEY,
      value: parsed.name,
      message: `No template named “${parsed.name}” exists in this context (or it is private to someone else).`,
    });
    return { ok: false, issues };
  }
  if (matches.length > 1) {
    issues.push({
      code: 'template-ambiguous',
      param: TEMPLATE_KEY,
      value: parsed.name,
      message: `${matches.length} templates are named “${parsed.name}” — rename one so a link can tell them apart.`,
    });
    return { ok: false, issues };
  }

  const template = matches[0];

  if (template.query_type === 'sql' && !opts.supportsSql) {
    issues.push({
      code: 'template-not-runnable',
      param: TEMPLATE_KEY,
      value: parsed.name,
      message: `“${parsed.name}” is a SQL template, and this context's datasource does not run SQL.`,
    });
    return { ok: false, issues };
  }

  // Strict `=== false`: templates saved before the flag existed carry no value
  // and must stay linkable — the opt-out is the author's explicit choice.
  if (template.options?.allow_url_execution === false) {
    issues.push({
      code: 'template-not-linkable',
      param: TEMPLATE_KEY,
      value: parsed.name,
      message: `The author of “${parsed.name}” disabled running it from a link — open it in the Templates panel instead.`,
    });
    return { ok: false, issues };
  }

  const declared = new Set(template.parameters.map((parameter) => parameter.id));
  for (const paramId of Object.keys(parsed.values)) {
    if (!declared.has(paramId)) {
      issues.push({
        code: 'unknown-param',
        param: `${TEMPLATE_PARAM_PREFIX}${paramId}`,
        value: parsed.values[paramId],
        message: `“${parsed.name}” declares no parameter named “${paramId}”.`,
      });
    }
  }

  const values: Record<string, string> = {};
  for (const parameter of template.parameters) {
    const fromUrl = parsed.values[parameter.id];
    const effective =
      fromUrl !== undefined && fromUrl.trim() !== ''
        ? fromUrl
        : (parameter.default ?? '');

    if (parameter.required && effective.trim() === '') {
      issues.push({
        code: 'missing-required',
        param: `${TEMPLATE_PARAM_PREFIX}${parameter.id}`,
        message: `“${parameter.id}” is required by “${parsed.name}” and has no default — add template.${parameter.id}=<value> to the link.`,
      });
      continue;
    }

    if (
      parameter.type === 'select' &&
      effective.trim() !== '' &&
      !(parameter.options ?? []).includes(effective)
    ) {
      issues.push({
        code: 'not-in-options',
        param: `${TEMPLATE_PARAM_PREFIX}${parameter.id}`,
        value: effective,
        message: `“${effective}” is not an option for “${parameter.id}” — expected one of ${(parameter.options ?? []).join(', ')}.`,
      });
      continue;
    }

    values[parameter.id] = effective;
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, template, values };
}

/** Join every issue into one tooltip. */
export function summarizeTemplateIssues(issues: TemplateUrlIssue[]): string {
  return issues.map((issue) => issue.message).join(' ');
}

/**
 * A stable key over just the template params, for the route watcher.
 *
 * The parameter keys are open-ended (`template.<paramId>`), so there is no
 * single property to watch — the signature plays the role
 * `precomputedQuerySignature` plays for `?precomputed=`. Sorting makes
 * reordering a link a no-op.
 *
 * It is `''` only when the URL carries no template key at all: an orphaned
 * `?template.x=1` still moves the signature, because the watcher must run to
 * SHOW the explaining chip, not only to execute.
 */
export function templateQuerySignature(query: QueryLike): string {
  const entries: string[] = [];
  for (const key of Object.keys(query).sort()) {
    if (!isTemplateKey(key)) continue;
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
