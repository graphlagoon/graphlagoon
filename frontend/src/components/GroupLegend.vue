<script setup lang="ts">
/**
 * The groups on the graph (communities, or clusters from a program) as a
 * small legend you can click, for when the Clusters panel is closed: click =
 * show only that group, Shift/Ctrl+click = add or remove it (useGroupRows,
 * the same rules as the panel's list).
 *
 * - `floating` (exploration): a card over the canvas, bottom-right (the
 *   canvas toolbar holds bottom-left), folded
 *   into a "● N groups" pill by default on narrow screens so it never covers
 *   the graph unasked.
 * - `chips` (case): one line of chips in the top strip, nothing over the canvas.
 */
import { computed, ref } from 'vue';
import { useGroupRows, type GroupKind } from '@/composables/useGroupRows';
import { useGraphStore } from '@/stores/graph';

const props = withDefaults(defineProps<{ variant?: 'floating' | 'chips'; max?: number }>(), {
  variant: 'floating',
  max: 8,
});

const emit = defineEmits<{
  /** "more…": open the Clusters panel on its list. */
  'open-panel': [];
}>();

const groups = useGroupRows();
const graphStore = useGraphStore();

/** Communities when there is a coloring, else the program clusters. */
const kind = computed<GroupKind>(() => (groups.communityRows.value.length > 0 ? 'community' : 'cluster'));
const rows = computed(() => groups.rowsOf(kind.value));
const shownRows = computed(() => rows.value.slice(0, props.max));
const more = computed(() => rows.value.length - shownRows.value.length);

const NARROW_PX = 900;
const folded = ref(typeof window !== 'undefined' && window.innerWidth < NARROW_PX);
</script>

<template>
  <div
    v-if="rows.length > 0"
    class="group-legend"
    :class="`group-legend--${props.variant}`"
    data-testid="group-legend"
  >
    <template v-if="props.variant === 'floating' && folded">
      <button class="legend-pill" data-testid="group-legend-unfold" @click="folded = false">
        <span class="dot" :style="{ backgroundColor: rows[0].color }"></span>
        {{ rows.length }} {{ kind === 'community' ? 'groups' : 'clusters' }}
      </button>
    </template>
    <template v-else>
      <div v-if="props.variant === 'floating'" class="legend-head">
        <span>{{ kind === 'community' ? 'Groups' : 'Clusters' }}</span>
        <button
          v-if="graphStore.isolation"
          class="link"
          data-testid="group-legend-show-all"
          @click="graphStore.clearIsolation()"
        >show all</button>
        <button class="link" aria-label="Fold the legend" data-testid="group-legend-fold" @click="folded = true">–</button>
      </div>
      <button
        v-for="row in shownRows"
        :key="row.key"
        class="legend-row"
        :class="{ off: !groups.isShown(row), solo: groups.isSolo(row) }"
        :aria-pressed="groups.isSolo(row)"
        :title="groups.isSolo(row) ? 'Show every node' : `Show only ${row.label} (Shift+click: add or remove)`"
        :data-testid="`group-legend-${row.key}`"
        @click="groups.clickRow(row, $event)"
      >
        <span class="dot" :style="{ backgroundColor: row.color }"></span>
        <span class="name">{{ row.label }}</span>
        <span class="count">{{ row.count }}</span>
      </button>
      <button v-if="more > 0" class="legend-row more" data-testid="group-legend-more" @click="emit('open-panel')">
        +{{ more }} more…
      </button>
      <button
        v-if="props.variant === 'chips' && graphStore.isolation"
        class="legend-row more"
        data-testid="group-legend-show-all"
        @click="graphStore.clearIsolation()"
      >show all</button>
    </template>
  </div>
</template>

<style scoped>
.group-legend--floating {
  position: absolute;
  right: 16px;
  bottom: 48px;
  z-index: 15;
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-width: 220px;
  max-height: 40%;
  overflow-y: auto;
  padding: 6px;
  background: var(--card-background, #fff);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  font-size: 12px;
}

.group-legend--chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.legend-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 4px;
  font-weight: 600;
  color: var(--text-muted, #666);
}

.legend-head span {
  flex: 1;
}

.link {
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--primary-color, #42b883);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}

.legend-row,
.legend-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid transparent;
  background: none;
  padding: 3px 6px;
  border-radius: 6px;
  font: inherit;
  color: var(--text-color, #333);
  cursor: pointer;
  text-align: left;
}

.group-legend--chips .legend-row {
  border-color: var(--border-color, #ddd);
  border-radius: 12px;
  background: var(--card-background, #fff);
}

.legend-pill {
  background: var(--card-background, #fff);
  border-color: var(--border-color, #ddd);
  border-radius: 12px;
}

.legend-row:hover {
  background: var(--hover-background, #f2f7f5);
}

.legend-row.solo {
  border-color: var(--primary-color, #42b883);
}

.legend-row.off {
  opacity: 0.45;
}

.legend-row:focus-visible,
.legend-pill:focus-visible,
.link:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
}

.count {
  color: var(--text-muted, #999);
  font-size: 11px;
}

.more {
  color: var(--text-muted, #666);
}
</style>
