<script setup lang="ts">
/**
 * The graphs of the case as chips in the strip over the canvas (UX-1): click
 * one to show only it, Shift/Ctrl+click to add or remove it, "All graphs" to
 * unify them. The ring color is the node ring of that source on a unified
 * canvas. The fill legend (roles or groups) and the merge summary live in a
 * popover, so nothing sits over the nodes.
 */
import { computed, ref } from 'vue';
import { AlertTriangle } from 'lucide-vue-next';
import { useInvestigationStore } from '@/stores/investigation';
import { roleColor } from '@/utils/graphAppearance';
import { mergedEntityCounts } from '@/utils/unifyGraph';

const props = defineProps<{ paintByGroup: boolean }>();
const emit = defineEmits<{
  pick: [id: string, event: MouseEvent];
  'show-all': [];
  'show-one': [event: MouseEvent];
}>();

const store = useInvestigationStore();
const open = ref(false);

const legendRoles = computed(() => [...new Set(Object.values(store.roles))].sort());
const mergedCounts = computed(() => mergedEntityCounts(store.unified.nodes));
const mergedTotal = computed(() => Object.values(mergedCounts.value).reduce((a, b) => a + b, 0));
const hasFillLegend = computed(() => (props.paintByGroup ? store.groups.length > 0 : legendRoles.value.length > 0));
</script>

<template>
  <div v-if="store.readableGraphItems.length" class="graph-chips" data-testid="provenance-legend" @keydown.esc="open = false">
    <!-- One scrolling row: eight graphs used to wrap into a 160 px block over a 1024 px canvas. -->
    <div class="graph-scroll">
      <button
        v-for="s in store.readableGraphItems"
        :key="s.id"
        type="button"
        class="chip graph"
        :class="{ off: !store.canvasIds.has(s.id) }"
        :aria-pressed="store.canvasIds.has(s.id)"
        :title="store.sourceErrors[s.id] ?? 'Show only this graph · Shift+click adds or removes it'"
        :data-testid="`legend-item-${s.id}`"
        @click="emit('pick', s.id, $event)"
      >
        <span class="ring" :style="{ borderColor: store.sourceColors[s.id] }"></span>
        <span class="name">{{ s.title }}</span>
        <AlertTriangle v-if="store.sourceErrors[s.id]" :size="14" class="warn" :aria-label="`Could not load: ${store.sourceErrors[s.id]}`" :data-testid="`legend-error-${s.id}`" />
      </button>
    </div>

    <button
      v-if="store.readableGraphItems.length > 1"
      type="button"
      class="chip"
      :data-testid="store.allOnCanvas ? 'canvas-one' : 'canvas-all'"
      :title="store.allOnCanvas ? 'Back to one graph at a time' : 'Unify every graph on one canvas, one ring per source'"
      @click="store.allOnCanvas ? emit('show-one', $event) : emit('show-all')"
    >
      {{ store.allOnCanvas ? 'One at a time' : `All graphs (${store.readableGraphItems.length})` }}
    </button>

    <span v-if="store.canvasItems.length > 1" class="muted" data-testid="unification-summary">
      <template v-if="mergedTotal">
        {{ mergedTotal }} entities merged by identity key:
        {{ Object.entries(mergedCounts).map(([e, n]) => `${n} by ${e}`).join(', ') }}
      </template>
      <template v-else>No entity merged across items yet.</template>
    </span>

    <span v-if="hasFillLegend" class="chip-wrap">
      <button type="button" class="chip" :class="{ open }" data-testid="legend-toggle" @click="open = !open">
        legend ▾
      </button>
      <div v-if="open" class="menu" data-testid="legend-menu">
        <div class="legend-title">Ring: the graph it came from</div>
        <template v-if="paintByGroup && store.groups.length">
          <div class="legend-title">Group (fill)</div>
          <div v-for="g in store.groups" :key="g.id" class="legend-row"><span class="fill" :style="{ background: g.color }"></span>{{ g.name }}</div>
        </template>
        <template v-else-if="legendRoles.length">
          <div class="legend-title">Role (fill)</div>
          <div v-for="role in legendRoles" :key="role" class="legend-row">
            <span class="fill" :style="{ background: roleColor(role) }"></span>
            {{ role }}
          </div>
        </template>
      </div>
    </span>
  </div>
</template>

<style scoped>
.graph-scroll {
  display: flex;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: thin;
}

.graph-scroll > .chip {
  flex-shrink: 0;
}

.graph-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 3px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  background: var(--color-surface);
  font: inherit;
  font-size: 12px;
  color: var(--text-color);
  cursor: pointer;
}

.chip.graph {
  font-weight: 600;
}

.chip.off {
  opacity: 0.5;
  font-weight: 400;
}

.chip.open {
  border-color: var(--color-primary);
}

.chip:hover,
.chip:focus-visible {
  border-color: var(--color-primary);
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ring {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  border: 2px solid;
  border-radius: 50%;
}

.warn {
  flex-shrink: 0;
  color: var(--color-warning, #d97706);
}

.muted {
  color: var(--text-muted);
}

.chip-wrap {
  position: relative;
}

.menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  min-width: 180px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.12));
}

.legend-title {
  margin: 6px 0 4px;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  white-space: nowrap;
}

.legend-title:first-child {
  margin-top: 0;
}

.legend-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  white-space: nowrap;
}

.fill {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
</style>
