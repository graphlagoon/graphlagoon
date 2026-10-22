<script setup lang="ts">
/**
 * What a person changes on an item of the material (UX-1), under its card in the inspector:
 * its title, description and tags (never its content: content changes are new versions);
 * its place among the items of its kind; a new version (edit the text of a note or markdown
 * document, upload a new file); and every version, each previewed, downloaded or pinned as
 * evidence with an optional label. Query runs keep their own history in the query card.
 */
import { computed, ref, watch } from 'vue';
import { api } from '@/services/api';
import { useInvestigationStore } from '@/stores/investigation';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { formatDate } from '@/utils/format';
import ItemPreview from '@/components/investigation/ItemPreview.vue';
import type { CaseItem, CaseItemVersion } from '@/types/investigation';

const props = defineProps<{ item: CaseItem; canEdit: boolean }>();

const store = useInvestigationStore();
const toast = useToast();
const { can } = usePermissions();
const busy = ref(false);

async function act(action: () => Promise<unknown>, fallback: string) {
  busy.value = true;
  try {
    await action();
    return true;
  } catch (e) {
    toast.error(getErrorMessage(e, fallback));
    return false;
  } finally {
    busy.value = false;
  }
}

// --- title, description, tags --------------------------------------------------
const editing = ref(false);
const title = ref('');
const description = ref('');
const tags = ref('');
/** The dossier flag is a tag the UI owns: kept, never shown as text. */
const userTags = computed(() => props.item.tags.filter((t) => t !== 'dossier'));
function startEdit() {
  title.value = props.item.title;
  description.value = props.item.description ?? '';
  tags.value = userTags.value.join(', ');
  editing.value = true;
}
async function saveEdit() {
  const nextTags = [...new Set(tags.value.split(',').map((t) => t.trim()).filter(Boolean))];
  const ok = await act(
    () =>
      store.updateItem(props.item.id, {
        title: title.value.trim() || props.item.title,
        // A note's description is its text: edited as a new version below, not here.
        ...(props.item.kind === 'note' ? {} : { description: description.value.trim() || null }),
        tags: props.item.tags.includes('dossier') ? [...nextTags, 'dossier'] : nextTags,
      }),
    'Failed to save the item',
  );
  if (ok) editing.value = false;
}

// --- order ------------------------------------------------------------------
const siblings = computed(() =>
  store.items.filter((i) => i.kind === props.item.kind && i.subkind !== 'brief').sort((a, b) => a.position - b.position),
);
const at = computed(() => siblings.value.findIndex((i) => i.id === props.item.id));

// --- new version ----------------------------------------------------------------
const textEditable = computed(
  () => props.item.kind === 'note' || (props.item.kind === 'document' && props.item.subkind === 'markdown'),
);
const editingText = ref(false);
const text = ref('');
async function startText() {
  if (props.item.kind === 'note' && props.item.description) text.value = props.item.description;
  else if (props.item.current_version && store.current) {
    const ok = await act(async () => {
      text.value = new TextDecoder().decode(await api.getInvestigationItemContent(store.current!.id, props.item.id));
    }, 'Failed to read the text');
    if (!ok) return;
  } else text.value = '';
  editingText.value = true;
}
async function saveText() {
  if (!text.value.trim()) return;
  const ok = await act(() => store.editItemText(props.item, text.value), 'Failed to save the new version');
  if (ok) {
    editingText.value = false;
    toast.success(`Saved as version ${props.item.current_version + 1}`);
  }
}
const fileInput = ref<HTMLInputElement | null>(null);
async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = '';
  if (!file) return;
  if (await act(() => store.uploadVersion(props.item.id, file), 'Failed to upload the new version')) {
    toast.success(`“${file.name}” is the new version`);
  }
}

// --- versions -------------------------------------------------------------------
const showVersions = ref(false);
const versions = ref<CaseItemVersion[]>([]);
const previewing = ref<number | null>(null);
const pinning = ref<number | null>(null);
const pinLabel = ref('');
async function loadVersions() {
  if (!store.current) return;
  versions.value = (await api.getInvestigationItemVersions(store.current.id, props.item.id)).slice().reverse();
}
watch(
  () => [showVersions.value, props.item.id, props.item.current_version, props.item.pinned.length] as const,
  ([open]) => {
    if (open) void act(loadVersions, 'Failed to list the versions');
  },
);
async function pin(v: CaseItemVersion) {
  const label = pinLabel.value.trim();
  const ok = await act(async () => {
    const pinned = await store.pinItem(props.item.id, { version: v.version, ...(label ? { label } : {}) });
    if (pinned) toast.success(`Pinned v${pinned.version} · hash ${pinned.sha256.slice(0, 8)}`);
  }, 'Failed to pin');
  if (ok) {
    pinning.value = null;
    pinLabel.value = '';
  }
}
</script>

<template>
  <div class="item-details" data-testid="item-details">
    <div v-if="canEdit" class="row-actions">
      <button v-if="!editing" class="btn btn-outline btn-sm" data-testid="item-edit" @click="startEdit">Edit</button>
      <button
        class="btn btn-outline btn-sm"
        :disabled="busy || at <= 0"
        title="Move up among the items of this kind"
        aria-label="Move up"
        data-testid="item-move-up"
        @click="act(() => store.moveItem(item, -1), 'Failed to move the item')"
      >↑</button>
      <button
        class="btn btn-outline btn-sm"
        :disabled="busy || at < 0 || at >= siblings.length - 1"
        title="Move down among the items of this kind"
        aria-label="Move down"
        data-testid="item-move-down"
        @click="act(() => store.moveItem(item, 1), 'Failed to move the item')"
      >↓</button>
      <button v-if="textEditable && !editingText" class="btn btn-outline btn-sm" :disabled="busy" data-testid="item-edit-text" @click="startText">Edit text</button>
      <template v-if="item.subkind === 'upload' && can('investigation.upload')">
        <button class="btn btn-outline btn-sm" :disabled="busy" data-testid="item-upload-version" @click="fileInput?.click()">Upload new version</button>
        <input ref="fileInput" type="file" class="hidden" data-testid="item-upload-version-input" @change="onFile" />
      </template>
      <button
        v-if="item.status === 'rejected'"
        class="btn btn-outline btn-sm"
        :disabled="busy"
        data-testid="item-reopen"
        @click="act(() => store.reopenItem(item.id), 'Failed to reopen')"
      >Reopen the suggestion</button>
    </div>

    <form v-if="editing" class="edit" data-testid="item-edit-form" @submit.prevent="saveEdit">
      <label>Title <input v-model="title" class="form-control" maxlength="255" data-testid="item-edit-title" /></label>
      <label v-if="item.kind !== 'note'">Description <textarea v-model="description" rows="2" class="form-control" data-testid="item-edit-description"></textarea></label>
      <label>Tags <input v-model="tags" class="form-control" placeholder="comma, separated" data-testid="item-edit-tags" /></label>
      <div class="row-actions">
        <button type="submit" class="btn btn-primary btn-sm" :disabled="busy" data-testid="item-edit-save">Save</button>
        <button type="button" class="btn btn-outline btn-sm" @click="editing = false">Cancel</button>
      </div>
    </form>
    <p v-else-if="userTags.length" class="muted">Tags: {{ userTags.join(', ') }}</p>

    <form v-if="editingText" class="edit" data-testid="item-text-form" @submit.prevent="saveText">
      <textarea v-model="text" rows="8" class="form-control mono" data-testid="item-text-input"></textarea>
      <p class="muted">Saved as a new version; the earlier ones stay, and pinned ones never change.</p>
      <div class="row-actions">
        <button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !text.trim()" data-testid="item-text-save">Save version</button>
        <button type="button" class="btn btn-outline btn-sm" @click="editingText = false">Cancel</button>
      </div>
    </form>

    <template v-if="item.current_version && item.kind !== 'query'">
      <button class="link-btn" :aria-expanded="showVersions" data-testid="item-versions-toggle" @click="showVersions = !showVersions">
        {{ showVersions ? '▾' : '▸' }} Versions ({{ item.current_version }})
      </button>
      <ul v-if="showVersions" class="versions" data-testid="item-versions">
        <li v-for="v in versions" :key="v.version" :data-testid="`item-version-${v.version}`">
          <div class="version-head">
            <strong>v{{ v.version }}</strong>
            <span class="muted">{{ v.author_kind === 'agent' ? 'agent · ' : '' }}{{ v.created_by }}<template v-if="v.created_at"> · {{ formatDate(v.created_at) }}</template></span>
            <span v-if="v.pinned_at" class="badge" :title="`Pinned by ${v.pinned_by}`">📌 {{ store.evidenceLabel(item.id, v.version) }}<template v-if="v.pin_label"> · {{ v.pin_label }}</template></span>
          </div>
          <div class="row-actions">
            <button class="link-btn" :data-testid="`item-version-preview-${v.version}`" @click="previewing = previewing === v.version ? null : v.version">
              {{ previewing === v.version ? 'Close' : 'Preview / download' }}
            </button>
            <button
              v-if="canEdit && !v.pinned_at"
              class="link-btn"
              :data-testid="`item-version-pin-${v.version}`"
              @click="pinning = pinning === v.version ? null : v.version"
            >Pin as evidence…</button>
          </div>
          <form v-if="pinning === v.version" class="pin-form" @submit.prevent="pin(v)">
            <input v-model="pinLabel" class="form-control" placeholder="Label (optional), e.g. as sent to the bank" maxlength="255" :data-testid="`item-version-pin-label-${v.version}`" />
            <button type="submit" class="btn btn-primary btn-sm" :disabled="busy" :data-testid="`item-version-pin-save-${v.version}`">Pin v{{ v.version }}</button>
          </form>
          <ItemPreview v-if="previewing === v.version && store.current" :item="item" :investigation-id="store.current.id" :version="v" />
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.item-details {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.edit label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mono {
  font-family: var(--font-mono, monospace);
}

.muted {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.hidden {
  display: none;
}

.link-btn {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--color-primary);
  font-size: 12px;
  cursor: pointer;
}

.versions {
  margin: 0;
  padding: 0;
  list-style: none;
}

.versions li {
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border-subtle);
}

.version-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  font-size: 12px;
}

.pin-form {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.badge {
  font-size: 11px;
}
</style>
