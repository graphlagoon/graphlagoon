<script setup lang="ts">
/**
 * Style presets: the Style panel's own contents, saved under a name.
 *
 * All of it lives in one modal opened from that panel, rather than inline in the
 * sidebar or behind a second toolbar button. A preset is not a setting you
 * nudge — it is an occasional, deliberate act — and the list plus a naming form
 * would crowd a 250px panel of sliders.
 *
 * Applying goes through the URL (`?style=<name>`), so whatever look is on screen
 * is always a link someone else can open.
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Check, Link2, Trash2, X } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import { ARTIFACT_NAME_PATTERN, type StylePresetEntry } from '@/types/graph';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';

const emit = defineEmits<{ (e: 'close'): void }>();

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

const contextId = computed(() => graphStore.currentContext?.id ?? null);
const activeName = computed(() => (route.query.style as string | undefined) ?? null);

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
  if (!contextId.value) return;
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
  if (saveBlockedReason.value) return;
  saving.value = true;
  error.value = null;
  const value = name.value.trim();
  try {
    await graphStore.saveStylePreset(value, description.value.trim() || undefined);
    await refresh();
    name.value = '';
    description.value = '';
    toast.success(`Style preset “${value}” saved`);
    apply(value);
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to save style preset');
  } finally {
    saving.value = false;
  }
}

function apply(value: string) {
  if (!contextId.value || activeName.value === value) return;
  router.replace({
    name: 'graph',
    params: { contextId: contextId.value },
    query: { ...route.query, style: value },
  });
}

function clearStyle() {
  if (!contextId.value) return;
  const query = { ...route.query };
  delete query.style;
  router.replace({ name: 'graph', params: { contextId: contextId.value }, query });
}

async function remove(value: string) {
  if (!contextId.value) return;
  if (!window.confirm(`Delete style preset “${value}”?`)) return;
  error.value = null;
  try {
    await api.deleteStylePreset(contextId.value, value);
    presets.value = presets.value.filter((p) => p.name !== value);
    if (activeName.value === value) clearStyle();
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

onMounted(refresh);
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal preset-modal" data-testid="style-preset-modal">
        <div class="modal-header">
          <h2>Style Presets</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')">
            <X :size="16" />
          </button>
        </div>

        <div class="modal-body">
          <p class="modal-hint">
            The style, labels and layout on this panel, stored under a name and
            opened from a link. A preset records nothing about which nodes are
            shown, so it applies to any graph in this context — including one
            loaded later.
          </p>

          <p
            v-if="graphStore.stylePresetError"
            class="field-error"
            data-testid="style-preset-url-error"
          >
            {{ graphStore.stylePresetError }}
          </p>
          <p v-if="error" class="field-error" data-testid="style-preset-error">
            {{ error }}
          </p>

          <section class="save-block" data-testid="style-preset-save">
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

          <section class="list-block">
            <div class="list-head">
              <span class="field-label">Saved presets</span>
              <button
                v-if="activeName"
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
        </div>

        <div class="modal-footer">
          <button
            class="btn btn-outline btn-sm"
            data-testid="style-preset-close"
            @click="emit('close')"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.preset-modal {
  background: var(--card-background, #fff);
  border-radius: 12px;
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h2 {
  margin: 0;
  font-size: 15px;
}

.modal-close {
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  padding: 2px;
}

.modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.modal-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.7;
}

.save-block,
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

.modal-footer {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}
</style>
