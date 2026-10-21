<script setup lang="ts">
/**
 * Case type editor (06 §1): what one kind of case means to the org. Vocabulary,
 * the decision catalog (outcomes and the actions they set in motion), the case's
 * fields, stages, SLA hours, retention, a notice, the agent's suggest kinds and
 * playbook, and the data a new case starts from (06 P5): starter queries, report
 * templates and the trace defaults. The server validates the spec (`schemas.CaseTypeSpec`).
 *
 * Help (06): a ? on each section, "Ask an AI" (a prompt built from the server's
 * authoring catalog, to write a new type or improve this one), and Import /
 * Copy JSON to bring the AI's answer back or take a type elsewhere.
 */
import { computed, reactive, ref } from 'vue';
import { Bot, ClipboardCopy, FileJson } from 'lucide-vue-next';
import { SUGGEST_KINDS } from '@/utils/caseVocabulary';
import { buildCaseTypeSkill } from '@/utils/caseTypeSkill';
import HelpTip from '@/components/admin/HelpTip.vue';
import AuthoringSkillModal from '@/components/admin/AuthoringSkillModal.vue';
import type { OrgAuthoring, OrgLibraryDoc } from '@/types/admin';
import type { CaseFieldType, CaseType, CaseTypeSpec, CaseTypeTraceDefaults } from '@/types/investigation';

const props = defineProps<{
  caseType: CaseType | null;
  library: OrgLibraryDoc[];
  busy?: boolean;
  /** `GET /api/org/authoring`: the schema and the lists the help and the AI prompt use. */
  authoring?: OrgAuthoring | null;
  /** The org's types, so the AI prompt does not duplicate one. */
  caseTypes?: { slug: string; label: string }[];
}>();
const emit = defineEmits<{ save: [slug: string, spec: CaseTypeSpec]; cancel: [] }>();

const FIELD_TYPES: CaseFieldType[] = ['text', 'number', 'money', 'date', 'enum'];
const isNew = computed(() => !props.caseType);
const list = (v: string[] | undefined | null) => (v ?? []).join(', ');
const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
/** "Report to the authorities" → "report_to_the_authorities". */
const slugify = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'x$1').slice(0, 50);
const blank = (v: number | null | undefined) => (v ?? '') as number | '';

/** The form for a spec (a saved type, or JSON pasted from an AI). */
function formFrom(t: (Partial<CaseTypeSpec> & { slug?: string }) | null) {
  return {
    slug: t?.slug ?? '',
    label: t?.label ?? '',
    description: t?.description ?? '',
    roles: list(t?.vocabularies?.roles),
    tags: list(t?.vocabularies?.tags),
    link_attributes: list(t?.vocabularies?.link_attributes),
    roles_multi: t?.roles_multi ?? false,
    outcomes: (t?.outcomes ?? []).map((o) => ({
      id: o.id ?? '', label: o.label ?? '', description: o.description ?? '',
      closes_case: o.closes_case ?? true, requires_review: o.requires_review ?? false,
    })),
    actions: (t?.actions ?? []).map((a) => ({ id: a.id ?? '', label: a.label ?? '', due_hours: blank(a.due_hours) })),
    fields: (t?.fields ?? []).map((f) => ({
      id: f.id ?? '', label: f.label ?? '', type: (f.type ?? 'text') as CaseFieldType,
      options: list(f.options), required: f.required ?? false, in_queue: f.in_queue ?? false,
    })),
    stages: list(t?.stages),
    sla_open: blank(t?.sla_hours?.open),
    sla_analysis: blank(t?.sla_hours?.analysis),
    retention_years: blank(t?.retention_years),
    notice: t?.notice ?? '',
    suggest_default: !t?.agent_suggest_kinds,
    suggest: [...(t?.agent_suggest_kinds ?? [])],
    playbook: t?.playbook ?? '',
    starter_queries: (t?.starter_queries ?? []).map((q) => ({ ...q, parameters: q.parameters ?? [] })),
    report_templates: [...(t?.report_templates ?? [])],
    trace_hops: blank(t?.analysis_defaults?.trace?.max_hops),
    trace_dwell: blank(t?.analysis_defaults?.trace?.max_dwell_hours),
    trace_min: blank(t?.analysis_defaults?.trace?.min_amount),
  };
}

const form = reactive(formFrom(props.caseType));
/** Trace defaults the form has no input for (allocation, stop types): kept as loaded. */
const baseTrace = ref<CaseTypeTraceDefaults>({ ...(props.caseType?.analysis_defaults?.trace ?? {}) });
const error = ref<string | null>(null);
const playbooks = computed(() => props.library.filter((d) => d.kind === 'playbook'));
const templates = computed(() => props.library.filter((d) => d.kind === 'template'));
/** The server's list when it is loaded, else the client's. */
const suggestKinds = computed(() => props.authoring?.suggest_kinds.all ?? [...SUGGEST_KINDS]);
const defaultSuggest = computed(() => props.authoring?.suggest_kinds.default.join(', ') ?? 'role, tag, hypothesis_status, same_as, status_change, task');
function addQuery() {
  form.starter_queries.push({ title: '', language: 'sql', query: '', parameters: [] });
}
const closes = computed(() => !form.outcomes.length || form.outcomes.some((o) => o.closes_case));

function addOutcome() {
  form.outcomes.push({ id: '', label: '', description: '', closes_case: true, requires_review: false });
}
function addAction() {
  form.actions.push({ id: '', label: '', due_hours: '' });
}
function addField() {
  form.fields.push({ id: '', label: '', type: 'text', options: '', required: false, in_queue: false });
}
const num = (v: number | '' | null | undefined) => (v === '' || v === null || v === undefined ? null : Number(v));

/** The spec as the server takes it (no validation here: see submit). */
function buildSpec(): CaseTypeSpec {
  return {
    label: form.label.trim(),
    description: form.description.trim() || null,
    vocabularies: { roles: split(form.roles), tags: split(form.tags), link_attributes: split(form.link_attributes) },
    roles_multi: form.roles_multi,
    outcomes: form.outcomes
      .filter((o) => o.label.trim())
      .map((o) => ({ id: o.id.trim() || slugify(o.label), label: o.label.trim(), description: o.description.trim() || null, closes_case: o.closes_case, requires_review: o.requires_review })),
    actions: form.actions
      .filter((a) => a.label.trim())
      .map((a) => ({ id: a.id.trim() || slugify(a.label), label: a.label.trim(), due_hours: num(a.due_hours) })),
    stages: split(form.stages),
    fields: form.fields
      .filter((f) => f.label.trim())
      .map((f) => ({
        id: f.id.trim() || slugify(f.label),
        label: f.label.trim(),
        type: f.type,
        options: f.type === 'enum' ? split(f.options) : [],
        required: f.required,
        in_queue: f.in_queue,
      })),
    sla_hours: { open: num(form.sla_open), analysis: num(form.sla_analysis) },
    retention_years: num(form.retention_years),
    notice: form.notice.trim() || null,
    agent_suggest_kinds: form.suggest_default ? null : [...form.suggest],
    playbook: form.playbook || null,
    starter_queries: form.starter_queries
      .filter((q) => q.title.trim() && q.query.trim())
      .map((q) => ({ ...q, title: q.title.trim(), query: q.query.trim() })),
    report_templates: [...form.report_templates], // the server checks they are templates of the library
    analysis_defaults: {
      trace: { ...baseTrace.value, max_hops: num(form.trace_hops), max_dwell_hours: num(form.trace_dwell), min_amount: num(form.trace_min) },
    },
  };
}

function submit() {
  error.value = null;
  const slug = isNew.value ? (form.slug.trim() || slugify(form.label)) : props.caseType!.slug;
  if (!form.label.trim()) return void (error.value = 'The type needs a label.');
  if (!/^[a-z][a-z0-9_]{0,49}$/.test(slug)) return void (error.value = 'The slug is lowercase letters, digits and _, starting with a letter.');
  if (!closes.value) return void (error.value = 'At least one outcome must close the case.');
  emit('save', slug, buildSpec());
}

// --- Ask an AI, Import / Copy JSON ---------------------------------------------
const showSkill = ref(false);
const skillText = computed(() =>
  props.authoring
    ? buildCaseTypeSkill({
        authoring: props.authoring,
        existingTypes: (props.caseTypes ?? []).filter((t) => t.slug !== props.caseType?.slug),
        playbooks: playbooks.value,
        templates: templates.value,
        current: isNew.value && !form.label.trim() ? null : (buildSpec() as unknown as Record<string, unknown>),
      })
    : '',
);

const importing = ref(false);
const importText = ref('');
const importError = ref<string | null>(null);
/** Fills the form from pasted JSON (the AI's answer, or a type copied elsewhere). */
function applyImport() {
  importError.value = null;
  let parsed: unknown;
  try {
    // An AI answer may come wrapped in a code fence.
    parsed = JSON.parse(importText.value.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (e) {
    return void (importError.value = `Not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return void (importError.value = 'Expected one JSON object (a case type).');
  const spec = parsed as Partial<CaseTypeSpec> & { slug?: string };
  const known = Object.keys((props.authoring?.case_type_schema?.properties as Record<string, unknown> | undefined) ?? {});
  const unknown = known.length ? Object.keys(spec).filter((k) => k !== 'slug' && !known.includes(k)) : [];
  if (unknown.length) return void (importError.value = `Unknown keys: ${unknown.join(', ')}. Ask the AI to keep to the schema.`);
  if (typeof spec.label !== 'string' || !spec.label.trim()) return void (importError.value = 'The type needs a "label".');
  for (const key of ['outcomes', 'actions', 'fields', 'stages', 'starter_queries', 'report_templates'] as const) {
    if (spec[key] !== undefined && !Array.isArray(spec[key])) return void (importError.value = `"${key}" must be a list.`);
  }
  const slug = isNew.value ? (spec.slug ?? form.slug) : props.caseType!.slug;
  Object.assign(form, formFrom({ ...spec, slug }));
  baseTrace.value = { ...(spec.analysis_defaults?.trace ?? {}) };
  importing.value = false;
  importText.value = '';
}

const copiedJson = ref(false);
async function copyJson() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(buildSpec(), null, 2));
    copiedJson.value = true;
    setTimeout(() => (copiedJson.value = false), 2000);
  } catch {
    /* clipboard blocked */
  }
}
</script>

<template>
  <form class="card case-type-editor" data-testid="case-type-editor" @submit.prevent="submit">
    <div class="head">
      <h3>{{ isNew ? 'New case type' : `Edit ${caseType!.label}` }}</h3>
      <span class="tools">
        <button
          type="button"
          class="btn btn-outline btn-sm"
          :disabled="!authoring"
          :title="authoring ? 'Copy a prompt for any AI assistant to write or improve this type' : 'Loading the help…'"
          data-testid="ct-ask-ai"
          @click="showSkill = true"
        >
          <Bot :size="14" /> Ask an AI
        </button>
        <button type="button" class="btn btn-outline btn-sm" data-testid="ct-import-json" @click="importing = !importing"><FileJson :size="14" /> Import JSON</button>
        <button type="button" class="btn btn-outline btn-sm" title="Copy this type as JSON" data-testid="ct-copy-json" @click="copyJson">
          <ClipboardCopy :size="14" /> {{ copiedJson ? 'Copied' : 'Copy JSON' }}
        </button>
      </span>
    </div>
    <div v-if="importing" class="import" data-testid="ct-import">
      <label>
        Paste a case type as JSON <span class="muted">(the AI's answer, or a type copied from another environment); it replaces the form, nothing is saved until you save</span>
        <textarea v-model="importText" rows="8" class="form-control mono" spellcheck="false" placeholder='{ "label": "Merchant review", "outcomes": [ … ] }' data-testid="ct-import-text"></textarea>
      </label>
      <p v-if="importError" class="error" data-testid="ct-import-error">{{ importError }}</p>
      <div class="actions">
        <button type="button" class="btn btn-outline btn-sm" @click="importing = false">Cancel</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="!importText.trim()" data-testid="ct-import-apply" @click="applyImport">Fill the form</button>
      </div>
    </div>
    <div class="grid two">
      <label>Label <input v-model="form.label" class="form-control" required data-testid="ct-label" /></label>
      <label v-if="isNew">Slug <input v-model="form.slug" class="form-control" :placeholder="slugify(form.label) || 'fraud_ring'" data-testid="ct-slug" /></label>
      <label v-else>Slug <input :value="caseType!.slug" class="form-control" disabled /></label>
    </div>
    <label>Description <textarea v-model="form.description" rows="2" class="form-control"></textarea></label>

    <fieldset>
      <legend>Vocabulary <span class="muted">offered, never imposed</span>
        <HelpTip title="Vocabulary" testid="ct-vocabulary">
          <span><b>Roles</b> and <b>tags</b> are what analysts mark entities with (the inspector offers these first; other values are allowed). <b>Link attributes</b> are the properties the Links analysis compares (two entities sharing a phone or a device).</span>
          <span>Several roles per entity: a company that is borrower <i>and</i> guarantor. Comma separated, in your team's language.</span>
        </HelpTip>
      </legend>
      <label>Roles <input v-model="form.roles" class="form-control" placeholder="victim, mule, organizer" data-testid="ct-roles" /></label>
      <label>Tags <input v-model="form.tags" class="form-control" placeholder="comma separated" /></label>
      <label>Link attributes <input v-model="form.link_attributes" class="form-control" placeholder="phone, email, device_id" /></label>
      <label class="check"><input v-model="form.roles_multi" type="checkbox" data-testid="ct-roles-multi" /> An entity may hold several roles</label>
    </fieldset>

    <fieldset data-testid="ct-outcomes">
      <legend>Decision outcomes <span class="muted">without any, the decision is free text</span>
        <HelpTip title="Decision outcomes" testid="ct-outcomes">
          <span>What a decision can record. <b>Closes the case</b>: the case freezes (read-only, retained) until someone reopens it. Leave it off for decisions along the way (block a terminal, ask for documents).</span>
          <span><b>Four eyes</b>: the decision waits until another person with write access approves it; a closing one closes the case then.</span>
          <span>The id stays in the record; the label is copied into each decision, so renaming it later does not rewrite history. At least one outcome must close the case.</span>
        </HelpTip>
      </legend>
      <table class="rows">
        <thead><tr><th>Label</th><th>Id</th><th>Closes the case</th><th>Four eyes</th><th>Description</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(o, i) in form.outcomes" :key="i">
            <td><input v-model="o.label" class="form-control" :data-testid="`ct-outcome-label-${i}`" /></td>
            <td><input v-model="o.id" class="form-control" :placeholder="slugify(o.label)" /></td>
            <td><input v-model="o.closes_case" type="checkbox" :data-testid="`ct-outcome-closes-${i}`" /></td>
            <td><input v-model="o.requires_review" type="checkbox" :data-testid="`ct-outcome-review-${i}`" /></td>
            <td><input v-model="o.description" class="form-control" /></td>
            <td><button type="button" class="btn btn-outline btn-sm" @click="form.outcomes.splice(i, 1)">×</button></td>
          </tr>
        </tbody>
      </table>
      <button type="button" class="btn btn-outline btn-sm" data-testid="ct-add-outcome" @click="addOutcome">+ outcome</button>
      <p v-if="!closes" class="error">At least one outcome must close the case.</p>
    </fieldset>

    <fieldset data-testid="ct-actions">
      <legend>Actions <span class="muted">a decision turns the chosen ones into tasks</span>
        <HelpTip title="Actions" testid="ct-actions">
          <span>Follow-ups a decision sets in motion: the person picks them in the decision panel and each becomes a <b>task</b> of the case, due <b>N hours</b> after the decision (e.g. "Hold the settlements", 2 h; "Report to the card network", 120 h).</span>
          <span>Tasks can still be done after the case is closed. An agent can be assigned tasks by its token name.</span>
        </HelpTip>
      </legend>
      <table class="rows">
        <thead><tr><th>Label</th><th>Id</th><th>Due in (hours)</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(a, i) in form.actions" :key="i">
            <td><input v-model="a.label" class="form-control" :data-testid="`ct-action-label-${i}`" /></td>
            <td><input v-model="a.id" class="form-control" :placeholder="slugify(a.label)" /></td>
            <td><input v-model="a.due_hours" type="number" min="1" class="form-control" /></td>
            <td><button type="button" class="btn btn-outline btn-sm" @click="form.actions.splice(i, 1)">×</button></td>
          </tr>
        </tbody>
      </table>
      <button type="button" class="btn btn-outline btn-sm" data-testid="ct-add-action" @click="addAction">+ action</button>
    </fieldset>

    <fieldset data-testid="ct-fields">
      <legend>Case fields <span class="muted">filled at creation, filterable in the queue</span>
        <HelpTip title="Case fields" testid="ct-fields">
          <span>Structured data of the case: an id, an amount, a reason code, a rating. <b>Required</b> fields are asked when the case is opened (also by the API and agents).</span>
          <span><b>In the queue</b>: a column, a filter (≥ for numbers, money and dates; contains for text; equals for enum) and a sort key once the queue is filtered by this type.</span>
          <span><code>enum</code> needs its options. Report templates read a field as <code v-pre>{{fields.&lt;id&gt;}}</code>.</span>
        </HelpTip>
      </legend>
      <table class="rows">
        <thead><tr><th>Label</th><th>Id</th><th>Type</th><th>Options (enum)</th><th>Required</th><th>In the queue</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(f, i) in form.fields" :key="i">
            <td><input v-model="f.label" class="form-control" :data-testid="`ct-field-label-${i}`" /></td>
            <td><input v-model="f.id" class="form-control" :placeholder="slugify(f.label)" /></td>
            <td>
              <select v-model="f.type" class="form-control" :data-testid="`ct-field-type-${i}`">
                <option v-for="ft in FIELD_TYPES" :key="ft" :value="ft">{{ ft }}</option>
              </select>
            </td>
            <td><input v-model="f.options" class="form-control" :disabled="f.type !== 'enum'" placeholder="A, B, C" /></td>
            <td><input v-model="f.required" type="checkbox" /></td>
            <td><input v-model="f.in_queue" type="checkbox" :data-testid="`ct-field-queue-${i}`" /></td>
            <td><button type="button" class="btn btn-outline btn-sm" @click="form.fields.splice(i, 1)">×</button></td>
          </tr>
        </tbody>
      </table>
      <button type="button" class="btn btn-outline btn-sm" data-testid="ct-add-field" @click="addField">+ field</button>
    </fieldset>

    <fieldset>
      <legend>Workflow
        <HelpTip title="Workflow" testid="ct-workflow">
          <span><b>Stages</b>: free labels for where a case stands ("Waiting for documents"), no rules attached.</span>
          <span><b>SLA</b>: hours of the open phase, then of analysis, counted from the alert date (else the occurrence, else creation). Under 20% left the case is urgent; a case may change its own SLA.</span>
          <span><b>Retention</b>: years a closed case cannot be deleted (empty = the org default). <b>Notice</b>: shown in the share dialog and the decision panel, e.g. a tipping-off warning.</span>
        </HelpTip>
      </legend>
      <label>Stages <input v-model="form.stages" class="form-control" placeholder="Awaiting the customer, Escalated" /></label>
      <div class="grid three">
        <label>SLA · open (hours) <input v-model="form.sla_open" type="number" min="1" class="form-control" data-testid="ct-sla-open" /></label>
        <label>SLA · analysis (hours) <input v-model="form.sla_analysis" type="number" min="1" class="form-control" /></label>
        <label>Retention (years) <input v-model="form.retention_years" type="number" min="0" class="form-control" placeholder="org default" /></label>
      </div>
      <label>Notice <span class="muted">shown where the case is shared and decided</span>
        <textarea v-model="form.notice" rows="2" class="form-control" placeholder="Do not tell the people under investigation that a case exists." data-testid="ct-notice"></textarea>
      </label>
    </fieldset>

    <fieldset>
      <legend>Agent
        <HelpTip title="Agent" testid="ct-agent">
          <span>What an AI agent writes as a <b>suggestion</b> that a person confirms; everything else it writes directly, with its author chip. Default: {{ defaultSuggest }}.</span>
          <span>Agents never decide, share, delete, reopen or export, whatever this says; they propose decisions.</span>
          <span>The <b>playbook</b> is the library doc the agent starts with on this type's cases.</span>
        </HelpTip>
      </legend>
      <label class="check"><input v-model="form.suggest_default" type="checkbox" /> Default suggest kinds</label>
      <div v-if="!form.suggest_default" class="checks">
        <label v-for="k in suggestKinds" :key="k" class="check"><input v-model="form.suggest" type="checkbox" :value="k" /> {{ k }}</label>
      </div>
      <label>Playbook
        <select v-model="form.playbook" class="form-control" data-testid="ct-playbook">
          <option value="">—</option>
          <option v-for="d in playbooks" :key="d.slug" :value="d.slug">{{ d.title }}</option>
        </select>
      </label>
    </fieldset>

    <fieldset data-testid="ct-data">
      <legend>A new case starts with
        <HelpTip title="A new case starts with" testid="ct-data">
          <span><b>Starter queries</b> (SQL or Cypher, with <code>:name</code> parameters) are copied into each new case as query items; the analysis bar lists them as <b>Detectors</b>. Parameters can be set through Import JSON.</span>
          <span><b>Report templates</b> are offered first in the dossier's "Draft report" (library docs of kind report template).</span>
          <span><b>Trace</b>: what "Follow the money" starts with on these cases (0 hours = no dwell limit).</span>
        </HelpTip>
      </legend>
      <div v-for="(q, i) in form.starter_queries" :key="i" class="row query" :data-testid="`ct-query-${i}`">
        <input v-model="q.title" class="form-control" placeholder="TPV and chargebacks by day" aria-label="Query title" />
        <select v-model="q.language" class="form-control" aria-label="Language"><option value="sql">SQL</option><option value="cypher">Cypher</option></select>
        <textarea v-model="q.query" rows="2" class="form-control mono" placeholder="SELECT … WHERE merchant = :merchant" aria-label="Query"></textarea>
        <button type="button" class="link-btn" @click="form.starter_queries.splice(i, 1)">remove</button>
      </div>
      <button type="button" class="link-btn" data-testid="ct-add-query" @click="addQuery">+ starter query <span class="muted">(copied into each new case as a query item)</span></button>
      <div v-if="templates.length" class="checks">
        <span class="muted">Report templates</span>
        <label v-for="d in templates" :key="d.slug" class="check"><input v-model="form.report_templates" type="checkbox" :value="d.slug" :data-testid="`ct-template-${d.slug}`" /> {{ d.title }}</label>
      </div>
      <p v-else class="muted">Report templates are org library docs of kind "report template".</p>
      <div class="grid three">
        <label>Trace · max layers <input v-model="form.trace_hops" type="number" min="1" max="20" class="form-control" placeholder="3" data-testid="ct-trace-hops" /></label>
        <label>Trace · max dwell (hours) <input v-model="form.trace_dwell" type="number" min="0" class="form-control" placeholder="24 (0 = none)" /></label>
        <label>Trace · min amount <input v-model="form.trace_min" type="number" min="0" class="form-control" placeholder="0" /></label>
      </div>
    </fieldset>

    <p v-if="error" class="error" data-testid="ct-error">{{ error }}</p>
    <div class="actions">
      <button type="button" class="btn btn-outline btn-sm" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="btn btn-primary btn-sm" :disabled="busy" data-testid="ct-save">Save type</button>
    </div>
    <AuthoringSkillModal v-model="showSkill" :title="isNew && !form.label.trim() ? 'Ask an AI to write a case type' : 'Ask an AI to improve this case type'" :text="skillText" testid="ct-skill">
      Copy this into any AI assistant (Claude, ChatGPT, Gemini…). It explains every part of a case type, the rules the
      server checks, the schema and an example, and lists your org's types and library. The AI interviews you, then
      answers with JSON: paste it into <b>Import JSON</b>, review the form and save.
    </AuthoringSkillModal>
  </form>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.head h3 {
  margin: 0;
}

.tools {
  display: inline-flex;
  gap: 6px;
}

.tools .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.import {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px dashed var(--color-primary);
  border-radius: 6px;
}

legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.case-type-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

label.check {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

fieldset {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 10px 12px;
}

legend {
  font-weight: 600;
  font-size: 13px;
}

.grid {
  display: grid;
  gap: 12px;
}

.grid.two {
  grid-template-columns: 1fr 1fr;
}

.grid.three {
  grid-template-columns: repeat(3, 1fr);
}

.rows {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.rows th {
  text-align: left;
  color: var(--text-muted);
  font-weight: 500;
  padding: 2px 4px;
}

.rows td {
  padding: 2px 4px;
}

.row.query {
  display: grid;
  grid-template-columns: 1fr 90px 2fr auto;
  gap: 6px;
  align-items: start;
}

.mono {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.link-btn {
  align-self: flex-start;
  border: 0;
  background: none;
  color: var(--color-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}

.muted {
  color: var(--text-muted);
  font-weight: 400;
}

.error {
  color: var(--color-danger, #b91c1c);
  font-size: 13px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
