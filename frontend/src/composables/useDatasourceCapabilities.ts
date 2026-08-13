/**
 * What a context's backend can do — the single place the UI branches on it.
 *
 * Components ask for capabilities, never for a datasource type, so adding a
 * backend means adding one row to CAPABILITIES rather than hunting down
 * `=== 'neptune'` checks scattered across panels.
 *
 * This matrix lives in the frontend on purpose: the server only reports which
 * datasource types it can *serve* (`config.datasources`). What each type can
 * *do* is a rendering concern, versioned with the UI that renders it — and the
 * backend enforces the same rules independently, returning
 * DATASOURCE_UNSUPPORTED_OPERATION if a stale client asks anyway.
 */

import { computed, unref, type ComputedRef, type Ref } from "vue";
import type { DatasourceType, GraphContext } from "@/types/graph";

export interface DatasourceCapabilities {
  /** Raw SQL graph queries and the query console's `sql` mode. */
  supportsSql: boolean;
  /** Cypher→SQL transpilation: the review flow, VLP modes, procedural BFS options, CTE fallback. */
  supportsTranspile: boolean;
  /** User-supplied CTE pre-filters spliced into the generated SQL. */
  supportsCtePrefilter: boolean;
  /** A stored table/column snapshot that can drift from the live source. */
  supportsDrift: boolean;
  /** Table/column configuration: catalog browsing, structural columns, property lists. */
  supportsCatalog: boolean;
  /** `nodes_mode: "types"` plus background property enrichment. */
  supportsProgressiveLoad: boolean;
}

const SQL_WAREHOUSE: DatasourceCapabilities = {
  supportsSql: true,
  supportsTranspile: true,
  supportsCtePrefilter: true,
  supportsDrift: true,
  supportsCatalog: true,
  supportsProgressiveLoad: true,
};

/**
 * Neptune is a native property graph: it speaks Cypher directly, so there is
 * no SQL, nothing to transpile, no table schema to drift, no catalog to browse,
 * and no wide projection worth deferring — it returns whole property maps.
 */
const NEPTUNE: DatasourceCapabilities = {
  supportsSql: false,
  supportsTranspile: false,
  supportsCtePrefilter: false,
  supportsDrift: false,
  supportsCatalog: false,
  supportsProgressiveLoad: false,
};

const CAPABILITIES: Record<DatasourceType, DatasourceCapabilities> = {
  sql_warehouse: SQL_WAREHOUSE,
  neptune: NEPTUNE,
};

export const DEFAULT_DATASOURCE_TYPE: DatasourceType = "sql_warehouse";

/** Human-readable name for a datasource, for badges and pickers. */
export const DATASOURCE_LABELS: Record<DatasourceType, string> = {
  sql_warehouse: "SQL Warehouse",
  neptune: "Amazon Neptune",
};

export const DATASOURCE_DESCRIPTIONS: Record<DatasourceType, string> = {
  sql_warehouse:
    "A graph stored as an edge table and a node table. Cypher is transpiled to SQL.",
  neptune:
    "A native graph database queried with openCypher. No tables to configure.",
};

/**
 * Resolve a datasource type, defaulting anything unrecognized to the warehouse.
 *
 * Contexts created before this field existed carry no value, and every one of
 * them is a warehouse context — so "unspecified" and "sql_warehouse" mean the
 * same thing.
 */
export function resolveDatasourceType(
  context?: Pick<GraphContext, "datasource_type"> | null,
): DatasourceType {
  const type = context?.datasource_type;
  return type && type in CAPABILITIES ? type : DEFAULT_DATASOURCE_TYPE;
}

export function capabilitiesFor(type: DatasourceType): DatasourceCapabilities {
  return CAPABILITIES[type] ?? SQL_WAREHOUSE;
}

/** Reactive capabilities for a context (or a plain object / null). */
export function useDatasourceCapabilities(
  context:
    | Ref<Pick<GraphContext, "datasource_type"> | null | undefined>
    | ComputedRef<Pick<GraphContext, "datasource_type"> | null | undefined>
    | Pick<GraphContext, "datasource_type">
    | null
    | undefined,
): ComputedRef<DatasourceCapabilities> {
  return computed(() => capabilitiesFor(resolveDatasourceType(unref(context))));
}

/** Which datasource types this server can serve, from the injected config. */
export function useAvailableDatasources(): ComputedRef<DatasourceType[]> {
  return computed(() => {
    const configured = window.__GRAPH_LAGOON_CONFIG__?.datasources;
    const types = Object.keys(CAPABILITIES) as DatasourceType[];
    // Without a server answer, offer only the warehouse: it is the one backend
    // guaranteed to exist, and offering a type the server cannot serve would
    // fail at creation time.
    if (!configured) return [DEFAULT_DATASOURCE_TYPE];
    return types.filter((type) => configured[type] === true);
  });
}
