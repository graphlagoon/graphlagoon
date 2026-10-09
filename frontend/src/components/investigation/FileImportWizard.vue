<script setup lang="ts">
/**
 * "Add file to the case" (T4, F2.5): one modal, five steps. Files are read in the
 * browser for detection and preview (fileMapping.ts, the twin of the server
 * interpreter); "Add to case" uploads them (sha256 on the server) and, for the
 * graph role, has the server generate the file context, exploration and source.
 *
 * shortcut: the mapping is edited as JSON (the table is derived from it), not
 * cell by cell; "save mapping" keeps it, named, on the file row, not in a
 * library of user presets.
 */
import { computed, ref, watch } from 'vue';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import { interpretMapping, lines, matchFile, parseLine, suggestPresets, type MappingSpec } from '@/utils/fileMapping';
import { FILE_MAPPING_PRESETS, QSA_ENRICHMENT } from '@/utils/fileMappingPresets';
import { derivedIdentityKeys, encodingFor, genericSpec, guessDelimiter, mappingRows } from '@/utils/fileImport';
import type { FileContextResult, FileEnrichmentSpec, FileRole, InvestigationFile } from '@/types/investigation';

const props = defineProps<{ investigationId: string }>();
const emit = defineEmits<{ close: []; done: [files: InvestigationFile[], result: FileContextResult | null] }>();

interface Picked {
  file: File;
  buffer: ArrayBuffer;
  sha256: string | null;
}

const STEPS = ['Files', 'Role', 'Map columns', 'Identity', 'Review'];
const step = ref(1);
const picked = ref<Picked[]>([]);
const role = ref<FileRole>('graph');
const detected = ref<string | null>(null);
const specText = ref('');
const enrichment = ref<FileEnrichmentSpec | null>(null);
const title = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
/** Uploaded rows, kept so a retry after a failed generation does not upload twice. */
const uploaded = ref<InvestigationFile[]>([]);

const maxEdges = window.__GRAPH_LAGOON_CONFIG__?.investigation_max_working_edges ?? 50000;

function readBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function sha256(buffer: ArrayBuffer): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // no WebCrypto (plain http): the server hash is the one that counts
  }
}

const spec = computed<MappingSpec | null>(() => {
  try {
    return JSON.parse(specText.value) as MappingSpec;
  } catch {
    return null;
  }
});

/** Decoded with the encoding the spec gives each file (SIMBA is Latin-1). */
const texts = computed<Record<string, string>>(() =>
  Object.fromEntries(
    picked.value.map((p) => [p.file.name, new TextDecoder(encodingFor(spec.value, p.file.name)).decode(p.buffer)]),
  ),
);

const preview = computed(() => {
  if (!spec.value) return { error: 'The mapping is not valid JSON', result: null };
  try {
    return { error: null, result: interpretMapping(spec.value, texts.value) };
  } catch (e) {
    return { error: getErrorMessage(e, 'Invalid mapping'), result: null };
  }
});
const rows = computed(() => (spec.value && !preview.value.error ? mappingRows(spec.value, texts.value) : []));
const identityKeys = computed(() => (spec.value ? derivedIdentityKeys(spec.value) : []));

const enrichmentColumns = computed<string[]>(() => {
  const e = enrichment.value;
  if (!e) return [];
  if (!e.input.header) return e.input.columns ?? [];
  const first = picked.value[0] ? lines(texts.value[picked.value[0].file.name] ?? '')[0] ?? '' : '';
  return parseLine(first, e.input.delimiter);
});
const enrichmentRowCount = computed(() => {
  const e = enrichment.value;
  if (!e || !picked.value[0]) return 0;
  const n = lines(texts.value[picked.value[0].file.name] ?? '').length;
  return e.input.header ? Math.max(0, n - 1) : n;
});
const nodeTypesText = computed({
  get: () => enrichment.value?.match_node_types.join(', ') ?? '',
  set: (v: string) => {
    if (enrichment.value) enrichment.value.match_node_types = v.split(',').map((s) => s.trim()).filter(Boolean);
  },
});
const matchProp = computed({
  get: () => (enrichment.value && typeof enrichment.value.match_source === 'object' ? enrichment.value.match_source.name : ''),
  set: (v: string) => {
    if (enrichment.value) enrichment.value.match_source = v.trim() ? { kind: 'prop', name: v.trim() } : 'node_id';
  },
});

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  error.value = null;
  picked.value = await Promise.all(
    files.map(async (file) => {
      const buffer = await readBuffer(file);
      return { file, buffer, sha256: await sha256(buffer) };
    }),
  );
  uploaded.value = [];
  detect();
}

/** Picks the preset whose headers match, else a generic two-column start. */
function detect() {
  const raw = Object.fromEntries(picked.value.map((p) => [p.file.name, new TextDecoder('latin1').decode(p.buffer)]));
  const found = suggestPresets(raw, FILE_MAPPING_PRESETS);
  detected.value = found[0] ?? null;
  const first = picked.value[0];
  const base = detected.value
    ? FILE_MAPPING_PRESETS[detected.value]
    : first
      ? genericSpec(first.file.name, raw[first.file.name])
      : null;
  specText.value = base ? JSON.stringify(base, null, 2) : '';
  role.value = detected.value === 'qsa_receita' ? 'enrichment' : 'graph';
  enrichment.value =
    detected.value === 'qsa_receita'
      ? structuredClone(QSA_ENRICHMENT)
      : first
        ? genericEnrichment(first.file.name, raw[first.file.name])
        : null;
  title.value = picked.value.length > 1 ? `${detected.value ? base!.name : 'Files'} · ${first!.file.name.split('_')[0]}` : (first?.file.name ?? '');
}

function genericEnrichment(name: string, text: string): FileEnrichmentSpec {
  const delimiter = guessDelimiter(text);
  const header = parseLine(lines(text)[0] ?? '', delimiter);
  return {
    name,
    input: { delimiter, header: true },
    key_column: header[0] ?? '',
    columns: header.slice(1, 11),
    match_node_types: [],
    match_source: 'node_id',
    key_digits: null,
  };
}

function toggleColumn(c: string) {
  const e = enrichment.value!;
  e.columns = e.columns.includes(c) ? e.columns.filter((x) => x !== c) : [...e.columns, c];
}

const skipsMapping = computed(() => role.value === 'attachment');
const canNext = computed(() => {
  if (step.value === 1) return picked.value.length > 0;
  if (step.value === 3 && role.value === 'graph') return !preview.value.error && !!preview.value.result?.graph.nodes.length;
  if (step.value === 3 && role.value === 'enrichment') {
    const e = enrichment.value;
    return !!e && !!e.name && !!e.key_column && e.columns.length > 0 && e.match_node_types.length > 0;
  }
  return true;
});

function next() {
  step.value = skipsMapping.value && step.value === 2 ? 5 : step.value + 1;
}
function back() {
  step.value = skipsMapping.value && step.value === 5 ? 2 : step.value - 1;
}

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
  if (!spec.value) return;
  specText.value = JSON.stringify({ ...spec.value, name }, null, 2);
}

async function submit() {
  busy.value = true;
  error.value = null;
  try {
    for (const p of picked.value.slice(uploaded.value.length)) {
      uploaded.value.push(await api.uploadInvestigationFile(props.investigationId, p.file, role.value));
    }
    let files = [...uploaded.value];
    let result: FileContextResult | null = null;
    if (role.value === 'graph') {
      // The main file (it carries the mapping and the context) is the first input's.
      const first = Object.values(spec.value!.inputs)[0];
      const mainName = first ? matchFile(first, files.map((f) => f.filename)) : null;
      files.sort((a, b) => Number(b.filename === mainName) - Number(a.filename === mainName));
      result = await api.createFileContext(props.investigationId, files[0].id, {
        mapping: spec.value!,
        file_ids: files.slice(1).map((f) => f.id),
        title: title.value.trim() || undefined,
      });
      files = [result.file, ...files.slice(1)];
    } else if (role.value === 'enrichment') {
      files = await Promise.all(
        files.map((f) => api.setInvestigationFileMapping(props.investigationId, f.id, enrichment.value!)),
      );
    }
    emit('done', files, result);
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to add the file');
  } finally {
    busy.value = false;
  }
}

watch(role, () => (error.value = null));
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal wizard" data-testid="file-import-wizard">
      <div class="modal-header">
        <h2>
          Add file to the case
          <small v-if="step > 2" class="hint">role: <strong>{{ role }}</strong></small>
        </h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>

      <ol class="steps">
        <li
          v-for="(s, i) in STEPS"
          :key="s"
          :class="{ done: i + 1 < step, current: i + 1 === step, skipped: skipsMapping && (i === 2 || i === 3) }"
        >
          {{ i + 1 }} {{ s }}
        </li>
      </ol>

      <div class="wizard-body">
        <!-- 1 · Files -->
        <section v-if="step === 1">
          <p class="hint">
            Pick every file of the layout at once (a SIMBA delivery is 5 TAB-separated files).
          </p>
          <input type="file" multiple data-testid="wizard-files" @change="onFiles" />
          <ul class="chips">
            <li v-for="p in picked" :key="p.file.name" class="chip">
              {{ p.file.name }} · {{ p.file.size }} B<template v-if="p.sha256"> · {{ p.sha256.slice(0, 8) }}…</template>
            </li>
          </ul>
        </section>

        <!-- 2 · Role -->
        <section v-else-if="step === 2" class="roles">
          <label class="role-opt">
            <input v-model="role" type="radio" value="graph" data-testid="wizard-role-graph" />
            <span><strong>Graph</strong><br /><span class="hint">becomes a file context and an exploration of the case</span></span>
          </label>
          <label class="role-opt">
            <input v-model="role" type="radio" value="enrichment" data-testid="wizard-role-enrichment" />
            <span><strong>Enrichment</strong><br /><span class="hint">joined by key to the case's nodes, in the inspector</span></span>
          </label>
          <label class="role-opt">
            <input v-model="role" type="radio" value="attachment" data-testid="wizard-role-attachment" />
            <span><strong>Attachment</strong><br /><span class="hint">kept with its hash, never read into the graph</span></span>
          </label>
        </section>

        <!-- 3 · Map columns -->
        <div v-else-if="step === 3" class="map-grid">
          <div class="map-main">
            <div class="detected">
              <span v-if="detected" class="badge" data-testid="wizard-detected">DETECTED</span>
              <strong>{{ detected ? FILE_MAPPING_PRESETS[detected].name : 'No known layout' }}</strong>
              <span class="hint">{{ picked.length }} file{{ picked.length === 1 ? '' : 's' }}</span>
              <ul class="chips">
                <li v-for="p in picked" :key="p.file.name" class="chip mono">
                  {{ p.file.name }}<template v-if="p.sha256"> · {{ p.sha256.slice(0, 5) }}…</template>
                </li>
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
                <summary>Edit the mapping (JSON)</summary>
                <textarea v-model="specText" rows="14" class="form-control mono" data-testid="wizard-spec"></textarea>
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
            </template>

            <template v-else-if="enrichment">
              <div class="form-group">
                <label>Key column</label>
                <select v-model="enrichment.key_column" class="form-control" data-testid="wizard-key-column">
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
                <label>Compare only the first N digits of the node key (CNPJ → CNPJ básico: 8)</label>
                <input v-model.number="enrichment.key_digits" type="number" min="1" max="20" class="form-control" />
              </div>
            </template>
          </div>

          <aside class="map-side">
            <div v-if="role === 'graph' && report" class="card" data-testid="wizard-quality">
              <h4>File quality</h4>
              <p v-if="report.edge_rows" class="note warn-note">
                <strong>{{ counterpartPct }}%</strong> of the transactions without an identified counterpart.
                {{ report.unknown_nodes }} “Desconhecido” nodes, visible and filterable.
              </p>
              <p v-if="report.rows_discarded" class="note">
                {{ report.rows_discarded }} row{{ report.rows_discarded === 1 ? '' : 's' }} discarded and listed in the report:
                {{ report.discarded.map((d) => `${d.from} ${d.row}: ${d.reason}`).join('; ') }}
              </p>
              <p v-if="report.missing_inputs.length || report.missing_columns.length" class="note warn-note">
                Missing: {{ [...report.missing_inputs, ...report.missing_columns].join(', ') }}
              </p>
              <p v-if="(preview.result?.graph.edges.length ?? 0) > maxEdges" class="note warn-note">
                Only the first {{ maxEdges }} edges are kept (working graph ceiling).
              </p>
              <p class="note">{{ report.rows_read }} rows read · {{ preview.result?.graph.nodes.length }} nodes · {{ preview.result?.graph.edges.length }} edges</p>
            </div>
            <div v-else-if="role === 'enrichment'" class="card">
              <h4>File</h4>
              <p class="note">{{ enrichmentRowCount }} rows. Only the case sees them; nothing goes to a context.</p>
            </div>
            <div class="card">
              <h4>Save this mapping as</h4>
              <input
                v-if="role === 'graph'"
                :value="spec?.name ?? ''"
                class="form-control"
                data-testid="wizard-mapping-name"
                @input="setSpecName(($event.target as HTMLInputElement).value)"
              />
              <input v-else-if="enrichment" v-model="enrichment.name" class="form-control" />
              <p class="hint">Kept with the file; it goes with the report.</p>
            </div>
            <div class="card custody">
              <strong>Chain of custody.</strong> The raw files are stored with SHA-256 and never changed.
            </div>
          </aside>
        </div>

        <!-- 4 · Identity -->
        <section v-else-if="step === 4">
          <template v-if="role === 'graph'">
            <p class="hint">These node types merge with the other sources of the case by their key:</p>
            <ul v-if="identityKeys.length" data-testid="wizard-identity">
              <li v-for="k in identityKeys" :key="k.node_type">
                <strong>{{ k.node_type }}</strong> → node id, normalized as {{ k.normalize }}
              </li>
            </ul>
            <p v-else class="hint">
              No node id is normalized as a document, account, phone or e-mail: the file graph sits beside the
              others without merging. Add <code>"normalize"</code> to an id in the mapping to merge.
            </p>
          </template>
          <p v-else-if="enrichment">
            Rows join <strong>{{ enrichment.match_node_types.join(', ') }}</strong> nodes by
            {{ typeof enrichment.match_source === 'object' ? `the property ${enrichment.match_source.name}` : 'the node id' }}
            = <span class="mono">{{ enrichment.key_column }}</span>
            <template v-if="enrichment.key_digits"> (first {{ enrichment.key_digits }} digits)</template>.
          </p>
        </section>

        <!-- 5 · Review -->
        <section v-else>
          <ul class="review">
            <li><strong>{{ picked.length }}</strong> file{{ picked.length === 1 ? '' : 's' }} as <strong>{{ role }}</strong></li>
            <li v-if="role === 'graph'">
              {{ preview.result?.graph.nodes.length }} nodes and {{ preview.result?.graph.edges.length }} edges with
              “{{ spec?.name }}”
            </li>
            <li v-if="role === 'enrichment'">Mapping “{{ enrichment?.name }}”</li>
          </ul>
          <div v-if="role === 'graph'" class="form-group">
            <label for="wizard-title">Exploration title</label>
            <input id="wizard-title" v-model="title" class="form-control" data-testid="wizard-title" />
          </div>
        </section>

        <p v-if="error" class="error-message" data-testid="wizard-error">{{ error }}</p>
      </div>

      <div class="modal-footer">
        <button v-if="step > 1" type="button" class="btn btn-outline" @click="back">Back</button>
        <button v-if="step < 5" type="button" class="btn btn-primary" :disabled="!canNext" data-testid="wizard-next" @click="next">
          Next: {{ STEPS[skipsMapping && step === 2 ? 4 : step].toLowerCase() }}
        </button>
        <button v-else type="button" class="btn btn-primary" :disabled="busy" data-testid="wizard-submit" @click="submit">
          {{ busy ? 'Adding…' : 'Add to case' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard {
  max-width: 1100px;
  width: 95vw;
}
.wizard-body {
  max-height: 68vh;
  overflow: auto;
}
.steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
}
.steps li {
  padding: 4px 12px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-size: 12px;
}
.steps li.done {
  background: var(--bg-secondary);
}
.steps li.current {
  background: var(--color-primary);
  color: #fff;
  font-weight: 600;
}
.steps li.skipped {
  opacity: 0.4;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  padding: 0;
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
.roles {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.role-opt {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
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
