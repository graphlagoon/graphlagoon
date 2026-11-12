<template>
  <Teleport to="body">
    <div class="modal-overlay skill-overlay" @click.self="emit('close')">
      <div class="modal-container" data-testid="enrichment-skill-modal">
        <div class="modal-header">
          <h2>{{ mode === 'fill' ? 'Ask an AI to fill in data' : 'Ask an AI to clean this file' }}</h2>
          <button class="close-btn" title="Close" aria-label="Close" @click="emit('close')"><X :size="20" /></button>
        </div>

        <div class="modal-content">
          <p v-if="mode === 'fill'" class="intro">
            Copy the text below into any AI assistant (ChatGPT, Claude, …) and tell it which columns you want. It lists
            the nodes, so the AI answers a CSV whose rows find their node by <code>node_id</code>.
          </p>
          <p v-else class="intro">
            The rows did not join the canvas, or need fixing first (a key inside text, a decimal comma, title lines).
            Copy the text below into any AI assistant: it holds the first lines of the file and how the canvas's ids
            look, and asks for a clean CSV, or a script for a file too large to paste.
          </p>

          <div v-if="mode === 'fill'" class="scope" role="radiogroup" aria-label="Which nodes">
            <label><input v-model="scope" type="radio" value="selected" :disabled="!selectedCount" data-testid="enrichment-skill-selected" /> Selected nodes ({{ selectedCount }})</label>
            <label><input v-model="scope" type="radio" value="all" data-testid="enrichment-skill-all" /> Every node on the canvas ({{ graph.nodes.length }})</label>
          </div>

          <p class="notice" data-testid="enrichment-skill-notice">
            <ShieldAlert :size="14" />
            <span v-if="mode === 'fill'">This prompt contains the ids and names of {{ fillNodes.length }} node{{ fillNodes.length === 1 ? '' : 's' }}<template v-if="fillTotal > fillNodes.length"> (the first {{ fillNodes.length }} of {{ fillTotal }})</template>. Pasting it into an AI assistant sends them outside Graph Lagoon.</span>
            <span v-else>This prompt contains the first {{ headLines.length }} lines of the file and a few node ids and property values. Pasting it into an AI assistant sends them outside Graph Lagoon.</span>
          </p>

          <div class="skill-toolbar">
            <button class="copy-btn" data-testid="enrichment-skill-copy" @click="copy">
              <component :is="copied ? Check : Copy" :size="14" />
              {{ copied ? 'Copied!' : 'Copy to clipboard' }}
            </button>
          </div>
          <pre class="skill-text" data-testid="enrichment-skill-text">{{ skillText }}</pre>

          <label class="answer-label" for="enrichment-skill-answer">Paste the AI's answer (the CSV)</label>
          <textarea id="enrichment-skill-answer" v-model="answer" rows="6" class="form-control mono" placeholder="node_id,sector,country&#10;c1,Retail,BR" data-testid="enrichment-skill-answer"></textarea>
          <div class="actions">
            <button class="btn btn-primary" :disabled="!answer.trim()" data-testid="enrichment-skill-use" @click="use">Use this answer</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/** "Ask an AI" for Your data → Enrich: copy a prompt, paste the CSV answer back (it goes to the auto-match). */
import { computed, ref } from 'vue';
import { Check, Copy, ShieldAlert, X } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import { caseNodeLabel } from '@/utils/caseLabels';
import { lines } from '@/utils/fileMapping';
import { buildEnrichmentCleanSkill, buildEnrichmentFillSkill, stripCodeFence } from '@/utils/enrichmentSkill';

const props = defineProps<{
  mode: 'fill' | 'clean';
  /** The file as it is (clean mode). */
  fileName?: string;
  fileText?: string;
}>();
const emit = defineEmits<{ close: []; answer: [text: string] }>();

const MAX_NODES = 500;
const HEAD_LINES = 15;

const graph = useGraphStore();
const selectedCount = computed(() => graph.selectedNodeIds.size);
const scope = ref<'selected' | 'all'>(graph.selectedNodeIds.size ? 'selected' : 'all');

const chosen = computed(() => (scope.value === 'selected' ? graph.nodes.filter((n) => graph.selectedNodeIds.has(n.node_id)) : graph.nodes));
const fillTotal = computed(() => chosen.value.length);
const fillNodes = computed(() => chosen.value.slice(0, MAX_NODES).map((n) => ({ id: n.node_id, type: n.node_type, name: caseNodeLabel(n) })));
const headLines = computed(() => lines(props.fileText ?? '').slice(0, HEAD_LINES));

const propertyNames = computed(() => [...new Set(graph.nodes.flatMap((n) => Object.keys(n.properties ?? {})))].sort());

/** Per type, a few ids and values of its text or number properties: how keys look on the canvas. */
function samplesByType() {
  return graph.nodeTypes.slice(0, 8).map((type) => {
    const nodes = graph.nodes.filter((n) => n.node_type === type);
    const properties: Record<string, string[]> = {};
    for (const n of nodes) {
      for (const [k, v] of Object.entries(n.properties ?? {})) {
        if (typeof v !== 'string' && typeof v !== 'number') continue;
        const vs = (properties[k] ??= []);
        if (vs.length < 2 && Object.keys(properties).length <= 8) vs.push(String(v).slice(0, 60));
      }
    }
    for (const k of Object.keys(properties)) if (!properties[k].length) delete properties[k];
    return { type, ids: nodes.slice(0, 3).map((n) => n.node_id), properties };
  });
}

const skillText = computed(() =>
  props.mode === 'fill'
    ? buildEnrichmentFillSkill({ nodes: fillNodes.value, total: fillTotal.value, nodeProperties: propertyNames.value })
    : buildEnrichmentCleanSkill({ fileName: props.fileName ?? 'the file', headLines: headLines.value, samplesByType: samplesByType() }),
);

const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(skillText.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard can fail (permissions / insecure context): the text stays selectable below.
  }
}

const answer = ref('');
function use() {
  emit('answer', stripCodeFence(answer.value));
}
</script>

<style scoped>
.skill-overlay {
  z-index: 10000;
}
.modal-container {
  background: var(--color-surface);
  border-radius: 12px;
  width: min(760px, calc(100vw - 32px));
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color);
}
.modal-header h2 {
  margin: 0;
  font-size: 1.1rem;
}
.close-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  display: flex;
}
.modal-content {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.intro {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
}
.scope {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 13px;
}
.notice {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
}
.notice svg {
  flex-shrink: 0;
  margin-top: 1px;
}
.skill-toolbar,
.actions {
  display: flex;
  justify-content: flex-end;
}
.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--color-primary);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}
.skill-text {
  margin: 0;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 260px;
  overflow-y: auto;
}
.answer-label {
  font-size: 13px;
  font-weight: 600;
}
.mono {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
</style>
