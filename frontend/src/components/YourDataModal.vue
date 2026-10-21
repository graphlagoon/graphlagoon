<script setup lang="ts">
/**
 * "Your data" on an exploration (BYOD-2): enrich the nodes or edges on the canvas from a
 * file, add nodes and edges from a mapped file or JSON, or draw them by hand. Everything
 * goes to the exploration's user layer: saved beside it, re-applied after every query,
 * never written to the context. Reuses the case wizard's mapping step.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/services/api';
import { useGraphStore } from '@/stores/graph';
import { useSketch } from '@/composables/useSketch';
import { useToast } from '@/composables/useToast';
import MappingStep from '@/components/investigation/MappingStep.vue';
import HelpTip from '@/components/admin/HelpTip.vue';
import { guideUrl } from '@/utils/docsLinks';
import { decoderLabel, encodingFor, genericSpec, guessDelimiter } from '@/utils/fileImport';
import { interpretMapping, lines, parseLine, suggestPresets, type MappingSpec } from '@/utils/fileMapping';
import { fileEnrichmentRows, matchFileRows, tableContentOf } from '@/utils/enrichment';
import {
  firstRows,
  importEdgeId,
  newOverlayId,
  overlayFromSnapshot,
  parseSnapshotJson,
  type OverlayEdge,
  type OverlayNode,
} from '@/utils/graphOverlay';
import { getErrorMessage } from '@/utils/errorMessage';
import type { FileEnrichmentSpec } from '@/types/investigation';
import type { GraphSnapshot } from '@/types/graph';

const emit = defineEmits<{ close: [] }>();

const graph = useGraphStore();
const sketch = useSketch();
const toast = useToast();

type Tab = 'enrich' | 'graph' | 'draw';
const tab = ref<Tab>('enrich');
const busy = ref(false);
const error = ref<string | null>(null);
const maxBytes = window.__GRAPH_LAGOON_CONFIG__?.exploration_overlay_max_bytes ?? 5 * 1024 * 1024;
const maxEdges = window.__GRAPH_LAGOON_CONFIG__?.investigation_max_working_edges ?? 50000;
const SCOPE = 'Saved with this exploration, beside it: the context never sees it.';

// --- the file (one per tab) -------------------------------------------------
interface Picked {
  name: string;
  buffer: ArrayBuffer;
}
const picked = ref<Picked | null>(null);

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  error.value = null;
  if (!file) return;
  if (file.size > maxBytes * 4) {
    error.value = `The file is ${Math.round(file.size / 1024)} KB; an exploration keeps about ${Math.round(maxBytes / 1024)} KB of your data. Keep only the rows and columns you need.`;
    return;
  }
  picked.value = { name: file.name, buffer: await file.arrayBuffer() };
  if (tab.value === 'enrich') startEnrichment();
  else startGraph();
}

watch(tab, () => {
  picked.value = null;
  error.value = null;
});

// --- enrich -------------------------------------------------------------------
const enrichment = ref<FileEnrichmentSpec | null>(null);
const enrichValid = ref(false);
const enrichText = computed(() =>
  picked.value && enrichment.value ? new TextDecoder(decoderLabel(enrichment.value.input.encoding)).decode(picked.value.buffer) : '',
);

/** The column whose values match the most node ids: a sensible first key. */
function likelyKey(header: string[], text: string, delimiter: string): string {
  const ids = new Set(graph.nodes.map((n) => n.node_id));
  const sample = lines(text).slice(1, 200).map((l) => parseLine(l, delimiter));
  let best = header[0] ?? '';
  let score = 0;
  header.forEach((col, i) => {
    const hits = sample.filter((row) => ids.has((row[i] ?? '').trim())).length;
    if (hits > score) [best, score] = [col, hits];
  });
  return best;
}

function startEnrichment() {
  const raw = new TextDecoder('utf-8').decode(picked.value!.buffer);
  const delimiter = guessDelimiter(raw);
  const header = parseLine(lines(raw)[0] ?? '', delimiter);
  const key = likelyKey(header, raw, delimiter);
  enrichment.value = {
    name: picked.value!.name.replace(/\.[^.]+$/, ''),
    input: { delimiter, header: true },
    target: 'nodes',
    key_column: key,
    columns: header.filter((c) => c !== key).slice(0, 20),
    match_node_types: [],
    match_source: 'node_id',
    normalize: 'none',
    overwrite: false,
  };
}

const enrichRows = computed(() => {
  if (!enrichment.value || !enrichText.value || !enrichValid.value) return null;
  try {
    return fileEnrichmentRows(tableContentOf(enrichText.value), enrichment.value);
  } catch {
    return null;
  }
});

/** What applying would do on the graph as the context gave it. */
const enrichPreview = computed(() => {
  const spec = enrichment.value;
  const rows = enrichRows.value;
  if (!spec || !rows) return null;
  const base = graph.baseGraph();
  const matches = matchFileRows(base, spec, rows);
  const onNodes = (spec.target ?? 'nodes') === 'nodes';
  const pool = onNodes ? base.nodes.map((n) => [n.node_id, n.properties] as const) : base.edges.map((e) => [e.edge_id, e.properties] as const);
  const props = new Map(pool);
  let kept = 0;
  for (const [id, row] of matches) {
    for (const [k, v] of Object.entries(row)) {
      const old = props.get(id)?.[k];
      if (v !== null && v !== undefined && old !== null && old !== undefined && old !== v) kept++;
    }
  }
  const allow = onNodes ? graph.propertyVisibility.nodeProperties : graph.propertyVisibility.edgeProperties;
  return {
    matched: matches.size,
    total: pool.length,
    what: onNodes ? 'nodes' : 'edges',
    kept,
    hidden: allow ? spec.columns.filter((c) => !allow.includes(c)) : [],
    keys: Object.keys(rows).length,
  };
});

async function applyEnrichment() {
  const spec = enrichment.value;
  const rows = enrichRows.value;
  if (!spec || !rows || !picked.value) return;
  // JSON copy: the spec comes from a form (Vue proxies), the layer is plain JSON.
  const entry = { id: newOverlayId(), filename: picked.value.name, spec: JSON.parse(JSON.stringify(spec)) as FileEnrichmentSpec, rows: firstRows(rows), row_count: Object.keys(rows).length };
  if (JSON.stringify(entry).length > maxBytes) {
    error.value = 'This file is too large for an exploration layer. Keep only the columns you need, or the rows whose key is on the canvas.';
    return;
  }
  await run(() => graph.setOverlayEnrichment(entry), `${enrichPreview.value?.matched ?? 0} ${enrichPreview.value?.what ?? 'nodes'} enriched from ${picked.value.name}`);
  picked.value = null;
}

// --- nodes and edges from a file ------------------------------------------------
const templates = ref<Record<string, MappingSpec>>({});
onMounted(async () => {
  try {
    for (const doc of await api.getOrgLibrary('mapping')) {
      const m = JSON.parse(doc.body) as { as?: string; spec?: MappingSpec };
      if (m.as === 'graph' && m.spec) templates.value[doc.slug] = { ...m.spec, name: m.spec.name ?? doc.title };
    }
  } catch {
    /* no library: the generic start still works */
  }
});
const specText = ref('');
const detected = ref<string | null>(null);
const graphValid = ref(false);
const graphTitle = ref('');
const json = ref<GraphSnapshot | null>(null);
const isJson = computed(() => !!picked.value && (/\.json$/i.test(picked.value.name) || /^\s*[{[]/.test(new TextDecoder().decode(picked.value.buffer.slice(0, 64)))));
const graphSpec = computed<MappingSpec | null>(() => {
  try {
    return JSON.parse(specText.value) as MappingSpec;
  } catch {
    return null;
  }
});
const graphTexts = computed<Record<string, string>>(() =>
  picked.value && !isJson.value ? { [picked.value.name]: new TextDecoder(encodingFor(graphSpec.value, picked.value.name)).decode(picked.value.buffer) } : {},
);

function startGraph() {
  const p = picked.value!;
  graphTitle.value = p.name;
  json.value = null;
  if (isJson.value) {
    const parsed = parseSnapshotJson(new TextDecoder().decode(p.buffer));
    if (parsed.error) error.value = parsed.error;
    json.value = parsed.snapshot;
    return;
  }
  const raw = { [p.name]: new TextDecoder('latin1').decode(p.buffer) };
  detected.value = suggestPresets(raw, templates.value)[0] ?? null;
  const base = detected.value ? templates.value[detected.value] : genericSpec(p.name, raw[p.name]);
  specText.value = JSON.stringify(base, null, 2);
}

/** The import as layer nodes and edges, and how it meets the canvas. */
const graphImport = computed(() => {
  if (!picked.value) return null;
  const importId = 'pending';
  let add: { nodes: OverlayNode[]; edges: OverlayEdge[] };
  if (isJson.value) {
    if (!json.value) return null;
    add = overlayFromSnapshot(importId, json.value);
  } else {
    if (!graphSpec.value || !graphValid.value) return null;
    try {
      const { graph: g } = interpretMapping(graphSpec.value, graphTexts.value);
      add = {
        nodes: g.nodes.map((n) => ({ id: n.node_id, type: n.node_type, properties: { ...(n.properties ?? {}) } })),
        edges: g.edges.slice(0, maxEdges).map((e) => ({
          id: importEdgeId(importId, e.edge_id),
          source: e.src,
          target: e.dst,
          type: e.relationship_type,
          properties: { ...(e.properties ?? {}) },
        })),
      };
    } catch {
      return null;
    }
  }
  const onCanvas = new Set(graph.baseGraph().nodes.map((n) => n.node_id));
  return {
    add,
    existing: add.nodes.filter((n) => onCanvas.has(n.id)).length,
    reaching: add.edges.filter((e) => onCanvas.has(e.source) || onCanvas.has(e.target)).length,
  };
});

async function applyGraph() {
  const g = graphImport.value;
  if (!g || !picked.value) return;
  const id = newOverlayId();
  const rename = (e: OverlayEdge) => ({ ...e, id: e.id.replace(/^import:pending:/, `import:${id}:`) });
  const add = { nodes: g.add.nodes, edges: g.add.edges.map(rename) };
  if (JSON.stringify(add).length > maxBytes) {
    error.value = 'This graph is too large for an exploration layer. Put it in a case instead (Investigations → Add file), where files of any size are kept.';
    return;
  }
  await run(
    () => graph.addOverlayImport({ id, filename: picked.value!.name, title: graphTitle.value || picked.value!.name, kind: isJson.value ? 'json' : 'mapping' }, add),
    `${add.nodes.length} nodes and ${add.edges.length} edges added from ${picked.value.name}`,
  );
  picked.value = null;
}

// --- what is in the layer ----------------------------------------------------------
const layer = computed(() => {
  void graph.overlayVersion;
  const o = graph.overlay;
  const imported = new Set(o?.imports.flatMap((i) => i.node_ids) ?? []);
  return {
    enrichments: o?.enrichments ?? [],
    imports: o?.imports ?? [],
    drawnNodes: (o?.nodes ?? []).filter((n) => !imported.has(n.id)).length,
    drawnEdges: (o?.edges ?? []).filter((e) => e.id.startsWith('sketch:')).length,
  };
});

async function removeDrawn() {
  const o = graph.overlay;
  if (!o) return;
  const imported = new Set(o.imports.flatMap((i) => i.node_ids));
  await run(
    () => graph.removeOverlayElements(o.nodes.filter((n) => !imported.has(n.id)).map((n) => n.id), o.edges.filter((e) => e.id.startsWith('sketch:')).map((e) => e.id)),
    'Drawn nodes and edges removed',
  );
}

async function run(action: () => Promise<string | null>, done: string) {
  busy.value = true;
  error.value = null;
  try {
    const failed = await action();
    if (failed) toast.warning(`On the canvas, but not saved: ${failed}`, 6000);
    else toast.success(graph.currentExploration ? done : `${done}. Save the exploration to keep it.`);
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to apply it');
  } finally {
    busy.value = false;
  }
}

function drawNode() {
  emit('close');
  sketch.openNodeDialog(null);
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal your-data" data-testid="your-data-modal">
        <div class="modal-header">
          <h2>Your data</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
        </div>
        <p class="hint">
          Add your own data to this graph. It is saved with the exploration, beside the context's data, and comes back
          after every query and expand. Others who open the exploration see it; the context does not change.
          <a :href="guideUrl('bring-your-own-data')" target="_blank" rel="noopener" data-testid="your-data-guide">Full guide</a>
        </p>

        <div class="tabs" role="tablist">
          <button role="tab" :class="{ active: tab === 'enrich' }" data-testid="your-data-tab-enrich" @click="tab = 'enrich'">Enrich from a file</button>
          <button role="tab" :class="{ active: tab === 'graph' }" data-testid="your-data-tab-graph" @click="tab = 'graph'">Nodes and edges from a file</button>
          <button role="tab" :class="{ active: tab === 'draw' }" data-testid="your-data-tab-draw" @click="tab = 'draw'">Draw</button>
        </div>

        <section v-if="tab === 'enrich'">
          <p class="hint">
            A CSV with a key column: each row adds its columns as properties to the node (or edge) with that key. Values already on a node win unless you tick "Replace".
            <HelpTip title="Enrich from a file" testid="your-data-enrich">
              <span>Example: <code>account,risk</code> then <code>4471-0,high</code> sets <code>risk = high</code> on the node <code>4471-0</code>.</span>
              <span>The key column is guessed from the ids on the canvas; the line under the settings says how many nodes match before you apply.</span>
              <span>Nodes that arrive later (another query, an expand) get their row too.</span>
              <a :href="guideUrl('bring-your-own-data', 'enrich-nodes-or-edges-from-a-file')" target="_blank" rel="noopener">More in the guide</a>
            </HelpTip>
          </p>
          <input type="file" accept=".csv,.tsv,.txt" data-testid="your-data-enrich-file" @change="onFile" />
          <template v-if="picked && enrichment">
            <MappingStep
              role="enrichment"
              :texts="{ [picked.name]: enrichText }"
              :file-names="[picked.name]"
              :detected="null"
              spec-text=""
              :enrichment="enrichment"
              title=""
              :scope-note="SCOPE"
              for-layer
              @update:enrichment="enrichment = $event"
              @update:valid="enrichValid = $event"
            />
            <p v-if="enrichPreview" class="preview" data-testid="your-data-enrich-preview">
              <strong>{{ enrichPreview.matched }} of {{ enrichPreview.total }} {{ enrichPreview.what }}</strong> match a row
              ({{ enrichPreview.keys }} keys in the file).
              <template v-if="enrichPreview.kept">
                {{ enrichPreview.kept }} value{{ enrichPreview.kept === 1 ? ' is' : 's are' }} already set{{ enrichment.overwrite ? ' and will be replaced' : ' and stay as they are' }}.
              </template>
              <template v-if="enrichPreview.hidden.length"> Hidden by your property visibility: {{ enrichPreview.hidden.join(', ') }}.</template>
            </p>
            <p v-if="enrichPreview && !enrichPreview.matched" class="warn">
              Nothing matches. Check the key column, the node types, and "Normalize keys" (a document with dots against digits only).
            </p>
            <div class="actions">
              <button class="btn btn-primary" :disabled="busy || !enrichPreview?.matched" data-testid="your-data-enrich-apply" @click="applyEnrichment">Apply</button>
            </div>
          </template>
        </section>

        <section v-else-if="tab === 'graph'">
          <p class="hint">
            A CSV with a mapping (which columns are nodes and edges), or JSON <code>{"nodes": [...], "edges": [...]}</code>.
            A node whose id is already on the canvas gets the missing properties instead of a copy, so new edges can reach it.
            <HelpTip title="Nodes and edges from a file" testid="your-data-graph">
              <span><strong>CSV</strong>: the mapping says which columns are node ids and which pair of them is an edge. A saved mapping of your organization is picked up from the file name and header.</span>
              <span><strong>JSON</strong>: every node needs <code>id</code> and <code>type</code>; every edge <code>source</code>, <code>target</code> and <code>type</code>.</span>
              <span>To connect to nodes already on the canvas, use the same ids (after <code>normalize</code>) the context uses.</span>
              <a :href="guideUrl('bring-your-own-data', 'add-nodes-and-edges')" target="_blank" rel="noopener">More in the guide</a>
            </HelpTip>
          </p>
          <input type="file" accept=".csv,.tsv,.txt,.json" data-testid="your-data-graph-file" @change="onFile" />
          <template v-if="picked">
            <MappingStep
              v-if="!isJson && specText"
              role="graph"
              :texts="graphTexts"
              :file-names="[picked.name]"
              :detected="detected"
              :spec-text="specText"
              :enrichment="null"
              :title="graphTitle"
              :scope-note="SCOPE"
              for-layer
              @update:spec-text="specText = $event"
              @update:title="graphTitle = $event"
              @update:valid="graphValid = $event"
            />
            <p v-if="graphImport" class="preview" data-testid="your-data-graph-preview">
              <strong>{{ graphImport.add.nodes.length }} nodes and {{ graphImport.add.edges.length }} edges.</strong>
              {{ graphImport.existing }} node{{ graphImport.existing === 1 ? ' is' : 's are' }} already on the canvas;
              {{ graphImport.reaching }} edge{{ graphImport.reaching === 1 ? ' reaches' : 's reach' }} a node already there.
            </p>
            <div class="actions">
              <button class="btn btn-primary" :disabled="busy || !graphImport?.add.nodes.length" data-testid="your-data-graph-apply" @click="applyGraph">Add to the graph</button>
            </div>
          </template>
        </section>

        <section v-else>
          <p class="hint">
            Right-click a node for <strong>Add a linked node</strong>. Select one node, then right-click another for
            <strong>Connect to the selected node</strong>. Right-click what you drew to remove it.
            <HelpTip title="Drawing by hand" testid="your-data-draw">
              <span>For what no file has: the phone a customer gave on a call, a company you know is behind an account.</span>
              <span>Drawn nodes have an amber ring and cannot be expanded (the context does not know them).</span>
              <a :href="guideUrl('bring-your-own-data', 'drawn-by-hand')" target="_blank" rel="noopener">More in the guide</a>
            </HelpTip>
          </p>
          <button class="btn btn-outline" data-testid="your-data-draw-node" @click="drawNode">Add a node…</button>
        </section>

        <p v-if="error" class="error-message" data-testid="your-data-error">{{ error }}</p>
        <p v-if="graph.overlayError" class="warn">{{ graph.overlayError }}</p>

        <section class="layer" data-testid="your-data-layer">
          <h3>In this exploration
            <HelpTip title="Your layer" testid="your-data-layer">
              <span>Everything here is saved beside the exploration, not in its snapshot: the context's data stays as the context gave it.</span>
              <span>Whoever opens the exploration sees it; only who can write the exploration changes it. A case that holds the exploration sees it too.</span>
              <span>Remove takes a file's properties, nodes and edges off the canvas at once.</span>
              <a :href="guideUrl('bring-your-own-data', 'in-an-exploration-your-layer')" target="_blank" rel="noopener">More in the guide</a>
            </HelpTip>
          </h3>
          <p v-if="!layer.enrichments.length && !layer.imports.length && !layer.drawnNodes" class="hint">Nothing yet.</p>
          <ul>
            <li v-for="f in layer.enrichments" :key="f.id" data-testid="your-data-layer-enrichment">
              <span>Enrichment <strong>{{ f.spec.name }}</strong> · {{ f.filename }} · {{ f.spec.target ?? 'nodes' }} by {{ f.spec.key_column ?? 'endpoints' }}</span>
              <button class="btn btn-sm btn-outline" :disabled="busy" @click="run(() => graph.removeOverlayEnrichment(f.id), `${f.spec.name} removed`)">Remove</button>
            </li>
            <li v-for="i in layer.imports" :key="i.id" data-testid="your-data-layer-import">
              <span>Import <strong>{{ i.title }}</strong> · {{ i.node_ids.length }} nodes, {{ i.edge_ids.length }} edges</span>
              <button class="btn btn-sm btn-outline" :disabled="busy" @click="run(() => graph.removeOverlayImport(i.id), `${i.title} removed`)">Remove</button>
            </li>
            <li v-if="layer.drawnNodes || layer.drawnEdges" data-testid="your-data-layer-drawn">
              <span>Drawn by hand · {{ layer.drawnNodes }} nodes, {{ layer.drawnEdges }} edges</span>
              <button class="btn btn-sm btn-outline" :disabled="busy" @click="removeDrawn">Remove all</button>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.your-data {
  width: min(960px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hint {
  color: var(--text-muted);
  font-size: 12px;
  margin: 0;
}
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
}
.tabs button {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 6px 10px;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 13px;
}
.tabs button.active {
  color: var(--text-color);
  border-bottom-color: var(--color-primary);
}
section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.preview {
  font-size: 13px;
  margin: 0;
}
.warn {
  color: var(--color-warning);
  font-size: 12px;
  margin: 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
}
.layer h3 {
  font-size: 13px;
  margin: 6px 0 0;
}
.layer ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.layer li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
