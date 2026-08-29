<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ChevronDown, Search, X } from 'lucide-vue-next';

/**
 * Picker for a fully-qualified warehouse table (`catalog.schema.table`).
 *
 * Replaces a native `<select>` that listed every table as one flat string. On
 * a real Databricks workspace that is 90+ options in which every row repeats
 * `catalog.schema.` and the only distinguishing part — the table name — sits
 * at the end, with no search: the browser's type-ahead matches the catalog,
 * which every option shares.
 *
 * Here the tables are grouped by `catalog.schema` (the grouping *is* the tree,
 * without making the user drill down three levels to reach a name they can
 * already type), the table name leads each row, and the search box filters on
 * any part of the qualified name.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    tables: string[];
    placeholder?: string;
    disabled?: boolean;
    testid?: string;
    /** Shown when the list is empty. */
    emptyHint?: string;
  }>(),
  { placeholder: 'Select a table…', disabled: false, testid: undefined, emptyHint: undefined },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const open = ref(false);
const query = ref('');
const manualMode = ref(false);
const manualValue = ref('');
const activeIndex = ref(0);
const rootRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);

/** `catalog.schema.table` → its parts; anything else is shown as-is. */
function split(name: string): { group: string; leaf: string } {
  const i = name.lastIndexOf('.');
  return i === -1 ? { group: '', leaf: name } : { group: name.slice(0, i), leaf: name.slice(i + 1) };
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.tables;
  return props.tables.filter((t) => t.toLowerCase().includes(q));
});

/** Groups in listing order, each with its tables — the shape the menu renders. */
const groups = computed(() => {
  const byGroup = new Map<string, string[]>();
  for (const table of filtered.value) {
    const { group } = split(table);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push(table);
  }
  return Array.from(byGroup, ([name, tables]) => ({ name, tables }));
});

/** Flat order of the rendered options, so the arrow keys can walk them. */
const flat = computed(() => groups.value.flatMap((g) => g.tables));

const selected = computed(() => (props.modelValue ? split(props.modelValue) : null));

watch(open, async (isOpen) => {
  if (!isOpen) return;
  query.value = '';
  activeIndex.value = Math.max(0, flat.value.indexOf(props.modelValue));
  await nextTick();
  searchRef.value?.focus();
});

watch(filtered, () => {
  activeIndex.value = 0;
});

function choose(table: string) {
  emit('update:modelValue', table);
  open.value = false;
}

function commitManual() {
  const value = manualValue.value.trim();
  if (!value) return;
  emit('update:modelValue', value);
  manualMode.value = false;
  manualValue.value = '';
  open.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const count = flat.value.length;
    if (count) activeIndex.value = (activeIndex.value + step + count) % count;
  } else if (event.key === 'Enter') {
    const table = flat.value[activeIndex.value];
    if (table) {
      event.preventDefault();
      choose(table);
    }
  } else if (event.key === 'Escape') {
    // Only the menu closes; the surrounding modal keeps its own Escape.
    event.stopPropagation();
    open.value = false;
  }
}

/**
 * Close on a click outside, via `pointerdown` on the document rather than the
 * component's `focusout`: pressing a button inside the menu fires `focusout`
 * from the search field *before* the new element takes focus, so a focus-based
 * guard closed the menu on mousedown and the click landed on nothing.
 */
function onPointerDown(event: PointerEvent) {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && rootRef.value?.contains(target)) return;
  open.value = false;
}

onMounted(() => document.addEventListener('pointerdown', onPointerDown, true));
onUnmounted(() => document.removeEventListener('pointerdown', onPointerDown, true));
</script>

<template>
  <div ref="rootRef" class="table-select" @keydown="onKeydown">
    <button
      type="button"
      class="ts-trigger form-control"
      :class="{ placeholder: !props.modelValue }"
      :disabled="props.disabled"
      :data-testid="props.testid"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span v-if="selected" class="ts-value">
        <span class="ts-leaf">{{ selected.leaf }}</span>
        <span v-if="selected.group" class="ts-group">{{ selected.group }}</span>
      </span>
      <span v-else>{{ props.placeholder }}</span>
      <ChevronDown :size="14" class="ts-chevron" />
    </button>

    <div v-if="open" class="ts-menu" role="listbox">
      <div class="ts-search">
        <Search :size="13" />
        <input
          ref="searchRef"
          v-model="query"
          type="text"
          class="ts-search-input"
          placeholder="Filter by catalog, schema or table…"
          :data-testid="props.testid ? `${props.testid}-search` : undefined"
        />
        <button v-if="query" type="button" class="ts-clear" aria-label="Clear filter" @click="query = ''">
          <X :size="12" />
        </button>
      </div>

      <div class="ts-list">
        <p v-if="props.tables.length === 0" class="ts-empty">
          {{ props.emptyHint ?? 'No tables available.' }}
        </p>
        <p v-else-if="flat.length === 0" class="ts-empty">
          Nothing matches “{{ query }}”.
        </p>

        <template v-for="group in groups" :key="group.name || '—'">
          <div class="ts-group-header">{{ group.name || 'Other' }}</div>
          <button
            v-for="table in group.tables"
            :key="table"
            type="button"
            role="option"
            class="ts-option"
            :class="{
              active: flat[activeIndex] === table,
              selected: table === props.modelValue,
            }"
            :aria-selected="table === props.modelValue"
            :data-testid="`table-option-${table}`"
            @click="choose(table)"
            @mousemove="activeIndex = flat.indexOf(table)"
          >
            {{ split(table).leaf }}
          </button>
        </template>
      </div>

      <!--
        The backend only lists tables whose name contains "edge" or "node", so a
        table called `relationships` cannot be picked from the list at all. Until
        that changes, typing the qualified name is the way through.
      -->
      <div class="ts-footer">
        <button
          v-if="!manualMode"
          type="button"
          class="ts-manual-toggle"
          :data-testid="props.testid ? `${props.testid}-manual` : undefined"
          @click="manualMode = true"
        >
          Table not listed? Enter its full name
        </button>
        <form v-else class="ts-manual" @submit.prevent="commitManual">
          <input
            v-model="manualValue"
            type="text"
            class="ts-manual-input"
            placeholder="catalog.schema.table"
            :data-testid="props.testid ? `${props.testid}-manual-input` : undefined"
          />
          <button
            type="submit"
            class="ts-manual-use"
            :disabled="!manualValue.trim()"
            :data-testid="props.testid ? `${props.testid}-manual-use` : undefined"
          >
            Use
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-select {
  position: relative;
}

.ts-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  text-align: left;
  cursor: pointer;
  background: var(--color-surface);
}
.ts-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.ts-trigger.placeholder {
  color: var(--color-text-muted);
}

.ts-value {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}
.ts-leaf {
  font-weight: var(--font-medium);
}
/* The qualified path is context, not the answer — it stays legible but never
   competes with the table name. */
.ts-group {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-chevron {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.ts-menu {
  position: absolute;
  z-index: var(--z-dropdown);
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.ts-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-muted);
}
.ts-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  font: inherit;
  font-size: var(--text-sm);
  background: transparent;
  color: var(--color-text);
}
.ts-clear {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--color-text-muted);
  display: inline-flex;
  padding: 0;
}

.ts-list {
  max-height: 260px;
  overflow-y: auto;
  padding: var(--space-1) 0;
}

.ts-group-header {
  position: sticky;
  top: 0;
  padding: 4px var(--space-3);
  background: var(--color-bg-muted);
  font-family: monospace;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.ts-option {
  display: block;
  width: 100%;
  padding: 6px var(--space-4);
  border: none;
  background: none;
  text-align: left;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-text);
  cursor: pointer;
}
.ts-option.active {
  background: var(--color-bg-muted);
}
.ts-option.selected {
  color: var(--color-primary);
  font-weight: var(--font-semibold);
}

.ts-empty {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.ts-footer {
  border-top: 1px solid var(--color-border);
  padding: var(--space-2) var(--space-3);
}
.ts-manual-toggle {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-primary);
  cursor: pointer;
}
.ts-manual {
  display: flex;
  gap: var(--space-2);
}
.ts-manual-input {
  flex: 1;
  min-width: 0;
  padding: 4px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--text-sm);
  font-family: monospace;
}
.ts-manual-use {
  padding: 4px var(--space-3);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: #fff;
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}
.ts-manual-use:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
