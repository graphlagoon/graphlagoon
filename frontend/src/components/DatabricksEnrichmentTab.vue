<script setup lang="ts">
/**
 * "Your data → From Databricks tables": the context's enrichment queries, run by hand over
 * the edges or nodes on screen. The `auto` ones also run after every query and expand; this is
 * where an author tests one and where a failure says why. Results stay on the canvas only.
 */
import { computed, ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { authorizedTables, queryEntries, targetOf } from '@/utils/queryEnrichment';
import { guideUrl } from '@/utils/docsLinks';

const graph = useGraphStore();
const entries = computed(() => queryEntries(graph.currentContext));
const tables = computed(() => authorizedTables(graph.currentContext));
const edgeCount = computed(() => graph.edges.length);
const running = ref<string | null>(null);

async function run(name: string) {
  running.value = name;
  try {
    await graph.runQueryEnrichment({ names: [name] });
  } finally {
    running.value = null;
  }
}

function outcome(name: string): { kind: 'ok' | 'error' | 'running'; text: string } | null {
  const r = graph.queryEnrichmentRuns[name];
  if (!r) return null;
  if (r.status === 'running') return { kind: 'running', text: 'Running…' };
  if (r.status === 'error') return { kind: 'error', text: r.error ?? 'The query failed' };
  const parts = [`${r.matched} of ${r.total} ${r.target} matched a row`, `${r.written} got new values`];
  if (r.truncated) parts.push('the result hit the row limit, so some edges may be missing');
  return { kind: 'ok', text: parts.join(' · ') };
}
</script>

<template>
  <section data-testid="your-data-databricks">
    <p class="hint">
      Queries the context's author wrote over this context's authorized Databricks tables. Each one adds properties
      to the edges or the nodes on the canvas; <strong>after every query</strong> ones also run by themselves. Nothing is saved:
      opening the graph again runs them again.
      <a :href="guideUrl('bring-your-own-data', 'enrich-from-databricks-tables')" target="_blank" rel="noopener">More in the guide</a>
    </p>

    <div v-if="!entries.length" class="nomatch" data-testid="your-data-databricks-empty">
      This context has no enrichment query yet. Someone with the "Create graph contexts" permission adds one in the
      context form, under <strong>Enrichment Tables → Enrich with a query</strong>.
    </div>

    <template v-else>
      <p class="tables" data-testid="your-data-databricks-tables">Authorized tables: {{ tables.join(', ') }}</p>
      <p v-if="!edgeCount && !graph.nodes.length" class="nomatch">Run a query first: the canvas is empty.</p>
      <ul class="queries">
        <li v-for="q in entries" :key="q.name" data-testid="your-data-databricks-query">
          <div class="head">
            <strong>{{ q.label }}</strong>
            <span class="chip">{{ targetOf(q) === 'nodes' ? 'nodes' : 'edges' }}</span>
            <span class="chip">{{ (q.query?.run ?? 'manual') === 'auto' ? 'after every query' : 'by hand' }}</span>
            <button
              class="btn btn-sm btn-primary"
              :disabled="!!running || (!edgeCount && !graph.nodes.length)"
              data-testid="your-data-databricks-run"
              @click="run(q.name)"
            >
              {{ running === q.name ? 'Running…' : 'Run' }}
            </button>
          </div>
          <p
            v-if="outcome(q.name)"
            class="outcome"
            :class="outcome(q.name)!.kind"
            data-testid="your-data-databricks-outcome"
          >
            {{ outcome(q.name)!.text }}
          </p>
          <details>
            <summary>Show the query</summary>
            <pre class="sql">{{ q.query?.sql }}</pre>
          </details>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
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
