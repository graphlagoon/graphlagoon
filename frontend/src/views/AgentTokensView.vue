<script setup lang="ts">
/**
 * Agent tokens (05 §2: /settings/agents). A token is the person's identity for
 * an MCP client: scope "every case I read" or specific cases, optional
 * unmasked data (when the org allows it), validity, the `claude mcp add`
 * command, revoke.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '@/services/api';
import { usePermissions } from '@/composables/usePermissions';
import { getErrorMessage } from '@/utils/errorMessage';
import type { AgentToken } from '@/types/admin';
import type { Investigation } from '@/types/investigation';

const { can } = usePermissions();
const config = window.__GRAPH_LAGOON_CONFIG__ ?? {};
const agentsEnabled = config.agents_enabled === true;
const orgUnmasked = config.agents_allow_unmasked_data === true;
// The API prefix is usually relative ("/graphlagoon"); an MCP client needs the full URL.
const mcpUrl = new URL(`${window.__GRAPH_LAGOON_API_URL__ || ''}/mcp`, window.location.origin).href;

const tokens = ref<AgentToken[]>([]);
const cases = ref<Investigation[]>([]);
const error = ref<string | null>(null);
const form = ref({ name: 'Claude Code', scope: 'user' as 'user' | 'case', investigation_ids: [] as string[], unmasked: false, days: 30 });
const created = ref<{ name: string; token: string } | null>(null);

const activeTokens = computed(() => tokens.value.filter((t) => t.active));
const command = computed(
  () => `claude mcp add --transport http graphlagoon ${mcpUrl} --header "Authorization: Bearer ${created.value?.token ?? 'glt_…'}"`,
);
const caseTitle = (id: string) => cases.value.find((c) => c.id === id)?.title ?? id.slice(0, 8);

async function run(action: () => Promise<unknown>, fallback: string) {
  error.value = null;
  try {
    await action();
  } catch (e) {
    error.value = getErrorMessage(e, fallback);
  }
}

onMounted(() =>
  run(async () => {
    if (!agentsEnabled) return;
    [tokens.value, cases.value] = await Promise.all([api.getAgentTokens(), api.getInvestigations()]);
  }, 'Failed to load the tokens'),
);

function createToken() {
  run(async () => {
    const token = await api.createAgentToken({
      name: form.value.name.trim(),
      expires_in_days: form.value.days,
      scope: form.value.scope,
      investigation_ids: form.value.scope === 'case' ? form.value.investigation_ids : [],
      unmasked: form.value.unmasked,
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

const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
</script>

<template>
  <div class="agents" data-testid="agent-tokens">
    <header class="head">
      <h1>Agents</h1>
      <span class="muted">An agent acts in your name, with your access, on the cases you choose.</span>
    </header>
    <div v-if="error" class="error" data-testid="agents-error">{{ error }}</div>
    <p v-if="!agentsEnabled" class="muted" data-testid="agents-disabled">
      Agents are turned off on this server (an administrator sets GRAPH_LAGOON_AGENTS_ENABLED).
    </p>
    <div v-else class="cols">
      <section class="panel" data-testid="agents-connect">
        <h2>Connect an agent</h2>
        <template v-if="can('investigation.agent')">
          <label class="field">
            <span>Token name</span>
            <input v-model="form.name" data-testid="token-name" />
          </label>
          <div class="field">
            <span>Cases</span>
            <label class="check"><input v-model="form.scope" type="radio" value="user" data-testid="token-scope-user" /> Every case I can read</label>
            <label class="check"><input v-model="form.scope" type="radio" value="case" data-testid="token-scope-case" /> Only these cases</label>
            <select v-if="form.scope === 'case'" v-model="form.investigation_ids" multiple size="5" data-testid="token-cases">
              <option v-for="c in cases" :key="c.id" :value="c.id">{{ c.title }}</option>
            </select>
          </div>
          <label v-if="orgUnmasked" class="check">
            <input v-model="form.unmasked" type="checkbox" data-testid="token-unmasked" /> Unmasked data (CPF, CNPJ, accounts)
          </label>
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
            :disabled="!form.name.trim() || (form.scope === 'case' && !form.investigation_ids.length)"
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
          The agent can do what you can in a case, except decide, share, delete and export. Roles, tags, matches,
          typologies and hypothesis statuses it writes arrive as suggestions you confirm in the case. Administrator
          policy: personal data is <strong>{{ orgUnmasked ? 'available unmasked to tokens marked so' : 'always masked' }}</strong>.
        </div>
      </section>

      <section class="panel">
        <h2>Active tokens</h2>
        <div v-for="t in activeTokens" :key="t.id" class="token" :data-testid="`token-${t.id}`">
          <div>
            <strong>{{ t.name }}</strong>
            <div class="muted">
              {{ t.scope === 'case' ? (t.investigation_ids ?? []).map(caseTitle).join(', ') : 'every case' }}
              <template v-if="t.unmasked"> · unmasked</template> · expires in {{ daysLeft(t.expires_at) }} days
            </div>
          </div>
          <button class="btn btn-outline btn-sm danger" :data-testid="`token-revoke-${t.id}`" @click="revoke(t)">Revoke</button>
        </div>
        <p v-if="!activeTokens.length" class="muted">No active tokens.</p>
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
  gap: 12px;
  align-items: baseline;
  margin-bottom: 12px;
}

.head h1 {
  margin: 0;
  font-size: 18px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.error {
  margin-bottom: 8px;
  color: var(--color-error);
}

.cols {
  display: grid;
  grid-template-columns: minmax(320px, 520px) minmax(280px, 1fr);
  gap: 16px;
}

.panel {
  padding: 14px 16px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.panel h2 {
  margin: 0 0 8px;
  font-size: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
  font-size: 13px;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.cmd {
  overflow-x: auto;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
  font-size: 12px;
}

.policy {
  margin-top: 10px;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
  font-size: 12px;
}

.token {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color);
  font-size: 13px;
}

.danger {
  color: var(--color-error);
}
</style>
