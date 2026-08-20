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
import type {
  DatasourceConnectionConfig,
  DatasourceType,
  GraphContext,
} from "@/types/graph";

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

/**
 * A REST connection is even further from the warehouse than Neptune: the query
 * language itself is opaque, so every SQL-shaped affordance is off. What a
 * given connection CAN do (expand, subgraph, …) is per-instance, not per-type —
 * that arrives from the server as `restOps` on its descriptor.
 */
const REST: DatasourceCapabilities = {
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
  rest: REST,
};

export const DEFAULT_DATASOURCE_TYPE: DatasourceType = "sql_warehouse";

/**
 * Copy for the datasource picker.
 *
 * Deliberately about *when to choose which*, not about how each one is built.
 * Whether a graph lives in two tables or in a native store is an implementation
 * detail the person creating a context cannot act on; what they can act on is
 * the trade-off they are accepting — completeness against latency — and what it
 * costs them if they pick wrong.
 */
export interface DatasourceCopy {
  /**
   * The concrete product, and the headline of the card: people recognize
   * "Databricks" and "Amazon Neptune" instantly, where the generic category
   * takes a beat to place. Also used on its own in badges and info panels.
   */
  label: string;
  /** The generic category, secondary — what kind of thing the product is. */
  kind: string;
  /** The workload this datasource is for, in three words. */
  tagline: string;
  /** What you get out of it. */
  description: string;
  /** What you give up. Rendered with emphasis; never omit it. */
  caveat: string;
}

export const DATASOURCE_COPY: Record<DatasourceType, DatasourceCopy> = {
  // The `rest` entry is a FALLBACK: real REST connections carry their own copy
  // from the server (see DatasourceDescriptor); this renders only for a
  // context whose connection is no longer configured.
  rest: {
    label: "REST connection",
    kind: "REST API",
    tagline: "Operational · external API",
    description: "A graph served by an external API this deployment registered.",
    caveat:
      "What you can query — and how complete the answer is — is defined by " +
      "the connection, not by Graph Lagoon.",
  },
  sql_warehouse: {
    label: "Databricks",
    kind: "SQL Warehouse",
    tagline: "Analytical · exploratory",
    description:
      "The complete graph — every node, edge and property is there to be " +
      "queried, cross-referenced and explored.",
    caveat: "Expect higher latency: queries are optimized for breadth, not speed.",
  },
  neptune: {
    label: "Amazon Neptune",
    kind: "openCypher",
    tagline: "Operational (OLTP) · low latency",
    description:
      "A graph tuned for serving live traffic, so traversals come back fast.",
    caveat:
      "It may not carry the full analytical picture — confirm the data you " +
      "need is present before drawing conclusions from it.",
  },
};

/** Human-readable name for a datasource, for badges and pickers. */
export const DATASOURCE_LABELS: Record<DatasourceType, string> = {
  sql_warehouse: DATASOURCE_COPY.sql_warehouse.label,
  neptune: DATASOURCE_COPY.neptune.label,
  rest: DATASOURCE_COPY.rest.label,
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

// ── Instance descriptors ─────────────────────────────────────────────────
//
// REST connections broke the per-type model: one type, N named instances,
// each with its own copy and its own operation flags, all declared on the
// server. A descriptor is the unified answer to "what backend is this?" —
// static for the built-in types, config-sourced for REST connections.

/** Per-connection operation flags a REST connection declared handlers for. */
export interface RestOperations {
  expand: boolean;
  subgraph: boolean;
  fetchNodes: boolean;
  schemaDiscovery: boolean;
}

/** Copy fields only a named connection carries (the query language is its own). */
export interface ConnectionCopy extends DatasourceCopy {
  queryLanguage?: string;
  queryPlaceholder?: string;
  exampleQuery?: string;
}

export interface DatasourceDescriptor {
  /** Stable identity: the type for built-ins, `rest:<name>` for connections. */
  id: string;
  type: DatasourceType;
  /** The connection name for `rest`; null for the single-instance types. */
  name: string | null;
  copy: ConnectionCopy;
  capabilities: DatasourceCapabilities;
  /** Present only for `rest` descriptors. */
  restOps?: RestOperations;
  /**
   * False for the synthetic descriptor of a context whose connection is no
   * longer registered on the server — render it, but expect queries to fail.
   */
  available: boolean;
}

function staticDescriptor(type: DatasourceType): DatasourceDescriptor {
  return {
    id: type,
    type,
    name: null,
    copy: DATASOURCE_COPY[type],
    capabilities: CAPABILITIES[type],
    available: true,
  };
}

function connectionDescriptor(
  connection: DatasourceConnectionConfig,
): DatasourceDescriptor {
  return {
    id: `rest:${connection.name}`,
    type: "rest",
    name: connection.name,
    copy: {
      label: connection.label,
      kind: connection.kind || DATASOURCE_COPY.rest.kind,
      tagline: connection.tagline,
      description: connection.description,
      caveat: connection.caveat,
      queryLanguage: connection.query_language,
      queryPlaceholder: connection.query_placeholder,
      exampleQuery: connection.example_query,
    },
    capabilities: REST,
    restOps: {
      expand: connection.capabilities?.expand === true,
      subgraph: connection.capabilities?.subgraph === true,
      fetchNodes: connection.capabilities?.fetch_nodes === true,
      schemaDiscovery: connection.capabilities?.schema_discovery === true,
    },
    available: true,
  };
}

/**
 * A context still pointing at a connection the server no longer registers.
 * Everything is off; the caveat says why instead of pretending it works.
 */
function orphanDescriptor(name: string): DatasourceDescriptor {
  return {
    id: `rest:${name}`,
    type: "rest",
    name,
    copy: {
      ...DATASOURCE_COPY.rest,
      label: name,
      caveat:
        "This connection is no longer configured on the server — queries " +
        "against it will fail until it is registered again.",
    },
    capabilities: REST,
    restOps: {
      expand: false,
      subgraph: false,
      fetchNodes: false,
      schemaDiscovery: false,
    },
    available: false,
  };
}

function restConnectionConfigs(): DatasourceConnectionConfig[] {
  return window.__GRAPH_LAGOON_CONFIG__?.datasource_connections ?? [];
}

/**
 * Resolve the full descriptor for a context — the instance-aware counterpart
 * of `resolveDatasourceType`, and the only way to reach a REST context's
 * per-connection copy and operation flags.
 */
export function resolveDatasourceDescriptor(
  context?: Pick<GraphContext, "datasource_type" | "datasource_name"> | null,
): DatasourceDescriptor {
  const type = resolveDatasourceType(context);
  if (type !== "rest") return staticDescriptor(type);

  const name = context?.datasource_name ?? "";
  const connection = restConnectionConfigs().find((c) => c.name === name);
  if (connection) return connectionDescriptor(connection);
  return orphanDescriptor(name || "unknown");
}

/** Reactive descriptor for a context (or a plain object / null). */
export function useDatasourceDescriptor(
  context:
    | Ref<
        Pick<GraphContext, "datasource_type" | "datasource_name"> | null | undefined
      >
    | ComputedRef<
        Pick<GraphContext, "datasource_type" | "datasource_name"> | null | undefined
      >
    | Pick<GraphContext, "datasource_type" | "datasource_name">
    | null
    | undefined,
): ComputedRef<DatasourceDescriptor> {
  return computed(() => resolveDatasourceDescriptor(unref(context)));
}

/**
 * Everything the context-creation picker should offer: the built-in types the
 * server can serve, then every registered REST connection.
 */
export function useDatasourceDescriptors(): ComputedRef<DatasourceDescriptor[]> {
  return computed(() => {
    const configured = window.__GRAPH_LAGOON_CONFIG__?.datasources;
    const staticTypes: DatasourceType[] = ["sql_warehouse", "neptune"];
    // Without a server answer, offer only the warehouse: it is the one backend
    // guaranteed to exist, and offering a type the server cannot serve would
    // fail at creation time.
    const offered = configured
      ? staticTypes.filter((type) => configured[type] === true)
      : [DEFAULT_DATASOURCE_TYPE];
    return [
      ...offered.map(staticDescriptor),
      ...restConnectionConfigs().map(connectionDescriptor),
    ];
  });
}

/** Which datasource types this server can serve, from the injected config. */
export function useAvailableDatasources(): ComputedRef<DatasourceType[]> {
  return computed(() => {
    const configured = window.__GRAPH_LAGOON_CONFIG__?.datasources;
    const types: DatasourceType[] = ["sql_warehouse", "neptune"];
    // Without a server answer, offer only the warehouse: it is the one backend
    // guaranteed to exist, and offering a type the server cannot serve would
    // fail at creation time.
    if (!configured) return [DEFAULT_DATASOURCE_TYPE];
    return types.filter((type) => configured[type] === true);
  });
}
