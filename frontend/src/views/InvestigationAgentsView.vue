<script setup lang="ts">
/**
 * Agents on a case (T11): connect an agent (personal token), the proposals
 * waiting for a person, and what agents did on the case. Accepting applies the
 * change through the same server service as the manual action.
 */
import { computed, ref, watch } from 'vue';
import { api } from '@/services/api';
import { useInvestigationStore } from '@/stores/investigation';
import { usePermissions } from '@/composables/usePermissions';
import { getErrorMessage } from '@/utils/errorMessage';
import { describeEvent, describeProposal } from '@/utils/investigationEvents';
import type { AgentToken } from '@/types/admin';
import type { InvestigationProposal } from '@/types/investigation';

const props = defineProps<{ id: string }>();

const store = useInvestigationStore();
const { can } = usePermissions();

const SCOPES = [
  { id: 'read', label: 'Read the case and the graph' },
  { id: 'analyze', label: 'Run analyses (trace, paths, typologies)' },
  { id: 'write', label: 'Write notes, evidence and draft artifacts' },
  { id: 'propose', label: 'Make proposals for you to accept' },
];
const KIND_LABELS: Record<string, string> = { role: 'Role', status: 'Status', typology: 'Typology' };

const config = window.__GRAPH_LAGOON_CONFIG__ ?? {};
const agentsEnabled = config.agents_enabled === true;
const unmasked = config.agents_allow_unmasked_data === true;
const mcpUrl = `${window.__GRAPH_LAGOON_API_URL__ || window.location.origin}/mcp`;

const proposals = ref<InvestigationProposal[]>([]);
const tokens = ref<AgentToken[]>([]);
const error = ref<string | null>(null);
const form = ref({ name: 'Claude Code', scopes: ['read', 'analyze', 'write', 'propose'], days: 30 });
const created = ref<{ name: string; token: string } | null>(null);
const rejecting = ref<string | null>(null);
const reason = ref('');

const canDecide = computed(() => !!store.current?.has_write_access && store.current.status !== 'decidido');
const activity = computed(() => store.events.filter((e) => e.actor_kind === 'agent').reverse());
const activeTokens = computed(() => tokens.value.filter((t) => t.active));
const command = computed(
  () => `claude mcp add --transport http graphlagoon ${mcpUrl} --header "Authorization: Bearer ${created.value?.token ?? 'glt_…'}"`,
);

async function run(action: () => Promise<unknown>, fallback: string) {
  error.value = null;
  try {
    await action();
  } catch (e) {
    error.value = getErrorMessage(e, fallback);
  }
}

async function load(id: string) {
  await store.openInvestigation(id);
  store.fetchEvents().catch(() => {});
  await run(async () => {
    proposals.value = await api.getInvestigationProposals(id, 'pending');
    if (agentsEnabled) tokens.value = await api.getAgentTokens();
  }, 'Failed to load agents');
}

watch(() => props.id, load, { immediate: true });

function createToken() {
  run(async () => {
    const token = await api.createAgentToken({
      name: form.value.name.trim(),
      scopes: form.value.scopes,
      expires_in_days: form.value.days,
    });
    created.value = { name: token.name, token: token.token };
    tokens.value = [token, ...tokens.value];
  }, 'Failed to create the token');
}

function revoke(token: AgentToken) {
  run(async () => {
    await api.revokeAgentToken(token.id);
    tokens.value = tokens.value.map((t) => (t.id === token.id ? { ...t, active: false } : t));
  }, 'Failed to revoke the token');
}

function decided(p: InvestigationProposal) {
  proposals.value = proposals.value.filter((x) => x.id !== p.id);
  rejecting.value = null;
  reason.value = '';
  store.fetchEvents().catch(() => {});
}

function accept(p: InvestigationProposal) {
  run(async () => {
    decided(await api.acceptProposal(props.id, p.id));
    await store.openInvestigation(props.id); // roles/status changed
  }, 'Failed to accept');
}

function reject(p: InvestigationProposal) {
  run(async () => decided(await api.rejectProposal(props.id, p.id, reason.value.trim())), 'Failed to reject');
}

const timeOf = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
</script>

<template>
  <div class="agents">
    <header class="head">
      <RouterLink :to="`/investigations/${id}`" class="back">← {{ store.current?.title ?? 'Case' }}</RouterLink>
      <span class="muted">› Agents</span>
    </header>
    <div v-if="error" class="error" data-testid="agents-error">{{ error }}</div>

    <div class="cols">
      <div class="col">
        <section class="panel" data-testid="agents-connect">
          <h2>Connect an agent</h2>
          <p class="muted">The agent acts in your name, with your access. It never sees what you can't see.</p>
          <p v-if="!agentsEnabled" class="muted" data-testid="agents-disabled">
            Agents are turned off on this server (an administrator sets GRAPH_LAGOON_AGENTS_ENABLED).
          </p>
          <template v-else-if="can('investigation.agent')">
            <label class="field">
              <span>Token name</span>
              <input v-model="form.name" data-testid="token-name" />
            </label>
            <div class="field">
              <span>What the agent may do</span>
              <label v-for="s in SCOPES" :key="s.id" class="check">
                <input v-model="form.scopes" type="checkbox" :value="s.id" :data-testid="`token-scope-${s.id}`" /> {{ s.label }}
              </label>
              <label class="check disabled">
                <input type="checkbox" disabled /> Decide, communicate, mark in DICT, share (never for agents)
              </label>
            </div>
            <label class="field">
              <span>Validity</span>
              <select v-model.number="form.days" data-testid="token-days">
                <option :value="7">7 days</option>
                <option :value="30">30 days</option>
                <option :value="90">90 days</option>
              </select>
            </label>
            <button
              class="btn btn-primary"
              :disabled="!form.name.trim() || !form.scopes.length"
              data-testid="token-create"
              @click="createToken"
            >
              Create token
            </button>
            <div class="field">
              <span>Command for Claude Code</span>
              <pre class="cmd" data-testid="token-command">{{ command }}</pre>
              <p class="muted">
                <template v-if="created">Copy it now: the token “{{ created.name }}” is shown only once.</template>
                The token appears once. Only its hash is stored, and it can be revoked at any time.
              </p>
            </div>
          </template>
          <p v-else class="muted">You don't have the permission to create agent tokens.</p>
          <div class="policy" data-testid="agents-policy">
            Administrator policy: CPF, CNPJ and accounts are
            <strong>{{ unmasked ? 'not masked' : 'masked' }}</strong> for agents.
          </div>
        </section>

        <section v-if="agentsEnabled" class="panel">
          <h2>Active tokens</h2>
          <div v-for="t in activeTokens" :key="t.id" class="token" :data-testid="`token-${t.id}`">
            <div>
              <strong>{{ t.name }}</strong>
              <div class="muted">{{ t.scopes.join(', ') }} · expires in {{ daysLeft(t.expires_at) }} days</div>
            </div>
            <button class="btn btn-outline btn-sm danger" :data-testid="`token-revoke-${t.id}`" @click="revoke(t)">Revoke</button>
          </div>
          <p v-if="!activeTokens.length" class="muted">No active tokens.</p>
        </section>
      </div>

      <section class="panel highlight" data-testid="proposals">
        <h2>{{ proposals.length }} {{ proposals.length === 1 ? 'proposal' : 'proposals' }} waiting for you</h2>
        <p class="muted">Changes to the case's reasoning only count with your approval.</p>
        <div v-for="p in proposals" :key="p.id" class="proposal" :data-testid="`proposal-${p.id}`">
          <div class="tag">{{ KIND_LABELS[p.kind] ?? p.kind }} · {{ p.actor.agent_name ?? p.actor.email }}</div>
          <strong>{{ describeProposal(p) }}</strong>
          <p v-if="p.rationale">{{ p.rationale }}</p>
          <template v-if="canDecide">
            <div v-if="rejecting === p.id" class="reject">
              <textarea v-model="reason" rows="2" placeholder="Why reject? (required)" data-testid="proposal-reason"></textarea>
              <div class="row">
                <button class="btn btn-outline btn-sm" :disabled="!reason.trim()" data-testid="proposal-reject-confirm" @click="reject(p)">
                  Reject
                </button>
                <button class="btn btn-sm link" @click="rejecting = null">Cancel</button>
              </div>
            </div>
            <div v-else class="row">
              <button class="btn btn-primary btn-sm" data-testid="proposal-accept" @click="accept(p)">Accept</button>
              <button class="btn btn-outline btn-sm" data-testid="proposal-reject" @click="rejecting = p.id; reason = ''">Reject</button>
            </div>
          </template>
        </div>
        <p v-if="!proposals.length" class="muted">Nothing to decide.</p>
      </section>

      <section class="panel" data-testid="agents-activity">
        <h2>Agent activity</h2>
        <div v-for="e in activity" :key="e.id" class="activity">
          <span class="muted">{{ timeOf(e.at) }}</span>
          <span>{{ e.agent_name }}: {{ describeEvent(e) }}</span>
        </div>
        <p v-if="!activity.length" class="muted">No agent activity yet.</p>
        <div class="policy">Everything an agent does goes to the journal as “agent, on behalf of you”, with the token used.</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.agents {
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

.cols {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel {
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--surface-color, transparent);
}

.panel.highlight {
  border: 2px solid var(--color-primary);
}

.panel h2 {
  margin: 0 0 8px;
  font-size: 17px;
}

.muted {
  font-size: 13px;
  color: var(--text-muted);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 10px 0;
  font-size: 14px;
}

.field > span {
  font-weight: 600;
}

.field input:not([type='checkbox']),
.field select {
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font: inherit;
}

.back {
  color: var(--text-color);
  font-weight: 600;
  text-decoration: none;
}

.check {
  display: flex;
  gap: 6px;
  font-weight: normal;
}

.check.disabled {
  color: var(--text-muted);
}

.cmd {
  margin: 0;
  padding: 10px;
  border-radius: 6px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.policy {
  margin-top: 12px;
  padding: 10px;
  border-radius: 6px;
  font-size: 13px;
  background: var(--color-primary-subtle);
}

.token {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color);
}

.danger {
  color: var(--color-danger, #b91c1c);
}

.proposal {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-top: 10px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.proposal p {
  margin: 6px 0;
  font-size: 14px;
}

.tag {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: #6d28d9;
  margin-bottom: 4px;
}

.row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.reject {
  align-self: stretch;
}

.reject textarea {
  width: 100%;
}

.activity {
  display: grid;
  grid-template-columns: 48px 1fr;
  gap: 8px;
  padding: 6px 0;
  font-size: 14px;
  border-bottom: 1px solid var(--border-color);
}

.error {
  color: var(--color-danger, #b91c1c);
  margin-bottom: 8px;
}
</style>
