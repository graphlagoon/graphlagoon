<script setup lang="ts">
/**
 * The Enrichment Tables toolbar of the context form: import entries from YAML (pasted or a
 * file), export the current ones, and ask an AI to write them from what the context declares.
 */
import { computed, ref } from 'vue';
import { Bot, FileUp, FileDown } from 'lucide-vue-next';
import type { EnrichmentTable } from '@/types/graph';
import { enrichmentTablesToYaml, mergeEnrichmentTables, parseEnrichmentTablesYaml } from '@/utils/enrichmentTablesYaml';
import { buildEnrichmentTablesSkill, type EnrichmentTablesSkillInput } from '@/utils/enrichmentTablesSkill';
import EnrichmentTablesSkillModal from '@/components/EnrichmentTablesSkillModal.vue';

const props = defineProps<{
  /** The complete entries in the form now. */
  tables: EnrichmentTable[];
  skill: Omit<EnrichmentTablesSkillInput, 'currentYaml'>;
}>();
const emit = defineEmits<{ import: [EnrichmentTable[]]; add: [] }>();

const open = ref(false);
const text = ref('');
const errors = ref<string[]>([]);
const done = ref<string | null>(null);
const asking = ref(false);
const skillText = computed(() =>
  buildEnrichmentTablesSkill({ ...props.skill, currentYaml: props.tables.length ? enrichmentTablesToYaml(props.tables) : '' }),
);

function toggle() {
  open.value = !open.value;
  errors.value = [];
  done.value = null;
}

function exportYaml() {
  text.value = props.tables.length ? enrichmentTablesToYaml(props.tables) : '';
  open.value = true;
  errors.value = [];
  done.value = props.tables.length ? 'The current entries are below: edit them and import, or copy them.' : 'Nothing to export yet.';
  void navigator.clipboard?.writeText(text.value).catch(() => undefined);
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) text.value = await file.text();
}

function apply() {
  const parsed = parseEnrichmentTablesYaml(text.value);
  errors.value = parsed.errors;
  done.value = null;
  if (!parsed.tables.length) return;
  const { added, replaced } = mergeEnrichmentTables(props.tables, parsed.tables);
  emit('import', parsed.tables);
  done.value =
    `${added} added, ${replaced} replaced.` +
    (parsed.errors.length ? ` ${parsed.errors.length} skipped (below).` : '') +
    ' Review them, then save the context.';
}
</script>

<template>
  <div class="tools">
    <button type="button" class="btn btn-sm btn-outline" data-testid="enrichment-add" @click="emit('add')">+ Attach table</button>
    <button type="button" class="btn btn-sm btn-outline" :aria-expanded="open" data-testid="enrichment-import-toggle" @click="toggle">
      <FileUp :size="14" /> Import YAML
    </button>
    <button type="button" class="btn btn-sm btn-outline" data-testid="enrichment-export" @click="exportYaml">
      <FileDown :size="14" /> Export YAML
    </button>
    <button
      type="button"
      class="btn btn-sm btn-outline"
      title="Ask an AI to write the enrichment tables for this context"
      data-testid="enrichment-ask-ai"
      @click="asking = true"
    >
      <Bot :size="14" /> Ask an AI
    </button>
  </div>
  <div v-if="open" class="import" data-testid="enrichment-import">
    <textarea
      v-model="text"
      rows="10"
      class="form-control mono"
      spellcheck="false"
      placeholder="enrichment_tables:&#10;  - name: tx_risk&#10;    label: Transaction risk&#10;    table: main.fraud.transactions&#10;    query:&#10;      target: edges&#10;      run: auto&#10;      sql: |&#10;        SELECT e.edge_id, t.risk FROM graph_edges e JOIN main.fraud.transactions t ON t.tx_id = e.props['tx_id']"
      data-testid="enrichment-import-text"
    ></textarea>
    <div class="import-actions">
      <label class="btn btn-sm btn-outline file-btn">
        Choose a file<input type="file" accept=".yaml,.yml,.json,text/yaml" data-testid="enrichment-import-file" @change="onFile" />
      </label>
      <button type="button" class="btn btn-sm btn-primary" :disabled="!text.trim()" data-testid="enrichment-import-apply" @click="apply">
        Import
      </button>
      <span class="muted">Entries with the same name are replaced; the others are added.</span>
    </div>
    <p v-if="done" class="done" data-testid="enrichment-import-done">{{ done }}</p>
    <ul v-if="errors.length" class="errors" data-testid="enrichment-import-errors">
      <li v-for="e in errors" :key="e">{{ e }}</li>
    </ul>
  </div>
  <EnrichmentTablesSkillModal v-if="asking" :text="skillText" @close="asking = false" />
</template>

<style scoped>
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tools .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.import {
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.8rem;
}
.import-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.file-btn input {
  display: none;
}
.muted {
  font-size: 0.8rem;
  color: var(--text-secondary, #666);
}
.done {
  margin: 0;
  font-size: 0.85rem;
}
.errors {
  margin: 0;
  padding-left: 18px;
  font-size: 0.8rem;
  color: var(--error-color, #c0392b);
}
</style>
