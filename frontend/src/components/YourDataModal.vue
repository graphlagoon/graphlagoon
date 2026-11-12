<script setup lang="ts">
/**
 * "Your data" on an exploration (BYOD-2): enrich the nodes or edges on the canvas from a
 * file, add nodes and edges from a mapped file or JSON, or draw them by hand. Everything
 * goes to the exploration's user layer: saved beside it, re-applied after every query,
 * never written to the context. Reuses the case wizard's mapping step.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { Bot } from 'lucide-vue-next';
import { api } from '@/services/api';
import { useGraphStore } from '@/stores/graph';
import { useSketch } from '@/composables/useSketch';
import { useToast } from '@/composables/useToast';
import MappingStep from '@/components/investigation/MappingStep.vue';
import EnrichmentSkillModal from '@/components/EnrichmentSkillModal.vue';
import DatabricksEnrichmentTab from '@/components/DatabricksEnrichmentTab.vue';
import { usePermissions } from '@/composables/usePermissions';
import HelpTip from '@/components/admin/HelpTip.vue';
import { guideUrl } from '@/utils/docsLinks';
import { encodingFor, genericSpec } from '@/utils/fileImport';
import { interpretMapping, suggestPresets, type MappingSpec } from '@/utils/fileMapping';
import { fileEnrichmentRows, matchFileRows, tableContentOf } from '@/utils/enrichment';
import { canvasKeyGuide, describeMatch, fallbackSpec, readTable, scopeLabel, suggestEnrichmentMatches, type MatchSuggestion, type ReadTable } from '@/utils/enrichmentAutoMatch';
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

type Tab = 'enrich' | 'graph' | 'draw' | 'databricks';
const { can } = usePermissions();
/** The layer tabs need write access; the context's Databricks queries only need to read it. */
const canEditLayer = computed(() => graph.canEditOverlay && can('exploration.edit_graph'));
const tab = ref<Tab>(canEditLayer.value ? 'enrich' : 'databricks');
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
  if (file) await takeFile(file);
}

async function takeFile(file: File) {
  error.value = null;
  if (file.size > maxBytes * 4) {
    error.value = `The file is ${Math.round(file.size / 1024)} KB; an exploration keeps about ${Math.round(maxBytes / 1024)} KB of your data. Keep only the rows and columns you need.`;
    return;
  }
  const buffer = await file.arrayBuffer();
  if (tab.value === 'enrich') {
    startEnrichment(file.name, decode(buffer));
    return;
  }
  picked.value = { name: file.name, buffer };
  startGraph();
}

const dragging = ref(false);
function onDrop(event: DragEvent) {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void takeFile(file);
}

/** UTF-8, or Windows-1252 when the bytes are not UTF-8 (a spreadsheet export from Excel). */
function decode(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

watch(tab, () => {
  picked.value = null;
  source.value = null;
  error.value = null;
});

// --- enrich -------------------------------------------------------------------
/** The rows to enrich from: a file, rows pasted from a spreadsheet, or an AI's answer. */
interface Source {
  name: string;
  /** As it came (what the "clean this file" prompt shows). */
  raw: string;
  table: ReadTable;
}
const source = ref<Source | null>(null);
const enrichment = ref<FileEnrichmentSpec | null>(null);
const enrichValid = ref(false);
const enrichText = computed(() => source.value?.table.text ?? '');
const suggestions = ref<MatchSuggestion[]>([]);
const showPaste = ref(false);
const pasteText = ref('');
const showAdjust = ref(false);
const skill = ref<'fill' | 'clean' | null>(null);

/** Reads the rows and picks how they join the canvas (enrichmentAutoMatch): no setting needed. */
function startEnrichment(name: string, raw: string) {
  const table = readTable(raw);
  if (!table.header.length || !table.rows.length) {
    error.value = 'No rows to read: the first line should name the columns, and each line after it is one row.';
    return;
  }
  const title = name.replace(/\.[^.]+$/, '');
  source.value = { name, raw, table };
  suggestions.value = suggestEnrichmentMatches(graph.baseGraph(), table, title);
  enrichment.value = suggestions.value[0]?.spec ?? fallbackSpec(title, table);
  showAdjust.value = false;
  showPaste.value = false;
}

function usePasted() {
  error.value = null;
  startEnrichment('pasted rows', pasteText.value);
}

function onAnswer(text: string) {
  skill.value = null;
  error.value = null;
  startEnrichment('AI answer', text);
}

function choose(s: MatchSuggestion) {
  enrichment.value = { ...s.spec, overwrite: enrichment.value?.overwrite ?? false };
}

/** Which suggestion the current settings are (none once the person adjusted them). */
const pickedSuggestion = computed(() => {
  const e = enrichment.value;
  return e ? suggestions.value.findIndex((s) => describeMatch(s.spec) === describeMatch(e) && scopeLabel(s.spec) === scopeLabel(e)) : -1;
});

/** What a row can join on this canvas, from its real nodes (the help, the example, the guard). */
const guide = computed(() => {
  void graph.overlayVersion;
  return canvasKeyGuide(graph.baseGraph());
});
/** A two-line CSV that would really join: the top type's first id-like property, or its node id. */
const example = computed(() => {
  const t = guide.value.types[0];
  if (!t) return null;
  const key = t.keys[0];
  const node = graph.baseGraph().nodes.find((n) => n.node_id === t.sample.id);
  const value = key ? String(node?.properties?.[key.name] ?? key.example) : t.sample.id;
  const column = key ? key.name : 'node_id';
  return { csv: `${column},risk\n${value},high`, column, type: t.type, id: t.sample.id, name: t.sample.name };
});

/** The first rows, to see what the file holds; the key columns are marked. */
const sampleRows = computed(() => source.value?.table.rows.slice(0, 5) ?? []);
const keyColumns = computed(() => {
  const e = enrichment.value;
  if (!e) return new Set<string>();
  if (e.target === 'edges' && e.edge_key?.by === 'endpoints') return new Set([e.edge_key.source_column, e.edge_key.target_column].filter((c): c is string => !!c));
  return new Set(e.key_column ? [e.key_column] : []);
});

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
  const types = (onNodes ? spec.match_node_types : spec.match_edge_types)?.filter((t) => t !== '*') ?? [];
  const inScope = (t: string) => !types.length || types.includes(t);
  const pool = onNodes
    ? base.nodes.filter((n) => inScope(n.node_type)).map((n) => [n.node_id, n.properties] as const)
    : base.edges.filter((e) => inScope(e.relationship_type)).map((e) => [e.edge_id, e.properties] as const);
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
    what: scopeLabel(spec),
    how: describeMatch(spec),
    kept,
    hidden: allow ? spec.columns.filter((c) => !allow.includes(c)) : [],
    keys: Object.keys(rows).length,
  };
});

async function applyEnrichment() {
  const spec = enrichment.value;
  const rows = enrichRows.value;
  const src = source.value;
  if (!spec || !rows || !src) return;
  // JSON copy: the spec comes from a form (Vue proxies), the layer is plain JSON.
  const entry = { id: newOverlayId(), filename: src.name, spec: JSON.parse(JSON.stringify(spec)) as FileEnrichmentSpec, rows: firstRows(rows), row_count: Object.keys(rows).length };
  if (JSON.stringify(entry).length > maxBytes) {
    error.value = 'This file is too large for an exploration layer. Keep only the columns you need, or the rows whose key is on the canvas.';
    return;
  }
  await run(() => graph.setOverlayEnrichment(entry), `${enrichPreview.value?.matched ?? 0} ${enrichPreview.value?.what ?? 'nodes'} enriched from ${src.name}`);
  if (!error.value) source.value = null;
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
        <p v-if="canEditLayer && tab !== 'databricks'" class="hint">
          Add your own data to this graph. It is saved with the exploration, beside the context's data, and comes back
          after every query and expand. Others who open the exploration see it; the context does not change.
          <a :href="guideUrl('bring-your-own-data')" target="_blank" rel="noopener" data-testid="your-data-guide">Full guide</a>
        </p>

        <div class="tabs" role="tablist">
          <template v-if="canEditLayer">
            <button role="tab" :class="{ active: tab === 'enrich' }" data-testid="your-data-tab-enrich" @click="tab = 'enrich'">Enrich from a file</button>
            <button role="tab" :class="{ active: tab === 'graph' }" data-testid="your-data-tab-graph" @click="tab = 'graph'">Nodes and edges from a file</button>
            <button role="tab" :class="{ active: tab === 'draw' }" data-testid="your-data-tab-draw" @click="tab = 'draw'">Draw</button>
          </template>
          <button role="tab" :class="{ active: tab === 'databricks' }" data-testid="your-data-tab-databricks" @click="tab = 'databricks'">From Databricks tables</button>
        </div>

        <section v-if="tab === 'enrich'">
          <p v-if="!guide.types.length" class="nomatch" data-testid="your-data-enrich-empty-canvas">
            There is nothing on the canvas to add data to yet. Run a query or open an exploration first: each row of
            your file then finds its node on the graph.
          </p>
          <template v-else>
          <p class="hint">
            Each row finds one node (or edge) by a <strong>key column</strong> and adds its other columns as properties.
            Values already on a node stay unless you tick "Replace" in Adjust.
            <HelpTip title="Enrich from a file" testid="your-data-enrich">
              <span>The join is found for you: every column is tried against the node ids and the properties below, as they are and normalized (<code>123.456.789-01</code> meets <code>12345678901</code>, <code>ACME</code> meets <code>Acme</code>).</span>
              <span>Nodes that arrive later (another query, an expand) get their row too.</span>
              <span>Nothing joins? <strong>Ask an AI to clean this file</strong> rewrites the key the way the canvas writes it.</span>
              <a :href="guideUrl('bring-your-own-data', 'enrich-nodes-or-edges-from-a-file')" target="_blank" rel="noopener">More in the guide</a>
            </HelpTip>
          </p>
          <div v-if="!source" class="key-guide" data-testid="your-data-enrich-guide">
            <h4>On this graph, a key can be</h4>
            <ul>
              <li v-for="t in guide.types" :key="t.type">
                <strong>{{ t.type }}</strong> <span class="hint">({{ t.count }})</span>:
                node id, e.g. <code>{{ t.sample.id }}</code><template v-for="k in t.keys" :key="k.name"> · <code class="prop">{{ k.name }}</code>, e.g. <code>{{ k.example }}</code></template>
              </li>
              <li v-if="guide.edge" class="hint">
                <strong>{{ guide.edge.type }}</strong> edges: two columns with both ends, e.g. <code>{{ guide.edge.src }}</code> and <code>{{ guide.edge.dst }}</code> (either order).
              </li>
            </ul>
            <p v-if="guide.idsOnly" class="warn" data-testid="your-data-enrich-ids-only">
              The nodes on the canvas carry no properties, so rows can only join by node id. A file keyed by a document,
              a name or an e-mail will not join until those properties are on the nodes.
            </p>
            <div v-if="example" class="example">
              <pre data-testid="your-data-enrich-example">{{ example.csv }}</pre>
              <span>sets <code>risk = high</code> on {{ example.type }} <code>{{ example.id }}</code><template v-if="example.name"> ({{ example.name }})</template>.</span>
            </div>
          </div>
          <div
            class="drop"
            :class="{ dragging, compact: !!source }"
            data-testid="your-data-enrich-drop"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
          >
            <template v-if="source">
              <span><strong>{{ source.name }}</strong> · {{ source.table.rows.length }} row{{ source.table.rows.length === 1 ? '' : 's' }} · {{ source.table.header.length }} column{{ source.table.header.length === 1 ? '' : 's' }}<template v-if="source.table.skipped"> · {{ source.table.skipped }} line{{ source.table.skipped === 1 ? '' : 's' }} above the header skipped</template></span>
              <label class="btn btn-sm btn-outline file-btn">Another file<input type="file" accept=".csv,.tsv,.txt" @change="onFile" /></label>
            </template>
            <template v-else>
              <span>Drop a CSV here, or</span>
              <label class="btn btn-sm btn-outline file-btn">Choose a file<input type="file" accept=".csv,.tsv,.txt" data-testid="your-data-enrich-file" @change="onFile" /></label>
            </template>
            <button class="btn btn-sm btn-outline" :aria-expanded="showPaste" data-testid="your-data-enrich-paste-toggle" @click="showPaste = !showPaste">Paste rows</button>
            <button class="btn btn-sm btn-outline" data-testid="your-data-enrich-ask-fill" @click="skill = 'fill'"><Bot :size="14" /> Ask an AI to fill in data</button>
          </div>
          <div v-if="showPaste" class="paste">
            <textarea v-model="pasteText" rows="5" class="form-control mono" :placeholder="`Copy the cells from a spreadsheet, with the header row, and paste them here. For example:\n${example?.csv.replaceAll(',', '\t') ?? 'node_id\trisk'}`" data-testid="your-data-enrich-paste"></textarea>
            <div class="actions">
              <button class="btn btn-sm btn-primary" :disabled="!pasteText.trim()" data-testid="your-data-enrich-paste-use" @click="usePasted">Use these rows</button>
            </div>
          </div>

          <template v-if="source && enrichment">
            <div v-if="suggestions.length > 1" class="alternatives" data-testid="your-data-enrich-alternatives">
              <span class="hint">Ways the rows join:</span>
              <button
                v-for="(s, i) in suggestions"
                :key="i"
                class="chip-btn"
                :class="{ active: pickedSuggestion === i }"
                :aria-pressed="pickedSuggestion === i"
                @click="choose(s)"
              >{{ s.matched }} {{ scopeLabel(s.spec) }} · {{ describeMatch(s.spec) }}</button>
            </div>
            <div v-if="!suggestions.length" class="nomatch" data-testid="your-data-enrich-nomatch">
              <span>No column of these rows meets the canvas: not as a node id, not as a property, under any normalization.
                The key may be inside text, split across columns, or the ids may come from another system.</span>
              <button class="btn btn-sm btn-outline" data-testid="your-data-enrich-ask-clean" @click="skill = 'clean'"><Bot :size="14" /> Ask an AI to clean this file</button>
            </div>

            <div class="sample-wrap">
              <table class="sample" data-testid="your-data-enrich-sample">
                <thead>
                  <tr><th v-for="c in source.table.header" :key="c" :class="{ key: keyColumns.has(c) }">{{ c }}<span v-if="keyColumns.has(c)" class="key-tag">key</span></th></tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in sampleRows" :key="i">
                    <td v-for="(c, j) in source.table.header" :key="j" :class="{ key: keyColumns.has(c) }">{{ r[j] }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <details class="adjust" :open="showAdjust" @toggle="showAdjust = ($event.target as HTMLDetailsElement).open">
              <summary data-testid="your-data-enrich-adjust">Adjust the matching and the columns</summary>
              <MappingStep
                role="enrichment"
                :texts="{ [source.name]: enrichText }"
                :file-names="[source.name]"
                :detected="null"
                spec-text=""
                :enrichment="enrichment"
                title=""
                :scope-note="SCOPE"
                for-layer
                @update:enrichment="enrichment = $event"
                @update:valid="enrichValid = $event"
              />
            </details>
            <p v-if="suggestions.length" class="hint">
              Joined automatically: the rows were tried against the node ids and every property, as they are and normalized.
              Not the right join? <button class="link-btn" @click="skill = 'clean'">Ask an AI to clean this file</button>
            </p>

            <div class="footer">
              <p v-if="enrichPreview" class="preview" data-testid="your-data-enrich-preview">
                <strong>{{ enrichPreview.matched }} of {{ enrichPreview.total }} {{ enrichPreview.what }}</strong> match a row
                ({{ enrichPreview.keys }} key{{ enrichPreview.keys === 1 ? '' : 's' }} in the file) · {{ enrichPreview.how }}.
                <template v-if="enrichPreview.kept">
                  {{ enrichPreview.kept }} value{{ enrichPreview.kept === 1 ? ' is' : 's are' }} already set{{ enrichment.overwrite ? ' and will be replaced' : ' and stay as they are' }}.
                </template>
                <template v-if="enrichPreview.hidden.length"> Hidden by your property visibility: {{ enrichPreview.hidden.join(', ') }}.</template>
              </p>
              <p v-else-if="!enrichValid" class="warn">Pick a key column and at least one column to add (Adjust the matching).</p>
              <button class="btn btn-primary" :disabled="busy || !enrichPreview?.matched" data-testid="your-data-enrich-apply" @click="applyEnrichment">Apply</button>
            </div>
          </template>
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

        <DatabricksEnrichmentTab v-else-if="tab === 'databricks'" />

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

        <section v-if="canEditLayer && tab !== 'databricks'" class="layer" data-testid="your-data-layer">
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
    <EnrichmentSkillModal
      v-if="skill"
      :mode="skill"
      :file-name="source?.name"
      :file-text="source?.raw"
      @close="skill = null"
      @answer="onAnswer"
    />
  </Teleport>
</template>

<style scoped>
.key-guide {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
}
.key-guide h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
.key-guide ul {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.key-guide code {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.key-guide code.prop {
  font-weight: 600;
}
.example {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.example pre {
  margin: 0;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border-radius: 6px;
  font-size: 12px;
}
.drop {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 14px;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  font-size: 13px;
}
.drop.compact {
  padding: 8px 10px;
  border-style: solid;
}
.drop.dragging {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}
.drop > span {
  flex: 1 1 200px;
}
.file-btn input {
  display: none;
}
.paste {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mono {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.alternatives {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.chip-btn {
  border: 1px solid var(--border-color);
  background: none;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-color);
}
.chip-btn.active {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}
.nomatch {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
}
.nomatch span {
  flex: 1 1 300px;
}
.sample-wrap {
  overflow-x: auto;
}
.sample {
  border-collapse: collapse;
  font-size: 12px;
  width: 100%;
}
.sample th,
.sample td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sample .key {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}
.key-tag {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 700;
  color: var(--color-primary);
  text-transform: uppercase;
}
.adjust summary {
  cursor: pointer;
  font-size: 13px;
  margin-bottom: 8px;
}
.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-primary);
  text-decoration: underline;
  cursor: pointer;
  font-size: inherit;
}
.footer {
  position: sticky;
  bottom: calc(-1 * var(--space-6, 24px));
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0 12px;
  background: var(--color-surface);
  border-top: 1px solid var(--border-color);
  z-index: 1;
}
.footer p {
  flex: 1;
}
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
