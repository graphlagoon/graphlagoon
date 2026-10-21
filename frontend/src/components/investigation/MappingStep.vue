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
import { NORMALIZER_LABELS } from '@/utils/identityKeys';
import HelpTip from '@/components/admin/HelpTip.vue';
import type { EnrichmentEdgeKey, FileEnrichmentSpec } from '@/types/investigation';
import type { IdentityNormalize } from '@/types/graph';

const props = defineProps<{
  role: 'graph' | 'enrichment';
  /** Decoded text per file name. */
  texts: Record<string, string>;
  fileNames: string[];
  detected: string | null;
  specText: string;
  enrichment: FileEnrichmentSpec | null;
  title: string;
  /** Where an enrichment file's rows go, shown beside it (the case by default). */
  scopeNote?: string;
  /** Used for an exploration's layer (BYOD-2): no "save as" or chain-of-custody cards (the
   * layer keeps parsed rows, not the file). */
  forLayer?: boolean;
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
const splitList = (v: string) => v.split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
const nodeTypesText = computed({
  get: () => (props.enrichment?.match_node_types ?? []).filter((t) => t !== '*').join(', '),
  set: (v: string) => patch({ match_node_types: splitList(v) }),
});
const edgeTypesText = computed({
  get: () => (props.enrichment?.match_edge_types ?? []).filter((t) => t !== '*').join(', '),
  set: (v: string) => patch({ match_edge_types: splitList(v) }),
});
const target = computed(() => props.enrichment?.target ?? 'nodes');
const edgeBy = computed(() => props.enrichment?.edge_key?.by ?? 'edge_id');
function setTarget(t: 'nodes' | 'edges') {
  patch({ target: t, edge_key: t === 'edges' ? props.enrichment?.edge_key ?? { by: 'edge_id' } : null });
}
function patchEdgeKey(p: Partial<EnrichmentEdgeKey>) {
  const current: EnrichmentEdgeKey = props.enrichment?.edge_key ?? { by: 'edge_id' };
  const next = { ...current, ...p };
  if (next.by === 'endpoints') {
    next.source_column ??= enrichmentColumns.value[0] ?? null;
    next.target_column ??= enrichmentColumns.value[1] ?? null;
  }
  patch({ edge_key: next });
}
/** Normalizers a file key can use (a regex needs an identity key with a pattern). */
const normalizers = (Object.keys(NORMALIZER_LABELS) as IdentityNormalize[]).filter((n) => n !== 'regex');
/** Columns that are the key, so they are not offered as properties. */
const keyColumns = computed(() => {
  const e = props.enrichment;
  if (!e) return new Set<string>();
  if (e.target === 'edges' && e.edge_key?.by === 'endpoints') {
    return new Set([e.edge_key.source_column, e.edge_key.target_column, e.edge_key.type_column].filter((c): c is string => !!c));
  }
  return new Set(e.key_column ? [e.key_column] : []);
});
const matchProp = computed({
  get: () => (props.enrichment && typeof props.enrichment.match_source === 'object' ? props.enrichment.match_source.name : ''),
  set: (v: string) => patch({ match_source: v.trim() ? { kind: 'prop', name: v.trim() } : 'node_id' }),
});

const valid = computed(() => {
  if (props.role === 'graph') return !preview.value.error && !!preview.value.result?.graph.nodes.length;
  const e = props.enrichment;
  if (!e || !e.name || e.columns.length === 0) return false;
  if (e.target === 'edges' && e.edge_key?.by === 'endpoints') return !!e.edge_key.source_column && !!e.edge_key.target_column;
  return !!e.key_column;
});
watch(valid, (v) => emit('update:valid', v), { immediate: true });
</script>

<template>
  <div class="map-grid" data-testid="mapping-step">
    <div class="map-main">
      <div class="detected">
        <span v-if="detected" class="badge" data-testid="wizard-detected">DETECTED</span>
        <strong v-if="role === 'graph' || detected">{{ detected ?? 'No known layout' }}</strong>
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
          <h4>Identity
            <HelpTip title="When a node from the file meets one already there" testid="mapping-identity">
              <span>Two nodes are one when they have the same type and id, after <code>normalize</code>.</span>
              <span>Normalize an id as a document, account, phone or e-mail to merge the file's nodes with the same entities from other sources.</span>
            </HelpTip>
          </h4>
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
          <label>The rows add properties to
            <HelpTip title="Nodes or edges" testid="enrich-target">
              <span><strong>Nodes</strong>: each row finds one node by its key and adds the other columns as its properties (a risk list by account, a segment by customer).</span>
              <span><strong>Edges</strong>: each row finds one edge, by its id or by the two nodes it joins (a channel per transfer).</span>
              <span>Nothing new is drawn: the file only adds properties to what is already on the canvas.</span>
            </HelpTip>
          </label>
          <div class="cols" role="radiogroup">
            <label class="col-opt"><input type="radio" :checked="target === 'nodes'" data-testid="wizard-target-nodes" @change="setTarget('nodes')" />nodes</label>
            <label class="col-opt"><input type="radio" :checked="target === 'edges'" data-testid="wizard-target-edges" @change="setTarget('edges')" />edges</label>
          </div>
        </div>
        <template v-if="target === 'edges'">
          <div class="form-group">
            <label>Find each edge by
              <HelpTip title="Finding an edge" testid="enrich-edge-key">
                <span><strong>Edge id</strong>: one column holds the id the context gives the edge.</span>
                <span><strong>Two endpoints</strong>: a source and a target column hold node ids. A row matches the edge in either direction, so <code>a → b</code> finds the edge <code>b → a</code> too.</span>
                <span>With a <strong>type column</strong>, only an edge of that type matches (a <code>TRANSFER</code> row never lands on a <code>KNOWS</code> edge between the same nodes).</span>
              </HelpTip>
            </label>
            <select :value="edgeBy" class="form-control" data-testid="wizard-edge-by" @change="patchEdgeKey({ by: ($event.target as HTMLSelectElement).value as EnrichmentEdgeKey['by'] })">
              <option value="edge_id">its edge id (one column)</option>
              <option value="endpoints">its two endpoints (source and target node ids, either direction)</option>
            </select>
          </div>
          <div v-if="edgeBy === 'endpoints'" class="form-row">
            <label>Source column
              <select :value="enrichment.edge_key?.source_column ?? ''" class="form-control" data-testid="wizard-edge-source" @change="patchEdgeKey({ source_column: ($event.target as HTMLSelectElement).value })">
                <option v-for="c in enrichmentColumns" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
            <label>Target column
              <select :value="enrichment.edge_key?.target_column ?? ''" class="form-control" data-testid="wizard-edge-target" @change="patchEdgeKey({ target_column: ($event.target as HTMLSelectElement).value })">
                <option v-for="c in enrichmentColumns" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
            <label>Edge type column (optional)
              <select :value="enrichment.edge_key?.type_column ?? ''" class="form-control" @change="patchEdgeKey({ type_column: ($event.target as HTMLSelectElement).value || null })">
                <option value="">any type</option>
                <option v-for="c in enrichmentColumns" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
          </div>
        </template>
        <div v-if="target === 'nodes' || edgeBy === 'edge_id'" class="form-group">
          <label>Key column
            <HelpTip title="Key column" testid="enrich-key">
              <span>The column whose value names the node (or edge) a row belongs to: a node id, or the value of the property set below.</span>
              <span>When several rows share a key, the first one sets the properties.</span>
            </HelpTip>
          </label>
          <select :value="enrichment.key_column ?? ''" class="form-control" data-testid="wizard-key-column" @change="patch({ key_column: ($event.target as HTMLSelectElement).value })">
            <option v-for="c in enrichmentColumns" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>Columns added as properties
            <HelpTip title="What becomes a property" testid="enrich-columns">
              <span>Each ticked column becomes a property with the column's name.</span>
              <span>A cell that reads as a plain number becomes a number (<code>2019</code>, <code>-5.5</code>); one with leading zeros stays text (<code>00042</code>). An empty cell sets nothing.</span>
            </HelpTip>
          </label>
          <div class="cols">
            <label v-for="c in enrichmentColumns.filter((x) => !keyColumns.has(x))" :key="c" class="col-opt">
              <input type="checkbox" :checked="enrichment.columns.includes(c)" @change="toggleColumn(c)" />{{ c }}
            </label>
          </div>
        </div>
        <div v-if="target === 'nodes'" class="form-group">
          <label>Node types it enriches (comma separated; empty = every type)
            <HelpTip title="Node types" testid="enrich-node-types">
              <span>Exact type names as the canvas shows them (<code>Account, Company</code>). Leave it empty to try every node.</span>
              <span>Useful when two types share ids, or when only one type should get the columns.</span>
            </HelpTip>
          </label>
          <input v-model="nodeTypesText" class="form-control" data-testid="wizard-node-types" />
        </div>
        <div v-else class="form-group">
          <label>Edge types it enriches (comma separated; empty = every type)
            <HelpTip title="Edge types" testid="enrich-edge-types">
              <span>Exact relationship types (<code>TRANSFER, PAYMENT</code>). Leave it empty to try every edge.</span>
            </HelpTip>
          </label>
          <input v-model="edgeTypesText" class="form-control" data-testid="wizard-edge-types" />
        </div>
        <div v-if="target === 'nodes'" class="form-group">
          <label>Node property holding the key (empty = the node id)
            <HelpTip title="Matching by a property" testid="enrich-match-prop">
              <span>By default the key is compared with the node id. Name a property (<code>registry_id</code>, <code>email</code>) to compare with its value instead.</span>
              <span>In a case, a node merged from several sources by an identity key also matches its entity value (a document, a phone).</span>
            </HelpTip>
          </label>
          <input v-model="matchProp" class="form-control" data-testid="wizard-match-prop" />
        </div>
        <div class="form-row">
          <label>Normalize keys on both sides
            <HelpTip title="Normalizing keys" testid="enrich-normalize">
              <span>Applied to the file's key and to the node's value before comparing them, so different spellings of the same value meet.</span>
              <ul>
                <li><strong>Digits only</strong>: <code>123.456.789-01</code> = <code>12345678901</code></li>
                <li><strong>Phone</strong>: <code>+1 (415) 555-0100</code> = <code>14155550100</code></li>
                <li><strong>E-mail</strong> / <strong>Lowercase</strong>: case is ignored</li>
              </ul>
              <span>Nothing matches? This is the first thing to check.</span>
            </HelpTip>
            <select :value="enrichment.normalize ?? 'none'" class="form-control" data-testid="wizard-normalize" @change="patch({ normalize: ($event.target as HTMLSelectElement).value as IdentityNormalize })">
              <option v-for="n in normalizers" :key="n" :value="n">{{ NORMALIZER_LABELS[n] }}</option>
            </select>
          </label>
          <label>Compare only the first N digits (a company id against its group prefix: 8)
            <HelpTip title="First N digits" testid="enrich-digits">
              <span>Keeps only the first N digits of both keys. A row keyed by a group's 8-digit prefix then reaches every company whose id starts with it.</span>
            </HelpTip>
            <input :value="enrichment.key_digits ?? ''" type="number" min="1" max="20" class="form-control" @input="patch({ key_digits: Number(($event.target as HTMLInputElement).value) || null })" />
          </label>
        </div>
        <label class="col-opt overwrite">
          <input type="checkbox" :checked="!!enrichment.overwrite" data-testid="wizard-overwrite" @change="patch({ overwrite: ($event.target as HTMLInputElement).checked })" />
          Replace values the {{ target === 'nodes' ? 'nodes' : 'edges' }} already have (otherwise theirs win and the file's show as conflicts)
          <HelpTip title="Which value wins" testid="enrich-overwrite">
            <span>By default a value already on the node wins: the file only fills properties that are missing or empty.</span>
            <span>In a case, the file's value that lost is kept as a conflict, visible in the inspector.</span>
            <span>Tick it when the file is the better source: then its values replace the ones there.</span>
          </HelpTip>
        </label>
        <p class="hint" data-testid="wizard-enrichment-summary">
          <template v-if="target === 'nodes'">
            Rows join <strong>{{ nodeTypesText || 'every' }}</strong> node{{ nodeTypesText ? 's' : ' type' }} by
            {{ typeof enrichment.match_source === 'object' ? `the property ${enrichment.match_source.name}` : 'the node id' }}
            = <span class="mono">{{ enrichment.key_column }}</span>
          </template>
          <template v-else-if="edgeBy === 'endpoints'">
            Rows join <strong>{{ edgeTypesText || 'every' }}</strong> edge{{ edgeTypesText ? 's' : ' type' }} whose endpoints are
            <span class="mono">{{ enrichment.edge_key?.source_column }}</span> and <span class="mono">{{ enrichment.edge_key?.target_column }}</span>
          </template>
          <template v-else>
            Rows join <strong>{{ edgeTypesText || 'every' }}</strong> edge{{ edgeTypesText ? 's' : ' type' }} by the edge id = <span class="mono">{{ enrichment.key_column }}</span>
          </template>
          <template v-if="enrichment.normalize && enrichment.normalize !== 'none'">, both normalized as {{ enrichment.normalize }}</template>
          <template v-if="enrichment.key_digits"> (first {{ enrichment.key_digits }} digits)</template>.
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
        <p class="note">{{ enrichmentRowCount }} rows. {{ scopeNote ?? 'Only the case sees them; nothing goes to a context.' }}</p>
      </div>
      <div v-if="!forLayer" class="card">
        <h4>Save this mapping as</h4>
        <input v-if="role === 'graph'" :value="spec?.name ?? ''" class="form-control" data-testid="wizard-mapping-name" @input="setSpecName(($event.target as HTMLInputElement).value)" />
        <input v-else-if="enrichment" :value="enrichment.name" class="form-control" @input="patch({ name: ($event.target as HTMLInputElement).value })" />
        <p class="hint">Kept with the file; it goes with the report.</p>
      </div>
      <div v-if="!forLayer" class="card custody"><strong>Chain of custody.</strong> The raw files are stored with SHA-256 and never changed.</div>
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
.form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
  margin-bottom: 10px;
  font-size: 12px;
}
.overwrite {
  display: block;
  margin: 4px 0 8px;
  font-size: 12px;
}
.hint {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
