<script setup lang="ts">
/**
 * Match review (T8, investigations F2.8): the entity-resolution suggestions of a
 * case, ordered by how much accepting changes the case, side by side with the
 * coinciding values highlighted. Nothing merges by itself: accept, reject and
 * defer each need a reason, which goes to the journal.
 */
import { computed, ref, watch } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { erFields } from '@/utils/entityResolution';
import { baseSourceId, type UnifiedNode } from '@/utils/unifyGraph';
import { getErrorMessage } from '@/utils/errorMessage';
import type { EntityMatch, MatchStatus } from '@/types/investigation';

const props = defineProps<{ id: string }>();
const store = useInvestigationStore();

const selectedId = ref<string | null>(null);
const reason = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const info = ref<string | null>(null);

async function load(id: string) {
  error.value = null;
  if (store.current?.id !== id) await store.openInvestigation(id);
  try {
    await Promise.all([store.loadWorkspace(), store.fetchMatches()]);
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to load the matches');
  }
}
watch(() => props.id, load, { immediate: true });

const canEdit = computed(() => !!store.current?.has_write_access && store.current.status !== 'decidido');
const nodeById = computed(() => new Map(store.unified.nodes.map((n) => [n.node_id, n])));
const neighbors = computed(() => {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  for (const e of store.unified.edges) {
    add(e.src, e.dst);
    add(e.dst, e.src);
  }
  return adj;
});

/** Connections the kept entity gains by absorbing the other one. */
function gain(m: EntityMatch): number {
  const left = neighbors.value.get(m.left.uid) ?? new Set<string>();
  return [...(neighbors.value.get(m.right.uid) ?? [])].filter((n) => n !== m.left.uid && !left.has(n)).length;
}

const queue = computed(() =>
  store.matches
    .filter((m) => m.status === 'sugerido' || m.status === 'adiado')
    .map((m) => ({ m, gain: gain(m) }))
    .sort((a, b) => b.gain - a.gain || b.m.score - a.m.score),
);
const decided = computed(() => store.matches.filter((m) => m.status === 'aceito' || m.status === 'recusado'));
const selected = computed(
  () => queue.value.find((q) => q.m.id === selectedId.value) ?? queue.value[0] ?? null,
);

function labelOf(uid: string): string {
  const n = nodeById.value.get(uid);
  return String(erFields(n?.properties ?? {}).name ?? uid);
}

function originOf(n: UnifiedNode | undefined): string {
  if (!n) return 'Not in the graph you can read';
  const ids = [...new Set(n.__sources.map((o) => baseSourceId(o.sourceId)))];
  const titles = ids.map((id) => store.sources.find((s) => s.id === id)?.title_snapshot ?? id);
  const ctx = store.contexts[n.__sources[0]?.contextId]?.title;
  return `${ctx ? `${ctx} · ` : ''}${titles.join(', ')}`;
}

/** Property rows, with the values the score compared marked. */
function rows(uid: string): { key: string; value: string; hit: boolean }[] {
  const props = nodeById.value.get(uid)?.properties ?? {};
  const f = erFields(props);
  const hits = new Set([f.doc, f.name, f.cep].filter((v) => v !== null));
  return Object.entries(props)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .slice(0, 10)
    .map(([key, v]) => ({ key, value: String(v), hit: hits.has(v) }));
}

function describeReason(r: EntityMatch['reasons'][number]): string {
  if (r.term === 'name') return `Similar name: Jaro-Winkler ${r.value.toFixed(2)} between “${r.left}” and “${r.right}”`;
  if (r.term === 'cpf_middle6') return 'The 6 visible CPF digits match';
  if (r.term === 'cep5') return r.value ? 'Same CEP (first 5 digits)' : 'CEP differs or is missing';
  return `${r.term}: ${r.value}`;
}

const masked = computed(() => !!selected.value?.m.reasons.some((r) => r.masked));

async function find() {
  busy.value = true;
  error.value = info.value = null;
  try {
    const n = await store.findMatches();
    info.value = n ? `${n} new suggestion(s)` : 'No new suggestions';
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to look for matches');
  } finally {
    busy.value = false;
  }
}

async function decide(status: Exclude<MatchStatus, 'sugerido'>) {
  const m = selected.value?.m;
  if (!m || !reason.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    await store.decideMatch(m.id, status, reason.value.trim());
    reason.value = '';
    selectedId.value = null;
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to record the decision');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="matches">
    <header class="head">
      <RouterLink :to="`/investigations/${id}`" class="back">← {{ store.current?.title ?? 'Case' }}</RouterLink>
      <span class="muted">› Match review</span>
      <button v-if="canEdit" class="btn btn-outline btn-sm find" :disabled="busy" data-testid="matches-find" @click="find">
        Find matches
      </button>
    </header>
    <div v-if="error" class="error" data-testid="matches-error">{{ error }}</div>
    <div v-if="info" class="muted info" data-testid="matches-info">{{ info }}</div>

    <div class="cols">
      <aside class="queue" data-testid="matches-queue">
        <h2>{{ queue.length }} {{ queue.length === 1 ? 'suggestion' : 'suggestions' }} to review</h2>
        <p class="muted">Ordered by how much they change the case, not only by score.</p>
        <button
          v-for="q in queue"
          :key="q.m.id"
          class="item"
          :class="{ active: selected?.m.id === q.m.id }"
          :data-testid="`match-item-${q.m.id}`"
          @click="selectedId = q.m.id; reason = ''"
        >
          <strong>{{ labelOf(q.m.left.uid) }}</strong>
          <span>= {{ labelOf(q.m.right.uid) }}</span>
          <span class="meta">
            score {{ q.m.score.toFixed(2) }} · +{{ q.gain }} connection(s)<template v-if="q.m.status === 'adiado'"> · deferred</template>
          </span>
        </button>
        <p v-if="!queue.length" class="muted">Nothing to review.</p>

        <template v-if="decided.length">
          <h3>Decided</h3>
          <div v-for="m in decided" :key="m.id" class="decided" :data-testid="`match-decided-${m.id}`">
            {{ m.status === 'aceito' ? 'Same' : 'Not the same' }}: {{ labelOf(m.left.uid) }} = {{ labelOf(m.right.uid) }}
            <span class="muted">· {{ m.reason_text }}</span>
          </div>
        </template>
      </aside>

      <section v-if="selected" class="detail" data-testid="match-detail">
        <h1>
          Same entity?
          <span class="score">score {{ selected.m.score.toFixed(2) }}</span>
        </h1>
        <div class="sides">
          <div v-for="(uid, i) in [selected.m.left.uid, selected.m.right.uid]" :key="uid" class="side" :class="i ? 'right' : 'left'">
            <div class="origin">{{ originOf(nodeById.get(uid)) }}</div>
            <table>
              <tr v-for="r in rows(uid)" :key="r.key">
                <th>{{ r.key }}</th>
                <td><mark v-if="r.hit">{{ r.value }}</mark><template v-else>{{ r.value }}</template></td>
              </tr>
            </table>
            <div v-if="!nodeById.get(uid)" class="muted">{{ uid }}</div>
          </div>
        </div>

        <div class="why">
          <h3>Why it is suggested</h3>
          <ul>
            <li v-for="r in selected.m.reasons" :key="r.term">{{ describeReason(r) }}</li>
          </ul>
          <div v-if="masked" class="note" data-testid="match-masked-note">
            The CPF is masked on one side, so this match never merges automatically. Only your acceptance joins the entities.
          </div>
        </div>

        <div class="effect" data-testid="match-effect">
          <strong>If accepted:</strong> {{ labelOf(selected.m.left.uid) }} absorbs {{ labelOf(selected.m.right.uid) }} and gains
          {{ selected.gain }} connection(s), from {{ neighbors.get(selected.m.left.uid)?.size ?? 0 }} to
          {{ (neighbors.get(selected.m.left.uid)?.size ?? 0) + selected.gain }}.
        </div>

        <template v-if="canEdit">
          <label class="reason-label" for="match-reason">Reason (goes to the journal)</label>
          <div class="actions">
            <input
              id="match-reason"
              v-model="reason"
              placeholder="e.g. confirmed by the home address in KYC"
              data-testid="match-reason"
            />
            <button class="btn btn-outline" :disabled="busy || !reason.trim()" data-testid="match-defer" @click="decide('adiado')">Defer</button>
            <button class="btn btn-outline" :disabled="busy || !reason.trim()" data-testid="match-reject" @click="decide('recusado')">
              Not the same
            </button>
            <button class="btn btn-primary" :disabled="busy || !reason.trim()" data-testid="match-accept" @click="decide('aceito')">
              Same entity
            </button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.matches {
  height: 100%;
  overflow-y: auto;
  padding: 12px 24px 24px;
}

.head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 12px;
}

.find {
  margin-left: auto;
}

.back,
.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.error {
  color: var(--color-danger);
  margin-bottom: 8px;
}

.info {
  margin-bottom: 8px;
}

.cols {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}

.queue h2 {
  font-size: 16px;
  margin: 0 0 4px;
}

.queue h3 {
  font-size: 13px;
  margin: 16px 0 4px;
}

.item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--surface-color, transparent);
  color: var(--text-color);
  text-align: left;
  font-size: 13px;
  cursor: pointer;
}

.item.active {
  border: 2px solid var(--color-primary);
}

.item .meta {
  font-size: 12px;
  color: var(--text-muted);
}

.decided {
  font-size: 12px;
  margin-top: 4px;
}

.detail h1 {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 20px;
  margin: 0 0 12px;
}

.score {
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  background: var(--color-primary-subtle);
}

.sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.side {
  padding: 12px 16px;
  border: 2px solid var(--color-primary);
  border-radius: 8px;
}

.side.left {
  border-color: var(--color-warning, #c2410c);
}

.origin {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
}

table {
  width: 100%;
  font-size: 13px;
  border-collapse: collapse;
}

th {
  width: 40%;
  padding: 3px 0;
  font-weight: normal;
  text-align: left;
  color: var(--text-muted);
}

mark {
  background: var(--color-primary-subtle);
  color: inherit;
}

.why,
.effect {
  margin-top: 16px;
  padding: 12px 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 13px;
}

.why h3 {
  font-size: 14px;
  margin: 0 0 6px;
}

.note {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--color-info-subtle, var(--color-primary-subtle));
}

.effect {
  border-color: var(--color-warning, #c2410c);
}

.reason-label {
  display: block;
  margin: 16px 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.actions {
  display: flex;
  gap: 8px;
}

.actions input {
  flex: 1;
  min-width: 0;
}
</style>
