/**
 * Cluster Program Parameters
 *
 * Pure helpers for resolving, defaulting, and validating the parameter values
 * of a cluster program. Values are exposed to program code as `params.<id>`,
 * already coerced to the declared type (number/boolean, not strings).
 */
import type {
  ClusterProgramParameter,
  ClusterProgramParamValues,
} from '@/types/cluster'

/** Minimal node shape needed to resolve node bindings (matches the graph store Node). */
export interface NodeBindingSource {
  node_id: string
  node_type: string
  properties?: Record<string, unknown>
}

export interface ResolveNodeBoundResult {
  /** Values for params whose binding resolved on this node */
  values: ClusterProgramParamValues
  /** Bindings that could not be resolved (property absent/null/empty/non-primitive) */
  missing: Array<{ paramId: string; binding: string }>
}

export type ResolveParamsResult =
  | { success: true; params: ClusterProgramParamValues }
  | { success: false; error: string }

/**
 * Build the default value map for a parameter declaration.
 *
 * - boolean params always get a value (`default ?? false`)
 * - other params are included only when they declare a default
 */
export function defaultParamValues(
  parameters: ClusterProgramParameter[] | undefined
): ClusterProgramParamValues {
  const values: ClusterProgramParamValues = {}
  for (const param of parameters ?? []) {
    if (param.type === 'boolean') {
      values[param.id] = param.default ?? false
    } else if (param.default !== undefined && param.default !== '') {
      values[param.id] = param.default
    }
  }
  return values
}

function isBlank(value: string | number | boolean | undefined): boolean {
  return value === undefined || (typeof value === 'string' && value.trim() === '')
}

/**
 * Parameters that are required but have no usable value yet.
 * Boolean params are never missing (they always resolve to a value).
 */
export function missingRequiredParams(
  parameters: ClusterProgramParameter[] | undefined,
  values: ClusterProgramParamValues
): ClusterProgramParameter[] {
  return (parameters ?? []).filter(
    p => p.type !== 'boolean' && p.required && isBlank(values[p.id])
  )
}

/**
 * Resolve the final `params` object for an execution.
 *
 * Starts from declared defaults, overlays the provided values, and coerces
 * each value to its declared type. Keys not present in the declaration are
 * dropped (stale values persisted before a declaration change). Fails on a
 * missing required value, a non-numeric value for a number param, or a select
 * value outside its options.
 */
/**
 * Resolve values for parameters bound to the clicked node (`node_binding`).
 *
 * Returns the resolved values plus the list of bindings that could not be
 * resolved. A binding is missing when the source value is undefined, null,
 * an empty string, or not a primitive — a missing binding should abort the
 * run (falling back to a declared default would silently use a value from
 * the wrong context). Coercion to the declared param type happens later in
 * `resolveParamValues`. Params without a binding are ignored.
 */
export function resolveNodeBoundValues(
  parameters: ClusterProgramParameter[] | undefined,
  node: NodeBindingSource
): ResolveNodeBoundResult {
  const values: ClusterProgramParamValues = {}
  const missing: Array<{ paramId: string; binding: string }> = []

  for (const param of parameters ?? []) {
    const binding = param.node_binding
    if (!binding) continue

    let raw: unknown
    if (binding === 'node_id') {
      raw = node.node_id
    } else if (binding === 'node_type') {
      raw = node.node_type
    } else if (binding.startsWith('prop:')) {
      raw = node.properties?.[binding.slice('prop:'.length)]
    } else {
      raw = undefined
    }

    if (
      (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') ||
      (typeof raw === 'string' && raw.trim() === '')
    ) {
      missing.push({ paramId: param.id, binding })
      continue
    }

    values[param.id] = raw
  }

  return { values, missing }
}

export function resolveParamValues(
  parameters: ClusterProgramParameter[] | undefined,
  values?: ClusterProgramParamValues
): ResolveParamsResult {
  const params: ClusterProgramParamValues = {}

  for (const param of parameters ?? []) {
    const provided = values?.[param.id]
    const raw = isBlank(provided) ? param.default : provided

    if (param.type === 'boolean') {
      params[param.id] = Boolean(raw ?? false)
      continue
    }

    if (isBlank(raw)) {
      if (param.required) {
        return { success: false, error: `Missing required parameter: ${param.id}` }
      }
      continue
    }

    switch (param.type) {
      case 'number': {
        const num = Number(raw)
        if (Number.isNaN(num)) {
          return { success: false, error: `Parameter "${param.id}" must be a number` }
        }
        params[param.id] = num
        break
      }
      case 'select': {
        const str = String(raw)
        if (!(param.options ?? []).includes(str)) {
          return {
            success: false,
            error: `Parameter "${param.id}" must be one of: ${(param.options ?? []).join(', ')}`,
          }
        }
        params[param.id] = str
        break
      }
      default:
        params[param.id] = String(raw)
    }
  }

  return { success: true, params }
}
