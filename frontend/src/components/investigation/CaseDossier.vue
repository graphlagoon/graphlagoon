<script setup lang="ts">
/**
 * Dossier (05 §2, §7): `?mode=dossier` of the case screen, same store. Summary and
 * indicators, groups, hypotheses with the evidence for and against each
 * (pinned versions E1, E2, … oldest first), the evidence, the tables flagged "Use in the
 * dossier", the journal, the decisions (with their four-eyes reviews) and the panel to
 * record one. Read-only once closed. Exports
 * download from the server; the print report is this page printed (print CSS below).
 */
import { computed, nextTick, ref, watch } from 'vue';
import { downloadBlob } from '@/utils/portableExport';
import { useInvestigationStore } from '@/stores/investigation';
import { api } from '@/services/api';
import { describeEvent } from '@/utils/investigationEvents';
import { AUTHOR_KIND_LABELS, HYPOTHESIS_STATUS_LABELS, REVIEW_LABELS, caseNumber, itemKindLabel } from '@/utils/investigationStatus';
import { useAuthStore } from '@/stores/auth';
import { caseNodeLabel, shortId } from '@/utils/caseLabels';
import { formatDate } from '@/utils/format';
import { methodStamp } from '@/utils/traceView';
import { getErrorMessage } from '@/utils/errorMessage';
import { buildPreview } from '@/utils/itemPreview';
import DecisionPanel from '@/components/investigation/DecisionPanel.vue';
import CaseTasksPanel from '@/components/investigation/CaseTasksPanel.vue';
import type { TraceResult } from '@/utils/trace';
import type { CaseAnnotation, CaseItem, HypothesisStatus, InvestigationDecision, InvestigationExportFormat } from '@/types/investigation';

const props = defineProps<{ id: string }>();
const store = useInvestigationStore();

const error = ref<string | null>(null);
const draft = ref('');
const showAllEvents = ref(false);
const JOURNAL_ROWS = 8;

watch(
  () => props.id,
  async (id) => {
    error.value = null;
    if (store.current?.id !== id) await store.openInvestigation(id);
    else await Promise.all([store.fetchItems(), store.fetchAnnotations()]).catch(() => {}); // pins made elsewhere
    if (!store.current) return;
    store.fetchEvents().catch(() => {});
    store.fetchBrief().catch(() => {});
  },
  { immediate: true },
);

const inv = computed(() => store.current);
const canEdit = computed(() => !!inv.value?.has_write_access && inv.value.status !== 'closed');

/** E1, E2, … by pin order; keyed by item id (a hypothesis cites items). */
const label = computed(() => new Map(store.evidence.map((e, i) => [e.item.id, `E${i + 1}`])));
const evidenceTitle = (itemId: string) => store.items.find((i) => i.id === itemId)?.title ?? '';

const roleCounts = computed(() => {
  const counts: Record<string, number> = {};
  for (const role of Object.values(store.roles)) counts[role] = (counts[role] ?? 0) + 1;
  return Object.entries(counts).map(([role, n]) => `${n} ${role}`);
});

const indicators = computed(() => {
  const restricted = store.restrictedItems.length;
  const by = (s: HypothesisStatus) => store.hypotheses.filter((h) => h.value.status === s).length;
  return [
    { label: 'Graphs', value: store.graphItems.length, hint: restricted ? `${restricted} restricted` : '' },
    { label: 'Material', value: store.items.length, hint: 'items' },
    { label: 'Evidence', value: store.evidence.length, hint: 'pinned with sha256' },
    { label: 'Hypotheses', value: store.hypotheses.length, hint: `${by('supported')} supported · ${by('open')} open · ${by('refuted')} refuted` },
    { label: 'Journal', value: store.events.length, hint: 'events' },
    { label: 'Suggestions', value: store.suggestions.length, hint: 'to review' },
  ];
});

const journal = computed(() => (showAllEvents.value ? store.events : store.events.slice(-JOURNAL_ROWS)));

/** Tables flagged "Use in the dossier" (tag `dossier`): the latest or pinned version, first rows. */
const dossierTables = computed(() => store.items.filter((i) => !i.deleted_at && i.tags.includes('dossier') && i.current_version > 0));
const tableRows = ref<Record<string, { columns: string[]; rows: unknown[][] }>>({});
watch(
  dossierTables,
  async (tables) => {
    for (const t of tables) {
      if (tableRows.value[t.id] || !store.current) continue;
      try {
        const preview = buildPreview(await api.getInvestigationItemContent(store.current.id, t.id), t.latest?.content_type);
        const { columns, rows } = preview.kind === 'table' ? preview : { columns: [], rows: [] };
        tableRows.value = { ...tableRows.value, [t.id]: { columns, rows: rows.slice(0, 20) } };
      } catch {
        tableRows.value = { ...tableRows.value, [t.id]: { columns: [], rows: [] } };
      }
    }
  },
  { immediate: true },
);

function shortHash(sha: string) {
  return `${sha.slice(0, 4)}…${sha.slice(-4)}`;
}

/** One line for how the evidence was made: the trace stamp, or its parameters. */
function paramsLine(e: (typeof store.evidence)[number]): string {
  const p = (e.item.provenance?.params ?? {}) as Record<string, unknown>;
  if (e.item.provenance?.tool === 'trace' && p.direction && p.allocation) {
    try {
      return methodStamp(p as unknown as TraceResult['method']);
    } catch {
      /* a stamp from another engine version: fall back to the raw parameters */
    }
  }
  const run = e.version.run as Record<string, unknown> | null | undefined;
  if (run) return `run · ${run.row_count ?? '?'} rows · ${run.duration_ms ?? '?'} ms`;
  return Object.entries(p).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || `${e.item.kind}/${e.item.subkind}`;
}

const fmtTime = (iso?: string | null) => formatDate(iso);

async function act(action: () => Promise<unknown>, fallback: string) {
  error.value = null;
  try {
    await action();
  } catch (e) {
    error.value = getErrorMessage(e, fallback);
  }
}

const auth = useAuthStore();
const RETENTION_YEARS = computed(
  () => store.caseType?.retention_years ?? window.__GRAPH_LAGOON_CONFIG__?.investigation_retention_years ?? 10,
);
const decisions = computed(() => inv.value?.decisions ?? []);
/** The panel shows for the first decision, or when asked; never while one waits for review. */
const deciding = ref(false);
const pending = computed(() => decisions.value.some((d) => d.review === 'pending'));
const canDecide = computed(() => canEdit.value && !pending.value);
const closedBy = computed(() => (inv.value?.status === 'closed' ? [...decisions.value].reverse().find((d) => d.closed_at) ?? null : null));
const decisionNumber = (d: InvestigationDecision) => `D${decisions.value.indexOf(d) + 1}`;
const entityName = (id: string) => {
  const n = store.unified.nodes.find((x) => x.node_id === id);
  return n ? caseNodeLabel(n, { templates: store.labelTemplates }) : shortId(id);
};
/** Four eyes: anyone else with write access, or the named reviewer. */
const canReview = (d: InvestigationDecision) =>
  d.review === 'pending' && !!inv.value?.has_write_access && d.decided_by !== auth.email && (!d.reviewer_email || d.reviewer_email === auth.email);
/** The author may withdraw a pending decision (never approve it). */
const canWithdraw = (d: InvestigationDecision) => d.review === 'pending' && !!inv.value?.has_write_access && d.decided_by === auth.email;
const reviewNote = ref('');
const review = (d: InvestigationDecision, approve: boolean) =>
  act(async () => {
    await store.reviewDecision(d.id, approve, reviewNote.value.trim() || undefined);
    reviewNote.value = '';
  }, 'Could not review the decision');

const EXPORTS: { format: InvestigationExportFormat; label: string }[] = [
  { format: 'json', label: 'JSON package' },
  { format: 'csv', label: 'CSV' },
];
const exporting = ref<string | null>(null);

/** Report templates of the org library, the case type's first (06 P5). */
const templates = ref<{ slug: string; title: string; preferred: boolean }[]>([]);
const template = ref('');
watch(
  () => [store.caseType?.slug, props.id],
  async () => {
    try {
      const preferred = store.caseType?.report_templates ?? [];
      templates.value = (await api.getOrgLibrary('template'))
        .map((d) => ({ slug: d.slug, title: d.title, preferred: preferred.includes(d.slug) }))
        .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.title.localeCompare(b.title));
      template.value = templates.value[0]?.slug ?? '';
    } catch {
      templates.value = [];
    }
  },
  { immediate: true },
);
const drafted = ref<string | null>(null);
async function draftReport() {
  if (!template.value) return;
  drafted.value = null;
  await act(async () => {
    const item = await store.renderReport(template.value);
    drafted.value = item?.title ?? null;
  }, 'Could not draft the report');
}

async function download(format: InvestigationExportFormat) {
  exporting.value = format;
  await act(async () => {
    const { blob, filename } = await api.exportInvestigation(props.id, format);
    downloadBlob(filename, blob);
  }, 'Could not export the case');
  exporting.value = null;
}

/** Print report: the browser prints this page (Save as PDF) with the whole journal. */
async function printLaudo() {
  showAllEvents.value = true;
  await nextTick();
  window.print();
}

const printedAt = formatDate(new Date());

function addHypothesis() {
  const text = draft.value.trim();
  if (!text) return;
  act(async () => {
    await store.addHypothesis(text);
    draft.value = '';
  }, 'Could not add the hypothesis');
}

function setStatus(h: CaseAnnotation, status: string) {
  act(() => store.updateHypothesis(h.id, { status }), 'Could not update the hypothesis');
}

type Side = 'evidence_for' | 'evidence_against';
const sideOf = (h: CaseAnnotation, side: Side): string[] => (h.value[side] as string[] | undefined) ?? [];
function link(h: CaseAnnotation, side: Side, itemId: string) {
  if (!itemId || sideOf(h, side).includes(itemId)) return;
  act(() => store.updateHypothesis(h.id, { [side]: [...sideOf(h, side), itemId] }), 'Could not link the evidence');
}
function unlink(h: CaseAnnotation, side: Side, itemId: string) {
  act(() => store.updateHypothesis(h.id, { [side]: sideOf(h, side).filter((x) => x !== itemId) }), 'Could not unlink the evidence');
}
const hypothesisNumber = (h: CaseAnnotation) => `H${store.hypotheses.indexOf(h) + 1}`;
const unflag = (t: CaseItem) => act(() => store.setInDossier(t, false), 'Could not update the item');
</script>

<template>
  <div class="dossier" data-testid="dossier">
    <div v-if="store.loading && !inv" class="loading"></div>
    <div v-else-if="store.error" class="error">{{ store.error }}</div>
    <template v-else-if="inv">
      <div v-if="error" class="error" data-testid="dossier-error">{{ error }}</div>
      <p class="print-only muted">
        Report · {{ inv.title }} · {{ caseNumber(id) }} · printed {{ printedAt }} · {{ inv.owner_email }}{{ inv.assignee_email ? ` · assignee ${inv.assignee_email}` : '' }}
        <template v-if="inv.frozen_hash"> · closing decision hash {{ inv.frozen_hash }}</template>
      </p>

      <div class="cols">
        <main class="main">
          <section class="card" data-testid="dossier-summary">
            <h2>Summary <span class="muted">built from the case and the evidence · review before deciding</span></h2>
            <p class="description">{{ inv.description || 'No description yet.' }}</p>
            <pre v-if="store.brief.text" class="brief" data-testid="dossier-brief">{{ store.brief.text }}</pre>
            <div class="chips">
              <span class="chip seal" data-testid="dossier-case-type">{{ store.caseTypeLabel(inv.case_type) }}</span>
              <span v-for="t in inv.tags" :key="t" class="chip">{{ t }}</span>
              <span v-for="r in roleCounts" :key="r" class="chip">{{ r }}</span>
              <span v-for="g in store.groups" :key="g.id" class="chip group" :style="{ borderColor: g.color }" :data-testid="`dossier-group-${g.id}`">
                {{ g.name }} · {{ g.targets.length }}
              </span>
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
                <tr v-for="h in store.hypotheses" :key="h.id" :data-testid="`hypothesis-${hypothesisNumber(h)}`">
                  <td>
                    <strong>{{ hypothesisNumber(h) }}</strong> · {{ h.value.text }}
                    <div class="muted">
                      {{ h.author_kind === 'agent' ? 'agent · ' : '' }}{{ h.author_email }}
                      <template v-if="h.status === 'suggested'"> · suggested</template>
                    </div>
                  </td>
                  <td>
                    <select
                      v-if="canEdit"
                      :value="h.value.status"
                      class="pill"
                      :class="h.value.status"
                      :data-testid="`hypothesis-status-${hypothesisNumber(h)}`"
                      @change="setStatus(h, ($event.target as HTMLSelectElement).value)"
                    >
                      <option v-for="(text, s) in HYPOTHESIS_STATUS_LABELS" :key="s" :value="s">{{ text }}</option>
                    </select>
                    <span v-else class="pill" :class="h.value.status">{{ HYPOTHESIS_STATUS_LABELS[h.value.status as HypothesisStatus] ?? h.value.status }}</span>
                  </td>
                  <td v-for="side in (['evidence_for', 'evidence_against'] as const)" :key="side" :data-testid="`hypothesis-${side}-${hypothesisNumber(h)}`">
                    <span v-for="eid in sideOf(h, side)" :key="eid" class="ev-chip" :title="evidenceTitle(eid)">
                      {{ label.get(eid) ?? 'E?' }} {{ evidenceTitle(eid) }}
                      <button v-if="canEdit" class="x" aria-label="Unlink" @click="unlink(h, side, eid)">×</button>
                    </span>
                    <span v-if="!sideOf(h, side).length" class="muted">none</span>
                    <select
                      v-if="canEdit && store.evidence.some((e) => !sideOf(h, side).includes(e.item.id))"
                      class="link-select"
                      :data-testid="`hypothesis-link-${side}-${hypothesisNumber(h)}`"
                      @change="link(h, side, ($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''"
                    >
                      <option value="">+ evidence</option>
                      <option v-for="e in store.evidence.filter((x) => !sideOf(h, side).includes(x.item.id))" :key="e.item.id" :value="e.item.id">
                        {{ label.get(e.item.id) }} · {{ e.item.title }}
                      </option>
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">No hypothesis yet.</p>
            <form v-if="canEdit" class="add" @submit.prevent="addHypothesis">
              <input v-model="draft" placeholder="New hypothesis, e.g. 4471-0 is a pass-through account" data-testid="hypothesis-input" />
              <button class="btn btn-primary btn-sm" :disabled="!draft.trim()" data-testid="hypothesis-add">Add hypothesis</button>
            </form>
          </section>

          <section class="card" data-testid="dossier-evidence">
            <h2>Evidence <span class="muted">pinned versions, immutable</span></h2>
            <div v-if="store.evidence.length" class="evidence-grid">
              <article v-for="e in store.evidence" :key="`${e.item.id}:${e.version.version}`" class="evidence" :data-testid="`evidence-${e.item.id}`">
                <div class="ev-kind">{{ itemKindLabel(e.item.kind) }} / {{ e.item.subkind }}</div>
                <strong>{{ label.get(e.item.id) }} · {{ e.item.title }}<template v-if="e.version.pin_label"> · {{ e.version.pin_label }}</template></strong>
                <div class="muted mono" :title="e.version.sha256">v{{ e.version.version }} · hash {{ shortHash(e.version.sha256) }}</div>
                <div class="muted params">{{ paramsLine(e) }}</div>
                <div class="muted">{{ e.version.pinned_by }} · {{ fmtTime(e.version.pinned_at) }}</div>
              </article>
            </div>
            <p v-else class="muted">No evidence yet. Pin a version in the material list (📌) or an analysis result.</p>
          </section>

          <section v-if="dossierTables.length" class="card" data-testid="dossier-tables">
            <h2>Tables <span class="muted">flagged “Use in the dossier” · latest version</span></h2>
            <article v-for="t in dossierTables" :key="t.id" class="dossier-table" :data-testid="`dossier-table-${t.id}`">
              <div class="table-head">
                <strong>{{ t.title }}</strong>
                <span class="muted">v{{ t.current_version }}<template v-if="t.latest"> · {{ shortHash(t.latest.sha256) }}</template><template v-if="t.latest?.run"> · {{ t.latest.run.row_count }} rows</template></span>
                <button v-if="canEdit" class="x" :aria-label="`Remove ${t.title} from the dossier`" @click="unflag(t)">×</button>
              </div>
              <table v-if="tableRows[t.id]?.rows.length" class="data">
                <thead><tr><th v-for="c in tableRows[t.id].columns" :key="c">{{ c }}</th></tr></thead>
                <tbody><tr v-for="(r, i) in tableRows[t.id].rows" :key="i"><td v-for="(_, j) in tableRows[t.id].columns" :key="j">{{ r[j] }}</td></tr></tbody>
              </table>
              <p v-else class="muted">{{ tableRows[t.id] ? 'No tabular rows in this version.' : 'Loading…' }}</p>
            </article>
          </section>

          <section v-if="store.tasks.some((t) => t.value.state === 'open')" class="card" data-testid="dossier-tasks">
            <h2>Tasks <span class="muted">open follow-ups · the canvas's Tasks tab has them all</span></h2>
            <CaseTasksPanel compact />
          </section>

          <section class="card" data-testid="dossier-journal">
            <h2>Journal <span class="muted">recorded automatically · not editable</span></h2>
            <div v-for="e in journal" :key="e.id" class="journal-row">
              <span class="muted">{{ fmtTime(e.at) }}</span>
              <span>
                {{ describeEvent(e) }} ·
                <span class="muted">{{ e.actor_kind === 'agent' ? `${AUTHOR_KIND_LABELS.agent} ${e.agent_name} by ${e.actor_email}` : e.actor_email }}</span>
              </span>
            </div>
            <p v-if="!store.events.length" class="muted">Nothing recorded yet.</p>
            <button v-if="store.events.length > JOURNAL_ROWS" class="link-btn" data-testid="dossier-all-events" @click="showAllEvents = !showAllEvents">
              {{ showAllEvents ? 'Show only the latest' : `See all ${store.events.length} events` }}
            </button>
          </section>

          <section class="card print-only" data-testid="dossier-hashes">
            <h2>Material</h2>
            <div v-for="i in store.items" :key="i.id" class="journal-row">
              <span>{{ i.title }} ({{ itemKindLabel(i.kind) }}/{{ i.subkind }})</span>
              <span class="mono">{{ i.latest ? `v${i.latest.version} · sha256 ${i.latest.sha256}` : i.accessible ? 'live reference' : 'restricted' }}</span>
            </div>
          </section>
        </main>

        <aside class="card decision" data-testid="dossier-decision">
          <h2>Decisions</h2>
          <ol v-if="decisions.length" class="decisions">
            <li v-for="d in decisions" :key="d.id" :data-testid="`decision-${decisionNumber(d)}`">
              <p data-testid="decision-outcome">
                <strong>{{ decisionNumber(d) }} · {{ d.outcome_label }}</strong>
                <span v-if="d.closes_case" class="flag">closes the case</span>
                <span v-if="d.review" class="flag" :class="`review-${d.review}`" data-testid="decision-review">{{ REVIEW_LABELS[d.review] }}</span>
              </p>
              <p v-if="d.targets.length" class="muted" data-testid="decision-targets">About {{ d.targets.map(entityName).join(', ') }}</p>
              <p class="rationale">{{ d.rationale }}</p>
              <p class="muted">
                {{ d.decided_by }} · {{ fmtTime(d.decided_at) }}<template v-if="d.reviewer_email"> · reviewer {{ d.reviewer_email }}</template>
                <template v-if="d.reviewed_by"> · {{ d.review }} by {{ d.reviewed_by }}<template v-if="d.review_note"> — {{ d.review_note }}</template></template>
              </p>
              <p class="muted mono" :title="d.hash" data-testid="decision-hash">{{ d.evidence.length }} pinned version(s) · hash {{ shortHash(d.hash) }}</p>
              <div v-if="canReview(d)" class="review" data-testid="decision-review-actions">
                <input v-model="reviewNote" type="text" class="form-control" placeholder="Note (optional)" data-testid="decision-review-note" />
                <button class="btn btn-primary btn-sm" data-testid="decision-approve" @click="review(d, true)">Approve</button>
                <button class="btn btn-outline btn-sm" data-testid="decision-reject" @click="review(d, false)">Reject</button>
              </div>
              <button v-else-if="canWithdraw(d)" class="btn btn-outline btn-sm" data-testid="decision-withdraw" @click="review(d, false)">
                Withdraw <span class="muted">(waiting for {{ d.reviewer_email ?? 'a second person' }})</span>
              </button>
            </li>
          </ol>
          <p v-if="closedBy" class="muted" data-testid="decision-closed">Closed by {{ decisionNumber(closedBy) }}: read-only, retained for {{ RETENTION_YEARS }} years.</p>
          <DecisionPanel
            v-if="canDecide && (deciding || !decisions.length || store.decisionProposal)"
            :key="store.decisionProposal?.id ?? 'own'"
            class="decide"
            @decided="deciding = false"
            @cancel="deciding = false"
          />
          <button v-else-if="canDecide" class="btn btn-outline btn-sm" data-testid="decision-new" @click="deciding = true">Record another decision</button>
          <p v-else-if="!decisions.length" class="muted">No decision yet. Only people with write access to the case record decisions.</p>
          <div class="exports" data-testid="dossier-exports">
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
            <button class="btn btn-secondary btn-sm" data-testid="export-laudo" @click="printLaudo">Print report</button>
          </div>
          <div v-if="templates.length && inv.has_write_access" class="report" data-testid="dossier-report">
            <select v-model="template" class="form-control" aria-label="Report template" data-testid="report-template">
              <option v-for="t in templates" :key="t.slug" :value="t.slug">{{ t.title }}{{ t.preferred ? ' · for this type' : '' }}</option>
            </select>
            <button class="btn btn-outline btn-sm" data-testid="report-draft" @click="draftReport">Draft report</button>
            <p v-if="drafted" class="muted" data-testid="report-drafted">“{{ drafted }}” is in the material: review it, pin it, print it.</p>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dossier {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 24px 24px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.error {
  color: var(--color-error);
  margin-bottom: 8px;
}

.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
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
  border-color: var(--color-suggested-fg);
  background: var(--color-suggested-bg);
  color: var(--color-suggested-fg);
}

.chip.group {
  border-width: 2px;
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

.hyp-table,
.data {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.hyp-table th,
.data th {
  text-align: left;
  font-size: 12px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-color);
  padding: 6px 8px;
}

.hyp-table td,
.data td {
  vertical-align: top;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.data {
  display: block;
  overflow-x: auto;
  font-size: 12px;
}

.pill {
  padding: 2px 8px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--color-surface);
}

.pill.supported {
  border-color: transparent;
  background: #ccfbf1;
  color: #115e59;
}

.pill.open {
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

.dossier-table {
  margin-bottom: 12px;
}

.table-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
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

.decisions {
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
}

.decisions li {
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color);
}

.flag {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 11px;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.flag.review-pending {
  background: #fef3c7;
  color: #92400e;
}

.flag.review-rejected {
  background: #fee2e2;
  color: #991b1b;
}

.review {
  display: flex;
  gap: 6px;
  align-items: center;
}

.rationale {
  white-space: pre-wrap;
  line-height: 1.5;
}

.report {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 8px;
}

.report .form-control {
  flex: 1;
  min-width: 140px;
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

.brief {
  margin: 8px 0;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
  white-space: pre-wrap;
  font: inherit;
  font-size: 13px;
}

/* Print report: the dossier as a document, without the app chrome or controls. */
@media print {
  :global(.toolbar),
  :global(.toast-container),
  :global(.case-header),
  :global(.status-bar) {
    display: none !important;
  }

  :global(.app),
  :global(.workspace) {
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
</style>
