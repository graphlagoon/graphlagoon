<script setup lang="ts">
/**
 * Case space (T10): versioned artifacts stored on the case Volume. People and
 * agents upload drafts; only a person approves. html/svg are never rendered.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import type { ArtifactKind, InvestigationActor, InvestigationArtifact } from '@/types/investigation';

const props = defineProps<{ investigationId: string; canEdit: boolean }>();
const emit = defineEmits<{ changed: [count: number] }>();

const KIND_LABELS: Record<ArtifactKind, string> = {
  slides: 'Slides',
  doc: 'Documents',
  report: 'Reports',
  image: 'Images',
  data: 'Data',
  other: 'Other',
};

const artifacts = ref<InvestigationArtifact[]>([]);
const selectedId = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const hidden = ref<Set<string>>(new Set());
const fileInput = ref<HTMLInputElement | null>(null);
let uploadTarget: string | undefined;

const preview = ref<{ text?: string; url?: string; type: 'text' | 'image' | 'pdf' | 'none' } | null>(null);

const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
const latest = (a: InvestigationArtifact) => a.versions[0];
const authorKind = (a: InvestigationArtifact) => latest(a)?.actor.kind ?? 'human';

const counts = computed(() => {
  const c: Record<string, number> = {};
  for (const a of artifacts.value) c[a.kind] = (c[a.kind] ?? 0) + 1;
  return c;
});

const visible = computed(() =>
  artifacts.value.filter(
    (a) => !hidden.value.has(a.kind) && !hidden.value.has(authorKind(a)) && !hidden.value.has(latest(a)?.status ?? 'draft'),
  ),
);

const selected = computed(() => artifacts.value.find((a) => a.id === selectedId.value) ?? null);

function toggle(key: string) {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = next;
}

function actorLabel(actor: InvestigationActor) {
  return actor.kind === 'agent' ? `agent · ${actor.agent_name}, for ${actor.email}` : `person · ${actor.email}`;
}

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '');

async function load() {
  error.value = null;
  try {
    artifacts.value = await api.getInvestigationArtifacts(props.investigationId);
    if (!selected.value) selectedId.value = artifacts.value[0]?.id ?? null;
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to load the case space');
  }
}

function replace(updated: InvestigationArtifact) {
  const i = artifacts.value.findIndex((a) => a.id === updated.id);
  if (i >= 0) artifacts.value.splice(i, 1, updated);
  else artifacts.value.unshift(updated);
  selectedId.value = updated.id;
  emit('changed', artifacts.value.length);
}

async function act(action: () => Promise<InvestigationArtifact>, fallback: string) {
  busy.value = true;
  error.value = null;
  try {
    replace(await action());
  } catch (e) {
    error.value = getErrorMessage(e, fallback);
  } finally {
    busy.value = false;
  }
}

function pickFile(artifactId?: string) {
  uploadTarget = artifactId;
  fileInput.value?.click();
}

function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  act(() => api.uploadInvestigationArtifact(props.investigationId, file, uploadTarget), 'Upload failed');
}

function approve(a: InvestigationArtifact) {
  act(() => api.approveArtifactVersion(props.investigationId, a.id, a.current_version), 'Approval failed');
}

async function download(a: InvestigationArtifact) {
  try {
    const blob = await api.getArtifactContent(props.investigationId, a.id, a.current_version);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = a.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    error.value = getErrorMessage(e, 'Download failed');
  }
}

function clearPreview() {
  if (preview.value?.url) URL.revokeObjectURL(preview.value.url);
  preview.value = null;
}

// Preview the latest version: md/txt as plain text (never HTML), images, pdf.
watch(
  () => (selected.value ? `${selected.value.id}:${selected.value.current_version}` : null),
  async () => {
    clearPreview();
    const a = selected.value;
    if (!a) return;
    const e = ext(a.name);
    const type = ['md', 'txt'].includes(e) ? 'text' : ['png', 'jpg', 'jpeg'].includes(e) ? 'image' : e === 'pdf' ? 'pdf' : 'none';
    if (a.download_only || type === 'none') {
      preview.value = { type: 'none' };
      return;
    }
    try {
      const blob = await api.getArtifactContent(props.investigationId, a.id, a.current_version);
      if (selected.value?.id !== a.id) return;
      preview.value =
        type === 'text'
          ? { type, text: await blob.text() }
          : { type, url: URL.createObjectURL(new Blob([blob], { type: latest(a).content_type })) };
    } catch {
      preview.value = { type: 'none' };
    }
  },
);

watch(() => props.investigationId, load, { immediate: true });
onUnmounted(clearPreview);
</script>

<template>
  <div class="space" data-testid="artifacts-space">
    <aside class="filters">
      <div class="filter-title">Type</div>
      <template v-for="(label, kind) in KIND_LABELS" :key="kind">
        <label v-if="counts[kind]">
          <input type="checkbox" :checked="!hidden.has(kind)" @change="toggle(kind)" /> {{ label }} ({{ counts[kind] }})
        </label>
      </template>
      <div class="filter-title">Author</div>
      <label><input type="checkbox" :checked="!hidden.has('human')" @change="toggle('human')" /> People</label>
      <label><input type="checkbox" :checked="!hidden.has('agent')" @change="toggle('agent')" /> Agents</label>
      <div class="filter-title">Status</div>
      <label><input type="checkbox" :checked="!hidden.has('draft')" @change="toggle('draft')" /> Draft</label>
      <label><input type="checkbox" :checked="!hidden.has('approved')" @change="toggle('approved')" /> Approved</label>
      <p class="info">
        Everything here lives in the case's storage, with hash and versions. Agents upload drafts; only people approve.
      </p>
    </aside>

    <section class="list">
      <div class="list-header">
        <h2>Case artifacts</h2>
        <button v-if="canEdit" class="btn btn-primary" :disabled="busy" data-testid="artifact-upload" @click="pickFile()">
          Upload artifact
        </button>
        <input ref="fileInput" type="file" hidden data-testid="artifact-file-input" @change="onFile" />
      </div>
      <div v-if="error" class="error" data-testid="artifact-error">{{ error }}</div>
      <button
        v-for="a in visible"
        :key="a.id"
        class="card"
        :class="{ active: a.id === selectedId }"
        :data-testid="`artifact-${a.id}`"
        @click="selectedId = a.id"
      >
        <span class="ext">{{ ext(a.name).toUpperCase() }}</span>
        <span class="card-main">
          <strong>{{ a.name }}</strong>
          <span class="muted">
            v{{ a.current_version }}<template v-if="latest(a)?.source_evidence_ids.length">
              · uses {{ latest(a).source_evidence_ids.join(', ') }}</template>
            · {{ when(latest(a)?.created_at) }}
          </span>
        </span>
        <span class="chip" :class="latest(a)?.actor.kind">{{ actorLabel(latest(a).actor) }}</span>
        <span class="chip" :class="latest(a)?.status" data-testid="artifact-status">
          {{ latest(a)?.status === 'approved' ? 'approved' : 'draft' }}
        </span>
      </button>
      <p v-if="!artifacts.length && !error" class="muted empty">
        No artifacts yet. Upload slides, documents, reports, images or data.
      </p>
    </section>

    <aside v-if="selected" class="detail" data-testid="artifact-detail">
      <h3>
        {{ selected.name }}
        <span class="muted">v{{ selected.current_version }} · sha256 {{ latest(selected).sha256.slice(0, 4) }}…{{ latest(selected).sha256.slice(-4) }}</span>
      </h3>
      <div class="preview" data-testid="artifact-preview">
        <pre v-if="preview?.type === 'text'">{{ preview.text }}</pre>
        <img v-else-if="preview?.type === 'image'" :src="preview.url" :alt="selected.name" />
        <iframe v-else-if="preview?.type === 'pdf'" :src="preview.url" :title="selected.name"></iframe>
        <p v-else class="muted">
          {{ selected.download_only ? 'Download only: this type is never opened in the browser.' : 'No preview for this type; download it.' }}
          {{ latest(selected).content_type }} · {{ latest(selected).size_bytes }} bytes
        </p>
      </div>
      <div class="filter-title">Versions</div>
      <ol class="versions">
        <li v-for="v in selected.versions" :key="v.version" :data-testid="`artifact-version-${v.version}`">
          v{{ v.version }} · {{ actorLabel(v.actor) }}<template v-if="v.note"> · {{ v.note }}</template>
          · <span :class="['chip', v.status]">{{ v.status }}</span>
          <template v-if="v.approved_by"> by {{ v.approved_by }}</template>
        </li>
      </ol>
      <div class="actions">
        <button class="btn btn-outline" data-testid="artifact-download" @click="download(selected)">Download</button>
        <template v-if="canEdit">
          <button class="btn btn-outline" :disabled="busy" data-testid="artifact-new-version" @click="pickFile(selected.id)">
            New version
          </button>
          <button
            v-if="latest(selected).status === 'draft'"
            class="btn btn-primary"
            :disabled="busy"
            data-testid="artifact-approve"
            @click="approve(selected)"
          >
            Approve v{{ selected.current_version }}
          </button>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.space {
  display: grid;
  grid-template-columns: 200px 1fr 360px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.filters,
.detail {
  padding: 16px;
  overflow-y: auto;
}

.filters {
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
}

.detail {
  border-left: 1px solid var(--border-color);
}

.filter-title {
  margin-top: 10px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
}

.info {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  font-size: 13px;
  background: var(--color-primary-subtle);
}

.list {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.list-header h2 {
  margin: 0;
  font-size: 18px;
}

.card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-color, #fff);
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: var(--text-color);
}

.card.active {
  border: 2px solid var(--color-primary);
}

.card-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ext {
  width: 40px;
  padding: 8px 0;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.chip {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  white-space: nowrap;
  background: var(--border-color);
}

.chip.agent {
  background: #ede9fe;
  color: #5b21b6;
}

.chip.approved {
  background: #d1fae5;
  color: #065f46;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.empty {
  margin-top: 24px;
}

.error {
  color: var(--color-danger, #b91c1c);
  font-size: 13px;
}

.detail h3 {
  margin: 0 0 10px;
  font-size: 16px;
}

.preview {
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  max-height: 320px;
  overflow: auto;
}

.preview pre {
  margin: 0;
  white-space: pre-wrap;
  font: inherit;
  font-size: 13px;
}

.preview img {
  max-width: 100%;
}

.preview iframe {
  width: 100%;
  height: 300px;
  border: none;
}

.versions {
  padding-left: 18px;
  font-size: 13px;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
