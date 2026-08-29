<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronRight, Search, X, AlertTriangle } from 'lucide-vue-next';

/**
 * Picks the edge table and the node table together.
 *
 * They used to be two independent dropdowns over flat `catalog.schema.table`
 * strings. That is the wrong shape for the task twice over:
 *
 * - The two tables are a *pair*, almost always from the same schema. Choosing
 *   them separately means naming the catalog and schema twice, and nothing
 *   notices when they end up in different ones.
 * - A dropdown answers "which of these names do I want" — but someone meeting
 *   a workspace for the first time is *browsing*, and a popover that closes
 *   when you look away is the worst place to browse.
 *
 * So: search across everything for people who know the name, a catalog/schema
 * tree for people who do not, and the role assignment (Edges / Nodes) on the
 * table row itself so the pair is chosen in one place.
 */
const props = withDefaults(
  defineProps<{
    edgeTables: string[];
    nodeTables: string[];
    edgeValue: string;
    nodeValue: string;
    /** Triple store: nodes come from the edge endpoints, so no node table. */
    nodeDisabled?: boolean;
  }>(),
  { nodeDisabled: false },
);

const emit = defineEmits<{
  'update:edgeValue': [value: string];
  'update:nodeValue': [value: string];
}>();

type Role = 'edge' | 'node';

interface TableEntry {
  full: string;
  catalog: string;
  schema: string;
  name: string;
  canBeEdge: boolean;
  canBeNode: boolean;
}

function parse(full: string) {
  const parts = full.split('.');
  if (parts.length >= 3) {
    return { catalog: parts[0], schema: parts.slice(1, -1).join('.'), name: parts[parts.length - 1] };
  }
  if (parts.length === 2) return { catalog: '', schema: parts[0], name: parts[1] };
  return { catalog: '', schema: '', name: full };
}

/** One row per table, carrying which roles the warehouse offers it for. */
const entries = computed<TableEntry[]>(() => {
  const byFull = new Map<string, TableEntry>();
  const add = (full: string, role: Role) => {
    const existing = byFull.get(full);
    if (existing) {
      if (role === 'edge') existing.canBeEdge = true;
      else existing.canBeNode = true;
      return;
    }
    byFull.set(full, {
      full,
      ...parse(full),
      canBeEdge: role === 'edge',
      canBeNode: role === 'node',
    });
  };
  props.edgeTables.forEach((t) => add(t, 'edge'));
  props.nodeTables.forEach((t) => add(t, 'node'));
  return Array.from(byFull.values()).sort((a, b) => a.full.localeCompare(b.full));
});

/** `catalog.schema` → its tables, for the browse tree. */
const locations = computed(() => {
  const byLocation = new Map<string, TableEntry[]>();
  for (const entry of entries.value) {
    const key = [entry.catalog, entry.schema].filter(Boolean).join('.');
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key)!.push(entry);
  }
  return byLocation;
});

const catalogs = computed(() => {
  const byCatalog = new Map<string, { schema: string; location: string; count: number }[]>();
  for (const [location, tables] of locations.value) {
    const [catalog, ...rest] = location.split('.');
    const schema = rest.join('.') || catalog;
    const key = rest.length ? catalog : '';
    if (!byCatalog.has(key)) byCatalog.set(key, []);
    byCatalog.get(key)!.push({ schema, location, count: tables.length });
  }
  return Array.from(byCatalog, ([name, schemas]) => ({ name, schemas }));
});

const search = ref('');
const expanded = ref(new Set<string>());
const activeLocation = ref('');
const manualMode = ref(false);
const manualValue = ref('');
const manualRole = ref<Role>('edge');

/** Follow the current selection: open where the user already is. */
watch(
  () => [props.edgeValue, props.nodeValue, locations.value.size] as const,
  () => {
    const current = props.edgeValue || props.nodeValue;
    if (current) {
      const { catalog, schema } = parse(current);
      const location = [catalog, schema].filter(Boolean).join('.');
      if (locations.value.has(location)) {
        activeLocation.value = location;
        if (catalog) expanded.value.add(catalog);
        return;
      }
    }
    if (!activeLocation.value && locations.value.size) {
      const [first] = locations.value.keys();
      activeLocation.value = first;
      expanded.value.add(first.split('.')[0]);
    }
  },
  { immediate: true },
);

const searching = computed(() => search.value.trim().length > 0);

const results = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (q) return entries.value.filter((e) => e.full.toLowerCase().includes(q));
  return locations.value.get(activeLocation.value) ?? [];
});

function toggleCatalog(name: string) {
  if (expanded.value.has(name)) expanded.value.delete(name);
  else expanded.value.add(name);
  expanded.value = new Set(expanded.value);
}

function assign(entry: TableEntry, role: Role) {
  const current = role === 'edge' ? props.edgeValue : props.nodeValue;
  // Clicking the role a table already holds clears it — the same button both
  // assigns and unassigns, so there is no separate "clear" affordance.
  const next = current === entry.full ? '' : entry.full;
  if (role === 'edge') emit('update:edgeValue', next);
  else emit('update:nodeValue', next);
}

function commitManual() {
  const value = manualValue.value.trim();
  if (!value) return;
  if (manualRole.value === 'edge') emit('update:edgeValue', value);
  else emit('update:nodeValue', value);
  manualValue.value = '';
  manualMode.value = false;
}

const edgeParts = computed(() => (props.edgeValue ? parse(props.edgeValue) : null));
const nodeParts = computed(() => (props.nodeValue ? parse(props.nodeValue) : null));

/** The shared `catalog.schema`, shown once instead of on both chips. */
const sharedLocation = computed(() => {
  const e = edgeParts.value;
  const n = nodeParts.value;
  if (!e) return null;
  const eLoc = [e.catalog, e.schema].filter(Boolean).join('.');
  if (props.nodeDisabled || !n) return eLoc;
  const nLoc = [n.catalog, n.schema].filter(Boolean).join('.');
  return eLoc === nLoc ? eLoc : null;
});

/**
 * Two tables from different schemas are legal but almost always a slip — the
 * old pair of dropdowns could not even see it happen.
 */
const mismatched = computed(
  () => !props.nodeDisabled && !!edgeParts.value && !!nodeParts.value && sharedLocation.value === null,
);
</script>

<template>
  <div class="wtp" data-testid="warehouse-table-picker">
    <!-- What is chosen, stated once. -->
    <div class="wtp-summary">
      <div class="wtp-chips">
        <span class="wtp-chip" :class="{ empty: !edgeValue }" data-testid="picked-edge-table">
          <span class="wtp-role">Edges</span>
          <span v-if="edgeParts" class="wtp-name">{{ edgeParts.name }}</span>
          <span v-else class="wtp-none">not chosen</span>
        </span>
        <span
          v-if="!nodeDisabled"
          class="wtp-chip"
          :class="{ empty: !nodeValue }"
          data-testid="picked-node-table"
        >
          <span class="wtp-role">Nodes</span>
          <span v-if="nodeParts" class="wtp-name">{{ nodeParts.name }}</span>
          <span v-else class="wtp-none">not chosen</span>
        </span>
        <span v-else class="wtp-chip derived">
          <span class="wtp-role">Nodes</span>
          <span class="wtp-none">derived from the edge endpoints</span>
        </span>
        <code v-if="sharedLocation" class="wtp-location">{{ sharedLocation }}</code>
      </div>
      <p v-if="mismatched" class="wtp-warning" data-testid="table-schema-mismatch">
        <AlertTriangle :size="13" />
        The two tables are in different schemas
        (<code>{{ edgeParts!.catalog }}.{{ edgeParts!.schema }}</code> and
        <code>{{ nodeParts!.catalog }}.{{ nodeParts!.schema }}</code>). That works only if
        the ids in one really refer to the other.
      </p>
    </div>

    <div class="wtp-search">
      <Search :size="13" />
      <input
        v-model="search"
        type="text"
        class="wtp-search-input"
        placeholder="Search every catalog and schema…"
        data-testid="table-search"
      />
      <button v-if="search" type="button" class="wtp-clear" aria-label="Clear search" @click="search = ''">
        <X :size="12" />
      </button>
    </div>

    <div class="wtp-body">
      <!-- Browse: catalog › schema. Hidden while searching, which spans them all. -->
      <nav v-if="!searching" class="wtp-tree" aria-label="Catalogs and schemas">
        <template v-for="catalog in catalogs" :key="catalog.name || '—'">
          <button
            v-if="catalog.name"
            type="button"
            class="wtp-catalog"
            :aria-expanded="expanded.has(catalog.name)"
            :data-testid="`catalog-${catalog.name}`"
            @click="toggleCatalog(catalog.name)"
          >
            <ChevronRight :size="12" class="wtp-chevron" :class="{ open: expanded.has(catalog.name) }" />
            {{ catalog.name }}
          </button>
          <button
            v-for="schema in catalog.schemas"
            v-show="!catalog.name || expanded.has(catalog.name)"
            :key="schema.location"
            type="button"
            class="wtp-schema"
            :class="{ active: activeLocation === schema.location }"
            :data-testid="`schema-${schema.location}`"
            @click="activeLocation = schema.location"
          >
            {{ schema.schema }}
            <span class="wtp-count">{{ schema.count }}</span>
          </button>
        </template>
      </nav>

      <!-- Tables of the chosen schema (or the search hits), with the role
           buttons on the row so the pair is picked in one place. -->
      <div class="wtp-tables">
        <p v-if="entries.length === 0" class="wtp-empty">
          The warehouse listed no tables. Use “not listed” below to name one directly.
        </p>
        <p v-else-if="results.length === 0" class="wtp-empty">
          Nothing matches “{{ search }}”.
        </p>
        <div
          v-for="entry in results"
          :key="entry.full"
          class="wtp-row"
          :data-testid="`table-row-${entry.full}`"
        >
          <span class="wtp-table-name">
            {{ entry.name }}
            <code v-if="searching" class="wtp-row-location">{{ entry.catalog }}.{{ entry.schema }}</code>
          </span>
          <span class="wtp-roles">
            <button
              type="button"
              class="wtp-role-btn"
              :class="{ on: edgeValue === entry.full }"
              :disabled="!entry.canBeEdge"
              :title="entry.canBeEdge ? 'Use as the edge table' : 'The warehouse does not list this as an edge table'"
              :data-testid="`assign-edge-${entry.full}`"
              @click="assign(entry, 'edge')"
            >
              Edges
            </button>
            <button
              type="button"
              class="wtp-role-btn"
              :class="{ on: nodeValue === entry.full }"
              :disabled="!entry.canBeNode || nodeDisabled"
              :title="nodeDisabled
                ? 'This context derives nodes from the edge endpoints'
                : entry.canBeNode ? 'Use as the node table' : 'The warehouse does not list this as a node table'"
              :data-testid="`assign-node-${entry.full}`"
              @click="assign(entry, 'node')"
            >
              Nodes
            </button>
          </span>
        </div>
      </div>
    </div>

    <!--
      The warehouse only lists tables whose name contains "edge" or "node", so a
      table called `transacoes` never appears above.
    -->
    <div class="wtp-manual">
      <button
        v-if="!manualMode"
        type="button"
        class="wtp-manual-toggle"
        data-testid="table-manual"
        @click="manualMode = true"
      >
        Table not listed? Name it directly
      </button>
      <form v-else class="wtp-manual-form" @submit.prevent="commitManual">
        <select v-model="manualRole" class="wtp-manual-role" aria-label="Role" data-testid="table-manual-role">
          <option value="edge">Edges</option>
          <option value="node" :disabled="nodeDisabled">Nodes</option>
        </select>
        <input
          v-model="manualValue"
          type="text"
          class="wtp-manual-input"
          placeholder="catalog.schema.table"
          data-testid="table-manual-input"
        />
        <button type="submit" class="wtp-manual-use" :disabled="!manualValue.trim()" data-testid="table-manual-use">
          Use
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.wtp {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

/* ── Selection summary ───────────────────────────────────── */
.wtp-summary {
  padding: var(--space-3);
  background: var(--color-bg-subtle);
  border-bottom: 1px solid var(--color-border);
}
.wtp-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.wtp-chip {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 3px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  font-size: var(--text-sm);
}
.wtp-chip.empty { border-style: dashed; }
.wtp-chip.derived { border-style: dashed; }
.wtp-role {
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
.wtp-name { font-weight: var(--font-medium); }
.wtp-none { color: var(--color-text-muted); font-style: italic; }
.wtp-location {
  font-family: monospace;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.wtp-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--color-warning);
}
.wtp-warning code { font-size: var(--text-xs); }

/* ── Search ──────────────────────────────────────────────── */
.wtp-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-muted);
}
.wtp-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-text);
}
.wtp-clear {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: var(--color-text-muted);
  display: inline-flex;
}

/* ── Browse + tables ─────────────────────────────────────── */
.wtp-body {
  display: flex;
  min-height: 190px;
  max-height: 260px;
}
.wtp-tree {
  width: 40%;
  max-width: 240px;
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
  padding: var(--space-1) 0;
  background: var(--color-bg-subtle);
}
.wtp-catalog,
.wtp-schema {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  border: none;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: var(--color-text);
}
/* Sticky: scrolling the schema list must never leave you unsure which catalog
   the schemas under the cursor belong to. */
.wtp-catalog {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--color-bg-subtle);
  padding: 4px var(--space-2);
  font-size: var(--text-xs);
  font-family: monospace;
  color: var(--color-text-muted);
}
.wtp-schema {
  padding: 4px var(--space-2) 4px var(--space-5);
  font-size: var(--text-sm);
  justify-content: space-between;
}
.wtp-schema:hover,
.wtp-catalog:hover { background: var(--color-bg-muted); }
.wtp-schema.active {
  background: var(--color-primary-subtle);
  color: var(--color-primary);
  font-weight: var(--font-medium);
}
.wtp-chevron { transition: transform var(--transition-fast); flex-shrink: 0; }
.wtp-chevron.open { transform: rotate(90deg); }
.wtp-count {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.wtp-tables {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: var(--space-1) 0;
}
.wtp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 4px var(--space-3);
}
.wtp-row:hover { background: var(--color-bg-muted); }
.wtp-table-name {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wtp-row-location {
  font-family: monospace;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.wtp-roles { display: flex; gap: 4px; flex-shrink: 0; }
.wtp-role-btn {
  padding: 2px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  font: inherit;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  cursor: pointer;
}
/* `:not(.on)` matters: `:hover:not(:disabled)` outranks `.wtp-role-btn.on` on
   specificity, so without it the pointer resting on a just-clicked button
   painted teal text on the teal background and the label vanished. */
.wtp-role-btn:hover:not(:disabled):not(.on) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.wtp-role-btn.on {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
  font-weight: var(--font-semibold);
}
.wtp-role-btn.on:hover { background: var(--color-primary-hover); }
.wtp-role-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.wtp-empty {
  margin: 0;
  padding: var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

/* ── Manual entry ────────────────────────────────────────── */
.wtp-manual {
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border);
}
.wtp-manual-toggle {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-primary);
  cursor: pointer;
}
.wtp-manual-form { display: flex; gap: var(--space-2); }
.wtp-manual-role,
.wtp-manual-input {
  padding: 4px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--text-sm);
}
.wtp-manual-input { flex: 1; min-width: 0; font-family: monospace; }
.wtp-manual-use {
  padding: 4px var(--space-3);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: #fff;
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}
.wtp-manual-use:disabled { opacity: 0.5; cursor: not-allowed; }

@media (max-width: 620px) {
  .wtp-body { flex-direction: column; max-height: none; }
  .wtp-tree { width: auto; max-width: none; border-right: none; border-bottom: 1px solid var(--color-border); max-height: 130px; }
}
</style>
