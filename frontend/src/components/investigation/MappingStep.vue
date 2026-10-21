<script setup lang="ts">
/**
 * Mapping step (05 §4, kill list "5 steps → 2"): the detected saved mapping with its
 * column table, the preview and the file quality for a graph; key column, columns
 * and node types for an enrichment; the identity keys the mapping yields. Reused by
 * the file wizard and by "query → graph". The JSON editor is the "advanced" path.
 */
import { computed, watch } from 'vue';
import { getErrorMessage } from '@/utils/errorMessage';
import { interpretMapping, lines, parseLine, type MappingSpec } from '@/utils/fileMapping';
import { derivedIdentityKeys, mappingRows } from '@/utils/fileImport';
import type { FileEnrichmentSpec } from '@/types/investigation';

const props = defineProps<{
  role: 'graph' | 'enrichment';
  /** Decoded text per file name. */
  texts: Record<string, string>;
  fileNames: string[];
  detected: string | null;
  specText: string;
  enrichment: FileEnrichmentSpec | null;
  title: string;
}>();
const emit = defineEmits<{
  'update:specText': [text: string];
  'update:enrichment': [spec: FileEnrichmentSpec | null];
  'update:title': [title: string];
  'update:valid': [valid: boolean];
}>();

const maxEdges = window.__GRAPH_LAGOON_CONFIG__?.investigation_max_working_edges ?? 50000;

const spec = computed<MappingSpec | null>(() => {
  try {
    return JSON.parse(props.specText) as MappingSpec;
  } catch {
    return null;
  }
});

const preview = computed(() => {
  if (props.role !== 'graph') return { error: null, result: null };
  if (!spec.value) return { error: 'The mapping is not valid JSON', result: null };
  try {
    return { error: null, result: interpretMapping(spec.value, props.texts) };
  } catch (e) {
    return { error: getErrorMessage(e, 'Invalid mapping'), result: null };
  }
});
const rows = computed(() => (spec.value && !preview.value.error ? mappingRows(spec.value, props.texts) : []));
const identityKeys = computed(() => (spec.value ? derivedIdentityKeys(spec.value) : []));
const report = computed(() => preview.value.result?.report ?? null);
const counterpartPct = computed(() =>
  report.value && report.value.edge_rows ? Math.round((100 * report.value.without_counterpart) / report.value.edge_rows) : 0,
);
const previewEdges = computed(() => {
  const g = preview.value.result?.graph;
  if (!g) return [];
  const type = new Map(g.nodes.map((n) => [n.node_id, n.node_type]));
  return g.edges.slice(0, 3).map((e) => ({
    id: e.edge_id,
    src: `${type.get(e.src) ?? ''} ${e.src}`,
    dst: `${type.get(e.dst) ?? ''} ${e.dst}`,
    detail: [e.relationship_type, ...Object.values(e.properties ?? {}).map(String)].join(' · '),
  }));
});

function setSpecName(name: string) {
  if (spec.value) emit('update:specText', JSON.stringify({ ...spec.value, name }, null, 2));
}

// --- enrichment ---
const first = computed(() => props.fileNames[0]);
const enrichmentColumns = computed<string[]>(() => {
  const e = props.enrichment;
  if (!e) return [];
  if (!e.input.header) return e.input.columns ?? [];
  const head = first.value ? lines(props.texts[first.value] ?? '')[0] ?? '' : '';
  return parseLine(head, e.input.delimiter);
});
const enrichmentRowCount = computed(() => {
  const e = props.enrichment;
  if (!e || !first.value) return 0;
  const n = lines(props.texts[first.value] ?? '').length;
  return e.input.header ? Math.max(0, n - 1) : n;
});
function patch(p: Partial<FileEnrichmentSpec>) {
  if (props.enrichment) emit('update:enrichment', { ...props.enrichment, ...p });
}
function toggleColumn(c: string) {
  const e = props.enrichment!;
  patch({ columns: e.columns.includes(c) ? e.columns.filter((x) => x !== c) : [...e.columns, c] });
}
const nodeTypesText = computed({
  get: () => props.enrichment?.match_node_types.join(', ') ?? '',
  set: (v: string) => patch({ match_node_types: v.split(',').map((s) => s.trim()).filter(Boolean) }),
});
const matchProp = computed({
  get: () => (props.enrichment && typeof props.enrichment.match_source === 'object' ? props.enrichment.match_source.name : ''),
  set: (v: string) => patch({ match_source: v.trim() ? { kind: 'prop', name: v.trim() } : 'node_id' }),
});

const valid = computed(() => {
  if (props.role === 'graph') return !preview.value.error && !!preview.value.result?.graph.nodes.length;
  const e = props.enrichment;
  return !!e && !!e.name && !!e.key_column && e.columns.length > 0 && e.match_node_types.length > 0;
});
watch(valid, (v) => emit('update:valid', v), { immediate: true });
</script>

<template>
  <div class="map-grid" data-testid="mapping-step">
    <div class="map-main">
      <div class="detected">
        <span v-if="detected" class="badge" data-testid="wizard-detected">DETECTED</span>
        <strong>{{ detected ?? 'No known layout' }}</strong>
        <span class="hint">{{ fileNames.length }} file{{ fileNames.length === 1 ? '' : 's' }}</span>
        <ul class="chips">
          <li v-for="f in fileNames" :key="f" class="chip mono">{{ f }}</li>
        </ul>
      </div>

      <template v-if="role === 'graph'">
        <table v-if="rows.length" class="map-table" data-testid="wizard-mapping-table">
          <thead>
            <tr><th>Column</th><th>Example</th><th>Becomes</th><th>Conversion</th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="i" :class="{ highlight: r.highlight }">
              <td class="mono">{{ r.columns }}</td>
              <td>{{ r.example }}</td>
              <td>{{ r.becomes }}</td>
              <td class="hint">{{ r.conversion }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="preview.error" class="error-message" data-testid="wizard-mapping-error">{{ preview.error }}</p>
        <details class="spec">
          <summary>Advanced: edit the mapping (JSON)</summary>
          <textarea :value="specText" rows="14" class="form-control mono" data-testid="wizard-spec" @input="emit('update:specText', ($event.target as HTMLTextAreaElement).value)"></textarea>
        </details>
        <div v-if="previewEdges.length" class="edge-preview">
          <h4>Preview of {{ previewEdges.length }} edges</h4>
          <div class="edges">
            <div v-for="e in previewEdges" :key="e.id" class="edge">
              <div>{{ e.src }} → <strong>{{ e.dst }}</strong></div>
              <div class="hint">{{ e.detail }}</div>
            </div>
          </div>
        </div>
        <div class="identity">
          <h4>Identity</h4>
          <ul v-if="identityKeys.length" data-testid="wizard-identity">
            <li v-for="k in identityKeys" :key="k.node_type"><strong>{{ k.node_type }}</strong> → node id, normalized as {{ k.normalize }}</li>
          </ul>
          <p v-else class="hint">
            No node id is normalized as a document, account, phone, e-mail, device, …: the file graph sits beside the others without merging.
            Add <code>"normalize"</code> to an id in the mapping to merge.
          </p>
        </div>
        <div class="form-group">
          <label for="wizard-title">Item title</label>
          <input id="wizard-title" :value="title" class="form-control" data-testid="wizard-title" @input="emit('update:title', ($event.target as HTMLInputElement).value)" />
        </div>
      </template>

      <template v-else-if="enrichment">
        <div class="form-group">
          <label>Key column</label>
          <select :value="enrichment.key_column" class="form-control" data-testid="wizard-key-column" @change="patch({ key_column: ($event.target as HTMLSelectElement).value })">
            <option v-for="c in enrichmentColumns" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>Columns shown in the inspector</label>
          <div class="cols">
            <label v-for="c in enrichmentColumns" :key="c" class="col-opt">
              <input type="checkbox" :checked="enrichment.columns.includes(c)" @change="toggleColumn(c)" />{{ c }}
            </label>
          </div>
        </div>
        <div class="form-group">
          <label>Node types it enriches (comma separated)</label>
          <input v-model="nodeTypesText" class="form-control" data-testid="wizard-node-types" />
        </div>
        <div class="form-group">
          <label>Node property holding the key (empty = the node id)</label>
          <input v-model="matchProp" class="form-control" data-testid="wizard-match-prop" />
        </div>
        <div class="form-group">
          <label>Compare only the first N digits of the node key (a company id against its group prefix: 8)</label>
          <input :value="enrichment.key_digits ?? ''" type="number" min="1" max="20" class="form-control" @input="patch({ key_digits: Number(($event.target as HTMLInputElement).value) || null })" />
        </div>
        <p class="hint">
          Rows join <strong>{{ enrichment.match_node_types.join(', ') || '…' }}</strong> nodes by
          {{ typeof enrichment.match_source === 'object' ? `the property ${enrichment.match_source.name}` : 'the node id' }}
          = <span class="mono">{{ enrichment.key_column }}</span><template v-if="enrichment.key_digits"> (first {{ enrichment.key_digits }} digits)</template>.
        </p>
      </template>
    </div>

    <aside class="map-side">
      <div v-if="role === 'graph' && report" class="card" data-testid="wizard-quality">
        <h4>File quality</h4>
        <p v-if="report.edge_rows" class="note warn-note">
          <strong>{{ counterpartPct }}%</strong> of the transactions without an identified counterpart.
          {{ report.unknown_nodes }} “Unknown” nodes, visible and filterable.
        </p>
        <p v-if="report.rows_discarded" class="note">
          {{ report.rows_discarded }} row{{ report.rows_discarded === 1 ? '' : 's' }} discarded and listed in the report:
          {{ report.discarded.map((d) => `${d.from} ${d.row}: ${d.reason}`).join('; ') }}
        </p>
        <p v-if="report.missing_inputs.length || report.missing_columns.length" class="note warn-note">
          Missing: {{ [...report.missing_inputs, ...report.missing_columns].join(', ') }}
        </p>
        <p v-if="(preview.result?.graph.edges.length ?? 0) > maxEdges" class="note warn-note">Only the first {{ maxEdges }} edges are kept (working graph ceiling).</p>
        <p class="note">{{ report.rows_read }} rows read · {{ preview.result?.graph.nodes.length }} nodes · {{ preview.result?.graph.edges.length }} edges</p>
      </div>
      <div v-else-if="role === 'enrichment'" class="card">
        <h4>File</h4>
        <p class="note">{{ enrichmentRowCount }} rows. Only the case sees them; nothing goes to a context.</p>
      </div>
      <div class="card">
        <h4>Save this mapping as</h4>
        <input v-if="role === 'graph'" :value="spec?.name ?? ''" class="form-control" data-testid="wizard-mapping-name" @input="setSpecName(($event.target as HTMLInputElement).value)" />
        <input v-else-if="enrichment" :value="enrichment.name" class="form-control" @input="patch({ name: ($event.target as HTMLInputElement).value })" />
        <p class="hint">Kept with the file; it goes with the report.</p>
      </div>
      <div class="card custody"><strong>Chain of custody.</strong> The raw files are stored with SHA-256 and never changed.</div>
    </aside>
  </div>
</template>

<style scoped>
.map-grid {
  display: grid;
  grid-template-columns: minmax(0, 2.5fr) minmax(0, 1fr);
  gap: 16px;
}
@media (max-width: 720px) {
  .map-grid {
    grid-template-columns: 1fr;
  }
}
.detected {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 10px;
}
.badge {
  background: var(--bg-secondary);
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  margin-right: 6px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
}
.chip {
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
}
.mono {
  font-family: var(--font-mono, monospace);
}
.map-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.map-table th,
.map-table td {
  text-align: left;
  padding: 5px 6px;
  border-bottom: 1px solid var(--border-color);
  overflow-wrap: anywhere;
}
.map-table tr.highlight {
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
}
.spec {
  margin: 10px 0;
}
.edges {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  font-size: 12px;
}
.edge {
  background: var(--bg-secondary);
  border-radius: 4px;
  padding: 6px 8px;
  overflow-wrap: anywhere;
}
.identity {
  margin-top: 10px;
}
.identity ul {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 13px;
}
h4 {
  margin: 8px 0 6px;
}
.card {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 10px;
}
.card h4 {
  margin: 0 0 6px;
}
.note {
  font-size: 12px;
  margin: 4px 0;
}
.warn-note {
  color: var(--color-warning);
}
.custody {
  font-size: 12px;
}
.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
}
.hint {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
