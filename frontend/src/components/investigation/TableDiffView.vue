<script setup lang="ts">
/** Renders a `TableDiff` (05 §3): counts, rows only on one side, rows whose shared columns changed. */
import type { TableDiff } from '@/types/investigation';

defineProps<{ diff: TableDiff }>();
const cell = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
</script>

<template>
  <div class="diff" data-testid="table-diff">
    <p class="summary" data-testid="table-diff-summary">
      <strong>{{ diff.left.title }}</strong> v{{ diff.left.version }} × <strong>{{ diff.right.title }}</strong> v{{ diff.right.version }}
      · key <code>{{ diff.key_column }}</code>
      · {{ diff.counts.same }} same · {{ diff.counts.changed }} changed · {{ diff.counts.only_left }} only on the left · {{ diff.counts.only_right }} only on the right
      <span v-if="diff.truncated" class="muted"> · lists cut at 500</span>
    </p>

    <section v-if="diff.changed.length">
      <h4>Changed</h4>
      <table class="t">
        <thead><tr><th>{{ diff.key_column }}</th><th>column</th><th>before</th><th>after</th></tr></thead>
        <tbody>
          <template v-for="row in diff.changed" :key="row.key">
            <tr v-for="(f, col) in row.fields" :key="`${row.key}-${col}`">
              <td>{{ row.key }}</td><td>{{ col }}</td><td class="before">{{ cell(f.left) }}</td><td class="after">{{ cell(f.right) }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <section v-for="side in (['only_left', 'only_right'] as const)" :key="side">
      <template v-if="diff[side].length">
        <h4>Only in {{ side === 'only_left' ? diff.left.title : diff.right.title }}</h4>
        <table class="t">
          <thead><tr><th v-for="c in diff.columns[side === 'only_left' ? 'left' : 'right']" :key="c">{{ c }}</th></tr></thead>
          <tbody>
            <tr v-for="(row, i) in diff[side].slice(0, 100)" :key="i"><td v-for="(v, j) in row" :key="j">{{ cell(v) }}</td></tr>
          </tbody>
        </table>
      </template>
    </section>
  </div>
</template>

<style scoped>
.diff {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}

.summary {
  margin: 0;
}

h4 {
  margin: 0 0 4px;
  font-size: 12px;
}

.t {
  width: 100%;
  border-collapse: collapse;
}

.t th,
.t td {
  padding: 2px 6px;
  border-bottom: 1px solid var(--border-color);
  text-align: left;
  white-space: nowrap;
}

.before {
  color: var(--color-error);
}

.after {
  color: #15803d;
}

.muted {
  color: var(--text-muted);
}
</style>
