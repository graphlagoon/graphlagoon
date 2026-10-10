<script setup lang="ts">
/**
 * "+ Adicionar" of the case (05 §4), replacing the global exploration modal.
 * Tabs: Minhas recentes (server-side search, node count, empty ones
 * disabled, "todas" for superusers), Nova exploração (a readable context →
 * the graph page with `?case=`; saving attaches and comes back), Consulta
 * (the Query Console embedded against a chosen context), Arquivo (F2 upload
 * path; the mapping wizard is opened from here) and Colar/Link.
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Lock } from 'lucide-vue-next';
import { api } from '@/services/api';
import QueryConsolePanel, { type ConsoleResult } from '@/components/QueryConsolePanel.vue';
import { useContextsStore } from '@/stores/contexts';
import { useInvestigationStore } from '@/stores/investigation';
import { useAuthStore } from '@/stores/auth';
import { useAddToCase, classifyPaste } from '@/composables/useAddToCase';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import type { Exploration, GraphContext } from '@/types/graph';
import type { CaseItem } from '@/types/investigation';

const props = defineProps<{
  open: boolean;
  /** The case the material goes to. */
  investigationId: string;
  /** First tab shown; "recent" by default. */
  initialTab?: Tab;
}>();

const emit = defineEmits<{ close: []; added: [investigationId: string]; upload: [] }>();

type Tab = 'recent' | 'new' | 'query' | 'file' | 'paste';
const TABS: { id: Tab; label: string }[] = [
  { id: 'recent', label: 'Minhas recentes' },
  { id: 'new', label: 'Nova exploração' },
  { id: 'query', label: 'Consulta' },
  { id: 'file', label: 'Arquivo' },
  { id: 'paste', label: 'Colar / link' },
];
const PAGE = 50;

const router = useRouter();
const contextsStore = useContextsStore();
const store = useInvestigationStore();
const authStore = useAuthStore();
const toast = useToast();
const { can } = usePermissions();
const addToCase = useAddToCase(computed(() => props.investigationId));

const tab = ref<Tab>('recent');
const explorations = ref<Exploration[]>([]);
const sources = ref<CaseItem[]>([]);
const checked = ref<string[]>([]);
const search = ref('');
const scope = ref<'mine' | 'all'>('mine');
const saving = ref(false);
const listLoading = ref(false);
const loadError = ref<string | null>(null);
const queryContextId = ref('');
const lastResult = ref<ConsoleResult | null>(null);
const pasted = ref('');
const pasting = ref(false);
const uploading = ref(false);

const isSuperuser = computed(() => window.__GRAPH_LAGOON_CONFIG__?.is_superuser === true);
const caseTitle = computed(() => (store.current?.id === props.investigationId ? store.current.title : ''));
const readableContexts = computed(() => contextsStore.contexts);

let listToken = 0;
async function loadList() {
  const token = ++listToken;
  listLoading.value = true;
  try {
    const q = search.value.trim();
    const rows = await api.getAllExplorations({ q: q || undefined, mine: scope.value === 'mine', limit: PAGE });
    if (token === listToken) explorations.value = rows;
  } catch (e) {
    if (token === listToken) loadError.value = getErrorMessage(e, 'Failed to load explorations');
  } finally {
    if (token === listToken) listLoading.value = false;
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(loadList, 250);
});
watch(scope, loadList);

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    tab.value = props.initialTab ?? 'recent';
    checked.value = [];
    search.value = '';
    scope.value = 'mine';
    loadError.value = null;
    lastResult.value = null;
    pasted.value = '';
    try {
      await Promise.all([loadList(), contextsStore.fetchContexts(), loadSources()]);
    } catch (e) {
      loadError.value = getErrorMessage(e, 'Failed to load explorations');
    }
    if (!queryContextId.value) queryContextId.value = sources.value.find((s) => s.context_id)?.context_id ?? readableContexts.value[0]?.id ?? '';
  },
  { immediate: true },
);

async function loadSources() {
  sources.value = [];
  try {
    sources.value = (await api.getInvestigationItems(props.investigationId, { kind: 'graph' })).filter((i) => i.subkind === 'exploration_ref');
  } catch (e) {
    loadError.value = getErrorMessage(e, 'Failed to load the case sources');
  }
}

const inCase = computed(() => new Set(sources.value.map((s) => s.exploration_id).filter(Boolean) as string[]));
const restricted = computed(() => sources.value.filter((s) => !s.accessible));
const contextOf = (id: string): GraphContext | undefined => contextsStore.contexts.find((c) => c.id === id);
/** Newest first, as the server orders them. */
const rows = computed(() => [...explorations.value].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')));
const isEmpty = (exp: Exploration) => exp.node_count === 0;
const nodesText = (exp: Exploration) => (exp.node_count === null || exp.node_count === undefined ? 'grafo salvo' : `${exp.node_count} nós`);
const when = (iso: string) => new Date(iso).toLocaleDateString();
const toAdd = computed(() => checked.value.filter((id) => !inCase.value.has(id)));
const newContextIds = computed(
  () => new Set(toAdd.value.map((id) => explorations.value.find((e) => e.id === id)?.graph_context_id).filter(Boolean) as string[]),
);

async function submit() {
  if (toAdd.value.length === 0 || saving.value) return;
  saving.value = true;
  const { added, error } = await store.addExplorations(props.investigationId, toAdd.value);
  saving.value = false;
  if (error) {
    toast.error(added ? `Added ${added}, then failed: ${error}` : error);
    return;
  }
  toast.success(`Adicionado ao caso ${caseTitle.value || ''}: ${added} exploração${added === 1 ? '' : 'ões'}`);
  emit('added', props.investigationId);
  emit('close');
}

function startExploration(ctx: GraphContext) {
  emit('close');
  void router.push({ path: `/graph/${ctx.id}`, query: { case: props.investigationId } });
}

function onResult(result: ConsoleResult) {
  lastResult.value = result;
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  if (!files.length) return;
  uploading.value = true;
  try {
    for (const file of files) await addToCase.addDocument(file);
    emit('added', props.investigationId);
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

const pasteKind = computed(() => (pasted.value.trim() ? classifyPaste(pasted.value).kind : null));
const pasteLabel = computed(() => ({ url: 'link (documento)', table: 'tabela', note: 'nota', '': '' })[pasteKind.value ?? ''] ?? '');

async function submitPaste() {
  if (!pasted.value.trim() || pasting.value) return;
  pasting.value = true;
  try {
    const item = await addToCase.addPasted(pasted.value);
    if (item) {
      emit('added', props.investigationId);
      emit('close');
    }
  } finally {
    pasting.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="modal-overlay" @click.self="emit('close')">
    <div class="modal add-popover" data-testid="add-items-popover">
      <div class="modal-header">
        <h2>Adicionar ao caso<template v-if="caseTitle"> “{{ caseTitle }}”</template></h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>

      <div class="tabs" role="tablist">
        <button
          v-for="t in TABS"
          :key="t.id"
          type="button"
          class="tab"
          :class="{ on: tab === t.id }"
          role="tab"
          :aria-selected="tab === t.id"
          :data-testid="`add-tab-${t.id}`"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <div v-if="loadError" class="error-message">{{ loadError }}</div>

      <!-- Minhas recentes -->
      <div v-if="tab === 'recent'" class="add-body" data-testid="add-tab-panel-recent">
        <div class="scope-row">
          <div class="scope" role="tablist">
            <button type="button" class="tab small" :class="{ on: scope === 'mine' }" data-testid="add-scope-mine" @click="scope = 'mine'">Minhas</button>
            <button v-if="isSuperuser" type="button" class="tab small" :class="{ on: scope === 'all' }" data-testid="add-scope-all" @click="scope = 'all'">Todas</button>
          </div>
          <input v-model="search" class="form-control search" placeholder="Buscar por título…" aria-label="Buscar explorações" data-testid="add-search" />
        </div>
        <p v-if="listLoading && !rows.length" class="hint">Carregando…</p>
        <div class="list">
          <label
            v-for="exp in rows"
            :key="exp.id"
            class="exp-row"
            :class="{ 'exp-in-case': inCase.has(exp.id), 'exp-checked': checked.includes(exp.id), 'exp-empty': isEmpty(exp) }"
            :data-testid="`add-exp-${exp.id}`"
          >
            <input v-model="checked" type="checkbox" :value="exp.id" :disabled="inCase.has(exp.id) || isEmpty(exp)" />
            <span class="exp-text">
              <span class="exp-title">{{ exp.title }}</span>
              <span class="exp-sub">
                {{ contextOf(exp.graph_context_id)?.title ?? 'Context desconhecido' }}
                · {{ nodesText(exp) }}
                · {{ when(exp.updated_at) }}
                <template v-if="exp.owner_email !== authStore.email"> · {{ exp.owner_email }}</template>
                <template v-if="inCase.has(exp.id)"> · já está no caso</template>
                <template v-else-if="isEmpty(exp)"> · vazia: abra e salve um grafo antes</template>
              </span>
            </span>
          </label>
        </div>
        <p v-if="!rows.length && !loadError && !listLoading" class="hint" data-testid="add-empty">
          {{ search ? 'Nenhuma exploração corresponde.' : 'Nenhuma exploração sua ainda. Comece uma nova em “Nova exploração”.' }}
        </p>
        <div v-for="s in restricted" :key="s.id" class="restricted" data-testid="add-restricted-source">
          <Lock :size="12" /> “{{ s.title }}” está no caso, mas você não tem acesso ao context dela ({{ s.author_email || 'dono' }}).
        </div>
        <div class="footer">
          <span class="hint" data-testid="add-preview">
            {{ toAdd.length }} nova{{ toAdd.length === 1 ? '' : 's' }} exploraç{{ toAdd.length === 1 ? 'ão' : 'ões' }}, de {{ newContextIds.size }} context{{ newContextIds.size === 1 ? '' : 's' }} · referência viva (fixe uma versão no material para congelar)
          </span>
          <button type="button" class="btn btn-primary" data-testid="add-submit" :disabled="toAdd.length === 0 || saving" @click="submit">
            Adicionar {{ toAdd.length }}
          </button>
        </div>
      </div>

      <!-- Nova exploração -->
      <div v-else-if="tab === 'new'" class="add-body" data-testid="add-tab-panel-new">
        <p class="hint">Escolha o context: a exploração abre com “← Caso” na barra; ao salvar ela entra no caso como referência viva.</p>
        <div class="list">
          <button
            v-for="ctx in readableContexts"
            :key="ctx.id"
            type="button"
            class="exp-row as-button"
            :data-testid="`add-new-context-${ctx.id}`"
            @click="startExploration(ctx)"
          >
            <span class="exp-text">
              <span class="exp-title">{{ ctx.title }}</span>
              <span v-if="ctx.description" class="exp-sub">{{ ctx.description }}</span>
            </span>
          </button>
        </div>
        <p v-if="!readableContexts.length" class="hint">Nenhum context legível.</p>
      </div>

      <!-- Consulta -->
      <div v-else-if="tab === 'query'" class="add-body query-body" data-testid="add-tab-panel-query">
        <div class="scope-row">
          <label for="add-query-context">Context</label>
          <select id="add-query-context" v-model="queryContextId" class="form-control" data-testid="add-query-context">
            <option v-for="ctx in readableContexts" :key="ctx.id" :value="ctx.id">{{ ctx.title }}</option>
          </select>
          <span v-if="lastResult" class="hint" data-testid="add-query-result">
            {{ lastResult.rows.length }} linhas · use “Adicionar resultado” ou “Salvar como consulta do caso”
          </span>
        </div>
        <QueryConsolePanel
          v-if="queryContextId"
          :key="queryContextId"
          :context-id="queryContextId"
          :case-id="investigationId"
          class="embedded-console"
          @close="tab = 'recent'"
          @result="onResult"
        />
        <p v-else class="hint">Escolha um context para consultar.</p>
      </div>

      <!-- Arquivo -->
      <div v-else-if="tab === 'file'" class="add-body" data-testid="add-tab-panel-file">
        <p class="hint">CSV/TSV entram como tabela; o resto como documento. Para mapear um arquivo para o grafo ou como enriquecimento, use o assistente.</p>
        <input v-if="can('investigation.upload')" type="file" multiple :disabled="uploading" data-testid="add-file-input" @change="onFiles" />
        <p v-else class="hint">Você não tem a permissão “Upload investigation files”.</p>
        <button v-if="can('investigation.upload')" type="button" class="btn btn-outline" data-testid="add-file-wizard" @click="emit('upload')">
          Abrir assistente de importação (grafo | enriquecimento | documento)
        </button>
      </div>

      <!-- Colar / link -->
      <div v-else class="add-body" data-testid="add-tab-panel-paste">
        <textarea
          v-model="pasted"
          rows="8"
          class="form-control mono"
          placeholder="Cole um texto (vira nota), uma URL (vira documento-link) ou linhas separadas por tab/;/, (viram tabela)…"
          data-testid="add-paste-input"
        ></textarea>
        <div class="footer">
          <span class="hint" data-testid="add-paste-kind">{{ pasteLabel ? `Detectado: ${pasteLabel}` : '' }}</span>
          <button type="button" class="btn btn-primary" data-testid="add-paste-submit" :disabled="!pasted.trim() || pasting" @click="submitPaste">Adicionar</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.add-popover {
  width: 95vw;
  max-width: 900px;
}

.tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--border-color);
}

.tab {
  padding: 6px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
}

.tab.on {
  border-bottom-color: var(--color-primary, #0f766e);
  color: var(--text-color);
  font-weight: 600;
}

.tab.small {
  padding: 3px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.tab.small.on {
  background: var(--color-bg-muted);
}

.scope {
  display: flex;
  gap: 2px;
}

.add-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 65vh;
  overflow: auto;
}

.query-body {
  overflow: hidden;
}

.embedded-console {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.scope-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.search {
  flex: 1;
  min-width: 160px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.exp-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  text-align: left;
  background: none;
  color: inherit;
}

.exp-row.exp-checked {
  border-color: var(--color-primary, #0f766e);
}

.exp-row.exp-in-case,
.exp-row.exp-empty {
  opacity: 0.6;
  cursor: default;
}

.exp-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.exp-sub,
.hint {
  font-size: 12px;
  color: var(--text-muted);
}

.restricted {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 12px;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  font-size: 13px;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}

.mono {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
</style>
