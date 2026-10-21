<script setup lang="ts">
/**
 * One doc of the org library (05 §6, 06): a playbook (markdown steps an agent
 * follows), a report template (markdown with {{placeholders}} rendered over a
 * case) or a file mapping (JSON the import wizard detects). The reference
 * under the body lists what this kind may use — placeholders, the agent's
 * tools, the mapping operators — from the server's authoring catalog; a click
 * inserts one at the cursor. "Ask an AI" copies a prompt to write or improve it.
 */
import { computed, nextTick, ref } from 'vue';
import { Bot } from 'lucide-vue-next';
import { buildLibrarySkill, type LibraryKind } from '@/utils/librarySkill';
import mappingExample from '@/assets/authoring/mapping-example.json';
import playbookExample from '@/assets/authoring/playbook-example.md?raw';
import templateExample from '@/assets/authoring/report-template-example.md?raw';
import HelpTip from '@/components/admin/HelpTip.vue';
import AuthoringSkillModal from '@/components/admin/AuthoringSkillModal.vue';
import type { OrgAuthoring } from '@/types/admin';
import type { CaseType } from '@/types/investigation';

export interface LibraryDraft {
  slug: string;
  title: string;
  kind: LibraryKind;
  body: string;
  isNew: boolean;
}

const props = defineProps<{ draft: LibraryDraft; authoring?: OrgAuthoring | null; caseTypes?: CaseType[] }>();
const emit = defineEmits<{ save: [draft: LibraryDraft]; cancel: [] }>();

const d = ref<LibraryDraft>({ ...props.draft });
const bodyEl = ref<HTMLTextAreaElement | null>(null);

const EXAMPLES: Record<LibraryKind, string> = {
  playbook: playbookExample.trim() + '\n',
  template: templateExample.trim() + '\n',
  mapping: JSON.stringify(mappingExample, null, 2) + '\n',
};
const KIND_LABELS: Record<LibraryKind, string> = { playbook: 'playbook', template: 'report template', mapping: 'file mapping (JSON)' };

/** For templates: the type whose fields the reference lists as {{fields.<id>}}. */
const typeSlug = ref('');
const forType = computed(() => (props.caseTypes ?? []).find((t) => t.slug === typeSlug.value) ?? null);
const typesWithFields = computed(() => (props.caseTypes ?? []).filter((t) => t.fields.length));

/** `{{key}}`, as written in a template (kept out of the template's own mustaches). */
const ph = (key: string) => `{{${key}}}`;

/** Inserts text at the cursor (or replaces the selection) and keeps the focus there. */
async function insert(text: string) {
  const el = bodyEl.value;
  const at = el ? el.selectionStart : d.value.body.length;
  const end = el ? el.selectionEnd : at;
  d.value.body = d.value.body.slice(0, at) + text + d.value.body.slice(end);
  await nextTick();
  el?.focus();
  el?.setSelectionRange(at + text.length, at + text.length);
}

const mappingError = computed(() => {
  if (d.value.kind !== 'mapping' || !d.value.body.trim()) return null;
  try {
    const m = JSON.parse(d.value.body);
    if (!m || typeof m !== 'object' || !['graph', 'enrichment'].includes(m.as) || typeof m.spec !== 'object') {
      return 'Expected {"as": "graph" | "enrichment", "spec": {…}}.';
    }
    return null;
  } catch (e) {
    return `Not valid JSON yet: ${(e as Error).message}`;
  }
});

const showSkill = ref(false);
const skillText = computed(() =>
  props.authoring
    ? buildLibrarySkill({
        kind: d.value.kind,
        authoring: props.authoring,
        caseType: forType.value ? { slug: forType.value.slug, label: forType.value.label, fields: forType.value.fields } : null,
        current: d.value.isNew && (!d.value.body.trim() || d.value.body === EXAMPLES[d.value.kind]) ? null : d.value.body,
      })
    : '',
);
</script>

<template>
  <form class="card doc-editor" data-testid="admin-library-editor" @submit.prevent="emit('save', d)">
    <div class="form-row">
      <label>Slug <input v-model="d.slug" class="form-control" :disabled="!d.isNew" pattern="[a-z0-9_-]+" required data-testid="library-slug" /></label>
      <label>Title <input v-model="d.title" class="form-control" required data-testid="library-title" /></label>
      <label>
        <span class="with-help">
          Kind
          <HelpTip title="Kinds of library doc" testid="library-kind">
            <span><b>Playbook</b>: markdown steps an AI agent follows on a case; agents get it as an MCP prompt and with <code>get_playbook</code>, and a case type can name it. <code>{investigation_id}</code> becomes the case.</span>
            <span><b>Report template</b>: markdown with <code v-pre>{{placeholders}}</code>; "Draft report" in the dossier (or the agent's <code>render_report</code>) fills it with a case's data into a document the person reviews.</span>
            <span><b>File mapping</b>: JSON <code>{"as": "graph" | "enrichment", "spec"}</code>; the import wizard starts from it when a file matches.</span>
          </HelpTip>
        </span>
        <select v-model="d.kind" class="form-control" data-testid="library-kind">
          <option v-for="(label, k) in KIND_LABELS" :key="k" :value="k">{{ label }}</option>
        </select>
      </label>
    </div>

    <div class="tools">
      <button type="button" class="btn btn-outline btn-sm" :disabled="!authoring" data-testid="library-ask-ai" @click="showSkill = true"><Bot :size="14" /> Ask an AI</button>
      <button type="button" class="btn btn-outline btn-sm" data-testid="library-example" @click="d.body = EXAMPLES[d.kind]">Start from the example</button>
      <span class="muted">replaces the body; nothing is saved until you save</span>
    </div>

    <textarea ref="bodyEl" v-model="d.body" class="form-control body" rows="18" spellcheck="false" data-testid="library-body"></textarea>
    <p v-if="mappingError" class="error" data-testid="library-mapping-error">{{ mappingError }}</p>

    <!-- Reference for this kind, from the server's catalog -->
    <div v-if="authoring" class="reference" data-testid="library-reference">
      <template v-if="d.kind === 'template'">
        <div class="ref-head">
          <strong>Placeholders</strong> <span class="muted">click to insert · a placeholder the case lacks stays in the text</span>
          <label v-if="typesWithFields.length" class="inline">
            fields of
            <select v-model="typeSlug" class="form-control" data-testid="library-template-type">
              <option value="">— a case type —</option>
              <option v-for="t in typesWithFields" :key="t.slug" :value="t.slug">{{ t.label }}</option>
            </select>
          </label>
        </div>
        <div class="chips">
          <button
            v-for="p in authoring.report_placeholders.filter((x) => x.key !== 'fields.<id>')"
            :key="p.key"
            type="button"
            class="chip"
            :title="p.description"
            :data-testid="`library-placeholder-${p.key}`"
            @click="insert(ph(p.key))"
            v-text="ph(p.key)"
          ></button>
          <button
            v-for="f in forType?.fields ?? []"
            :key="f.id"
            type="button"
            class="chip field"
            :title="`${f.label} (${f.type})`"
            :data-testid="`library-placeholder-fields.${f.id}`"
            @click="insert(ph(`fields.${f.id}`))"
            v-text="ph(`fields.${f.id}`)"
          ></button>
        </div>
      </template>
      <template v-else-if="d.kind === 'playbook'">
        <div class="ref-head"><strong>The agent's tools</strong> <span class="muted">click to insert · <code>{investigation_id}</code> is the case · the standing rules (never decide, untrusted data…) are added for you</span></div>
        <div class="chips">
          <button v-for="t in authoring.agent_tools" :key="t.name" type="button" class="chip" :title="t.summary" :data-testid="`library-tool-${t.name}`" @click="insert(`\`${t.name}\``)">{{ t.name }}</button>
        </div>
      </template>
      <template v-else>
        <div class="ref-head"><strong>Mapping operators</strong> <span class="muted">the full format is in "Ask an AI" and the example</span></div>
        <p class="ops"><b>convert</b> {{ authoring.mapping.converters.join(', ') }}</p>
        <p class="ops"><b>normalize</b> {{ authoring.mapping.normalizers.join(', ') }}</p>
        <p class="ops"><b>when</b> {{ authoring.mapping.when_ops.join(', ') }} · inputs take <code>delimiter</code> or fixed-width <code>widths</code></p>
      </template>
    </div>

    <div class="form-row">
      <button type="submit" class="btn btn-primary btn-sm" :disabled="!!mappingError" data-testid="admin-library-save">Save</button>
      <button type="button" class="btn btn-outline btn-sm" @click="emit('cancel')">Cancel</button>
    </div>

    <AuthoringSkillModal v-model="showSkill" :title="`Ask an AI to write a ${KIND_LABELS[d.kind]}`" :text="skillText" testid="library-skill">
      Copy this into any AI assistant. It explains how a {{ KIND_LABELS[d.kind] }} works, lists exactly what it may use
      (from this server) with an example, and asks the AI to interview you first. Paste its answer into the body above,
      review it and save.
    </AuthoringSkillModal>
  </form>
</template>

<style scoped>
.doc-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
}

.body {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.with-help {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tools {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tools .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.reference {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 12px;
}

.ref-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 160px;
  overflow: auto;
}

.chip {
  padding: 1px 6px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--color-surface, #fff);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.chip.field {
  border-style: dashed;
}

.ops {
  margin: 0;
}

.muted {
  color: var(--text-muted);
  font-size: 12px;
}

.error {
  margin: 0;
  color: var(--color-danger, #b91c1c);
  font-size: 12px;
}
</style>
