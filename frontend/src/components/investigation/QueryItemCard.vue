<script setup lang="ts">
/**
 * The expanded card of a saved query (05 §3 "Consulta do caso"): context and
 * SQL, the `:name` parameters with their source (valor fixo | seleção atual |
 * grupo | propriedade), "Executar de novo", the run history (versions with
 * `run`), "Comparar 2 runs", "Usar no dossiê" (tag) and "Promover → grafo |
 * enriquecimento" (the latest run becomes a mapped table item).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/services/api';
import TableDiffView from './TableDiffView.vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import { queryParameterNames } from '@/composables/useAddToCase';
import { getErrorMessage } from '@/utils/errorMessage';
import type { CaseItem, CaseItemVersion, TableDiff } from '@/types/investigation';

const props = defineProps<{ item: CaseItem; canEdit: boolean }>();

const store = useInvestigationStore();
const graph = useGraphStore();
const toast = useToast();

type Source = 'fixed' | 'selection' | 'group' | 'property';
const SOURCES: { id: Source; label: string }[] = [
  { id: 'fixed', label: 'valor fixo' },
  { id: 'selection', label: 'seleção atual' },
  { id: 'group', label: 'grupo' },
  { id: 'property', label: 'propriedade' },
];

const params = computed(() => {
  const declared = props.item.query?.parameters ?? [];
  const names = queryParameterNames(props.item.query?.text ?? '');
  return names.map((id) => declared.find((p) => p.id === id) ?? { id, label: id, type: 'input' as const, required: true });
});
const sourceOf = ref<Record<string, Source>>({});
const valueOf = ref<Record<string, string>>({});
watch(
  params,
  (list) => {
    for (const p of list) {
      sourceOf.value[p.id] ??= 'fixed';
      valueOf.value[p.id] ??= p.default ?? '';
    }
  },
  { immediate: true },
);

const groups = computed(() => store.annotations.filter((a) => a.kind === 'group' && a.status !== 'rejected'));
/** The id a query understands: the node id without the `@source` suffix of unified ids. */
const rawId = (uid: string) => uid.split('@')[0];
const selectedIds = computed(() => [...graph.selectedNodeIds]);

function resolve(id: string): unknown {
  const source = sourceOf.value[id];
  const value = valueOf.value[id] ?? '';
  if (source === 'selection') return selectedIds.value.map(rawId);
  if (source === 'group') return (groups.value.find((g) => g.id === value)?.targets ?? []).map(rawId);
  if (source === 'property') {
    const picked = new Set(selectedIds.value);
    return graph.nodes.filter((n) => picked.has(n.node_id)).map((n) => n.properties?.[value]).filter((v) => v !== undefined && v !== null);
  }
  return value.includes(',') ? value.split(',').map((v) => v.trim()).filter(Boolean) : value;
}

const busy = ref(false);
async function run() {
  if (busy.value) return;
  busy.value = true;
  try {
    const values = Object.fromEntries(params.value.map((p) => [p.id, resolve(p.id)]));
    const updated = await store.runQuery(props.item.id, values);
    const r = updated?.latest?.run as { row_count?: number; duration_ms?: number } | undefined;
    toast.success(`Executada: ${r?.row_count ?? '?'} linhas em ${r?.duration_ms ?? '?'} ms`);
    await loadHistory();
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha ao executar a consulta'));
  } finally {
    busy.value = false;
  }
}

// --- history -----------------------------------------------------------------
const history = ref<CaseItemVersion[]>([]);
const showHistory = ref(false);
const picked = ref<number[]>([]);
const diff = ref<TableDiff | null>(null);
async function loadHistory() {
  if (!store.current) return;
  history.value = (await api.getInvestigationItemVersions(store.current.id, props.item.id)).filter((v) => v.run).reverse();
}
onMounted(loadHistory);
const runOf = (v: CaseItemVersion) => v.run as { row_count?: number; duration_ms?: number; statement_id?: string; run_by?: string; author_kind?: string } | null | undefined;
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : '');
function togglePick(version: number) {
  picked.value = picked.value.includes(version) ? picked.value.filter((v) => v !== version) : [...picked.value, version].slice(-2);
}
async function compareRuns() {
  if (picked.value.length !== 2 || !store.current) return;
  const [a, b] = [...picked.value].sort((x, y) => x - y);
  try {
    diff.value = await api.compareInvestigationTables(store.current.id, { left: { item_id: props.item.id, version: a }, right: { item_id: props.item.id, version: b } });
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha ao comparar'));
  }
}
async function pinRun(version: number) {
  try {
    const v = await store.pinItem(props.item.id, { version });
    if (v) toast.success(`Fixada v${v.version} · ${v.sha256.slice(0, 8)}`);
    await loadHistory();
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha ao fixar'));
  }
}

// --- dossier flag and promotion --------------------------------------------------
const inDossier = computed(() => props.item.tags.includes('dossier'));
async function toggleDossier() {
  const tags = inDossier.value ? props.item.tags.filter((t) => t !== 'dossier') : [...props.item.tags, 'dossier'];
  try {
    await store.updateItem(props.item.id, { tags });
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha ao atualizar'));
  }
}
const promoting = ref(false);
async function promote(as: 'graph' | 'enrichment') {
  if (!store.current || promoting.value) return;
  promoting.value = true;
  try {
    const [created] = await api.promoteInvestigationTables(store.current.id, { item_ids: [props.item.id], as });
    await store.fetchItems();
    if (as === 'graph') await store.loadWorkspace();
    toast.success(`“${created.title}” ${as === 'graph' ? 'no grafo' : 'como enriquecimento'}`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha ao promover'));
  } finally {
    promoting.value = false;
  }
}
</script>

<template>
  <div class="qcard" :data-testid="`query-card-${item.id}`" @click.stop>
    <div class="meta muted">
      <span>{{ item.query?.language.toUpperCase() }} → {{ item.query?.output }}</span>
      <span v-if="item.context_id">· context {{ item.context_id.slice(0, 8) }}</span>
    </div>
    <pre class="sql">{{ item.query?.text }}</pre>

    <div v-if="params.length" class="params" data-testid="query-params">
      <div v-for="p in params" :key="p.id" class="param">
        <code>:{{ p.id }}</code>
        <select v-model="sourceOf[p.id]" class="form-control" :data-testid="`query-param-source-${p.id}`">
          <option v-for="s in SOURCES" :key="s.id" :value="s.id">{{ s.label }}</option>
        </select>
        <input v-if="sourceOf[p.id] === 'fixed'" v-model="valueOf[p.id]" class="form-control" :placeholder="p.placeholder || 'valor (vírgula separa listas)'" :data-testid="`query-param-value-${p.id}`" />
        <span v-else-if="sourceOf[p.id] === 'selection'" class="muted">{{ selectedIds.length }} selecionado{{ selectedIds.length === 1 ? '' : 's' }}</span>
        <select v-else-if="sourceOf[p.id] === 'group'" v-model="valueOf[p.id]" class="form-control">
          <option value="" disabled>grupo…</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.value.name ?? g.id }} ({{ g.targets.length }})</option>
        </select>
        <input v-else v-model="valueOf[p.id]" class="form-control" placeholder="nome da propriedade (dos selecionados)" />
      </div>
    </div>

    <div class="row">
      <button v-if="canEdit" class="btn btn-primary btn-sm" :disabled="busy" :data-testid="`query-run-${item.id}`" @click="run">▶ Executar de novo</button>
      <button class="link-btn" :data-testid="`query-history-${item.id}`" @click="showHistory = !showHistory">Histórico ({{ history.length }})</button>
      <button v-if="canEdit" class="link-btn" :class="{ on: inDossier }" :data-testid="`query-dossier-${item.id}`" @click="toggleDossier">
        {{ inDossier ? '★ No dossiê' : 'Usar no dossiê' }}
      </button>
      <template v-if="canEdit && item.current_version">
        <span class="muted">Promover →</span>
        <button class="link-btn" :disabled="promoting" :data-testid="`query-promote-graph-${item.id}`" @click="promote('graph')">grafo</button>
        <button class="link-btn" :disabled="promoting" :data-testid="`query-promote-enrichment-${item.id}`" @click="promote('enrichment')">enriquecimento</button>
      </template>
    </div>

    <div v-if="showHistory" class="history" data-testid="query-history">
      <p v-if="!history.length" class="muted">Nenhuma execução ainda.</p>
      <div v-for="v in history" :key="v.id" class="run" :data-testid="`query-run-row-${v.version}`">
        <input type="checkbox" :checked="picked.includes(v.version)" title="Comparar" @change="togglePick(v.version)" />
        <span>v{{ v.version }}</span>
        <code :title="v.sha256">{{ v.sha256.slice(0, 8) }}</code>
        <span>{{ runOf(v)?.row_count ?? '?' }} linhas</span>
        <span>{{ runOf(v)?.duration_ms ?? '?' }} ms</span>
        <span v-if="runOf(v)?.statement_id" class="muted" :title="runOf(v)?.statement_id">stmt</span>
        <span class="muted">{{ runOf(v)?.author_kind === 'agent' ? 'agente' : runOf(v)?.run_by }} · {{ when(v.created_at) }}</span>
        <span v-if="v.pinned_at" class="muted">📌</span>
        <button v-else-if="canEdit" class="link-btn" @click="pinRun(v.version)">Fixar</button>
      </div>
      <button v-if="history.length >= 2" class="btn btn-outline btn-sm" :disabled="picked.length !== 2" :data-testid="`query-compare-runs-${item.id}`" @click="compareRuns">
        Comparar 2 runs
      </button>
      <TableDiffView v-if="diff" :diff="diff" />
    </div>
  </div>
</template>

<style scoped>
.qcard {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px dashed var(--border-color);
  font-size: 12px;
  cursor: default;
}

.sql {
  max-height: 90px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11px;
}

.params {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.param {
  display: grid;
  grid-template-columns: auto 1fr 1fr;
  gap: 6px;
  align-items: center;
}

.param .form-control {
  font-size: 12px;
  padding: 2px 6px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.history {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.run {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.link-btn {
  padding: 0 2px;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--color-primary);
  cursor: pointer;
}

.link-btn.on {
  font-weight: 600;
}

.muted {
  color: var(--text-muted);
}
</style>
