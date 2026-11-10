<script setup lang="ts">
/**
 * The context modal's "Default look": the look the context opens with when no
 * exploration says otherwise, and the fallback on a case canvas whose items
 * have none. Stored under `default_behaviors.look` (no column of its own).
 *
 * Taken from what already exists rather than built here: one of the context's
 * explorations (its style block), one of its style presets, or pasted JSON (a
 * preset export). The same picker hands an exploration's or a preset's
 * behaviors to the Default Behaviors field (`import-behaviors`).
 */
import { computed, ref } from 'vue';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import { styleOf } from '@/utils/caseLook';
import { parseImportedStylePreset } from '@/utils/stylePresetImport';
import { toDefaultLook, type DefaultLook } from '@/composables/useContextDefaultLook';
import type { Exploration, StylePresetEntry, StylePresetSettings } from '@/types/graph';
import type { GraphLook } from '@/types/investigation';

const props = defineProps<{
  modelValue: DefaultLook | null;
  /** The saved context to import from; null while creating one (only JSON can be pasted). */
  contextId: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [look: DefaultLook | null];
  'import-behaviors': [behaviors: Record<string, unknown>];
}>();

const open = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const explorations = ref<Exploration[]>([]);
const presets = ref<StylePresetEntry[]>([]);
/** `exploration:<id>` | `preset:<name>` | `json` */
const choice = ref('');
const json = ref('');

/** One line on what the look sets: what a reader needs to recognise it. */
const summary = computed(() => {
  const look = props.modelValue;
  if (!look) return 'Stock look';
  const parts: string[] = [];
  const count = (m?: Record<string, unknown> | null) => (m ? Object.keys(m).length : 0);
  const colors = count(look.nodeTypeColors) + count(look.edgeTypeColors);
  const icons = count(look.nodeTypeIcons) + count(look.edgeTypeIcons);
  if (colors) parts.push(`${colors} type color${colors === 1 ? '' : 's'}`);
  if (icons) parts.push(`${icons} icon${icons === 1 ? '' : 's'}`);
  if (look.textFormat) parts.push('labels');
  if (look.layout_algorithm) parts.push(`${look.layout_algorithm} layout`);
  if (look.aesthetics) parts.push('sizes');
  return parts.length ? parts.join(' · ') : 'Custom look';
});

const sourceLabel = computed(() => {
  const source = props.modelValue?.source;
  if (!source) return null;
  if (source.startsWith('preset:')) return `from preset “${source.slice(7)}”`;
  if (source.startsWith('exploration:')) return `from exploration “${source.slice(12)}”`;
  if (source === 'current') return 'saved from the Look panel';
  if (source === 'json') return 'pasted JSON';
  return null;
});

async function openImport() {
  open.value = true;
  error.value = null;
  choice.value = props.contextId ? '' : 'json';
  if (!props.contextId) return;
  loading.value = true;
  try {
    const [exps, list] = await Promise.all([
      api.getExplorations(props.contextId),
      api.listStylePresets(props.contextId).catch(() => [] as StylePresetEntry[]),
    ]);
    // Only explorations that carry a look are worth offering.
    explorations.value = exps.filter((e) => styleOf(e.state as GraphLook) || e.state?.behaviors);
    presets.value = list;
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to list explorations and presets');
  } finally {
    loading.value = false;
  }
}

/** The chosen settings block and its source label, or an error message. */
async function chosen(): Promise<{ settings: StylePresetSettings; source: string } | string> {
  if (choice.value === 'json') {
    const parsed = parseImportedStylePreset(json.value);
    return parsed.ok ? { settings: parsed.settings, source: 'json' } : parsed.error;
  }
  if (choice.value.startsWith('exploration:')) {
    const exp = explorations.value.find((e) => e.id === choice.value.slice(12));
    if (!exp) return 'Pick an exploration';
    const state = exp.state as GraphLook;
    return { settings: { ...(styleOf(state) ?? {}), behaviors: state.behaviors }, source: `exploration:${exp.title}` };
  }
  if (choice.value.startsWith('preset:') && props.contextId) {
    const name = choice.value.slice(7);
    const preset = await api.getStylePreset(props.contextId, name);
    return { settings: preset.settings, source: `preset:${name}` };
  }
  return 'Pick an exploration, a preset or paste JSON';
}

async function importLook() {
  error.value = null;
  try {
    const got = await chosen();
    if (typeof got === 'string') {
      error.value = got;
      return;
    }
    const look = toDefaultLook(got.settings, got.source);
    if (!styleOf(look as GraphLook)) {
      error.value = 'That has no look to import (no colors, icons, labels or layout)';
      return;
    }
    emit('update:modelValue', look);
    open.value = false;
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to import the look');
  }
}

async function importBehaviors() {
  error.value = null;
  try {
    const got = await chosen();
    if (typeof got === 'string') {
      error.value = got;
      return;
    }
    if (!got.settings.behaviors || !Object.keys(got.settings.behaviors).length) {
      error.value = 'That has no behaviors to import';
      return;
    }
    emit('import-behaviors', got.settings.behaviors as Record<string, unknown>);
    open.value = false;
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to import the behaviors');
  }
}
</script>

<template>
  <div class="form-group" data-testid="context-default-look">
    <label>Default Look</label>
    <div class="look-row">
      <span class="look-summary" data-testid="context-default-look-summary">
        {{ summary }}<template v-if="sourceLabel"> <span class="source">({{ sourceLabel }})</span></template>
      </span>
      <button
        v-if="!open"
        type="button"
        class="btn btn-outline btn-sm"
        data-testid="context-default-look-open-import"
        @click="openImport"
      >
        Import from…
      </button>
      <button
        v-if="modelValue"
        type="button"
        class="btn btn-outline btn-sm"
        data-testid="context-default-look-clear"
        @click="emit('update:modelValue', null)"
      >
        Clear
      </button>
    </div>

    <div v-if="open" class="import-box" data-testid="context-default-look-import-box">
      <p v-if="loading" class="hint">Loading explorations and presets…</p>
      <select v-else v-model="choice" class="form-control" data-testid="context-default-look-source">
        <option value="" disabled>Choose where to import from…</option>
        <optgroup v-if="explorations.length" label="Explorations">
          <option v-for="e in explorations" :key="e.id" :value="`exploration:${e.id}`">{{ e.title }}</option>
        </optgroup>
        <optgroup v-if="presets.length" label="Style presets">
          <option v-for="p in presets" :key="p.name" :value="`preset:${p.name}`">{{ p.name }}</option>
        </optgroup>
        <option value="json">Paste JSON (a style preset export)…</option>
      </select>
      <textarea
        v-if="choice === 'json'"
        v-model="json"
        class="form-control"
        rows="4"
        spellcheck="false"
        placeholder='{"nodeTypeColors": {"Person": "#4f8ef7"}}'
        data-testid="context-default-look-json"
      />
      <div class="import-actions">
        <button type="button" class="btn btn-primary btn-sm" :disabled="!choice" data-testid="context-default-look-import" @click="importLook">
          Import look
        </button>
        <button type="button" class="btn btn-outline btn-sm" :disabled="!choice" data-testid="context-default-behaviors-import" @click="importBehaviors">
          Import behaviors
        </button>
        <button type="button" class="btn btn-outline btn-sm" @click="open = false">Cancel</button>
      </div>
      <span v-if="error" class="hint hint-error" data-testid="context-default-look-error">{{ error }}</span>
    </div>
    <span class="hint">
      The look (colors, icons, labels, layout) this context opens with when no exploration says
      otherwise; a case shows it for a graph that has no look of its own. A preset can also be
      made the default with the ★ in the Look panel.
    </span>
  </div>
</template>

<style scoped>
.look-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.look-summary {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

.source {
  color: var(--text-muted);
}

.import-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.import-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.hint-error {
  color: var(--error-color, #c0392b);
}
</style>
