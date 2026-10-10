<script setup lang="ts">
/**
 * Renders the active analysis item (05 §3 "Resultado = item") from the content of
 * its latest version: trace, paths, typologies, Vínculos or a metrics table.
 * Pinning freezes that version as evidence.
 */
import { computed, ref, watch } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import { useCaseAnalyses, type LinksContent, type MetricsContent, type PathsContent, type TraceContent, type TypologiesContent } from '@/composables/useCaseAnalyses';
import { getErrorMessage } from '@/utils/errorMessage';
import TraceResultPanel, { type TraceView } from '@/components/investigation/TraceResultPanel.vue';
import PathBar from '@/components/investigation/PathBar.vue';
import TypologyBadgesPanel from '@/components/investigation/TypologyBadgesPanel.vue';
import type { CaseItem } from '@/types/investigation';

type Content = TraceContent | PathsContent | TypologiesContent | LinksContent | MetricsContent;

const props = defineProps<{ item: CaseItem; canEdit: boolean; traceView: TraceView; focus: [number, number] | null }>();
const emit = defineEmits<{ close: []; rerun: [tool: string]; 'update:traceView': [view: TraceView] }>();

const store = useInvestigationStore();
const graph = useGraphStore();
const toast = useToast();
const { nameOf } = useCaseAnalyses();

const loading = ref(false);
const content = computed(() => store.contents[`${props.item.id}:${props.item.current_version}`] as Content | undefined);

watch(
  () => `${props.item.id}:${props.item.current_version}`,
  async () => {
    if (content.value !== undefined) return;
    loading.value = true;
    try {
      await store.loadItemJson(props.item);
    } catch (e) {
      toast.error(getErrorMessage(e, 'Failed to load the analysis'));
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

const tool = computed(() => String(props.item.provenance?.tool ?? content.value?.tool ?? ''));
const pinned = computed(() => props.item.pinned.some((v) => v.version === props.item.current_version));

async function pin() {
  try {
    const v = await store.pinItem(props.item.id);
    if (v) toast.success(`Evidence saved · hash ${v.sha256.slice(0, 8)}`);
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to pin the version'));
  }
}

function selectLinked(c: LinksContent) {
  graph.selectedNodeIds = new Set(c.pairs.flatMap((p) => [p.left, p.right]));
  graph.selectedEdgeIds = new Set();
}

const metricsPreview = computed(() => (content.value?.tool === 'metrics' ? (content.value as MetricsContent).rows.slice(0, 50) : []));
</script>

<template>
  <div class="result" data-testid="analysis-result">
    <header>
      <strong data-testid="analysis-result-title">{{ item.title }}</strong>
      <span class="muted">v{{ item.current_version }} · {{ item.author_kind === 'agent' ? 'agent · ' : '' }}{{ item.author_email }}</span>
      <span class="muted" v-if="pinned">📌 pinned</span>
      <span class="actions">
        <button v-if="tool !== 'trace'" class="btn btn-outline btn-sm" :disabled="!canEdit" data-testid="analysis-rerun" @click="emit('rerun', tool)">Run again…</button>
        <button v-if="tool !== 'trace'" class="btn btn-primary btn-sm" :disabled="!canEdit || pinned" data-testid="analysis-pin" @click="pin">{{ pinned ? 'Pinned' : 'Pin as evidence' }}</button>
        <button class="btn btn-outline btn-sm" data-testid="analysis-close" @click="emit('close')">Close</button>
      </span>
    </header>

    <p v-if="loading || !content" class="muted">Loading the result…</p>
    <template v-else>
      <TraceResultPanel
        v-if="content.tool === 'trace'"
        :content="content"
        :name-of="nameOf"
        :view="traceView"
        :focus="focus"
        :can-edit="canEdit"
        :pinned="pinned"
        @update:view="emit('update:traceView', $event)"
        @pin="pin"
        @rerun="emit('rerun', 'trace')"
      />
      <PathBar v-else-if="content.tool === 'paths'" :content="content" :name-of="nameOf" />
      <TypologyBadgesPanel v-else-if="content.tool === 'typologies'" :results="content.results" :can-edit="canEdit" />
      <div v-else-if="content.tool === 'links'" class="links" data-testid="links-result">
        <p>
          <strong>{{ content.pairs.length }}</strong> {{ content.pairs.length === 1 ? 'pair shares' : 'pairs share' }}
          {{ content.params.attributes.join(', ') }} (min {{ content.params.minShared ?? 1 }}<template v-if="content.params.maxEntities">, values shared by ≤ {{ content.params.maxEntities }}</template>).
          The <code>compartilha_*</code> edges are on the canvas as the layer “{{ item.title }}”.
        </p>
        <button class="btn btn-outline btn-sm" :disabled="!content.pairs.length" data-testid="links-select" @click="selectLinked(content)">Select the linked entities</button>
        <ul class="pairs">
          <li v-for="p in content.pairs.slice(0, 30)" :key="`${p.left}|${p.right}`" :data-testid="`link-pair`">
            <b>{{ nameOf(p.left) }}</b> ↔ <b>{{ nameOf(p.right) }}</b> <span class="muted">· {{ p.shared.join(', ') }}</span>
          </li>
        </ul>
      </div>
      <div v-else-if="content.tool === 'metrics'" class="metrics">
        <table>
          <thead><tr><th v-for="c in content.columns" :key="c">{{ c }}</th></tr></thead>
          <tbody>
            <tr v-for="r in metricsPreview" :key="String(r.node_id)">
              <td v-for="c in content.columns" :key="c">{{ typeof r[c] === 'number' ? (r[c] as number).toFixed(3).replace(/\.?0+$/, '') : r[c] }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="content.rows.length > 50" class="muted">first 50 of {{ content.rows.length }} rows</p>
      </div>
      <p v-else class="muted">This item has no renderer; open it as a table.</p>
    </template>
  </div>
</template>

<style scoped>
.result {
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-size: 13px;
}

header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.muted {
  color: var(--text-muted);
}

.links {
  padding: 8px 12px;
}

.pairs {
  columns: 2;
  margin: 8px 0 0;
  padding-left: 18px;
}

.metrics {
  padding: 8px 12px;
  overflow: auto;
}

table {
  border-collapse: collapse;
  font-size: 12px;
}

th,
td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--color-border-subtle);
  text-align: left;
  white-space: nowrap;
}
</style>
