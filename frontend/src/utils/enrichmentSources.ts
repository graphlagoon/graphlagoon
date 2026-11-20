/**
 * Which tables a context may list as enrichment tables: the deployment's allowed sources
 * (`enrichment_sources` in /api/config: the graph catalog.schema pairs plus the
 * enrichment-only schemas and tables). The server decides on save and on every run; this only
 * lets the form warn early. Pure.
 */
import type { EnrichmentProviderInfo } from '@/types/graph';

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
