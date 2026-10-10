<script setup lang="ts">
/**
 * "Add to investigation" (T3, F1). Opened from a case (case fixed) or from an
 * exploration (exploration pre-checked, case chosen here). Lists the caller's
 * own recent explorations (server-side search, node count, empty ones
 * disabled); superusers can switch to every context. Sources the caller cannot
 * read show as placeholders.
 *
 * shortcut: the overlap preview only lists the identity keys the contexts share;
 * the exact node/edge overlap needs the unified graph (F1.6).
 */
import { ref, computed, watch } from 'vue';
import { api } from '@/services/api';
import { Lock } from 'lucide-vue-next';
import { useContextsStore } from '@/stores/contexts';
import { useInvestigationStore } from '@/stores/investigation';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import type { Exploration, GraphContext } from '@/types/graph';
import type { CaseItem } from '@/types/investigation';

const props = defineProps<{
  open: boolean;
  /** Fixed case (opened from the case). */
  investigationId?: string;
  /** Pre-checked exploration (opened from an exploration). */
  explorationId?: string;
}>();

const emit = defineEmits<{ close: []; added: [investigationId: string] }>();

const PAGE = 50;

const contextsStore = useContextsStore();
const store = useInvestigationStore();
const authStore = useAuthStore();
const toast = useToast();

const explorations = ref<Exploration[]>([]);
const sources = ref<CaseItem[]>([]);
const caseId = ref('');
const checked = ref<string[]>([]);
const search = ref('');
const scope = ref<'mine' | 'all'>('mine');
const saving = ref(false);
const listLoading = ref(false);
const loadError = ref<string | null>(null);

const isSuperuser = computed(() => window.__GRAPH_LAGOON_CONFIG__?.is_superuser === true);

/** Cases the caller can add to: writable and not decided. */
const writableCases = computed(() =>
  store.investigations.filter((i) => i.has_write_access && i.status !== 'decided'),
);
const caseTitle = computed(() => {
  const inv =
    store.investigations.find((i) => i.id === caseId.value) ??
    (store.current?.id === caseId.value ? store.current : null);
  return inv?.title ?? '';
});

let listToken = 0;
async function loadList() {
  const token = ++listToken;
  listLoading.value = true;
  try {
    const q = search.value.trim();
    const rows = await api.getAllExplorations({ q: q || undefined, mine: scope.value === 'mine', limit: PAGE });
    // The pre-checked exploration (opened from it) stays listed even when it is not "mine".
    if (props.explorationId && !rows.some((e) => e.id === props.explorationId)) {
      try {
        rows.unshift(await api.getExploration(props.explorationId));
      } catch {
        /* unreadable: the row is just absent */
      }
    }
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
    caseId.value = props.investigationId ?? '';
    checked.value = props.explorationId ? [props.explorationId] : [];
    search.value = '';
    scope.value = 'mine';
    loadError.value = null;
    try {
      await Promise.all([
        loadList(),
        contextsStore.fetchContexts(),
        props.investigationId ? Promise.resolve() : store.fetchInvestigations(),
      ]);
    } catch (e) {
      loadError.value = getErrorMessage(e, 'Failed to load explorations');
    }
  },
  { immediate: true },
);

watch(caseId, async (id) => {
  // Drop the previous case's rows; the user's own picks stay.
  checked.value = checked.value.filter((e) => !inCase.value.has(e));
  sources.value = [];
  if (!id) return;
  try {
    sources.value = (await api.getInvestigationItems(id, { kind: 'graph' })).filter((i) => i.subkind === 'exploration_ref');
    // Rows already in the case render checked (and disabled).
    checked.value = [...new Set([...checked.value, ...inCase.value])];
  } catch (e) {
    loadError.value = getErrorMessage(e, 'Failed to load the case sources');
  }
});

const inCase = computed(
  () => new Set(sources.value.map((s) => s.exploration_id).filter(Boolean) as string[]),
);
const restricted = computed(() => sources.value.filter((s) => !s.accessible));

function contextOf(id: string): GraphContext | undefined {
  return contextsStore.contexts.find((c) => c.id === id);
}

/** Newest first, as the server orders them (kept stable across the pre-checked insert). */
const rows = computed(() =>
  [...explorations.value].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')),
);

const isEmpty = (exp: Exploration) => exp.node_count === 0;
const nodesText = (exp: Exploration) =>
  exp.node_count === null || exp.node_count === undefined ? 'saved graph' : `${exp.node_count} nodes`;
const when = (iso: string) => new Date(iso).toLocaleDateString();

const toAdd = computed(() => checked.value.filter((id) => !inCase.value.has(id)));
const newContextIds = computed(
  () =>
    new Set(
      toAdd.value
        .map((id) => explorations.value.find((e) => e.id === id)?.graph_context_id)
        .filter(Boolean) as string[],
    ),
);

/** Entities keyed in two or more of the contexts involved (case + selection). */
const sharedKeys = computed(() => {
  const contextIds = new Set(newContextIds.value);
  for (const s of sources.value) if (s.context_id) contextIds.add(s.context_id);
  const byEntity = new Map<string, string[]>();
  for (const id of contextIds) {
    const ctx = contextOf(id);
    for (const key of ctx?.identity_keys ?? []) {
      const source = key.source === 'node_id' ? 'node id' : key.source.name;
      const list = byEntity.get(key.entity) ?? [];
      list.push(`${source} (${ctx!.title})`);
      byEntity.set(key.entity, list);
    }
  }
  return [...byEntity.entries()]
    .filter(([, uses]) => uses.length > 1)
    .map(([entity, uses]) => ({ entity, uses }));
});

async function submit() {
  if (!caseId.value || toAdd.value.length === 0 || saving.value) return;
  saving.value = true;
  const { added, error } = await store.addExplorations(caseId.value, toAdd.value);
  saving.value = false;
  if (error) {
    toast.error(added ? `Added ${added}, then failed: ${error}` : error);
    return;
  }
  toast.success(`Added ${added} exploration${added === 1 ? '' : 's'} to “${caseTitle.value}”`);
  emit('added', caseId.value);
  emit('close');
}
</script>

<template>
  <div v-if="open" class="modal-overlay" @click.self="emit('close')">
    <div class="modal add-modal" data-testid="add-to-investigation-modal">
      <div class="modal-header">
        <h2>{{ investigationId ? `Add to “${caseTitle}”` : 'Add to investigation' }}</h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>

      <div class="add-body">
        <div class="add-main">
          <div v-if="!investigationId" class="form-group">
            <label for="add-case">Investigation</label>
            <select id="add-case" v-model="caseId" class="form-control" data-testid="add-case-select">
              <option value="" disabled>Choose a case…</option>
              <option v-for="inv in writableCases" :key="inv.id" :value="inv.id">{{ inv.title }}</option>
            </select>
            <span v-if="!writableCases.length" class="hint">
              No case you can edit. Create one in Investigations first.
            </span>
          </div>

          <div class="scope-row">
            <div class="tabs" role="tablist">
              <button
                type="button"
                class="tab"
                :class="{ on: scope === 'mine' }"
                role="tab"
                data-testid="add-scope-mine"
                @click="scope = 'mine'"
              >
                My recent explorations
              </button>
              <button
                v-if="isSuperuser"
                type="button"
                class="tab"
                :class="{ on: scope === 'all' }"
                role="tab"
                data-testid="add-scope-all"
                @click="scope = 'all'"
              >
                All contexts
              </button>
            </div>
            <input
              id="add-search"
              v-model="search"
              class="form-control search"
              placeholder="Search by title…"
              aria-label="Search explorations"
              data-testid="add-search"
            />
          </div>

          <div v-if="loadError" class="error-message">{{ loadError }}</div>
          <p v-if="listLoading && !rows.length" class="hint">Loading…</p>

          <label
            v-for="exp in rows"
            :key="exp.id"
            class="exp-row"
            :class="{
              'exp-in-case': inCase.has(exp.id),
              'exp-checked': checked.includes(exp.id),
              'exp-empty': isEmpty(exp),
            }"
            :data-testid="`add-exp-${exp.id}`"
          >
            <input
              v-model="checked"
              type="checkbox"
              :value="exp.id"
              :disabled="inCase.has(exp.id) || isEmpty(exp)"
            />
            <span class="exp-text">
              <span class="exp-title">{{ exp.title }}</span>
              <span class="exp-sub">
                {{ contextOf(exp.graph_context_id)?.title ?? 'Unknown context' }}
                · {{ nodesText(exp) }}
                · {{ when(exp.updated_at) }}
                <template v-if="exp.owner_email !== authStore.email"> · {{ exp.owner_email }}</template>
                <template v-if="inCase.has(exp.id)"> · already in the case</template>
                <template v-else-if="isEmpty(exp)"> · empty: open it and save a graph first</template>
              </span>
            </span>
          </label>
          <p v-if="!rows.length && !loadError && !listLoading" class="hint" data-testid="add-empty">
            {{ search ? 'No exploration matches.' : 'No exploration of yours yet. Save one from a context to add it here.' }}
          </p>

          <div
            v-for="s in restricted"
            :key="s.id"
            class="restricted"
            data-testid="add-restricted-source"
          >
            <span class="ctx-title"><Lock :size="12" /> Restricted context</span>
            <span>
              “{{ s.title }}” is in the case, but you don't have access to its context.
              Ask {{ s.author_email || 'its owner' }} for access.
            </span>
          </div>
        </div>

        <aside class="add-preview" data-testid="add-preview">
          <h4>Union preview</h4>
          <p>
            {{ toAdd.length }} new exploration{{ toAdd.length === 1 ? '' : 's' }}, from
            {{ newContextIds.size }} context{{ newContextIds.size === 1 ? '' : 's' }}.
          </p>
          <h4>Identity keys used</h4>
          <ul v-if="sharedKeys.length" class="keys">
            <li v-for="k in sharedKeys" :key="k.entity">
              <strong>{{ k.entity }}</strong> → {{ k.uses.join(' = ') }}
            </li>
          </ul>
          <p v-else class="hint">
            No identity key shared between these contexts: the explorations will sit
            side by side, without merged entities.
          </p>

          <h4>How it is kept</h4>
          <p class="hint">
            As a live reference: the case follows the exploration. Pin a version in the material
            list to freeze it with a hash.
          </p>
          <p class="hint">
            Whoever opens the case without access to one of these contexts sees a
            “restricted exploration” instead of its data.
          </p>
        </aside>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn btn-outline" @click="emit('close')">Cancel</button>
        <button
          type="button"
          class="btn btn-primary"
          data-testid="add-submit"
          :disabled="!caseId || toAdd.length === 0 || saving"
          @click="submit"
        >
          Add {{ toAdd.length }} exploration{{ toAdd.length === 1 ? '' : 's' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.add-modal {
  max-width: 960px;
  width: 95vw;
}

.add-body {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 20px;
  max-height: 65vh;
  overflow: auto;
}

@media (max-width: 720px) {
  .add-body {
    grid-template-columns: 1fr;
  }
}

.scope-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--color-bg-muted);
}

.tab {
  padding: 4px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.tab.on {
  background: var(--color-surface);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
}

.search {
  flex: 1;
  min-width: 160px;
}

.ctx-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
  display: block;
}

.exp-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  margin-bottom: 6px;
  cursor: pointer;
}

.exp-row.exp-checked {
  border-color: var(--primary-color);
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

.exp-title {
  display: block;
}

.exp-sub,
.hint {
  font-size: 12px;
  color: var(--text-muted);
}

.restricted {
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  margin-bottom: 8px;
}

.add-preview {
  border-left: 1px solid var(--border-color);
  padding-left: 16px;
  font-size: 13px;
}

.add-preview h4 {
  margin: 12px 0 6px;
}

.add-preview h4:first-child {
  margin-top: 0;
}

.keys {
  padding-left: 16px;
  margin: 0;
}

.mode-opt {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-bottom: 8px;
}
</style>
