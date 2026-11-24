<template>
  <div class="label-portable">
    <div class="portable-row">
      <button
        class="btn btn-outline btn-sm"
        ref="toggleButton"
        data-testid="label-import-toggle"
        :aria-expanded="showImport"
        title="Paste label formats as JSON — from the AI prompt or exported from another context"
        @click="showImport = !showImport"
      >
        <Upload :size="12" /> {{ showImport ? 'Hide import' : 'Import JSON' }}
      </button>
      <button
        class="btn btn-outline btn-sm"
        data-testid="label-export"
        title="Download the default templates and every rule as a JSON file"
        @click="exportLabels"
      >
        <Download :size="12" /> Export JSON
      </button>
    </div>

    <section v-if="showImport" class="import-block" data-testid="label-import">
      <p class="muted">
        Paste the JSON the AI prompt (robot button) answered with, or label
        formats exported from another context. Every rule in it is applied at
        once.
      </p>
      <textarea
        v-model="importText"
        class="field-input import-textarea"
        data-testid="label-import-text"
        aria-label="Label formats JSON"
        rows="6"
        placeholder='{"defaults": {"nodeTemplate": "..."}, "rules": [{"name": "...", "target": "node", "types": ["..."], "template": "..."}]}'
      />
      <div class="portable-row">
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          class="file-input"
          data-testid="label-import-file"
          @change="pickFile"
        />
        <button class="btn btn-outline btn-sm" @click="fileInput?.click()">Choose file…</button>
      </div>
      <p
        v-if="parsedImport && !parsedImport.ok"
        class="field-error"
        data-testid="label-import-parse-error"
      >
        {{ parsedImport.error }}
      </p>
      <p v-if="importError" class="field-error">{{ importError }}</p>

      <p v-if="summary" class="muted" data-testid="label-import-summary">{{ summary }}</p>

      <div
        v-if="importWarnings"
        class="field-warning warning-block"
        data-testid="label-import-warnings"
      >
        <p>
          These labels name things this graph does not have. A rule for a
          missing type matches nothing; a missing property shows as
          <code>[its name]</code>.
        </p>
        <ul>
          <li v-if="importWarnings.missingNodeTypes.length">
            node types: {{ importWarnings.missingNodeTypes.join(', ') }}
          </li>
          <li v-if="importWarnings.missingEdgeTypes.length">
            edge types: {{ importWarnings.missingEdgeTypes.join(', ') }}
          </li>
          <li v-if="importWarnings.missingProperties.length">
            properties: {{ importWarnings.missingProperties.join(', ') }}
          </li>
          <li v-if="importWarnings.sessionMetricRefs.length">
            metrics (session-computed — labels show a placeholder until the
            metric is computed here): {{ importWarnings.sessionMetricRefs.join(', ') }}
          </li>
        </ul>
        <button
          v-if="needsAdapting"
          class="btn btn-outline btn-sm"
          data-testid="label-import-adapt"
          @click="emit('adapt', { json: importText, source: importedSource })"
        >
          <Bot :size="12" /> Ask an AI to adapt it
        </button>
      </div>

      <label v-if="graphStore.textFormatRules.length > 0" class="replace-row">
        <input v-model="replaceRules" type="checkbox" data-testid="label-import-replace" />
        Remove the {{ currentRulesText }} first
      </label>

      <div class="portable-row">
        <button
          class="btn btn-primary btn-sm"
          data-testid="label-import-apply"
          :disabled="!parsedImport?.ok"
          @click="applyImport"
        >
          Apply
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { Bot, Download, Upload } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import { mergeTextFormat, parseImportedLabelFormats } from '@/utils/labelFormatImport';
import { hasCompatibilityWarnings, styleCompatibilityWarnings } from '@/utils/stylePresetImport';
import { buildSourceSchema, downloadJson, readFileAsText, safeFilename } from '@/utils/portableExport';
import {
  PORTABLE_EXPORT_VERSION,
  type PortableLabelFormats,
  type PortableSourceSchema,
} from '@/types/portable';
import type { StylePresetSettings } from '@/types/graph';

const emit = defineEmits<{
  /** The pasted labels belong to another graph: open the AI prompt in adapt mode. */
  (e: 'adapt', payload: { json: string; source?: PortableSourceSchema }): void;
}>();

const graphStore = useGraphStore();
const toast = useToast();

const showImport = ref(false);
const importText = ref('');
const importError = ref<string | null>(null);
const replaceRules = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const toggleButton = ref<HTMLButtonElement | null>(null);

function sourceSchema() {
  return buildSourceSchema({
    context: graphStore.currentContext,
    loadedNodeTypes: graphStore.nodeTypes,
    loadedEdgeTypes: graphStore.edgeTypes,
  });
}

function exportLabels() {
  const payload: PortableLabelFormats = {
    graphlagoon_export: 'label-formats',
    export_version: PORTABLE_EXPORT_VERSION,
    source: sourceSchema(),
    textFormat: graphStore.getTextFormatState(),
  };
  downloadJson(safeFilename(`labels-${graphStore.currentContext?.title || 'context'}`), payload);
}

/** Parsed view of the Import box; null while it holds nothing. */
const parsedImport = computed(() => {
  const text = importText.value.trim();
  return text ? parseImportedLabelFormats(text) : null;
});

const importedSource = computed(() =>
  parsedImport.value?.ok ? parsedImport.value.source : undefined,
);

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * "3 current rules (1 label, 2 tooltip)": the open tab lists one surface
 * only, so the count alone would hide what a replace deletes on the other.
 */
const currentRulesText = computed(() => {
  const rules = graphStore.textFormatRules;
  const tooltip = rules.filter((r) => r.surface === 'tooltip').length;
  const both = rules.filter((r) => r.surface === 'both').length;
  const label = rules.length - tooltip - both;
  const kinds = [
    label > 0 ? `${label} label` : '',
    tooltip > 0 ? `${tooltip} tooltip` : '',
    both > 0 ? `${both} both` : '',
  ].filter(Boolean);
  return `${plural(rules.length, 'current rule')}${kinds.length > 1 ? ` (${kinds.join(', ')})` : ''}`;
});

/** What Apply is about to do, said before the click. */
const summary = computed(() => {
  if (!parsedImport.value?.ok) return '';
  const { rules, defaults } = parsedImport.value.textFormat;
  const parts: string[] = [];
  if (rules.length > 0) {
    const types = new Set(rules.flatMap((r) => r.types.map((t) => `${r.target}:${t}`)));
    parts.push(
      types.size > 0 ? `${plural(rules.length, 'rule')} for ${plural(types.size, 'type')}` : plural(rules.length, 'rule'),
    );
  }
  const defaultCount = Object.keys(defaults).length;
  if (defaultCount > 0) parts.push(plural(defaultCount, 'default template'));
  const replacing = replaceRules.value && graphStore.textFormatRules.length > 0
    ? `, replacing the ${currentRulesText.value}`
    : '';
  return `Ready to apply: ${parts.join(' and ')}${replacing}.`;
});

const compatibility = computed(() => {
  if (!parsedImport.value?.ok) return null;
  const schema = sourceSchema();
  return styleCompatibilityWarnings(
    { textFormat: parsedImport.value.textFormat } as StylePresetSettings,
    {
      nodeTypes: schema.node_types,
      edgeTypes: schema.relationship_types,
      nodeProperties: schema.node_properties,
      edgeProperties: schema.edge_properties,
    },
  );
});

const importWarnings = computed(() =>
  compatibility.value && hasCompatibilityWarnings(compatibility.value) ? compatibility.value : null,
);

/** A metric that is just not computed yet is nothing an AI can rename. */
const needsAdapting = computed(() => {
  const w = importWarnings.value;
  return !!w && w.missingNodeTypes.length + w.missingEdgeTypes.length + w.missingProperties.length > 0;
});

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importError.value = null;
  try {
    importText.value = await readFileAsText(file);
  } catch {
    importError.value = 'Could not read the file';
  } finally {
    input.value = '';
  }
}

function applyImport() {
  const result = parseImportedLabelFormats(importText.value);
  if (!result.ok) return;
  const before = graphStore.getTextFormatState();
  const { state, added, updated, removed } = mergeTextFormat(before, result.textFormat, {
    replaceRules: replaceRules.value,
  });
  graphStore.loadTextFormatState(state);

  const parts: string[] = [];
  if (added > 0) parts.push(`${plural(added, 'rule')} added`);
  if (updated > 0) parts.push(`${plural(updated, 'rule')} updated`);
  if (removed > 0) parts.push(`${plural(removed, 'rule')} removed`);
  if (Object.keys(result.textFormat.defaults).length > 0) parts.push('defaults updated');
  toast.undoable(`Labels imported: ${parts.join(', ')}`, () => graphStore.loadTextFormatState(before));

  importText.value = '';
  replaceRules.value = false;
  showImport.value = false;
  // Apply is unmounted with the box: keep keyboard focus in the panel.
  void nextTick(() => toggleButton.value?.focus());
}
</script>

<style scoped>
.label-portable {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.portable-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.portable-row .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.file-input {
  display: none;
}

.import-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.field-input {
  min-width: 0;
  box-sizing: border-box;
  padding: 6px 9px;
  font-size: 12px;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: var(--input-bg, #fff);
  color: inherit;
}

.import-textarea {
  font-family: 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  resize: vertical;
}

.warning-block {
  overflow-wrap: anywhere;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--warning-color, #b8860b);
  border-radius: 4px;
}

.warning-block p,
.warning-block ul {
  margin: 0;
}

.warning-block ul {
  padding-left: 16px;
}

.warning-block .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
}

.replace-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.field-error {
  margin: 0;
  font-size: 11px;
  color: var(--danger-color, #c0392b);
  overflow-wrap: anywhere;
}

.field-warning {
  margin: 0;
  font-size: 11px;
  color: var(--warning-color, #b8860b);
}

.muted {
  margin: 0;
  font-size: 11px;
  opacity: 0.65;
}
</style>
