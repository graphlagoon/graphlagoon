<script setup lang="ts">
/**
 * Filter chips over the canvas (05 §3): fonte, papel, tag, grupo, tipo, janela
 * temporal and the audited 👁 toggle. Multi-value, visual only (the layout
 * stays). Saved views keep the chips, the layout and the closed groups (05 §5).
 */
import { computed, ref } from 'vue';
import { Eye, EyeOff, X } from 'lucide-vue-next';
import { useCaseFilters, type ChipField } from '@/stores/caseFilters';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { ROLE_LABELS } from '@/utils/graphAppearance';
import type { CaseItem, CaseViewContent } from '@/types/investigation';

const props = defineProps<{ canEdit: boolean }>();
const emit = defineEmits<{ 'apply-view': [content: CaseViewContent] }>();

const filters = useCaseFilters();
const store = useInvestigationStore();
const graph = useGraphStore();
const toast = useToast();

const open = ref<string | null>(null);
const viewName = ref('');

interface Chip {
  id: ChipField | 'types';
  label: string;
  options: { value: string; label: string; color?: string }[];
  selected: string[];
  toggle: (value: string) => void;
}

const chips = computed<Chip[]>(() => [
  {
    id: 'sources',
    label: 'fonte',
    options: store.canvasItems.map((s) => ({ value: s.id, label: s.title, color: store.sourceColors[s.id] })),
    selected: filters.sources,
    toggle: (v) => filters.toggle('sources', v),
  },
  {
    id: 'roles',
    label: 'papel',
    options: [...new Set([...store.vocabulary.roles, ...Object.values(store.roles)])].map((r) => ({ value: r, label: ROLE_LABELS[r] ?? r })),
    selected: filters.roles,
    toggle: (v) => filters.toggle('roles', v),
  },
  { id: 'tags', label: 'tag', options: store.tagsUsed.map((t) => ({ value: t, label: t })), selected: filters.tags, toggle: (v) => filters.toggle('tags', v) },
  {
    id: 'groups',
    label: 'grupo',
    options: store.groups.map((g) => ({ value: g.id, label: `${g.name} · ${g.targets.length}`, color: g.color })),
    selected: filters.groups,
    toggle: (v) => filters.toggle('groups', v),
  },
  { id: 'types', label: 'tipo', options: graph.nodeTypes.map((t) => ({ value: t, label: t })), selected: filters.types, toggle: (v) => filters.toggleType(v) },
]);

const windowLabel = computed(() => {
  const w = filters.window;
  if (!w) return null;
  const f = (t: number) => new Date(t).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `${f(w[0])} – ${f(w[1])}`;
});

function summary(c: Chip): string {
  if (!c.selected.length) return c.label;
  const names = c.selected.map((v) => c.options.find((o) => o.value === v)?.label ?? v);
  return names.length > 2 ? `${c.label}: ${names.length}` : `${c.label}: ${names.join(', ')}`;
}

async function saveView() {
  const title = viewName.value.trim() || `View ${store.views.length + 1}`;
  try {
    await store.saveView(title, { filters: filters.snapshot(), layout: graph.layoutAlgorithm, groups_closed: [...store.groupsClosed] });
    viewName.value = '';
    open.value = null;
    toast.success(`View “${title}” saved`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to save the view'));
  }
}

async function applyView(item: CaseItem) {
  try {
    const content = await store.loadItemJson<CaseViewContent>(item);
    if (!content) return;
    filters.restore(content.filters);
    emit('apply-view', content);
    open.value = null;
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to load the view'));
  }
}
</script>

<template>
  <div class="chips" data-testid="case-filter-chips" @keydown.esc="open = null">
    <template v-for="c in chips" :key="c.id">
      <span class="chip-wrap">
        <button
          class="chip"
          :class="{ on: c.selected.length, open: open === c.id }"
          :data-testid="`chip-${c.id}`"
          :disabled="!c.options.length"
          @click="open = open === c.id ? null : c.id"
        >
          {{ summary(c) }} ▾
        </button>
        <div v-if="open === c.id" class="menu" :data-testid="`chip-menu-${c.id}`">
          <label v-for="o in c.options" :key="o.value" class="opt">
            <input type="checkbox" :checked="c.selected.includes(o.value)" :data-testid="`chip-opt-${c.id}-${o.value}`" @change="c.toggle(o.value)" />
            <span v-if="o.color" class="swatch" :style="{ background: o.color }"></span>
            {{ o.label }}
          </label>
        </div>
      </span>
    </template>

    <button v-if="windowLabel" class="chip on" data-testid="chip-window" title="Time window from the timeline; click to clear" @click="filters.window = null">
      ⏱ {{ windowLabel }} ✕
    </button>

    <button
      class="chip eye"
      :class="{ on: filters.unmasked }"
      :title="filters.unmasked ? 'Documents shown in clear (journaled); click to mask' : 'Documents masked; click to show in clear (journaled)'"
      data-testid="chip-unmasked"
      @click="filters.setUnmasked(!filters.unmasked)"
    >
      <component :is="filters.unmasked ? Eye : EyeOff" :size="13" /> {{ filters.unmasked ? 'em claro' : 'mascarado' }}
    </button>

    <button v-if="filters.activeCount" class="chip clear" data-testid="chips-clear" title="Clear every filter" @click="filters.clear()">
      <X :size="13" /> {{ filters.activeCount }}
    </button>

    <span class="chip-wrap views">
      <button class="chip" :class="{ open: open === 'views' }" data-testid="chip-views" @click="open = open === 'views' ? null : 'views'">
        visões<template v-if="store.views.length"> · {{ store.views.length }}</template> ▾
      </button>
      <div v-if="open === 'views'" class="menu" data-testid="views-menu">
        <button v-for="v in store.views" :key="v.id" class="opt link" :data-testid="`view-apply-${v.id}`" @click="applyView(v)">{{ v.title }}</button>
        <p v-if="!store.views.length" class="muted">No saved view yet.</p>
        <form v-if="props.canEdit" class="save" @submit.prevent="saveView">
          <input v-model="viewName" placeholder="Name this view" data-testid="view-name" />
          <button class="btn btn-primary btn-sm" data-testid="view-save">Save view</button>
        </form>
      </div>
    </span>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--color-surface);
  font-size: 12px;
}

.chip-wrap {
  position: relative;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  background: var(--color-surface);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-color);
}

.chip:disabled {
  opacity: 0.5;
  cursor: default;
}

.chip.on {
  border-color: var(--color-primary);
  background: var(--color-primary-subtle);
  color: var(--color-primary);
  font-weight: 600;
}

.chip.open {
  border-color: var(--color-primary);
}

.chip.clear {
  border-style: dashed;
}

.menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  min-width: 220px;
  max-height: 280px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.12));
}

.opt {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  font-size: 13px;
  white-space: nowrap;
}

.opt.link {
  width: 100%;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  color: var(--color-primary);
  cursor: pointer;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.views {
  margin-left: auto;
}

.save {
  display: flex;
  gap: 6px;
  padding: 6px;
  border-top: 1px solid var(--border-color);
}

.save input {
  flex: 1;
  min-width: 0;
}

.muted {
  margin: 4px 6px;
  color: var(--text-muted);
}
</style>
