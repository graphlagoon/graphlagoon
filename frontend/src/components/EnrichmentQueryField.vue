<script setup lang="ts">
/**
 * The enrichment query of one authorized table in the context form: the author's SELECT over
 * the loaded graph (`graph_edges`, `graph_nodes`) and the context's authorized tables,
 * returning `edge_id` (or `node_id`) and the columns that become edge (or node) properties.
 */
const sql = defineModel<string>('sql', { required: true });
const target = defineModel<'edges' | 'nodes'>('target', { required: true });
const run = defineModel<'auto' | 'manual'>('run', { required: true });
const overwrite = defineModel<boolean>('overwrite', { required: true });
const nodeProps = defineModel<boolean>('nodeProps', { required: true });
defineProps<{ tables: string[] }>();

const EXAMPLES = {
  edges: `SELECT e.edge_id, t.risk_score, c.channel
FROM graph_edges e
JOIN main.fraud.transactions t ON t.tx_id = e.props['tx_id']
JOIN main.fraud.channels c ON c.id = t.channel_id`,
  nodes: `SELECT n.node_id, count(*) AS tx_90d, sum(l.amount) AS volume_90d
FROM graph_nodes n
JOIN main.fraud.ledger l ON l.account_id = n.node_id
GROUP BY n.node_id`,
};
</script>

<template>
  <div class="enrichment-query" data-testid="enrichment-query">
    <p class="contract">
      Read the graph on screen from <code>graph_edges</code>(edge_id, src, dst, relationship_type, props) and
      <code>graph_nodes</code>(node_id, node_type, props), where <code>props</code> is a string map
      (<code>e.props['tx_id']</code>). Join any authorized table:
      <span v-if="tables.length">{{ tables.join(', ') }}</span><span v-else>none yet</span>.
      Return <code>{{ target === 'nodes' ? 'node_id' : 'edge_id' }}</code>, one row per
      {{ target === 'nodes' ? 'node' : 'edge' }}; every other column becomes
      {{ target === 'nodes' ? 'a node' : 'an edge' }} property.
    </p>
    <textarea
      v-model="sql"
      rows="5"
      class="form-control mono"
      spellcheck="false"
      :placeholder="EXAMPLES[target]"
      data-testid="enrichment-query-sql"
    ></textarea>
    <div class="options">
      <label>
        Enriches
        <select v-model="target" class="form-control" data-testid="enrichment-query-target">
          <option value="edges">the edges</option>
          <option value="nodes">the nodes</option>
        </select>
      </label>
      <label>
        Runs
        <select v-model="run" class="form-control" data-testid="enrichment-query-run">
          <option value="auto">after every query and expand</option>
          <option value="manual">only from Your data</option>
        </select>
      </label>
      <label class="check">
        <input v-model="overwrite" type="checkbox" data-testid="enrichment-query-overwrite" />
        Replace values {{ target === 'nodes' ? 'the node' : 'the edge' }} already has
      </label>
      <label class="check">
        <input v-model="nodeProps" type="checkbox" data-testid="enrichment-query-node-props" />
        Send node properties (otherwise id and type only)
      </label>
    </div>
  </div>
</template>

<style scoped>
.enrichment-query {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.contract {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-secondary, #666);
}
.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.8rem;
}
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  font-size: 0.85rem;
}
.options label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.options select {
  width: auto;
}
</style>
