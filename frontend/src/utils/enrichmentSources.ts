/**
 * Which tables a context may list as enrichment tables: the deployment's allowed sources
 * (`enrichment_sources` in /api/config: the graph catalog.schema pairs plus the
 * enrichment-only schemas and tables). The server decides on save and on every run; this only
 * lets the form warn early. Pure.
 */
import type { EnrichmentProviderInfo, EnrichmentTable, ProviderParamInfo, TableProviderInfo } from '@/types/graph';

const bare = (part: string) => part.trim().replace(/`/g, '').toLowerCase();

/** The allowed sources the server announced, or null when it did not (older server). */
export function configuredEnrichmentSources(): string[] | null {
  const sources = window.__GRAPH_LAGOON_CONFIG__?.enrichment_sources;
  return Array.isArray(sources) ? sources : null;
}

/** Enrichment providers the deployment registered (/api/config `enrichment_providers`). */
export function configuredEnrichmentProviders(): EnrichmentProviderInfo[] {
  const providers = window.__GRAPH_LAGOON_CONFIG__?.enrichment_providers;
  return Array.isArray(providers) ? providers : [];
}

/** Table providers the deployment registered (/api/config `table_providers`). */
export function configuredTableProviders(): TableProviderInfo[] {
  const providers = window.__GRAPH_LAGOON_CONFIG__?.table_providers;
  return Array.isArray(providers) ? providers : [];
}

/** A table source of a context, joined with what the server says about its provider. */
export interface TableSourceInfo {
  /** The context's name for it: what an action's `source` holds. */
  name: string;
  label: string;
  /** The entry's description, else the provider's registered one. */
  description: string;
  provider: string;
  /** False: the provider is not registered on this server (the source cannot run here). */
  registered: boolean;
  targets: ('node' | 'edge')[];
  columns: string[];
  /** The parameters the context lets a caller set: an action binds or fixes these. */
  params: ProviderParamInfo[];
  /** The parameters the context closed, with the value it uses. */
  locked: { name: string; value: string }[];
}

/** The table sources a context declares (`enrichment_tables` entries with `table_provider`). */
export function contextTableSources(
  tables: EnrichmentTable[] | null | undefined,
  providers: TableProviderInfo[] = configuredTableProviders(),
): TableSourceInfo[] {
  return (tables ?? []).flatMap((entry) => {
    const ref = entry.table_provider;
    if (!ref?.name) return [];
    const provider = providers.find((p) => p.name === ref.name);
    const opened = new Set(ref.runtime_params ?? []);
    const declared = provider?.params ?? [];
    const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    return [{
      name: entry.name,
      label: entry.label,
      description: entry.description?.trim() || provider?.description?.trim() || '',
      provider: ref.name,
      registered: !!provider,
      targets: provider?.targets ?? [],
      columns: provider?.columns ?? [],
      // The context's value, when it sets one, is what applies when nobody says otherwise.
      params: declared.filter((p) => opened.has(p.name)).map((p) => ({ ...p, default: ref.params?.[p.name] ?? p.default })),
      locked: declared.filter((p) => !opened.has(p.name)).map((p) => ({ name: p.name, value: text(ref.params?.[p.name] ?? p.default) })),
    }];
  });
}

/** The source an action points at: by `source`, or (an action older than sources) the first one using its `provider`. */
export function actionTableSource(
  action: { source?: string; provider?: string },
  sources: TableSourceInfo[],
): TableSourceInfo | undefined {
  return action.source ? sources.find((s) => s.name === action.source) : sources.find((s) => s.provider === action.provider);
}

/** Targets one enrichment run may carry: the server's `enrichment_max_keys` (500 when it does not say). */
export function enrichmentBatchSize(): number {
  const size = window.__GRAPH_LAGOON_CONFIG__?.enrichment_max_keys;
  return typeof size === 'number' && size >= 1 ? Math.floor(size) : 500;
}

/** What an enrichment says it does: the author's description, else its provider's registered one. */
export function enrichmentDescription(
  entry: { description?: string | null; provider?: { name: string } | null },
  providers: EnrichmentProviderInfo[] = configuredEnrichmentProviders(),
): string {
  return entry.description?.trim() || providers.find((p) => p.name === entry.provider?.name)?.description?.trim() || '';
}

/**
 * False only when `table` is a full catalog.schema.table that is neither one of `ownTables`
 * nor inside `sources`. Unknown cases (no sources announced, a two-part name the server
 * resolves with its default catalog) are left to the server.
 */
export function isAllowedEnrichmentSource(table: string, sources: string[] | null, ownTables: string[] = []): boolean {
  const parts = table.split('.').map(bare);
  if (!sources || parts.length !== 3 || parts.some((p) => !p)) return true;
  const full = parts.join('.');
  if (ownTables.some((t) => t.split('.').map(bare).join('.') === full)) return true;
  return sources.some((source) => {
    const s = source.split('.').map(bare);
    return s.length === 2 ? s[0] === parts[0] && s[1] === parts[1] : s.join('.') === full;
  });
}

/**
 * The `removed` tables that `sql` names (catalog.schema.table as written in the list). A kept
 * query reading one would break: the server refuses that save (ENRICHMENT_QUERY_ORPHANED).
 * A text match, so a reference by a shorter name is left to the server.
 */
export function removedTablesReadBy(sql: string, removed: string[]): string[] {
  const text = sql.replace(/`/g, '').toLowerCase();
  return removed.filter((table) => {
    const name = bare(table.split('.').map(bare).join('.')).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    return name && new RegExp(`(^|[^\\w.])${name}($|[^\\w.])`).test(text);
  });
}
