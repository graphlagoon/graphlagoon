<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAdminStore } from '@/stores/admin';

/**
 * "Why can't they?" — runs the real evaluation path for one email and shows
 * the per-permission decision, the rule/group that matched, and how the
 * Databricks membership resolved (fresh/cache/stale + error).
 */
const admin = useAdminStore();

const email = ref('');
const canInspect = computed(() => email.value.trim().length >= 3);

function inspect() {
  if (canInspect.value) void admin.inspectPermissions(email.value.trim());
}

const REASONS: Record<string, string> = {
  superuser: 'superuser — bypasses every rule',
  deny_rule: 'deny rule',
  allow_rule: 'allow rule',
  mode_everyone: 'mode is everyone (default)',
  restricted_no_match: 'restricted, and no allow rule matched',
};

const report = computed(() => admin.inspection);
</script>

<template>
  <div>
    <div class="search-bar card">
      <h3 class="panel-title">Inspector</h3>
      <input
        v-model="email"
        type="email"
        class="form-control"
        data-testid="admin-inspect-email"
        list="admin-inspect-suggestions"
        placeholder="someone@company.com"
        autocomplete="off"
        @keydown.enter.prevent="inspect"
      />
      <datalist id="admin-inspect-suggestions">
        <option v-for="u in admin.users" :key="u.email" :value="u.email" />
      </datalist>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-testid="admin-inspect-run"
        :disabled="!canInspect || admin.loading.inspect"
        @click="inspect"
      >
        {{ admin.loading.inspect ? 'Inspecting…' : 'Inspect' }}
      </button>
    </div>

    <div v-if="report" class="card" data-testid="admin-inspect-report">
      <div class="list-item-title">
        {{ report.email }}
        <span v-if="report.is_superuser" class="badge badge-warning">superuser</span>
      </div>
      <p class="list-item-subtitle resolution-line">
        Databricks groups:
        <template v-if="report.resolved_databricks_groups.length">
          {{ report.resolved_databricks_groups.join(', ') }}
        </template>
        <template v-else>none resolved</template>
        ({{ report.resolution.source
        }}<template v-if="report.resolution.error"> — {{ report.resolution.error }}</template>)
        · Member of:
        <template v-if="report.group_memberships.length">
          <span v-for="(g, i) in report.group_memberships" :key="g.group_id">
            {{ g.name }} <em>via {{ g.via }}</em><template v-if="i < report.group_memberships.length - 1">, </template>
          </span>
        </template>
        <template v-else>no groups</template>
      </p>

      <div
        v-for="p in report.permissions"
        :key="p.id"
        class="list-item"
        :data-permission="p.id"
      >
        <div class="list-item-content">
          <div class="list-item-title">
            {{ p.label }}
            <span
              class="badge"
              :class="p.allowed ? 'badge-success' : 'badge-danger'"
              :data-testid="`admin-inspect-${p.id}`"
            >
              {{ p.allowed ? 'allowed' : 'denied' }}
            </span>
          </div>
          <div class="list-item-subtitle">
            {{ REASONS[p.reason] ?? p.reason
            }}<template v-if="p.matched"> · {{ p.matched.effect }} · group {{ p.matched.group_name }}</template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0;
}
.resolution-line {
  margin: var(--space-2, 8px) 0 var(--space-3, 12px);
}
.badge-success {
  background: var(--color-success, #059669);
  color: #fff;
}
.badge-danger {
  background: var(--color-danger, #b91c1c);
  color: #fff;
}
</style>
