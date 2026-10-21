<script setup lang="ts">
/**
 * "Add file to the case" (05 §4): two steps. 1 · what it is (files, detected
 * layout, graph | enrichment | document); 2 · the mapping (MappingStep, reused by
 * "query → graph"). Files are read in the browser for detection and preview
 * (fileMapping.ts, the twin of the server interpreter); "Add to case" uploads them
 * (sha256 on the server) as items of the case, with the mapping on the main one.
 * The org's saved mappings (library docs of kind `mapping`, 06 P5) are matched
 * against the files; a superuser saves the current one for the org.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import { lines, matchFile, parseLine, suggestPresets, type MappingSpec } from '@/utils/fileMapping';
import { encodingFor, genericSpec, guessDelimiter } from '@/utils/fileImport';
import MappingStep from '@/components/investigation/MappingStep.vue';
import type { CaseItem, FileEnrichmentSpec } from '@/types/investigation';

type FileRole = 'graph' | 'enrichment' | 'attachment';

const props = defineProps<{ investigationId: string; initialRole?: FileRole }>();
const emit = defineEmits<{ close: []; done: [items: CaseItem[], graph: CaseItem | null] }>();

interface Picked {
  file: File;
  buffer: ArrayBuffer;
  sha256: string | null;
}

const STEPS = ['What it is', 'Mapping'];
const step = ref(1);
const picked = ref<Picked[]>([]);
const role = ref<FileRole>(props.initialRole ?? 'graph');
const detected = ref<string | null>(null);
/** Mapping specs the files are matched against, by slug (the org's saved mappings). */
const templates = ref<Record<string, MappingSpec>>({});
/** Saved enrichment mappings: used when their key and columns are in the file's header. */
const enrichmentTemplates = ref<Record<string, FileEnrichmentSpec>>({});
const isSuperuser = window.__GRAPH_LAGOON_CONFIG__?.is_superuser === true;

onMounted(async () => {
  try {
    for (const doc of await api.getOrgLibrary('mapping')) {
      const m = JSON.parse(doc.body) as { as?: string; spec?: unknown };
      if (m.as === 'graph') templates.value[doc.slug] = { ...(m.spec as MappingSpec), name: (m.spec as MappingSpec).name ?? doc.title };
      if (m.as === 'enrichment') enrichmentTemplates.value[doc.slug] = m.spec as FileEnrichmentSpec;
    }
    if (picked.value.length) detect();
  } catch {
    /* no library (older backend): the generic start still works */
  }
});
const specText = ref('');
const enrichment = ref<FileEnrichmentSpec | null>(null);
const title = ref('');
const mappingValid = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
/** Uploaded rows, kept so a retry after a failed generation does not upload twice. */
const uploaded = ref<CaseItem[]>([]);

function readBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function sha256(buffer: ArrayBuffer): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // no WebCrypto (plain http): the server hash is the one that counts
  }
}

const spec = computed<MappingSpec | null>(() => {
  try {
    return JSON.parse(specText.value) as MappingSpec;
  } catch {
    return null;
  }
});

/** Decoded with the encoding the spec gives each file (bank statement exports are often Latin-1). */
const texts = computed<Record<string, string>>(() =>
  Object.fromEntries(picked.value.map((p) => [p.file.name, new TextDecoder(encodingFor(spec.value, p.file.name)).decode(p.buffer)])),
);
const fileNames = computed(() => picked.value.map((p) => p.file.name));

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  error.value = null;
  picked.value = await Promise.all(
    files.map(async (file) => {
      const buffer = await readBuffer(file);
      return { file, buffer, sha256: await sha256(buffer) };
    }),
  );
  uploaded.value = [];
  detect();
}

/** Picks the saved mapping whose inputs match the files, else a generic two-column start. */
function detect() {
  const raw = Object.fromEntries(picked.value.map((p) => [p.file.name, new TextDecoder('latin1').decode(p.buffer)]));
  const found = suggestPresets(raw, templates.value);
  detected.value = found[0] ?? null;
  const first = picked.value[0];
  const base = detected.value ? templates.value[detected.value] : first ? genericSpec(first.file.name, raw[first.file.name]) : null;
  specText.value = base ? JSON.stringify(base, null, 2) : '';
  if (!props.initialRole) role.value = 'graph';
  enrichment.value = first ? savedEnrichment(raw[first.file.name]) ?? genericEnrichment(first.file.name, raw[first.file.name]) : null;
  title.value = picked.value.length > 1 ? `${detected.value ? base!.name : 'Files'} · ${first!.file.name.split('_')[0]}` : (first?.file.name ?? '');
}

function savedEnrichment(text: string): FileEnrichmentSpec | null {
  for (const s of Object.values(enrichmentTemplates.value)) {
    const header = new Set(parseLine(lines(text)[0] ?? '', s.input?.delimiter ?? ','));
    if (header.has(s.key_column) && s.columns.every((c) => header.has(c))) return structuredClone(s);
  }
  return null;
}

// --- "Save for the org" (superusers): the mapping becomes a library doc ----------
const saveSlug = ref('');
const saved = ref<string | null>(null);
async function saveForOrg() {
  const slug = saveSlug.value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return;
  error.value = null;
  try {
    const body = role.value === 'enrichment' ? { as: 'enrichment', spec: enrichment.value } : { as: 'graph', spec: spec.value };
    const titleOf = role.value === 'enrichment' ? enrichment.value?.name : spec.value?.name;
    await api.putAdminLibraryDoc(slug, { title: titleOf || slug, kind: 'mapping', body: JSON.stringify(body) });
    saved.value = slug;
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to save the mapping for the org');
  }
}

function genericEnrichment(name: string, text: string): FileEnrichmentSpec {
  const delimiter = guessDelimiter(text);
  const header = parseLine(lines(text)[0] ?? '', delimiter);
  return { name, input: { delimiter, header: true }, key_column: header[0] ?? '', columns: header.slice(1, 11), match_node_types: [], match_source: 'node_id', key_digits: null };
}

const canNext = computed(() => picked.value.length > 0);
const canSubmit = computed(() => (role.value === 'attachment' ? picked.value.length > 0 : mappingValid.value));

async function submit() {
  busy.value = true;
  error.value = null;
  try {
    // Every file is an item of the case (05 §1): a table (graph/enrichment) or a document.
    for (const p of picked.value.slice(uploaded.value.length)) {
      uploaded.value.push(
        await api.uploadInvestigationItem(props.investigationId, p.file, role.value === 'attachment' ? { kind: 'document', subkind: 'upload' } : { kind: 'table', subkind: 'csv' }),
      );
    }
    let items = [...uploaded.value];
    let graph: CaseItem | null = null;
    const nameOf = (i: CaseItem) => i.provenance.filename ?? i.title;
    if (role.value === 'graph') {
      // The main file carries the mapping; the others are its extra inputs (a multi-file layout).
      const first = Object.values(spec.value!.inputs)[0];
      const mainName = first ? matchFile(first, items.map(nameOf)) : null;
      items.sort((a, b) => Number(nameOf(b) === mainName) - Number(nameOf(a) === mainName));
      graph = await api.updateInvestigationItem(props.investigationId, items[0].id, {
        title: title.value.trim() || undefined,
        mapping: { as: 'graph', spec: spec.value! as unknown as Record<string, unknown>, extra_item_ids: items.slice(1).map((f) => f.id) },
      });
      items = [graph, ...items.slice(1)];
    } else if (role.value === 'enrichment') {
      items = await Promise.all(items.map((f) => api.updateInvestigationItem(props.investigationId, f.id, { mapping: { as: 'enrichment', spec: enrichment.value! } })));
    }
    emit('done', items, graph);
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to add the file');
  } finally {
    busy.value = false;
  }
}

watch(role, () => (error.value = null));
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal wizard" data-testid="file-import-wizard">
      <div class="modal-header">
        <h2>Add file to the case <small v-if="step > 1" class="hint">as <strong>{{ role }}</strong></small></h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </div>

      <ol class="steps">
        <li v-for="(s, i) in STEPS" :key="s" :class="{ done: i + 1 < step, current: i + 1 === step, skipped: role === 'attachment' && i === 1 }">{{ i + 1 }} {{ s }}</li>
      </ol>

      <div class="wizard-body">
        <!-- 1 · What it is -->
        <section v-if="step === 1" class="what">
          <p class="hint">Pick every file of the layout at once (a statement delivery can be several related files).</p>
          <input type="file" multiple data-testid="wizard-files" @change="onFiles" />
          <ul class="chips">
            <li v-for="p in picked" :key="p.file.name" class="chip">
              {{ p.file.name }} · {{ p.file.size }} B<template v-if="p.sha256"> · {{ p.sha256.slice(0, 8) }}…</template>
            </li>
          </ul>
          <p v-if="picked.length" class="detected-line">
            <span v-if="detected" class="badge" data-testid="wizard-detected-hint">DETECTED</span>
            {{ detected ? templates[detected].name : 'No known layout: a generic mapping starts from the first columns.' }}
          </p>
          <div class="roles">
            <label class="role-opt">
              <input v-model="role" type="radio" value="graph" data-testid="wizard-role-graph" />
              <span><strong>Graph</strong><br /><span class="hint">a table of the case mapped onto the canvas (no context is created)</span></span>
            </label>
            <label class="role-opt">
              <input v-model="role" type="radio" value="enrichment" data-testid="wizard-role-enrichment" />
              <span><strong>Enrichment</strong><br /><span class="hint">joined by key to the case's nodes, in the inspector</span></span>
            </label>
            <label class="role-opt">
              <input v-model="role" type="radio" value="attachment" data-testid="wizard-role-attachment" />
              <span><strong>Document</strong><br /><span class="hint">kept with its hash, never read into the graph</span></span>
            </label>
          </div>
        </section>

        <!-- 2 · Mapping -->
        <MappingStep
          v-else-if="role !== 'attachment'"
          :role="role"
          :texts="texts"
          :file-names="fileNames"
          :detected="detected ? (templates[detected].name ?? detected) : null"
          v-model:spec-text="specText"
          v-model:enrichment="enrichment"
          v-model:title="title"
          @update:valid="mappingValid = $event"
        />
        <section v-else>
          <ul class="review">
            <li><strong>{{ picked.length }}</strong> file{{ picked.length === 1 ? '' : 's' }} kept as documents with their SHA-256.</li>
          </ul>
        </section>

        <p v-if="step === 2 && isSuperuser && role !== 'attachment'" class="save-org" data-testid="wizard-save-org">
          <input v-model="saveSlug" class="form-control" placeholder="mapping-slug" aria-label="Slug of the saved mapping" data-testid="wizard-save-slug" />
          <button type="button" class="btn btn-outline btn-sm" :disabled="!saveSlug.trim() || (role === 'graph' ? !mappingValid : !enrichment)" data-testid="wizard-save-org-btn" @click="saveForOrg">
            Save this mapping for the org
          </button>
          <span v-if="saved" class="hint" data-testid="wizard-saved">saved as “{{ saved }}”: the next files with this layout start from it</span>
        </p>
        <p v-if="error" class="error-message" data-testid="wizard-error">{{ error }}</p>
      </div>

      <div class="modal-footer">
        <button v-if="step > 1" type="button" class="btn btn-outline" @click="step = 1">Back</button>
        <button v-if="step === 1" type="button" class="btn btn-primary" :disabled="!canNext" data-testid="wizard-next" @click="step = 2">
          Next: {{ role === 'attachment' ? 'review' : 'mapping' }}
        </button>
        <button v-else type="button" class="btn btn-primary" :disabled="busy || !canSubmit" data-testid="wizard-submit" @click="submit">
          {{ busy ? 'Adding…' : 'Add to case' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard {
  max-width: 1100px;
  width: 95vw;
}
.wizard-body {
  max-height: 68vh;
  overflow: auto;
}
.steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
}
.steps li {
  padding: 4px 12px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-size: 12px;
}
.steps li.done {
  background: var(--bg-secondary);
}
.steps li.current {
  background: var(--color-primary);
  color: #fff;
  font-weight: 600;
}
.steps li.skipped {
  opacity: 0.4;
}
.what {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  padding: 0;
  margin: 0;
}
.chip {
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
}
.save-org {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 8px 0 0;
}

.save-org .form-control {
  max-width: 220px;
}

.detected-line {
  margin: 0;
  font-size: 13px;
}
.badge {
  background: var(--bg-secondary);
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  margin-right: 6px;
}
.roles {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.role-opt {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.hint {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
