<script setup lang="ts">
/**
 * Style presets: the Look panel's contents, saved under a name.
 *
 * The Presets tab of the Look panel on both pages. How a preset is applied is
 * the host's call: the exploration page applies through the URL (`?style=`),
 * so whatever look is on screen is always a link someone else can open; a
 * case has no URL look, so it applies straight to the store and saves the
 * result on the graph item.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Bot, Check, Download, Link2, Trash2 } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import { ARTIFACT_NAME_PATTERN, type StylePresetEntry, type StylePresetSettings } from '@/types/graph';
import { PORTABLE_EXPORT_VERSION, type PortableStylePreset, type PortableSourceSchema } from '@/types/portable';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import { buildSourceSchema, downloadJson, readFileAsText, safeFilename } from '@/utils/portableExport';
import {
  hasCompatibilityWarnings,
  parseImportedStylePreset,
  styleCompatibilityWarnings,
} from '@/utils/stylePresetImport';
import StylePresetSkillModal from './StylePresetSkillModal.vue';
import { confirmAction } from '@/composables/useConfirm';

const props = defineProps<{
  /** `url`: `?style=<name>` (the exploration page); `store`: straight onto the canvas (a case). */
  apply: 'url' | 'store';
  /** The context whose presets are listed; null when the canvas has none (a frozen item). */
  contextId: string | null;
  /** Whether the person may write presets to that context (import-and-save). */
  canWrite: boolean;
}>();

const emit = defineEmits<{ applied: [name: string | null] }>();

const graphStore = useGraphStore();
const router = useRouter();
const route = useRoute();
const toast = useToast();

const presets = ref<StylePresetEntry[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const name = ref('');
const description = ref('');

const contextId = computed(() => props.contextId);
const viaUrl = computed(() => props.apply === 'url');
/** The preset applied through the store (a case); the URL knows its own. */
const appliedName = ref<string | null>(null);
const activeName = computed(() =>
  viaUrl.value ? ((route.query.style as string | undefined) ?? null) : appliedName.value,
);

const nameError = computed(() => {
  const value = name.value.trim();
  if (!value) return null;
  // Same alphabet the backend enforces for every named artifact.
  if (!ARTIFACT_NAME_PATTERN.test(value)) {
    return 'Letters, digits, _ - . only, up to 64, starting with a letter or digit';
  }
  return null;
});

const isOverwrite = computed(() =>
  presets.value.some((p) => p.name === name.value.trim()),
);

const saveBlockedReason = computed(() => {
  if (!contextId.value) return 'No context loaded';
  if (!name.value.trim()) return 'Enter a name';
  return nameError.value;
});

function presetUrl(value: string): string {
  const href = router.resolve({
    name: 'graph',
    params: { contextId: contextId.value },
    query: { ...route.query, style: value },
  }).href;
  return new URL(href, window.location.origin).toString();
}

function formatDate(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

async function refresh() {
  if (!contextId.value) {
    presets.value = [];
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    presets.value = await api.listStylePresets(contextId.value);
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to list style presets');
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saveBlockedReason.value || !contextId.value) return;
  saving.value = true;
  error.value = null;
  const value = name.value.trim();
  try {
    const preset = await api.putStylePreset(contextId.value, value, {
      settings: graphStore.buildStylePreset(),
      description: description.value.trim() || null,
    });
    // Saving the look you are already looking at makes it the active one.
    if (viaUrl.value) graphStore.currentStylePreset = preset;
    await refresh();
    name.value = '';
    description.value = '';
    toast.success(`Style preset “${value}” saved`);
    await apply(value);
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to save style preset');
  } finally {
    saving.value = false;
  }
}

async function apply(value: string) {
  if (!contextId.value || activeName.value === value) return;
  if (viaUrl.value) {
    router.replace({
      name: 'graph',
      params: { contextId: contextId.value },
      query: { ...route.query, style: value },
    });
    return;
  }
  error.value = null;
  try {
    const preset = await api.getStylePreset(contextId.value, value);
    graphStore.applyStylePreset(preset.settings, { freshLayout: true });
    appliedName.value = value;
    emit('applied', value);
  } catch (e) {
    error.value = getErrorMessage(e, `Failed to load style preset “${value}”`);
  }
}

function clearStyle() {
  if (!contextId.value || !viaUrl.value) return;
  const query = { ...route.query };
  delete query.style;
  router.replace({ name: 'graph', params: { contextId: contextId.value }, query });
}

async function remove(value: string) {
  if (!contextId.value) return;
  const ok = await confirmAction({
    title: `Delete style preset “${value}”?`,
    message: 'Links that name this preset will open with the default look.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  error.value = null;
  try {
    await api.deleteStylePreset(contextId.value, value);
    presets.value = presets.value.filter((p) => p.name !== value);
    if (activeName.value === value) {
      if (viaUrl.value) clearStyle();
      else appliedName.value = null;
    }
    toast.success(`Style preset “${value}” deleted`);
  } catch (e) {
    // A 403 here names the author — the only place ownership ever surfaces,
    // since the listing deliberately does not carry it.
    error.value = getErrorMessage(e, 'Failed to delete style preset');
  }
}

async function copyLink(value: string) {
  try {
    await navigator.clipboard.writeText(presetUrl(value));
    toast.success('Link copied');
  } catch {
    toast.error('Could not copy the link');
  }
}

// ---------------------------------------------------------------------------
// Export / import — a preset travelling to another context or instance.
// ---------------------------------------------------------------------------

const showSkill = ref(false);
const showImport = ref(false);
const importText = ref('');
const importName = ref('');
const importDescription = ref('');
const importError = ref<string | null>(null);
const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function sourceSchema(): PortableSourceSchema {
  return buildSourceSchema({
    context: graphStore.currentContext,
    loadedNodeTypes: graphStore.nodeTypes,
    loadedEdgeTypes: graphStore.edgeTypes,
  });
}

function envelope(
  settings: StylePresetSettings,
  presetName?: string,
  presetDescription?: string | null,
): PortableStylePreset {
  return {
    graphlagoon_export: 'style-preset',
    export_version: PORTABLE_EXPORT_VERSION,
    name: presetName,
    description: presetDescription ?? null,
    source: sourceSchema(),
    settings,
  };
}

/** Download a saved preset as a portable JSON file. */
async function exportPreset(value: string) {
  if (!contextId.value) return;
  error.value = null;
  try {
    const preset = await api.getStylePreset(contextId.value, value);
    downloadJson(
      safeFilename(`style-${value}`),
      envelope(preset.settings, preset.name, preset.description),
    );
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to export style preset');
  }
}

/** Download whatever the Look panel currently shows, saved or not. */
function exportCurrentLook() {
  downloadJson(
    safeFilename(`style-${graphStore.currentContext?.title || 'current'}`),
    envelope(graphStore.buildStylePreset(), name.value.trim() || undefined, description.value.trim() || null),
  );
}

/** Parsed view of the Import box; null while it holds nothing parseable. */
const parsedImport = computed(() => {
  const text = importText.value.trim();
  if (!text) return null;
  return parseImportedStylePreset(text);
});

const importedSource = computed(() =>
  parsedImport.value?.ok ? parsedImport.value.source : undefined,
);

const importWarnings = computed(() => {
  if (!parsedImport.value?.ok) return null;
  const w = styleCompatibilityWarnings(parsedImport.value.settings, {
    nodeTypes: sourceSchema().node_types,
    edgeTypes: sourceSchema().relationship_types,
    nodeProperties: sourceSchema().node_properties,
    edgeProperties: sourceSchema().edge_properties,
  });
  return hasCompatibilityWarnings(w) ? w : null;
});

const importNameError = computed(() => {
  const value = importName.value.trim();
  if (!value) return null;
  return ARTIFACT_NAME_PATTERN.test(value)
    ? null
    : 'Letters, digits, _ - . only, up to 64, starting with a letter or digit';
});

const importSaveBlockedReason = computed(() => {
  if (!contextId.value) return 'No context loaded';
  if (!parsedImport.value?.ok) return 'Paste a preset first';
  if (!importName.value.trim()) return 'Enter a name';
  return importNameError.value;
});

// The envelope's name/description prefill the save form once — the user may
// still rename before saving.
watch(parsedImport, (result) => {
  if (result?.ok) {
    if (result.name && !importName.value) importName.value = result.name;
    if (result.description && !importDescription.value) importDescription.value = result.description;
  }
});

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importError.value = null;
  try {
    importText.value = await readFileAsText(file);
  } catch (e) {
    importError.value = getErrorMessage(e, 'Could not read the file');
  } finally {
    input.value = '';
  }
}

/** Apply in memory only — no server write, so read-only viewers can use it. */
function applyImportOnly() {
  importError.value = null;
  const result = parsedImport.value;
  if (!result) {
    importError.value = 'Paste a preset first';
    return;
  }
  if (!result.ok) {
    importError.value = result.error;
    return;
  }
  graphStore.applyStylePreset(result.settings, { freshLayout: true });
  // The look on screen no longer comes from a named preset — say so.
  graphStore.currentStylePreset = null;
  appliedName.value = null;
  if (activeName.value) clearStyle();
  emit('applied', null);
  toast.success('Imported style applied');
}

/** Save the imported preset under a name, then apply it. */
async function saveImport() {
  importError.value = null;
  if (importSaveBlockedReason.value) {
    importError.value = importSaveBlockedReason.value;
    return;
  }
  const result = parsedImport.value;
  if (!result?.ok || !contextId.value) return;
  const value = importName.value.trim();
  importing.value = true;
  try {
    await api.putStylePreset(contextId.value, value, {
      settings: result.settings,
      description: importDescription.value.trim() || null,
    });
    await refresh();
    toast.success(`Style preset “${value}” imported`);
    importText.value = '';
    importName.value = '';
    importDescription.value = '';
    showImport.value = false;
    await apply(value);
  } catch (e) {
    importError.value = getErrorMessage(e, 'Failed to save the imported preset');
  } finally {
    importing.value = false;
  }
}

onMounted(refresh);
watch(contextId, refresh);
</script>

<template>
  <div class="style-presets" data-testid="style-presets">
    <div class="head">
      <p class="hint">
        The style, labels and layout of this panel, stored under a name. A preset
        records nothing about which nodes are shown, so it applies to any graph in
        its context — including one loaded later.
      </p>
      <button
        class="btn-icon-only"
        data-testid="style-preset-skill-help"
        title="Ask an AI to write or adapt a style preset"
        aria-label="Ask an AI to write or adapt a style preset"
        @click="showSkill = true"
      >
        <Bot :size="16" />
      </button>
    </div>

    <p v-if="!contextId" class="muted" data-testid="style-preset-no-context">
      This graph has no context of its own, so there are no presets to list. The
      Style and Labels tabs still change its look.
    </p>

    <p
      v-if="viaUrl && graphStore.stylePresetError"
      class="field-error"
      data-testid="style-preset-url-error"
    >
      {{ graphStore.stylePresetError }}
    </p>
    <p v-if="error" class="field-error" data-testid="style-preset-error">
      {{ error }}
    </p>

    <section v-if="contextId" class="save-block" data-testid="style-preset-save">
      <label class="field-label" for="preset-name">Save current look as</label>
      <div class="save-row">
        <input
          id="preset-name"
          v-model="name"
          type="text"
          class="field-input"
          placeholder="e.g. investigacao"
          data-testid="style-preset-name-input"
          :disabled="saving"
          @keyup.enter="save"
        />
        <button
          class="btn btn-primary btn-sm"
          data-testid="style-preset-save-button"
          :disabled="!!saveBlockedReason || saving"
          :title="saveBlockedReason || 'Save this look under the given name'"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
      <input
        v-model="description"
        type="text"
        class="field-input"
        placeholder="What is this look for? (optional)"
        maxlength="280"
        data-testid="style-preset-description-input"
        :disabled="saving"
      />
      <p v-if="nameError" class="field-error">{{ nameError }}</p>
      <p
        v-else-if="isOverwrite"
        class="field-warning"
        data-testid="style-preset-overwrite"
      >
        Overwrites an existing preset. It keeps its original author, so only
        that person can delete it.
      </p>
    </section>

    <div class="portable-row">
      <button
        class="btn btn-outline btn-sm"
        data-testid="style-preset-export-current"
        title="Download the current look as a JSON file you can import into another context"
        @click="exportCurrentLook"
      >
        <Download :size="12" /> Export current look
      </button>
      <button
        class="btn btn-outline btn-sm"
        data-testid="style-preset-import-toggle"
        @click="showImport = !showImport"
      >
        {{ showImport ? 'Hide import' : 'Import JSON' }}
      </button>
    </div>

    <section v-if="showImport" class="import-block" data-testid="style-preset-import">
      <span class="field-label">Import a preset</span>
      <p class="muted">
        Paste a preset exported from any context (or the JSON an AI wrote),
        or choose the file. Presets from another graph name other types and
        properties — the robot button rewrites them for this graph.
      </p>
      <textarea
        v-model="importText"
        class="field-input import-textarea"
        data-testid="style-preset-import-text"
        rows="5"
        placeholder='{"graphlagoon_export": "style-preset", "settings": {...}}'
      />
      <div class="portable-row">
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          class="file-input"
          data-testid="style-preset-import-file"
          @change="pickFile"
        />
        <button class="btn btn-outline btn-sm" @click="fileInput?.click()">
          Choose file…
        </button>
      </div>
      <p
        v-if="parsedImport && !parsedImport.ok"
        class="field-error"
        data-testid="style-preset-import-parse-error"
      >
        {{ parsedImport.error }}
      </p>
      <div
        v-if="importWarnings"
        class="field-warning warning-block"
        data-testid="style-preset-import-warnings"
      >
        <p>This preset names things this graph does not have:</p>
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
            metrics (session-computed — labels show a placeholder until
            the metric is computed here): {{ importWarnings.sessionMetricRefs.join(', ') }}
          </li>
        </ul>
        <button
          class="btn btn-outline btn-sm"
          data-testid="style-preset-import-adapt"
          @click="showSkill = true"
        >
          <Bot :size="12" /> Ask an AI to adapt it
        </button>
      </div>
      <div v-if="canWrite && contextId" class="save-row">
        <input
          v-model="importName"
          type="text"
          class="field-input"
          placeholder="Save as…"
          data-testid="style-preset-import-name"
          :disabled="importing"
        />
        <button
          class="btn btn-primary btn-sm"
          data-testid="style-preset-import-save"
          :disabled="!!importSaveBlockedReason || importing"
          :title="importSaveBlockedReason || 'Save the imported preset and apply it'"
          @click="saveImport"
        >
          {{ importing ? 'Saving…' : 'Save & apply' }}
        </button>
      </div>
      <p v-if="importNameError" class="field-error">{{ importNameError }}</p>
      <div class="portable-row">
        <button
          class="btn btn-outline btn-sm"
          data-testid="style-preset-import-apply"
          :disabled="!parsedImport?.ok"
          title="Apply to this view without saving a preset"
          @click="applyImportOnly"
        >
          Apply only
        </button>
      </div>
      <p v-if="importError" class="field-error" data-testid="style-preset-import-error">
        {{ importError }}
      </p>
    </section>

    <section v-if="contextId" class="list-block">
      <div class="list-head">
        <span class="field-label">Saved presets</span>
        <button
          v-if="viaUrl && activeName"
          class="btn btn-outline btn-sm"
          data-testid="style-preset-clear"
          @click="clearStyle"
        >
          Stop using “{{ activeName }}”
        </button>
      </div>

      <p v-if="loading" class="muted">Loading presets…</p>

      <p v-else-if="presets.length === 0" class="muted" data-testid="style-preset-empty">
        None yet. Style the graph the way you want it, then save it above.
      </p>

      <ul v-else class="preset-list" data-testid="style-preset-list">
        <li
          v-for="entry in presets"
          :key="entry.name"
          class="preset-item"
          :class="{ active: activeName === entry.name }"
          :data-testid="`style-preset-item-${entry.name}`"
        >
          <button
            class="preset-name"
            :title="`Apply ${entry.name}`"
            :data-testid="`style-preset-apply-${entry.name}`"
            @click="apply(entry.name)"
          >
            <Check
              v-if="activeName === entry.name"
              :size="12"
              class="active-tick"
            />
            <span class="preset-label">{{ entry.name }}</span>
            <span class="preset-date">{{ formatDate(entry.modified_at) }}</span>
          </button>
          <div class="preset-actions">
            <button
              class="btn-icon-only"
              title="Export as JSON file"
              :data-testid="`style-preset-export-${entry.name}`"
              @click="exportPreset(entry.name)"
            >
              <Download :size="14" />
            </button>
            <button
              v-if="viaUrl"
              class="btn-icon-only"
              title="Copy link"
              :data-testid="`style-preset-copy-${entry.name}`"
              @click="copyLink(entry.name)"
            >
              <Link2 :size="14" />
            </button>
            <button
              class="btn-icon-only danger"
              title="Delete (only its creator can)"
              :data-testid="`style-preset-delete-${entry.name}`"
              @click="remove(entry.name)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </li>
      </ul>
    </section>

    <StylePresetSkillModal
      v-model="showSkill"
      :imported-json="importText"
      :imported-source="importedSource"
    />
  </div>
</template>

<style scoped>
.style-presets {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.7;
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

.import-textarea {
  font-family: 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  resize: vertical;
}

.warning-block {
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

.save-block,
.import-block,
.list-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.field-label {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.85;
}

.save-row {
  display: flex;
  gap: 6px;
  min-width: 0;
}

.field-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 6px 9px;
  font-size: 12px;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: var(--input-bg, #fff);
  color: inherit;
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

.preset-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow-y: auto;
}

.preset-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 4px;
}

.preset-item.active {
  border-color: var(--primary-color, #007bff);
}

.preset-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  padding: 2px 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.active-tick {
  flex-shrink: 0;
  color: var(--primary-color, #007bff);
}

.preset-label {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preset-date {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.55;
  white-space: nowrap;
}

.preset-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.btn-icon-only.danger:hover {
  color: var(--danger-color, #c0392b);
}
</style>
