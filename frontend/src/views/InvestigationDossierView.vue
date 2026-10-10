<script setup lang="ts">
/**
 * Dossier (T7, investigations F4.2): summary and indicators, hypotheses with the
 * evidence for and against each, the frozen evidence (E1, E2, … oldest first) and
 * the journal. The decision panel (F4.5) records the outcome, actions and rationale;
 * the server freezes the case and from then on the dossier is read-only. Exports
 * (F4.6, `investigation.export`) download from the server; the laudo is this page
 * printed (print CSS below), with the file and source hashes it adds on paper.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { usePermissions } from '@/composables/usePermissions';
import { downloadBlob } from '@/utils/portableExport';
import { useInvestigationStore } from '@/stores/investigation';
import { api } from '@/services/api';
import { describeEvent } from '@/utils/investigationEvents';
import { DECISION_ACTION_LABELS, DECISION_OUTCOME_LABELS, deadlineOf, HYPOTHESIS_STATUS_LABELS, STATUS_LABELS, URGENT_DAYS } from '@/utils/investigationStatus';
import { ROLE_LABELS } from '@/utils/graphAppearance';
import { methodStamp } from '@/utils/traceView';
import { getErrorMessage } from '@/utils/errorMessage';
import type { TraceResult } from '@/utils/trace';
import type {
  DecisionAction,
  DecisionOutcome,
  Hypothesis,
  HypothesisStatus,
  InvestigationEvidence,
  InvestigationExportFormat,
  InvestigationRole,
} from '@/types/investigation';

const props = defineProps<{ id: string }>();
const store = useInvestigationStore();

const pendingProposals = ref(0);
const error = ref<string | null>(null);
const draft = ref('');
const showAllEvents = ref(false);
const JOURNAL_ROWS = 8;

watch(
  () => props.id,
  async (id) => {
    error.value = null;
    if (store.current?.id !== id) await store.openInvestigation(id);
    if (!store.current) return;
    store.fetchEvidence().catch((e) => (error.value = getErrorMessage(e, 'Failed to load the evidence')));
    store.fetchEvents().catch(() => {});
    store.fetchNotes().catch(() => {});
    store.fetchFiles().catch(() => {});
    api.getInvestigationProposals(id, 'pending').then((p) => (pendingProposals.value = p.length)).catch(() => {});
  },
  { immediate: true },
);

const inv = computed(() => store.current);
const canEdit = computed(() => !!inv.value?.has_write_access && inv.value.status !== 'decidido');
const deadline = computed(() => (inv.value ? deadlineOf(inv.value) : null));

/** E1, E2, … by creation order. */
const label = computed(() => new Map(store.evidence.map((e, i) => [e.id, `E${i + 1}`])));
const evidenceById = computed(() => new Map(store.evidence.map((e) => [e.id, e])));

const roleCounts = computed(() => {
  const counts: Partial<Record<InvestigationRole, number>> = {};
  for (const role of Object.values(store.roles)) counts[role] = (counts[role] ?? 0) + 1;
  return Object.entries(counts).map(([role, n]) => `${n} ${ROLE_LABELS[role as InvestigationRole] ?? role}`);
});

const indicators = computed(() => {
  const restricted = store.sources.filter((s) => !s.accessible).length;
  const by = (s: HypothesisStatus) => store.hypotheses.filter((h) => h.status === s).length;
  return [
    { label: 'Sources', value: store.sources.length, hint: restricted ? `${restricted} restricted` : '' },
    { label: 'Evidence', value: store.evidence.length, hint: 'frozen with sha256' },
    { label: 'Hypotheses', value: store.hypotheses.length, hint: `${by('sustentada')} supported · ${by('aberta')} open · ${by('refutada')} refuted` },
    { label: 'Notes', value: store.notes.length, hint: '' },
    { label: 'Journal', value: store.events.length, hint: 'events' },
    { label: 'Proposals', value: pendingProposals.value, hint: 'pending' },
  ];
});

/** Accepted typology badges (F4.3), with the CC 4.001 item they cite. */
const badges = computed(() => [
  ...new Set(
    store.events
      .filter((e) => e.kind === 'typology.accepted')
      .map((e) => `${(e.payload as Record<string, string>).normRef} · ${(e.payload as Record<string, string>).label}`),
  ),
]);

const journal = computed(() => (showAllEvents.value ? store.events : store.events.slice(-JOURNAL_ROWS)));

function shortHash(sha: string) {
  return `${sha.slice(0, 4)}…${sha.slice(-4)}`;
}

/** One line for how the evidence was made: the trace stamp, or its parameters. */
function paramsLine(e: InvestigationEvidence): string {
  const p = e.params as Record<string, unknown>;
  if (e.kind === 'trace' && p.direction && p.allocation) {
    try {
      return methodStamp(p as unknown as TraceResult['method']);
    } catch {
      /* a stamp from another engine version: fall back to the raw parameters */
    }
  }
  if (e.kind === 'graph_state') return `${p.tab_title ?? p.view ?? 'graph'} · ${p.nodes ?? '?'} nodes · ${p.edges ?? '?'} edges`;
  return Object.entries(p).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
}

const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '');

async function act(action: () => Promise<unknown>, fallback: string) {
  error.value = null;
  try {
    await action();
  } catch (e) {
    error.value = getErrorMessage(e, fallback);
  }
}

const OUTCOMES = DECISION_OUTCOME_LABELS;
const ACTIONS = DECISION_ACTION_LABELS;
const RETENTION_YEARS = window.__GRAPH_LAGOON_CONFIG__?.investigation_retention_years ?? 10;
const outcome = ref<DecisionOutcome>('comunicar');
const actions = ref<DecisionAction[]>([]);
const rationale = ref('');
const deciding = ref(false);

async function recordDecision() {
  if (!rationale.value.trim()) return;
  deciding.value = true;
  await act(
    () => store.recordDecision({ outcome: outcome.value, actions: actions.value, rationale: rationale.value.trim() }),
    'Failed to record the decision',
  );
  deciding.value = false;
}

const { can } = usePermissions();
const EXPORTS: { format: InvestigationExportFormat; label: string }[] = [
  { format: 'siscoaf', label: 'Siscoaf summary' },
  { format: 'json', label: 'Package JSON' },
  { format: 'csv', label: 'CSV' },
  { format: 'simba', label: 'SIMBA layout' },
];
const exporting = ref<string | null>(null);

async function download(format: InvestigationExportFormat) {
  exporting.value = format;
  await act(async () => {
    const { blob, filename } = await api.exportInvestigation(props.id, format);
    downloadBlob(filename, blob);
  }, 'Failed to export the case');
  exporting.value = null;
}

/** Laudo PDF: the browser prints this page (Save as PDF) with the whole journal. */
async function printLaudo() {
  showAllEvents.value = true;
  await nextTick();
  window.print();
}

const printedAt = new Date().toLocaleString();

function addHypothesis() {
  const text = draft.value.trim();
  if (!text) return;
  act(async () => {
    await store.addHypothesis({ text });
    draft.value = '';
  }, 'Failed to add the hypothesis');
}

function setStatus(h: Hypothesis, status: string) {
  act(() => store.updateHypothesis(h.id, { status: status as HypothesisStatus }), 'Failed to update the hypothesis');
}

type Side = 'evidence_for' | 'evidence_against';
function link(h: Hypothesis, side: Side, evidenceId: string) {
  if (!evidenceId || h[side].includes(evidenceId)) return;
  act(() => store.updateHypothesis(h.id, { [side]: [...h[side], evidenceId] }), 'Failed to link the evidence');
}
function unlink(h: Hypothesis, side: Side, evidenceId: string) {
  act(() => store.updateHypothesis(h.id, { [side]: h[side].filter((x) => x !== evidenceId) }), 'Failed to unlink the evidence');
}
</script>

<template>
  <div class="dossier" data-testid="dossier">
    <div v-if="store.loading && !inv" class="loading"></div>
    <div v-else-if="store.error" class="error">{{ store.error }}</div>
    <template v-else-if="inv">
      <header class="head">
        <RouterLink :to="`/investigations/${id}`" class="back">← Workspace</RouterLink>
        <h1 data-testid="dossier-title">{{ inv.title }}</h1>
        <span class="muted">#{{ id.slice(0, 8) }} · Dossier</span>
        <span class="status">{{ STATUS_LABELS[inv.status] ?? inv.status }}</span>
        <span v-if="deadline" class="muted" :class="{ urgent: deadline.daysLeft < URGENT_DAYS }">
          {{ deadline.phase }} · {{ deadline.daysLeft }} d left
        </span>
      </header>
      <div v-if="error" class="error" data-testid="dossier-error">{{ error }}</div>
      <p class="print-only muted">
        Laudo · printed {{ printedAt }} · {{ inv.owner_email }}{{ inv.assignee_email ? ` · assignee ${inv.assignee_email}` : '' }}
        <template v-if="inv.frozen_hash"> · frozen hash {{ inv.frozen_hash }}</template>
      </p>

      <div class="cols">
        <main class="main">
          <section class="card" data-testid="dossier-summary">
            <h2>Summary <span class="muted">built from the case and its evidence · review before deciding</span></h2>
            <p class="description">{{ inv.description || 'No description yet.' }}</p>
            <div class="chips">
              <span v-if="inv.typology" class="chip seal">{{ inv.typology }}</span>
              <span v-for="b in badges" :key="b" class="chip seal" data-testid="dossier-badge">{{ b }}</span>
              <span v-if="inv.origin" class="chip">origin · {{ inv.origin }}</span>
              <span v-for="r in roleCounts" :key="r" class="chip">{{ r }}</span>
            </div>
            <div class="indicators" data-testid="dossier-indicators">
              <div v-for="i in indicators" :key="i.label" class="indicator">
                <div class="value">{{ i.value }}</div>
                <div class="ind-label">{{ i.label }}</div>
                <div v-if="i.hint" class="muted">{{ i.hint }}</div>
              </div>
            </div>
          </section>

          <section class="card" data-testid="dossier-hypotheses">
            <h2>Hypotheses</h2>
            <table v-if="store.hypotheses.length" class="hyp-table">
              <thead>
                <tr><th>Hypothesis</th><th>Status</th><th>For</th><th>Against</th></tr>
              </thead>
              <tbody>
                <tr v-for="h in store.hypotheses" :key="h.id" :data-testid="`hypothesis-${h.id}`">
                  <td>
                    <strong>{{ h.id }}</strong> · {{ h.text }}
                    <div v-if="h.note" class="muted">{{ h.note }}</div>
                  </td>
                  <td>
                    <select
                      v-if="canEdit"
                      :value="h.status"
                      class="pill"
                      :class="h.status"
                      :data-testid="`hypothesis-status-${h.id}`"
                      @change="setStatus(h, ($event.target as HTMLSelectElement).value)"
                    >
                      <option v-for="(text, s) in HYPOTHESIS_STATUS_LABELS" :key="s" :value="s">{{ text }}</option>
                    </select>
                    <span v-else class="pill" :class="h.status">{{ HYPOTHESIS_STATUS_LABELS[h.status] }}</span>
                  </td>
                  <td v-for="side in (['evidence_for', 'evidence_against'] as const)" :key="side" :data-testid="`hypothesis-${side}-${h.id}`">
                    <span v-for="eid in h[side]" :key="eid" class="ev-chip" :title="evidenceById.get(eid)?.title">
                      {{ label.get(eid) ?? 'E?' }} {{ evidenceById.get(eid)?.title ?? '' }}
                      <button v-if="canEdit" class="x" aria-label="Unlink" @click="unlink(h, side, eid)">×</button>
                    </span>
                    <span v-if="!h[side].length" class="muted">none</span>
                    <select
                      v-if="canEdit && store.evidence.some((e) => !h[side].includes(e.id))"
                      class="link-select"
                      :data-testid="`hypothesis-link-${side}-${h.id}`"
                      @change="link(h, side, ($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''"
                    >
                      <option value="">+ evidence</option>
                      <option v-for="e in store.evidence.filter((x) => !h[side].includes(x.id))" :key="e.id" :value="e.id">
                        {{ label.get(e.id) }} · {{ e.title }}
                      </option>
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">No hypotheses yet.</p>
            <form v-if="canEdit" class="add" @submit.prevent="addHypothesis">
              <input v-model="draft" placeholder="New hypothesis, e.g. 4471-0 is a pass-through account" data-testid="hypothesis-input" />
              <button class="btn btn-primary btn-sm" :disabled="!draft.trim()" data-testid="hypothesis-add">Add hypothesis</button>
            </form>
          </section>

          <section class="card" data-testid="dossier-evidence">
            <h2>Frozen evidence</h2>
            <div v-if="store.evidence.length" class="evidence-grid">
              <article v-for="e in store.evidence" :key="e.id" class="evidence" :data-testid="`evidence-${e.id}`">
                <div class="ev-kind">{{ e.kind.replace('_', ' ') }}</div>
                <strong>{{ label.get(e.id) }} · {{ e.title }}</strong>
                <div class="muted mono" :title="e.sha256">hash {{ shortHash(e.sha256) }}</div>
                <div class="muted params">{{ paramsLine(e) }}</div>
                <div class="muted">{{ e.created_by }} · {{ fmtTime(e.created_at) }}</div>
              </article>
            </div>
            <p v-else class="muted">
              No evidence yet. Pin it from the workspace (Pin evidence) or the Follow the money tab (Save as evidence).
            </p>
          </section>

          <section class="card" data-testid="dossier-journal">
            <h2>Journal <span class="muted">recorded automatically · not editable</span></h2>
            <div v-for="e in journal" :key="e.id" class="journal-row">
              <span class="muted">{{ fmtTime(e.at) }}</span>
              <span>
                {{ describeEvent(e) }} ·
                <span class="muted">{{ e.actor_kind === 'agent' ? `agent ${e.agent_name} for ${e.actor_email}` : e.actor_email }}</span>
              </span>
            </div>
            <p v-if="!store.events.length" class="muted">Nothing recorded yet.</p>
            <button
              v-if="store.events.length > JOURNAL_ROWS"
              class="link-btn"
              data-testid="dossier-all-events"
              @click="showAllEvents = !showAllEvents"
            >
              {{ showAllEvents ? 'Show the latest only' : `See all ${store.events.length} events` }}
            </button>
          </section>

          <section class="card print-only" data-testid="dossier-hashes">
            <h2>Sources and files</h2>
            <div v-for="src in store.sources" :key="src.id" class="journal-row">
              <span>{{ src.title_snapshot }}</span>
              <span class="mono">{{ src.accessible ? `${src.mode} · ${src.frozen_sha256 ?? 'live'}` : 'restricted' }}</span>
            </div>
            <div v-for="f in store.files" :key="f.id" class="journal-row">
              <span>{{ f.filename }} ({{ f.role }})</span>
              <span class="mono">sha256 {{ f.sha256 }}</span>
            </div>
          </section>
        </main>

        <aside class="card decision" data-testid="dossier-decision">
          <h2>Decision</h2>
          <template v-if="inv.decision">
            <p data-testid="decision-outcome"><strong>{{ OUTCOMES[inv.decision.outcome] ?? inv.decision.outcome }}</strong></p>
            <ul v-if="inv.decision.actions.length" class="decided-actions">
              <li v-for="a in inv.decision.actions" :key="a">{{ ACTIONS[a] ?? a }}</li>
            </ul>
            <p class="rationale">{{ inv.decision.rationale }}</p>
            <p class="muted">{{ inv.decision.decided_by }} · {{ fmtTime(inv.decision.decided_at) }}</p>
            <p v-if="inv.frozen_hash" class="muted mono" :title="inv.frozen_hash" data-testid="decision-hash">
              frozen · hash {{ shortHash(inv.frozen_hash) }}
            </p>
            <p class="muted">Read-only and retained for {{ RETENTION_YEARS }} years.</p>
          </template>
          <form v-else-if="canEdit" class="decide" data-testid="decision-form" @submit.prevent="recordDecision">
            <fieldset>
              <legend>Outcome</legend>
              <label v-for="(text, o) in OUTCOMES" :key="o">
                <input v-model="outcome" type="radio" :value="o" :data-testid="`decision-outcome-${o}`" /> {{ text }}
              </label>
            </fieldset>
            <fieldset>
              <legend>Actions with it</legend>
              <label v-for="(text, a) in ACTIONS" :key="a">
                <input v-model="actions" type="checkbox" :value="a" :data-testid="`decision-action-${a}`" /> {{ text }}
              </label>
            </fieldset>
            <label class="field">
              <span class="legend">Rationale</span>
              <textarea v-model="rationale" rows="5" data-testid="decision-rationale" placeholder="Why, citing the evidence (E1, E2, …)"></textarea>
            </label>
            <p class="notice">
              The account holder is never told (tipping-off prohibition). The case is visible only to the people it
              was shared with by name.
            </p>
            <button class="btn btn-primary" :disabled="!rationale.trim() || deciding" data-testid="decision-record">
              Record decision
            </button>
            <p class="muted">
              Recording freezes the case with a hash, writes the decision to the journal and retains everything for
              {{ RETENTION_YEARS }} years.
            </p>
          </form>
          <p v-else class="muted">Not decided yet. Only people with write access to the case record the decision.</p>
          <div v-if="can('investigation.export')" class="exports" data-testid="dossier-exports">
            <button
              v-for="x in EXPORTS"
              :key="x.format"
              class="btn btn-secondary btn-sm"
              :disabled="exporting !== null"
              :data-testid="`export-${x.format}`"
              @click="download(x.format)"
            >
              {{ x.label }}
            </button>
            <button class="btn btn-secondary btn-sm" data-testid="export-laudo" @click="printLaudo">Laudo PDF</button>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dossier {
  height: 100%;
  overflow-y: auto;
  padding: 12px 24px 24px;
}

.head {
  display: flex;
  gap: 12px;
  align-items: baseline;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.head h1 {
  margin: 0;
  font-size: 18px;
}

.back,
.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.urgent {
  color: #c2410c;
  font-weight: 600;
}

.status {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-primary-subtle);
  font-size: 12px;
  font-weight: 600;
}

.error {
  color: var(--color-error);
  margin-bottom: 8px;
}

.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 20px;
  align-items: start;
}

@media (max-width: 1000px) {
  .cols {
    grid-template-columns: minmax(0, 1fr);
  }
}

.main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.card {
  padding: 16px 18px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--color-surface);
}

.card h2 {
  margin: 0 0 10px;
  font-size: 16px;
}

.card h2 .muted {
  font-weight: normal;
}

.description {
  margin: 0 0 10px;
  line-height: 1.5;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 3px 10px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-size: 12px;
}

.chip.seal {
  border-color: #f59e0b;
  background: #fff7ed;
  color: #9a3412;
}

.indicators {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.indicator {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--color-bg-subtle);
}

.indicator .value {
  font-size: 20px;
  font-weight: 700;
}

.ind-label {
  font-size: 12px;
  font-weight: 600;
}

.hyp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.hyp-table th {
  text-align: left;
  font-size: 12px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-color);
  padding: 6px 8px;
}

.hyp-table td {
  vertical-align: top;
  padding: 8px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.pill {
  padding: 2px 8px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--color-surface);
}

.pill.sustentada {
  border-color: transparent;
  background: #ccfbf1;
  color: #115e59;
}

.pill.aberta {
  background: var(--color-bg-muted);
}

.ev-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 4px 4px 0;
  font-size: 12px;
}

.x {
  border: 0;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 2px;
}

.link-select {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  max-width: 100%;
}

.add {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.add input {
  flex: 1;
  min-width: 0;
}

.evidence-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}

.evidence {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 13px;
  min-width: 0;
}

.ev-kind {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-primary);
  font-weight: 700;
}

.mono {
  font-family: ui-monospace, monospace;
}

.params {
  overflow-wrap: anywhere;
}

.journal-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: 13px;
}

.link-btn {
  margin-top: 8px;
  border: 0;
  background: none;
  color: var(--color-primary);
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
}

.decision {
  border: 2px solid var(--color-primary);
  position: sticky;
  top: 0;
}

.decide fieldset {
  border: 0;
  padding: 0;
  margin: 0 0 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.decide legend,
.decide .legend {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}

.decide .field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.decide button {
  width: 100%;
  margin: 8px 0;
}

.decided-actions {
  margin: 0 0 8px;
  padding-left: 18px;
  font-size: 13px;
}

.rationale {
  white-space: pre-wrap;
  line-height: 1.5;
}

.exports {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 12px;
}

.print-only {
  display: none;
}

/* Laudo PDF: the dossier as a document, without the app chrome or controls. */
@media print {
  :global(.toolbar),
  :global(.toast-container) {
    display: none !important;
  }

  :global(.app) {
    height: auto;
    display: block;
  }

  .dossier {
    height: auto;
    overflow: visible;
    padding: 0;
  }

  .cols {
    grid-template-columns: minmax(0, 1fr);
  }

  .decision {
    position: static;
    border-width: 1px;
  }

  .back,
  .exports,
  .decide,
  .add,
  .link-btn,
  .link-select,
  .x {
    display: none !important;
  }

  .print-only {
    display: block;
  }

  .card {
    break-inside: avoid;
  }
}

.notice {
  padding: 10px;
  border-radius: 6px;
  background: var(--color-bg-subtle);
  font-size: 13px;
}
</style>
