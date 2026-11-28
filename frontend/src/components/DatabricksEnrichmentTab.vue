<script setup lang="ts">
/**
 * "Your data → Context enrichments": the context's enrichment queries and providers, run by
 * hand over the edges or nodes on screen. The `auto` ones also run after every query and
 * expand; this is where an author tests one and where a failure says why. A saved snapshot keeps the
 * values and which enrichment wrote them.
 */
import { computed, ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { authorizedTables, queryEntries, runSpec, targetOf } from '@/utils/queryEnrichment';
import { describeRun } from '@/utils/enrichmentStatus';
import { configuredEnrichmentProviders, enrichmentDescription } from '@/utils/enrichmentSources';
import { paramHint, paramProblem, paramText, paramValues } from '@/utils/providerParams';
import type { EnrichmentTable, ProviderParamInfo } from '@/types/graph';
import { guideUrl } from '@/utils/docsLinks';

const graph = useGraphStore();
const entries = computed(() => queryEntries(graph.currentContext));
const tables = computed(() => authorizedTables(graph.currentContext));
const edgeCount = computed(() => graph.edges.length);
const running = ref<string | null>(null);

const providers = configuredEnrichmentProviders();
const providerOf = (q: EnrichmentTable) => providers.find((p) => p.name === q.provider?.name);

/** The parameters of `q` that its author lets whoever runs it change. */
function openParams(q: EnrichmentTable): ProviderParamInfo[] {
  const open = q.provider?.runtime_params ?? [];
  return (providerOf(q)?.params ?? []).filter((p) => open.includes(p.name));
}

/** What this context sets for a parameter (else the provider's default), as text. */
const contextValue = (q: EnrichmentTable, p: ProviderParamInfo) => paramText(q.provider?.params?.[p.name] ?? p.default);

/** Entry name → parameter name → the text typed for this run ('' = the context's value). */
const typed = ref<Record<string, Record<string, string>>>({});
const textOf = (q: EnrichmentTable, name: string) => typed.value[q.name]?.[name] ?? '';
function setText(q: EnrichmentTable, name: string, text: string) {
  typed.value = { ...typed.value, [q.name]: { ...typed.value[q.name], [name]: text } };
}

function problemOf(q: EnrichmentTable, p: ProviderParamInfo): string {
  const text = textOf(q, p.name);
  if (!text.trim() && p.required && !contextValue(q, p)) return 'needs a value';
  return paramProblem(p, text);
}
const blocked = (q: EnrichmentTable) => openParams(q).some((p) => problemOf(q, p));

async function run(q: EnrichmentTable) {
  const name = q.name;
  running.value = name;
  try {
    const given = paramValues(openParams(q), typed.value[name] ?? {});
    await graph.runQueryEnrichment({ names: [name], ...(Object.keys(given).length ? { params: { [name]: given } } : {}) });
  } finally {
    running.value = null;
  }
}

function outcome(name: string): { kind: 'ok' | 'error' | 'running'; text: string } | null {
  const r = graph.queryEnrichmentRuns[name];
  if (!r) return null;
  const kind = r.status === 'error' ? 'error' : r.status === 'done' ? 'ok' : 'running';
  return { kind, text: describeRun(r) };
}
</script>

<template>
  <section data-testid="your-data-databricks">
    <p class="hint">
      Queries the context's author wrote over this context's authorized Databricks tables, and providers the
      deployment registered (for example a Lakebase lookup). Each one adds properties
      to the edges or the nodes on the canvas; <strong>after every query</strong> ones also run by themselves. A saved
      exploration keeps the values it had, and opening it runs those again to refresh them.
      <a :href="guideUrl('bring-your-own-data', 'enrich-from-databricks-tables')" target="_blank" rel="noopener">More in the guide</a>
    </p>

    <div v-if="!entries.length" class="nomatch" data-testid="your-data-databricks-empty">
      This context has no enrichment query or provider yet. Someone with the "Create graph contexts" permission adds one in the
      context form, under <strong>Enrichments and data sources</strong>.
    </div>

    <template v-else>
      <p v-if="tables.length" class="tables" data-testid="your-data-databricks-tables">Authorized tables: {{ tables.join(', ') }}</p>
      <p v-if="!edgeCount && !graph.nodes.length" class="nomatch">Run a query first: the canvas is empty.</p>
      <ul class="queries">
        <li v-for="q in entries" :key="q.name" data-testid="your-data-databricks-query">
          <div class="head">
            <strong>{{ q.label }}</strong>
            <span class="chip">{{ targetOf(q) === 'nodes' ? 'nodes' : 'edges' }}</span>
            <span v-if="q.provider" class="chip">provider {{ q.provider.name }}</span>
            <span class="chip">{{ (runSpec(q)?.run ?? 'manual') === 'auto' ? 'after every query' : 'by hand' }}</span>
            <button
              class="btn btn-sm btn-primary"
              :disabled="!!running || (!edgeCount && !graph.nodes.length) || blocked(q)"
              data-testid="your-data-databricks-run"
              @click="run(q)"
            >
              {{ running === q.name ? 'Running…' : graph.queryEnrichmentRuns[q.name]?.status === 'error' ? 'Retry' : 'Run' }}
            </button>
          </div>
          <p v-if="enrichmentDescription(q)" class="what" data-testid="your-data-databricks-description">{{ enrichmentDescription(q) }}</p>
          <p v-if="providerOf(q)?.columns?.length" class="what" data-testid="your-data-databricks-columns">
            Adds: {{ providerOf(q)!.columns!.join(', ') }}
          </p>
          <div v-if="openParams(q).length" class="params" data-testid="your-data-databricks-params">
            <label v-for="p in openParams(q)" :key="p.name" class="param">
              <span class="param-name"><code>{{ p.name }}</code> <span v-if="paramHint(p)">{{ paramHint(p) }}</span></span>
              <select
                v-if="p.choices?.length || p.type === 'bool'"
                class="form-control"
                :value="textOf(q, p.name)"
                :data-testid="`your-data-databricks-param-${p.name}`"
                @change="setText(q, p.name, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ contextValue(q, p) ? `This context's value (${contextValue(q, p)})` : '(not set)' }}</option>
                <option v-for="c in p.type === 'bool' ? ['true', 'false'] : p.choices!" :key="c" :value="c">{{ c }}</option>
              </select>
              <input
                v-else
                type="text"
                class="form-control"
                :value="textOf(q, p.name)"
                :placeholder="contextValue(q, p) ? `This context's value: ${contextValue(q, p)}` : 'required'"
                :data-testid="`your-data-databricks-param-${p.name}`"
                @input="setText(q, p.name, ($event.target as HTMLInputElement).value)"
              />
              <span v-if="problemOf(q, p)" class="param-problem" data-testid="your-data-databricks-param-problem">{{ p.name }} {{ problemOf(q, p) }}</span>
            </label>
          </div>
          <p
            v-if="outcome(q.name)"
            class="outcome"
            :class="outcome(q.name)!.kind"
            data-testid="your-data-databricks-outcome"
          >
            {{ outcome(q.name)!.text }}
          </p>
          <details v-if="q.query?.sql">
            <summary>Show the query</summary>
            <pre class="sql">{{ q.query?.sql }}</pre>
          </details>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.what {
  margin: 4px 0 0;
  font-size: 0.85rem;
  color: var(--text-secondary, #666);
  overflow-wrap: anywhere;
  white-space: pre-line;
}
.params {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 6px 12px;
  margin-top: 6px;
}
.param {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.8rem;
}
.param-name {
  color: var(--text-secondary, #666);
}
.param-problem {
  color: var(--danger-color, #f44336);
}
.hint,
.tables {
  font-size: 0.85rem;
  color: var(--text-secondary, #666);
}
.nomatch {
  font-size: 0.85rem;
  padding: 8px 10px;
  border: 1px dashed var(--border-color, #ccc);
  border-radius: 6px;
}
.queries {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.queries li {
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  padding: 8px 10px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.head .btn {
  margin-left: auto;
}
.chip {
  font-size: 0.75rem;
  padding: 0 6px;
  border-radius: 3px;
  background: color-mix(in srgb, #3b82f6 18%, transparent);
}
.outcome {
  margin: 6px 0 0;
  font-size: 0.85rem;
}
.outcome.error {
  color: var(--error-color, #c0392b);
}
.sql {
  white-space: pre-wrap;
  font-size: 0.75rem;
  margin: 4px 0 0;
  max-height: 160px;
  overflow: auto;
}
summary {
  cursor: pointer;
  font-size: 0.8rem;
  margin-top: 4px;
}
</style>
