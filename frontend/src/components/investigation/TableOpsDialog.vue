<script setup lang="ts">
/**
 * Operations on the selected table items (05 §3): **Juntar** by key (a new
 * table with the parents as provenance), **Comparar** two tables (diff by
 * key), **Promover em lote** to enrichment (one shared key column) and
 * **Unir no grafo** (each table gets its own mapping, source/target columns).
 * The columns come from each item's latest content.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '@/services/api';
import TableDiffView from './TableDiffView.vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { commonColumn, parseTableContent } from '@/utils/caseTables';
import type { CaseItem, TableDiff } from '@/types/investigation';

export type TableOp = 'join' | 'compare' | 'enrichment' | 'graph';

const props = defineProps<{ investigationId: string; op: TableOp; items: CaseItem[] }>();
const emit = defineEmits<{ close: []; done: [] }>();

const store = useInvestigationStore();
const toast = useToast();

const TITLES: Record<TableOp, string> = {
  join: 'Juntar tabelas por chave',
  compare: 'Comparar duas tabelas',
  enrichment: 'Promover a enriquecimento',
  graph: 'Unir no grafo',
};

const columns = ref<Record<string, string[]>>({});
const loading = ref(true);
const busy = ref(false);
const key = ref('');
const title = ref('');
const nodeTypes = ref('');
const source = ref('');
const target = ref('');
const sourceType = ref('Entidade');
const edgeType = ref('relacionado');
const normalize = ref('');
const diff = ref<TableDiff | null>(null);

const shared = computed(() => commonColumn(props.items.map((i) => columns.value[i.id] ?? [])));
const allColumns = computed(() => [...new Set(props.items.flatMap((i) => columns.value[i.id] ?? []))]);
const canSubmit = computed(() => {
  if (props.op === 'graph') return !!source.value && !!target.value;
  return !!key.value;
});

onMounted(async () => {
  try {
    for (const item of props.items) {
      const data = await api.getInvestigationItemContent(props.investigationId, item.id);
      columns.value[item.id] = parseTableContent(data, item.latest?.content_type ?? 'application/json').columns;
    }
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha ao ler as tabelas'));
  } finally {
    loading.value = false;
  }
  key.value = shared.value ?? allColumns.value[0] ?? '';
  source.value = allColumns.value[0] ?? '';
  target.value = allColumns.value[1] ?? allColumns.value[0] ?? '';
  if (props.op === 'join') title.value = `${props.items.map((i) => i.title).join(' + ')} por ${key.value}`;
});

async function submit() {
  if (!canSubmit.value || busy.value) return;
  busy.value = true;
  const ids = props.items.map((i) => i.id);
  try {
    if (props.op === 'join') {
      const item = await api.joinInvestigationTables(props.investigationId, { item_ids: ids, key_column: key.value, title: title.value || undefined });
      toast.success(`Tabela “${item.title}” criada`);
    } else if (props.op === 'compare') {
      diff.value = await api.compareInvestigationTables(props.investigationId, { left: { item_id: ids[0] }, right: { item_id: ids[1] }, key_column: key.value });
      return;
    } else if (props.op === 'enrichment') {
      const types = nodeTypes.value.split(',').map((t) => t.trim()).filter(Boolean);
      await api.promoteInvestigationTables(props.investigationId, { item_ids: ids, as: 'enrichment', options: { key_column: key.value, match_node_types: types.length ? types : ['*'] } });
      toast.success(`${ids.length} tabela${ids.length === 1 ? '' : 's'} promovida${ids.length === 1 ? '' : 's'} a enriquecimento por ${key.value}`);
    } else {
      await api.promoteInvestigationTables(props.investigationId, {
        item_ids: ids,
        as: 'graph',
        options: { source_column: source.value, target_column: target.value, source_type: sourceType.value || 'Entidade', edge_type: edgeType.value || 'relacionado', ...(normalize.value ? { normalize: normalize.value } : {}) },
      });
      toast.success(`${ids.length} tabela${ids.length === 1 ? '' : 's'} no grafo, cada uma como fonte`);
    }
    await store.fetchItems();
    if (props.op === 'graph') await store.loadWorkspace();
    emit('done');
    emit('close');
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha na operação'));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal ops" :class="{ wide: diff }" data-testid="table-ops-dialog">
      <div class="modal-header">
        <h2>{{ TITLES[op] }}</h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>

      <TableDiffView v-if="diff" :diff="diff" />

      <template v-else>
        <p class="muted">
          {{ items.map((i) => i.title).join(' · ') }}
          <template v-if="loading"> · lendo colunas…</template>
        </p>

        <template v-if="op !== 'graph'">
          <div class="form-group">
            <label for="ops-key">Coluna-chave</label>
            <input id="ops-key" v-model="key" class="form-control" list="ops-columns" data-testid="ops-key" />
            <datalist id="ops-columns"><option v-for="c in allColumns" :key="c" :value="c"></option></datalist>
            <span v-if="shared" class="muted">Em comum: {{ shared }}</span>
            <span v-else-if="!loading" class="muted">As tabelas não compartilham coluna; escolha a chave com cuidado.</span>
          </div>
          <div v-if="op === 'join'" class="form-group">
            <label for="ops-title">Título da nova tabela</label>
            <input id="ops-title" v-model="title" class="form-control" data-testid="ops-title" />
          </div>
          <div v-if="op === 'enrichment'" class="form-group">
            <label for="ops-types">Tipos de entidade que casam (separados por vírgula; vazio = todos)</label>
            <input id="ops-types" v-model="nodeTypes" class="form-control" placeholder="Pessoa, Conta" data-testid="ops-node-types" />
          </div>
        </template>

        <template v-else>
          <div class="grid">
            <div class="form-group">
              <label for="ops-src">Coluna de origem</label>
              <input id="ops-src" v-model="source" class="form-control" list="ops-columns" data-testid="ops-source" />
            </div>
            <div class="form-group">
              <label for="ops-dst">Coluna de destino</label>
              <input id="ops-dst" v-model="target" class="form-control" list="ops-columns" data-testid="ops-target" />
            </div>
            <div class="form-group">
              <label for="ops-ntype">Tipo das entidades</label>
              <input id="ops-ntype" v-model="sourceType" class="form-control" />
            </div>
            <div class="form-group">
              <label for="ops-etype">Tipo da relação</label>
              <input id="ops-etype" v-model="edgeType" class="form-control" />
            </div>
            <div class="form-group">
              <label for="ops-norm">Normalizar ids</label>
              <select id="ops-norm" v-model="normalize" class="form-control">
                <option value="">nenhum</option>
                <option value="cpf_cnpj">CPF/CNPJ</option>
                <option value="account">conta</option>
                <option value="phone">telefone</option>
                <option value="email">e-mail</option>
                <option value="lower">minúsculas</option>
              </select>
            </div>
          </div>
          <datalist id="ops-columns"><option v-for="c in allColumns" :key="c" :value="c"></option></datalist>
          <p class="muted">As outras colunas viram propriedades da relação. Cada tabela entra como fonte própria, com anel.</p>
        </template>

        <div class="modal-footer">
          <button type="button" class="btn btn-outline" @click="emit('close')">Cancelar</button>
          <button type="button" class="btn btn-primary" :disabled="!canSubmit || busy || loading" data-testid="ops-submit" @click="submit">
            {{ op === 'join' ? 'Juntar' : op === 'compare' ? 'Comparar' : op === 'enrichment' ? 'Promover' : 'Unir no grafo' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ops {
  max-width: 560px;
  width: 95vw;
}

.ops.wide {
  max-width: 960px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  font-size: 13px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
