<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useSchemaDrift } from '@/composables/useSchemaDrift';
import { useContextsStore } from '@/stores/contexts';
import { api } from '@/services/api';
import {
  collectPropertyReferences,
  findRawQueryReferences,
  findDanglingReferences,
  type PropertyReference,
} from '@/utils/contextReferences';
import type { GraphContext, PropertyColumn, SchemaDriftFinding, Exploration } from '@/types/graph';

/**
 * Review-and-apply UI for a context's schema drift.
 *
 * Every auto_fixable finding defaults to "apply the proposed fix" (checked).
 * Unchecking one keeps that piece of the stored snapshot as-is instead —
 * findings carry enough of the stored value (`finding.stored`) to reconstruct
 * what "as-is" means without a second round-trip. STRUCTURAL_COLUMN_MISSING
 * and TABLE_NOT_FOUND are never auto_fixable: those need a human decision in
 * the edit form (or, for a missing table, are unrecoverable — see
 * docs/dev/decision-log.md).
 */
const props = defineProps<{
  open: boolean;
  contextId: string;
  hasWriteAccess: boolean;
}>();

const emit = defineEmits<{
  close: [];
  applied: [GraphContext];
}>();

const { state, check, clear } = useSchemaDrift();
const contextsStore = useContextsStore();

const drift = computed(() => state(props.contextId).drift);
const loading = computed(() => state(props.contextId).loading);
const loadError = computed(() => state(props.contextId).error);

const checkingTypes = ref(false);
const applying = ref(false);
const applyError = ref<string | null>(null);

const deselected = ref<Set<string>>(new Set());
const renameMap = ref<Map<string, string>>(new Map());

function findingKey(f: SchemaDriftFinding): string {
  return `${f.code}|${f.side}|${f.name}`;
}

function isDeselected(f: SchemaDriftFinding): boolean {
  return deselected.value.has(findingKey(f));
}

function toggleFinding(f: SchemaDriftFinding) {
  const key = findingKey(f);
  const next = new Set(deselected.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  deselected.value = next;
}

// --- Dangling-reference check (warn-only, never rewrites saved state) --------

const explorations = ref<Exploration[]>([]);
const explorationsLoaded = ref(false);
const acknowledgedDangling = ref(false);

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    deselected.value = new Set();
    renameMap.value = new Map();
    checkingTypes.value = false;
    applyError.value = null;
    acknowledgedDangling.value = false;
    explorations.value = [];
    explorationsLoaded.value = false;
    if (!state(props.contextId).drift) {
      await check(props.contextId);
    }
    // Best-effort: a failed fetch just means the panel shows nothing rather
    // than blocking the review — the drift findings themselves already loaded.
    try {
      explorations.value = await api.getExplorations(props.contextId);
    } catch {
      explorations.value = [];
    } finally {
      explorationsLoaded.value = true;
    }
  },
  { immediate: true },
);

/** Property names being dropped by the currently-selected fixes (not renamed, not deselected). */
const removedColumns = computed(() => {
  const names: string[] = [];
  for (const f of findingsOfCode('PROPERTY_COLUMN_MISSING')) {
    if (!isDeselected(f) && !renameMap.value.has(findingKey(f))) names.push(f.name);
  }
  return names;
});

const clusterPrograms = computed(
  () => contextsStore.contexts.find((c) => c.id === props.contextId)?.cluster_programs ?? [],
);

interface ExplorationDangling {
  exploration: Exploration;
  refs: PropertyReference[];
}

const danglingByExploration = computed<ExplorationDangling[]>(() => {
  if (removedColumns.value.length === 0) return [];
  const known = new Set([
    ...effectiveProperties('node').map((p) => p.name),
    ...effectiveProperties('edge').map((p) => p.name),
  ]);

  const results: ExplorationDangling[] = [];
  for (const exploration of explorations.value) {
    const structuredRefs = collectPropertyReferences(exploration.state, clusterPrograms.value);
    const rawRefs = findRawQueryReferences(removedColumns.value, [
      { location: 'graph_query', text: exploration.state.graph_query },
      { location: 'cte_prefilter', text: exploration.state.cte_prefilter },
    ]);
    const dangling = [...findDanglingReferences(structuredRefs, known), ...rawRefs];
    if (dangling.length > 0) results.push({ exploration, refs: dangling });
  }
  return results;
});

const totalDanglingCount = computed(() =>
  danglingByExploration.value.reduce((sum, d) => sum + d.refs.length, 0),
);

const hasCertainDangling = computed(() =>
  danglingByExploration.value.some((d) => d.refs.some((r) => r.certain)),
);

const showDanglingPanel = computed(() => explorationsLoaded.value && danglingByExploration.value.length > 0);

/**
 * Retry the check. Types are requested on every check now, so reaching this
 * means discovery itself failed (the backend reports `types_checked: false`
 * when the `SELECT DISTINCT` errored, not merely when it was skipped).
 */
async function refreshWithTypes() {
  checkingTypes.value = true;
  try {
    await check(props.contextId, true);
  } finally {
    checkingTypes.value = false;
  }
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

const findingsBySeverity = computed(() =>
  [...(drift.value?.findings ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  ),
);

const hasTableNotFound = computed(() =>
  (drift.value?.findings ?? []).some((f) => f.code === 'TABLE_NOT_FOUND'),
);

function findingsOfCode(code: string, side?: 'node' | 'edge'): SchemaDriftFinding[] {
  return (drift.value?.findings ?? []).filter(
    (f) => f.code === code && (side === undefined || f.side === side),
  );
}

/** Same-side PROPERTY_COLUMN_ADDED names available as rename targets, minus
 * any already claimed by another rename mapping. */
function renameCandidates(missing: SchemaDriftFinding): SchemaDriftFinding[] {
  const claimed = new Set(renameMap.value.values());
  return findingsOfCode('PROPERTY_COLUMN_ADDED', missing.side).filter(
    (added) => !claimed.has(added.name) || renameMap.value.get(findingKey(missing)) === added.name,
  );
}

function setRename(missing: SchemaDriftFinding, targetName: string) {
  const next = new Map(renameMap.value);
  if (targetName) next.set(findingKey(missing), targetName);
  else next.delete(findingKey(missing));
  renameMap.value = next;
}

/** A finding suppressed from the plain findings list because a rename mapping covers it. */
function isSuppressedByRename(f: SchemaDriftFinding): boolean {
  if (f.code === 'PROPERTY_COLUMN_MISSING') return renameMap.value.has(findingKey(f));
  if (f.code === 'PROPERTY_COLUMN_ADDED') {
    return [...renameMap.value.values()].includes(f.name);
  }
  return false;
}

const visibleFindings = computed(() => findingsBySeverity.value.filter((f) => !isSuppressedByRename(f)));

function effectiveProperties(side: 'node' | 'edge'): PropertyColumn[] {
  const base = (
    side === 'node' ? drift.value?.proposed.node_properties : drift.value?.proposed.edge_properties
  ) ?? [];
  let result: PropertyColumn[] = base.map((p) => ({ ...p }));

  for (const f of findingsOfCode('PROPERTY_COLUMN_MISSING', side)) {
    const key = findingKey(f);
    const targetName = renameMap.value.get(key);
    if (targetName) {
      const target = result.find((p) => p.name === targetName);
      if (target) {
        target.display_name = (f.stored?.display_name as string | undefined) ?? target.display_name;
        target.description = (f.stored?.description as string | undefined) ?? target.description;
      }
    } else if (isDeselected(f)) {
      // Keep the stale column instead of dropping it.
      result.push({
        name: f.name,
        data_type: (f.stored?.data_type as string | undefined) ?? 'string',
        display_name: f.stored?.display_name as string | undefined,
        description: f.stored?.description as string | undefined,
      });
    }
  }

  for (const f of findingsOfCode('PROPERTY_COLUMN_ADDED', side)) {
    if (isDeselected(f) && !isSuppressedByRename(f)) {
      result = result.filter((p) => p.name !== f.name);
    }
  }

  for (const f of findingsOfCode('PROPERTY_TYPE_CHANGED', side)) {
    if (isDeselected(f)) {
      const target = result.find((p) => p.name === f.name);
      if (target) target.data_type = (f.stored?.data_type as string | undefined) ?? target.data_type;
    }
  }

  return result;
}

function effectiveTypes(side: 'node' | 'edge'): string[] | null {
  if (!drift.value?.types_checked) return null;
  const base = (side === 'node' ? drift.value.proposed.node_types : drift.value.proposed.relationship_types) ?? [];
  let result = [...base];

  for (const f of findingsOfCode('TYPE_VALUE_REMOVED', side)) {
    if (isDeselected(f) && !result.includes(f.name)) result.push(f.name);
  }
  for (const f of findingsOfCode('TYPE_VALUE_ADDED', side)) {
    if (isDeselected(f)) result = result.filter((t) => t !== f.name);
  }
  return result;
}

async function apply() {
  if (!drift.value) return;
  if (showDanglingPanel.value && hasCertainDangling.value && !acknowledgedDangling.value) return;
  applying.value = true;
  applyError.value = null;

  try {
    const payload: Record<string, unknown> = {
      node_properties: effectiveProperties('node'),
      edge_properties: effectiveProperties('edge'),
    };
    const nodeTypes = effectiveTypes('node');
    const relationshipTypes = effectiveTypes('edge');
    if (nodeTypes !== null) payload.node_types = nodeTypes;
    if (relationshipTypes !== null) payload.relationship_types = relationshipTypes;

    const updated = await contextsStore.updateContext(props.contextId, payload);
    clear(props.contextId);
    emit('applied', updated);
  } catch (e) {
    applyError.value = e instanceof Error ? e.message : 'Failed to apply schema changes';
  } finally {
    applying.value = false;
  }
}

function severityLabel(f: SchemaDriftFinding): string {
  return f.severity === 'error' ? 'Error' : f.severity === 'warning' ? 'Warning' : 'Info';
}
</script>

<template>
  <div v-if="open" class="modal-overlay" data-testid="schema-drift-modal" @click.self="emit('close')">
    <div class="modal drift-modal">
      <div class="modal-header">
        <h2>Schema Check</h2>
        <button class="modal-close" @click="emit('close')">&times;</button>
      </div>

      <div v-if="loading" class="loading"></div>
      <div v-else-if="loadError" class="error-message">{{ loadError }}</div>
      <div v-else-if="drift" class="drift-body">
        <div v-if="drift.status === 'ok'" class="empty-state-inline">
          Nothing to fix — the stored schema matches the live tables.
        </div>

        <div v-else class="findings-list">
          <div
            v-for="f in visibleFindings"
            :key="`${f.code}|${f.side}|${f.name}`"
            class="finding-row"
            :class="`finding-row--${f.severity}`"
          >
            <input
              v-if="f.auto_fixable"
              type="checkbox"
              :checked="!isDeselected(f)"
              @change="toggleFinding(f)"
            />
            <div class="finding-body">
              <div class="finding-header">
                <span class="finding-severity">{{ severityLabel(f) }}</span>
                <span class="finding-side">{{ f.side }}</span>
                <span class="finding-name">{{ f.name }}</span>
              </div>
              <p class="finding-message">{{ f.message }}</p>

              <div v-if="f.code === 'PROPERTY_COLUMN_MISSING' && renameCandidates(f).length > 0" class="rename-row">
                <label>Was this renamed to…?</label>
                <select
                  :value="renameMap.get(`${f.code}|${f.side}|${f.name}`) || ''"
                  @change="setRename(f, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">No — {{ isDeselected(f) ? 'keep it' : 'drop it' }}</option>
                  <option v-for="c in renameCandidates(f)" :key="c.name" :value="c.name">
                    {{ c.name }}
                  </option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div class="types-section">
          <template v-if="!drift.types_checked">
            <span class="hint hint-warn" data-testid="schema-drift-types-failed">
              Node/relationship type discovery failed, so type changes are not included below.
              Column findings are unaffected.
            </span>
            <button
              type="button"
              class="btn btn-sm btn-outline"
              :disabled="checkingTypes"
              data-testid="schema-drift-check-types"
              @click="refreshWithTypes"
            >
              {{ checkingTypes ? 'Retrying…' : 'Retry type discovery' }}
            </button>
          </template>
          <span v-else class="hint">Node and relationship types were included in this check.</span>
        </div>

        <!-- Dangling-reference warning: informational only, never rewrites saved state -->
        <details v-if="showDanglingPanel" class="dangling-panel" data-testid="schema-drift-dangling-panel" open>
          <summary>
            Applying this leaves {{ totalDanglingCount }} reference{{ totalDanglingCount === 1 ? '' : 's' }}
            across {{ danglingByExploration.length }} exploration{{ danglingByExploration.length === 1 ? '' : 's' }} dangling
          </summary>
          <ul class="dangling-list">
            <li v-for="d in danglingByExploration" :key="d.exploration.id">
              <strong>{{ d.exploration.title }}</strong>
              <ul>
                <li v-for="(r, i) in d.refs" :key="i">
                  <code>{{ r.property }}</code> in {{ r.location }}
                  <span v-if="!r.certain" class="uncertain-badge">possible match, not confirmed</span>
                </li>
              </ul>
            </li>
          </ul>
          <label v-if="hasCertainDangling" class="acknowledge-row">
            <input v-model="acknowledgedDangling" type="checkbox" data-testid="schema-drift-acknowledge" />
            I understand these explorations will reference columns that no longer exist
          </label>
        </details>

        <div v-if="applyError" class="error-message">{{ applyError }}</div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn btn-outline" @click="emit('close')">Close</button>
        <button
          v-if="drift && drift.status !== 'ok' && !hasTableNotFound"
          type="button"
          class="btn btn-primary"
          data-testid="schema-drift-apply"
          :disabled="!hasWriteAccess || applying || (showDanglingPanel && hasCertainDangling && !acknowledgedDangling)"
          :title="!hasWriteAccess ? 'You need write access to apply changes' : undefined"
          @click="apply"
        >
          {{ applying ? 'Applying…' : 'Apply' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drift-modal {
  max-width: 640px;
  width: 90%;
}

.drift-body {
  padding: 4px 0;
}

.empty-state-inline {
  padding: 16px;
  color: var(--text-muted);
  font-size: 14px;
}

.findings-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow-y: auto;
}

.finding-row {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 6px;
  border-left: 3px solid var(--border-color, #ddd);
  background: var(--bg-secondary, #f5f5f5);
}

.finding-row--error {
  border-left-color: #dc2626;
}

.finding-row--warning {
  border-left-color: #d97706;
}

.finding-row--info {
  border-left-color: #2563eb;
}

.finding-row input[type='checkbox'] {
  margin-top: 3px;
}

.finding-body {
  flex: 1;
}

.finding-header {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}

.finding-severity {
  font-weight: 600;
  text-transform: uppercase;
}

.finding-side {
  color: var(--text-muted);
}

.finding-name {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
}

.finding-message {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-color);
}

.rename-row {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.rename-row select {
  padding: 2px 6px;
}

.types-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color, #eee);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.hint-warn {
  color: #92400e;
}

.dangling-panel {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: #fffbeb;
  color: #92400e;
  font-size: 13px;
}

.dangling-panel summary {
  cursor: pointer;
  font-weight: 600;
}

.dangling-list {
  margin: 8px 0 0;
  padding-left: 18px;
}

.dangling-list ul {
  margin: 2px 0 6px;
  padding-left: 16px;
}

.uncertain-badge {
  margin-left: 6px;
  font-size: 11px;
  font-style: italic;
  opacity: 0.8;
}

.acknowledge-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-weight: 500;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}
</style>
