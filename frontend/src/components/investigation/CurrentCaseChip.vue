<script setup lang="ts">
/**
 * Top-bar chip `[● título · #id ▾]` (05 §2): the current case, app-wide.
 * Opens a quick switch (5 recent + search over the queue) and "Novo caso".
 * Opening a case (`/investigations/:id`) or a graph with `?case=` makes it
 * current; a case that no longer exists or was unshared clears the chip.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Briefcase, ChevronDown, Plus } from 'lucide-vue-next';
import { api } from '@/services/api';
import { useCurrentCaseStore } from '@/stores/currentCase';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import type { Investigation } from '@/types/investigation';

const route = useRoute();
const router = useRouter();
const store = useCurrentCaseStore();
const { can } = usePermissions();
const toast = useToast();

const open = ref(false);
const search = ref('');
const all = ref<Investigation[]>([]);
const loading = ref(false);
const newTitle = ref('');
const creating = ref(false);

const matches = computed(() => {
  const q = search.value.trim().toLowerCase();
  const writable = all.value.filter((i) => i.status !== 'decided');
  if (!q) return [];
  return writable.filter((i) => i.title.toLowerCase().includes(q) || i.id.startsWith(q)).slice(0, 8);
});
const label = computed(() => (store.hasCase ? `${store.title || 'Caso'} · ${store.shortId}` : 'Sem caso atual'));

async function toggle() {
  open.value = !open.value;
  if (!open.value) return;
  search.value = '';
  newTitle.value = '';
  loading.value = true;
  try {
    all.value = await api.getInvestigations();
  } catch {
    all.value = [];
  } finally {
    loading.value = false;
  }
}

function pick(inv: { id: string; title: string }) {
  store.setCurrentCase(inv);
  open.value = false;
}

async function createCase() {
  const title = newTitle.value.trim();
  if (!title || creating.value) return;
  creating.value = true;
  try {
    const inv = await api.createInvestigation({ title });
    store.setCurrentCase(inv);
    open.value = false;
    await router.push(`/investigations/${inv.id}`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Falha ao criar o caso'));
  } finally {
    creating.value = false;
  }
}

onMounted(() => void store.ensureLoaded());

// Opening a case, or a graph started from one (?case=), makes it current.
watch(
  () => (route.name === 'investigation' ? String(route.params?.id) : (route.query?.case as string | undefined)) ?? null,
  (id) => {
    if (id && id !== store.caseId) store.setCurrentCase({ id, title: store.recent.find((r) => r.id === id)?.title ?? '' });
  },
  { immediate: true },
);
</script>

<template>
  <div class="case-chip-wrap">
    <button
      class="case-chip"
      :class="{ empty: !store.hasCase }"
      :title="store.hasCase ? `Caso atual: ${store.title}` : 'Nenhum caso atual: escolha um'"
      :aria-expanded="open"
      data-testid="current-case-chip"
      @click="toggle"
    >
      <span class="dot" aria-hidden="true">●</span>
      <Briefcase :size="13" />
      <span class="chip-label" data-testid="current-case-label">{{ label }}</span>
      <ChevronDown :size="12" />
    </button>

    <div v-if="open" class="case-menu" data-testid="current-case-menu" @click.stop>
      <input v-model="search" class="form-control" placeholder="Buscar caso…" aria-label="Buscar caso" data-testid="current-case-search" />
      <template v-if="search.trim()">
        <button v-for="inv in matches" :key="inv.id" class="menu-item" :data-testid="`current-case-pick-${inv.id}`" @click="pick(inv)">
          {{ inv.title }} <span class="muted">#{{ inv.id.slice(0, 4) }}</span>
        </button>
        <p v-if="!matches.length && !loading" class="muted hint">Nenhum caso encontrado.</p>
      </template>
      <template v-else>
        <p class="section">Recentes</p>
        <button
          v-for="inv in store.recentCases"
          :key="inv.id"
          class="menu-item"
          :class="{ on: inv.id === store.caseId }"
          :data-testid="`current-case-pick-${inv.id}`"
          @click="pick(inv)"
        >
          {{ inv.title || 'Caso' }} <span class="muted">#{{ inv.id.slice(0, 4) }}</span>
        </button>
        <p v-if="!store.recentCases.length" class="muted hint">Abra um caso ou busque pelo título.</p>
      </template>
      <div v-if="can('investigation.create')" class="new-case">
        <input v-model="newTitle" class="form-control" placeholder="Novo caso: título" data-testid="current-case-new-title" @keydown.enter="createCase" />
        <button class="btn btn-primary btn-sm" :disabled="!newTitle.trim() || creating" data-testid="current-case-new-submit" @click="createCase">
          <Plus :size="12" /> Novo caso
        </button>
      </div>
      <button v-if="store.hasCase" class="menu-item muted" data-testid="current-case-clear" @click="store.setCurrentCase(null); open = false">
        Sem caso atual
      </button>
    </div>
    <div v-if="open" class="backdrop" @click="open = false"></div>
  </div>
</template>

<style scoped>
.case-chip-wrap {
  position: relative;
}

.case-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 240px;
  padding: 3px 10px;
  border: 1px solid var(--color-primary, #0f766e);
  border-radius: var(--radius-pill, 999px);
  background: color-mix(in srgb, var(--color-primary, #0f766e) 10%, transparent);
  color: var(--color-primary, #0f766e);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.case-chip.empty {
  border-color: var(--border-color, #ddd);
  background: none;
  color: var(--text-muted, #666);
  font-weight: 500;
}

.case-chip .dot {
  font-size: 9px;
}

.case-chip.empty .dot {
  opacity: 0.4;
}

.chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.case-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 1001;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 300px;
  padding: 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: var(--radius-md, 8px);
  background: var(--card-background, #fff);
  box-shadow: 0 8px 24px rgb(0 0 0 / 15%);
  font-size: 13px;
}

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.section {
  margin: 4px 0 0;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #666);
}

.menu-item {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: none;
  font: inherit;
  text-align: left;
  color: var(--text-color, #333);
  cursor: pointer;
}

.menu-item:hover,
.menu-item.on {
  background: var(--bg-secondary, #f5f5f5);
}

.new-case {
  display: flex;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-color, #ddd);
}

.hint {
  margin: 4px 0;
  font-size: 12px;
}

.muted {
  color: var(--text-muted, #666);
}
</style>
