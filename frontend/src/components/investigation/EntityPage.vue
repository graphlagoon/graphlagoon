<script setup lang="ts">
/**
 * Everything about one entity (05 §3), as a drawer over the case: label, type and
 * sources, role · tags · groups, every property, the items that cite it, its
 * notes, enrichment and the journal lines that mention it.
 */
import { computed } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { caseNodeLabel, shortId } from '@/utils/caseLabels';
import { formatDate } from '@/utils/format';
import { describeEvent } from '@/utils/investigationEvents';
import { baseSourceId, nodeSourceIds, type UnifiedNode } from '@/utils/unifyGraph';
import EnrichmentTab from '@/components/investigation/EnrichmentTab.vue';
import SeenInOtherCases from '@/components/investigation/SeenInOtherCases.vue';
import type { CaseItem } from '@/types/investigation';

const props = defineProps<{ node: UnifiedNode; canEdit: boolean }>();
const emit = defineEmits<{ close: []; 'select-item': [item: CaseItem] }>();

const store = useInvestigationStore();

const id = computed(() => props.node.node_id);
const title = computed(() => caseNodeLabel(props.node, { templates: store.labelTemplates }));
const sources = computed(() => nodeSourceIds(props.node).map((s) => ({ id: s, title: store.itemTitle(baseSourceId(s)), color: store.sourceColors[s] })));
const role = computed(() => store.roles[id.value]);
const tags = computed(() => store.entityTags.get(id.value) ?? []);
const groups = computed(() => store.groups.filter((g) => g.targets.includes(id.value)));
const properties = computed(() => Object.entries(props.node.properties ?? {}));
const annotations = computed(() => store.annotations.filter((a) => a.targets.includes(id.value) && !['role', 'tag', 'group'].includes(a.kind)));
const items = computed(() => {
  const srcs = new Set(nodeSourceIds(props.node));
  return store.items.filter((i) => !i.deleted_at && (i.anchor?.entity_ids?.includes(id.value) || srcs.has(i.id) || JSON.stringify(i.provenance?.params ?? {}).includes(id.value)));
});
const events = computed(() => store.events.filter((e) => JSON.stringify(e.payload).includes(id.value)).reverse());
const neighbours = computed(() => {
  const out = new Map<string, number>();
  for (const e of store.unified.edges) {
    const other = e.src === id.value ? e.dst : e.dst === id.value ? e.src : null;
    if (other) out.set(e.relationship_type, (out.get(e.relationship_type) ?? 0) + 1);
  }
  return [...out.entries()];
});
const nameOf = (nid: string) => {
  const n = store.unified.nodes.find((x) => x.node_id === nid);
  return n ? caseNodeLabel(n, { templates: store.labelTemplates }) : shortId(nid);
};
const fmt = (iso?: string | null) => formatDate(iso);
</script>

<template>
  <div class="drawer-overlay" @click.self="emit('close')">
    <aside class="entity-page" role="dialog" aria-modal="true" :aria-label="title" data-testid="entity-page">
      <header>
        <div>
          <div class="muted">{{ node.node_type }} · {{ shortId(node.node_id) }}</div>
          <h2 data-testid="entity-page-title">{{ title }}</h2>
          <div class="chips">
            <span v-for="s in sources" :key="s.id" class="chip" :style="{ borderColor: s.color, color: s.color }">{{ s.title }}</span>
            <span v-if="role" class="chip plain">role: {{ role }}</span>
            <span v-for="t in tags" :key="t" class="chip plain">#{{ t }}</span>
            <span v-for="g in groups" :key="g.id" class="chip plain" :style="{ borderColor: g.color }">{{ g.name }}</span>
          </div>
          <SeenInOtherCases :uid="node.node_id" :current-id="store.current?.id ?? null" />
        </div>
        <button class="modal-close" aria-label="Close" data-testid="entity-page-close" @click="emit('close')">&times;</button>
      </header>

      <div class="cols">
        <section>
          <h3>Data</h3>
          <dl class="props">
            <template v-for="[k, v] in properties" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
          </dl>
          <h3>Relations</h3>
          <ul class="plain">
            <li v-for="[t, n] in neighbours" :key="t">{{ t }} <span class="muted">· {{ n }}</span></li>
            <li v-if="!neighbours.length" class="muted">No edges on the canvas.</li>
          </ul>
          <h3>Annotations</h3>
          <ul class="plain">
            <li v-for="a in annotations" :key="a.id">
              {{ a.kind }}<template v-if="a.kind === 'same_as'"> {{ nameOf(a.targets.find((t) => t !== id) ?? '') }}</template><template v-else-if="a.value?.norm_ref"> {{ a.value.norm_ref }}</template>
              <span class="muted"> · {{ a.status }} · {{ a.author_kind === 'agent' ? 'agent' : a.author_email }}</span>
            </li>
            <li v-if="!annotations.length" class="muted">None.</li>
          </ul>
        </section>
        <section>
          <h3>Items that cite it <span class="muted">{{ items.length }}</span></h3>
          <ul class="plain" data-testid="entity-page-items">
            <li v-for="i in items" :key="i.id"><button class="link-btn" @click="emit('select-item', i)">{{ i.title }}</button> <span class="muted">{{ i.kind }}/{{ i.subkind }} · {{ i.author_kind === 'agent' ? 'agent' : i.author_email }}</span></li>
            <li v-if="!items.length" class="muted">No item cites this entity yet.</li>
          </ul>
          <h3>Enrichment</h3>
          <EnrichmentTab :node="node" :can-edit="canEdit" />
          <h3>Journal</h3>
          <ul class="plain" data-testid="entity-page-events">
            <li v-for="e in events.slice(0, 20)" :key="e.id"><span class="muted">{{ fmt(e.at) }}</span> {{ describeEvent(e, nameOf) }}</li>
            <li v-if="!events.length" class="muted">Nothing recorded about this entity.</li>
          </ul>
        </section>
      </div>
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

.entity-page {
  width: min(760px, 95vw);
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px 24px;
  background: var(--color-surface);
  box-shadow: var(--shadow-lg, -4px 0 16px rgba(0, 0, 0, 0.15));
  font-size: 13px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

h2 {
  margin: 2px 0 8px;
  font-size: 18px;
  word-break: break-all;
}

h3 {
  margin: 14px 0 6px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 2px 8px;
  border: 1.5px solid;
  border-radius: var(--radius-pill);
  font-size: 12px;
}

.chip.plain {
  border-color: var(--border-color);
  color: var(--text-color);
}

.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 20px;
}

.props {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 12px;
  margin: 0;
}

.props dt {
  color: var(--text-muted);
}

.props dd {
  margin: 0;
  word-break: break-word;
}

.plain {
  margin: 0;
  padding-left: 16px;
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--color-primary);
  cursor: pointer;
}
</style>
