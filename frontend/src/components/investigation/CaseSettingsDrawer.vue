<script setup lang="ts">
/**
 * ⚙ of the case (05 §2): name, type, deadlines, members, which agent writes stay
 * "suggested", vocabularies, identity keys, edge semantics by relationship type
 * and label templates. Everything lands in one `PATCH /api/investigations/{id}`.
 */
import { computed, reactive, ref, watch } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { KIND_PRESET_LABELS } from '@/utils/investigationStatus';
import { NORMALIZER_LABELS } from '@/utils/identityKeys';
import { DEFAULT_SUGGEST_KINDS, PRESET_DEFAULTS, SUGGEST_KINDS } from '@/utils/casePresets';
import type { EdgeSemantics, IdentityKey, IdentityNormalize } from '@/types/graph';
import type { KindPreset } from '@/types/investigation';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; share: [] }>();

const store = useInvestigationStore();
const graph = useGraphStore();
const toast = useToast();

const inv = computed(() => store.current!);
const canEdit = computed(() => inv.value.has_write_access && inv.value.status !== 'decided');

interface KeyRow { node_type: string; entity: string; prop: string; normalize: IdentityNormalize; pattern: string }
interface SemRow { type: string; amount_prop: string; time_prop: string; weight_prop: string; timestamp_prop: string; amount_unit: 'units' | 'cents' }
interface LabelRow { node_type: string; template: string }

const form = reactive({
  title: '',
  description: '',
  kind_preset: 'livre' as KindPreset,
  alert_at: '',
  occurred_at: '',
  days_open: '' as string | number,
  days_analysis: '' as string | number,
  suggest: [] as string[],
  roles: '',
  tags: '',
  link_attributes: '',
  keys: [] as KeyRow[],
  semantics: [] as SemRow[],
  labels: [] as LabelRow[],
});
const busy = ref(false);

const toInput = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');
const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function load() {
  const s = inv.value.settings ?? {};
  const v = (s.vocabularies ?? {}) as Record<string, string[]>;
  form.title = inv.value.title;
  form.description = inv.value.description ?? '';
  form.kind_preset = inv.value.kind_preset;
  form.alert_at = toInput(inv.value.alert_at);
  form.occurred_at = toInput(inv.value.occurred_at);
  form.days_open = inv.value.deadline_days?.open ?? '';
  form.days_analysis = inv.value.deadline_days?.analysis ?? '';
  form.suggest = (s.agent_suggest_kinds as string[] | undefined) ?? [...DEFAULT_SUGGEST_KINDS];
  form.roles = list(v.roles ?? store.vocabulary.roles);
  form.tags = list(v.tags ?? store.vocabulary.tags);
  form.link_attributes = list(v.link_attributes ?? store.vocabulary.link_attributes);
  form.keys = ((s.identity_keys as IdentityKey[] | undefined) ?? []).map((k) => ({
    node_type: k.node_type, entity: k.entity, prop: k.source === 'node_id' ? '' : k.source.name, normalize: k.normalize, pattern: k.pattern ?? '',
  }));
  form.semantics = Object.entries((s.edge_semantics as Record<string, EdgeSemantics> | undefined) ?? {}).map(([type, e]) => ({
    type, amount_prop: e.amount_prop ?? '', time_prop: e.time_prop ?? '', weight_prop: e.weight_prop ?? '', timestamp_prop: e.timestamp_prop ?? '', amount_unit: e.amount_unit ?? 'units',
  }));
  form.labels = Object.entries((s.label_templates as Record<string, string> | undefined) ?? {}).map(([node_type, template]) => ({ node_type, template }));
}
watch(() => props.open, (o) => o && load(), { immediate: true });

function applyPreset() {
  const d = PRESET_DEFAULTS[form.kind_preset];
  form.roles = list(d.roles);
  form.link_attributes = list(d.link_attributes);
}

const nodeTypes = computed(() => graph.nodeTypes);
const edgeTypes = computed(() => ['*', ...graph.edgeTypes]);
const edgeProps = computed(() => {
  const keys = new Set<string>();
  for (const e of store.unified.edges) for (const k of Object.keys(e.properties ?? {})) keys.add(k);
  return [...keys].sort();
});

async function save() {
  busy.value = true;
  try {
    const identity_keys: IdentityKey[] = form.keys
      .filter((k) => k.node_type.trim() && k.entity.trim())
      .map((k) => ({
        node_type: k.node_type.trim(),
        entity: k.entity.trim(),
        source: k.prop.trim() ? { kind: 'prop', name: k.prop.trim() } : 'node_id',
        normalize: k.normalize,
        ...(k.normalize === 'regex' && k.pattern.trim() ? { pattern: k.pattern.trim() } : {}),
      }));
    const edge_semantics = Object.fromEntries(
      form.semantics
        .filter((r) => r.type.trim())
        .map((r) => [
          r.type.trim(),
          {
            ...(r.amount_prop.trim() ? { amount_prop: r.amount_prop.trim(), amount_unit: r.amount_unit } : {}),
            ...(r.time_prop.trim() ? { time_prop: r.time_prop.trim() } : {}),
            ...(r.weight_prop.trim() ? { weight_prop: r.weight_prop.trim() } : {}),
            ...(r.timestamp_prop.trim() ? { timestamp_prop: r.timestamp_prop.trim() } : {}),
          },
        ]),
    );
    const label_templates = Object.fromEntries(form.labels.filter((l) => l.node_type.trim() && l.template.trim()).map((l) => [l.node_type.trim(), l.template.trim()]));
    const days: Record<string, number> = {};
    if (form.days_open !== '' && form.days_open !== null) days.open = Number(form.days_open);
    if (form.days_analysis !== '' && form.days_analysis !== null) days.analysis = Number(form.days_analysis);
    await store.updateInvestigation({
      title: form.title.trim() || inv.value.title,
      description: form.description.trim() || null,
      kind_preset: form.kind_preset,
      alert_at: form.alert_at ? new Date(form.alert_at).toISOString() : null,
      occurred_at: form.occurred_at ? new Date(form.occurred_at).toISOString() : null,
      deadline_days: Object.keys(days).length ? days : null,
      settings: {
        ...(inv.value.settings ?? {}),
        agent_suggest_kinds: form.suggest,
        vocabularies: { roles: split(form.roles), tags: split(form.tags), link_attributes: split(form.link_attributes) },
        identity_keys,
        edge_semantics,
        label_templates,
      },
    });
    toast.success('Settings saved');
    emit('close');
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to save the settings'));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="open && store.current" class="drawer-overlay" @click.self="emit('close')">
    <aside class="drawer" data-testid="case-settings">
      <header>
        <h2>Case settings</h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">&times;</button>
      </header>
      <form class="body" @submit.prevent="save">
        <section>
          <h3>General</h3>
          <label>Name <input v-model="form.title" :disabled="!canEdit" data-testid="settings-title" /></label>
          <label>Type
            <select v-model="form.kind_preset" :disabled="!canEdit" data-testid="settings-preset" @change="applyPreset">
              <option v-for="(label, key) in KIND_PRESET_LABELS" :key="key" :value="key">{{ label }}</option>
            </select>
          </label>
          <label>Description <textarea v-model="form.description" rows="2" :disabled="!canEdit"></textarea></label>
        </section>
        <section>
          <h3>Deadlines</h3>
          <div class="grid">
            <label>Alert at <input v-model="form.alert_at" type="date" :disabled="!canEdit" data-testid="settings-alert-at" /></label>
            <label>Occurred at <input v-model="form.occurred_at" type="date" :disabled="!canEdit" /></label>
            <label>Days · open <input v-model="form.days_open" type="number" min="1" placeholder="preset" :disabled="!canEdit" /></label>
            <label>Days · analysis <input v-model="form.days_analysis" type="number" min="1" placeholder="preset" :disabled="!canEdit" /></label>
          </div>
          <p class="muted">Pix/MED counts 45 + 45 days from the alert; other types have a deadline only when you set the days.</p>
        </section>
        <section>
          <h3>Members</h3>
          <p>
            Owner {{ inv.owner_email }}<template v-if="inv.assignee_email"> · assignee {{ inv.assignee_email }}</template>
            <template v-if="inv.shared_with.length"> · shared with {{ inv.shared_with.map((s) => `${s.email} (${s.role})`).join(', ') }}</template>
          </p>
          <button type="button" class="btn btn-outline btn-sm" :disabled="!inv.can_manage" data-testid="settings-share" @click="emit('share')">Share…</button>
        </section>
        <section>
          <h3>Agent</h3>
          <p class="muted">Writes of these kinds by an agent arrive as suggestions to confirm; everything else applies directly with the agent's chip.</p>
          <div class="checks">
            <label v-for="k in SUGGEST_KINDS" :key="k"><input v-model="form.suggest" type="checkbox" :value="k" :disabled="!canEdit" :data-testid="`settings-suggest-${k}`" /> {{ k }}</label>
          </div>
        </section>
        <section>
          <h3>Vocabularies</h3>
          <label>Roles <input v-model="form.roles" :disabled="!canEdit" placeholder="comma separated" data-testid="settings-roles" /></label>
          <label>Tags <input v-model="form.tags" :disabled="!canEdit" placeholder="comma separated" /></label>
          <label>Link attributes (Vínculos) <input v-model="form.link_attributes" :disabled="!canEdit" placeholder="telefone, email, device_id…" data-testid="settings-link-attributes" /></label>
        </section>
        <section>
          <h3>Identity keys <span class="muted">override a context's key for the same node type</span></h3>
          <table class="rows" data-testid="settings-identity-keys">
            <thead><tr><th>Node type</th><th>Entity</th><th>Property (empty = id)</th><th>Normalize</th><th>Pattern</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(k, i) in form.keys" :key="i">
                <td><input v-model="k.node_type" list="settings-node-types" :disabled="!canEdit" /></td>
                <td><input v-model="k.entity" :disabled="!canEdit" /></td>
                <td><input v-model="k.prop" :disabled="!canEdit" /></td>
                <td><select v-model="k.normalize" :disabled="!canEdit"><option v-for="(label, n) in NORMALIZER_LABELS" :key="n" :value="n">{{ label }}</option></select></td>
                <td><input v-model="k.pattern" :disabled="!canEdit || k.normalize !== 'regex'" placeholder="sid=(\w+)" /></td>
                <td><button type="button" class="link-btn danger" :disabled="!canEdit" @click="form.keys.splice(i, 1)">remove</button></td>
              </tr>
            </tbody>
          </table>
          <button type="button" class="link-btn" :disabled="!canEdit" data-testid="settings-add-key" @click="form.keys.push({ node_type: '', entity: '', prop: '', normalize: 'none', pattern: '' })">+ key</button>
          <datalist id="settings-node-types"><option v-for="t in nodeTypes" :key="t" :value="t"></option></datalist>
        </section>
        <section>
          <h3>Edge semantics <span class="muted">by relationship type; `*` for the rest</span></h3>
          <table class="rows" data-testid="settings-edge-semantics">
            <thead><tr><th>Type</th><th>Amount</th><th>Unit</th><th>Time</th><th>Weight</th><th>Timestamp</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in form.semantics" :key="i">
                <td><input v-model="r.type" list="settings-edge-types" :disabled="!canEdit" /></td>
                <td><input v-model="r.amount_prop" list="settings-edge-props" :disabled="!canEdit" /></td>
                <td><select v-model="r.amount_unit" :disabled="!canEdit"><option value="units">units</option><option value="cents">cents</option></select></td>
                <td><input v-model="r.time_prop" list="settings-edge-props" :disabled="!canEdit" /></td>
                <td><input v-model="r.weight_prop" list="settings-edge-props" :disabled="!canEdit" /></td>
                <td><input v-model="r.timestamp_prop" list="settings-edge-props" :disabled="!canEdit" /></td>
                <td><button type="button" class="link-btn danger" :disabled="!canEdit" @click="form.semantics.splice(i, 1)">remove</button></td>
              </tr>
            </tbody>
          </table>
          <button type="button" class="link-btn" :disabled="!canEdit" data-testid="settings-add-semantics" @click="form.semantics.push({ type: '*', amount_prop: '', time_prop: '', weight_prop: '', timestamp_prop: '', amount_unit: 'units' })">+ relationship type</button>
          <datalist id="settings-edge-types"><option v-for="t in edgeTypes" :key="t" :value="t"></option></datalist>
          <datalist id="settings-edge-props"><option v-for="p in edgeProps" :key="p" :value="p"></option></datalist>
        </section>
        <section>
          <h3>Label templates <span class="muted">{nome} · {cpf} (documents stay masked)</span></h3>
          <table class="rows" data-testid="settings-labels">
            <tbody>
              <tr v-for="(l, i) in form.labels" :key="i">
                <td><input v-model="l.node_type" list="settings-node-types" :disabled="!canEdit" placeholder="node type" /></td>
                <td><input v-model="l.template" :disabled="!canEdit" placeholder="{nome} · {cpf}" /></td>
                <td><button type="button" class="link-btn danger" :disabled="!canEdit" @click="form.labels.splice(i, 1)">remove</button></td>
              </tr>
            </tbody>
          </table>
          <button type="button" class="link-btn" :disabled="!canEdit" data-testid="settings-add-label" @click="form.labels.push({ node_type: '', template: '' })">+ template</button>
        </section>
        <footer>
          <button type="button" class="btn btn-outline" @click="emit('close')">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="!canEdit || busy" data-testid="settings-save">{{ busy ? 'Saving…' : 'Save settings' }}</button>
        </footer>
      </form>
    </aside>
  </div>
</template>

<style scoped>
.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  background: rgba(15, 23, 42, 0.25);
}

.drawer {
  width: min(720px, 95vw);
  height: 100%;
  overflow-y: auto;
  background: var(--color-surface);
  box-shadow: var(--shadow-lg, -4px 0 16px rgba(0, 0, 0, 0.15));
  font-size: 13px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-color);
}

h2 {
  margin: 0;
  font-size: 16px;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px 20px 24px;
}

section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

h3 {
  margin: 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

input,
select,
textarea {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}

.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}

.checks label {
  flex-direction: row;
  align-items: center;
  gap: 4px;
}

.muted {
  font-weight: normal;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.rows {
  width: 100%;
  border-collapse: collapse;
}

.rows th {
  text-align: left;
  font-weight: 500;
  font-size: 11px;
  color: var(--text-muted);
}

.rows td input,
.rows td select {
  width: 100%;
  min-width: 70px;
}

.link-btn {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--color-primary);
  cursor: pointer;
}

.link-btn.danger {
  color: var(--color-error);
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
