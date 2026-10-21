<script setup lang="ts">
/**
 * Shows any item version the browser can render (table, text, image, PDF, HTML)
 * and downloads the rest. Case data never runs in the app's origin: HTML goes
 * into a sandboxed iframe, markdown is shown as text, images and PDFs as blobs.
 * A table may be seen as a chart (06 P5); the chart is the item's view
 * (`state.chart`), saved without a new version.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { api } from '@/services/api';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { downloadBlob } from '@/utils/portableExport';
import { buildPreview, itemFileName, PREVIEW_MAX_BYTES, type ItemPreview } from '@/utils/itemPreview';
import { useInvestigationStore } from '@/stores/investigation';
import TableChart from '@/components/investigation/TableChart.vue';
import type { CaseItem, TableChartSpec } from '@/types/investigation';

const props = defineProps<{ item: CaseItem; investigationId: string }>();

const toast = useToast();
const busy = ref(false);
const preview = ref<ItemPreview | null>(null);
const blobUrl = ref<string | null>(null);
let bytes: ArrayBuffer | null = null;

const contentType = computed(() => props.item.latest?.content_type ?? '');
const tooBig = computed(() => (props.item.latest?.size_bytes ?? 0) > PREVIEW_MAX_BYTES);

async function load(): Promise<ArrayBuffer> {
  bytes ??= await api.getInvestigationItemContent(props.investigationId, props.item.id);
  return bytes;
}

// --- a table as a chart --------------------------------------------------------
const store = useInvestigationStore();
const asChart = ref(false);
const chart = ref<TableChartSpec | null>(null);
const canSaveView = computed(() => !!store.current?.has_write_access && store.current.status !== 'closed' && props.item.kind === 'table');
const tableOf = computed(() => (preview.value?.kind === 'table' ? preview.value : null));
const numericColumns = computed(() => {
  const t = tableOf.value;
  if (!t) return [];
  return t.columns.filter((_, j) => t.rows.some((r) => r[j] !== null && r[j] !== '' && Number.isFinite(Number(r[j]))));
});
/** The saved chart, else the first column over the numeric ones. */
function startChart() {
  const t = tableOf.value!;
  const saved = props.item.state?.chart;
  const x = saved && t.columns.includes(saved.x) ? saved.x : t.columns[0];
  chart.value = saved ? { ...saved, series: saved.series.filter((s) => t.columns.includes(s)) } : { type: 'line', x, series: numericColumns.value.filter((c) => c !== x).slice(0, 3) };
}
function showChart(on: boolean) {
  asChart.value = on;
  if (on && !chart.value) startChart();
}
function toggleSeries(col: string) {
  if (!chart.value) return;
  const has = chart.value.series.includes(col);
  chart.value = { ...chart.value, series: has ? chart.value.series.filter((s) => s !== col) : [...chart.value.series, col] };
}
async function saveView(clear = false) {
  try {
    await store.updateItem(props.item.id, { state: { chart: clear ? null : chart.value } });
    toast.success(clear ? 'The table shows as a table again' : 'Saved: the table opens as this chart');
    if (clear) asChart.value = false;
  } catch (e) {
    toast.error(getErrorMessage(e, 'Could not save the view'));
  }
}

async function open() {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await load();
    preview.value = buildPreview(data, contentType.value);
    if (preview.value.kind === 'table' && props.item.state?.chart) showChart(true);
    if (preview.value.kind === 'image' || preview.value.kind === 'pdf') {
      revokeBlob();
      blobUrl.value = URL.createObjectURL(new Blob([data], { type: contentType.value }));
    }
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to read the item'));
  } finally {
    busy.value = false;
  }
}

async function download() {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await load();
    downloadBlob(itemFileName(props.item), new Blob([data], { type: contentType.value || 'application/octet-stream' }));
  } catch (e) {
    toast.error(getErrorMessage(e, 'Failed to download the item'));
  } finally {
    busy.value = false;
  }
}

function revokeBlob() {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
  blobUrl.value = null;
}

function closePreview() {
  preview.value = null;
  revokeBlob();
}

onBeforeUnmount(revokeBlob);
</script>

<template>
  <div class="item-preview">
    <div class="row-actions">
      <button v-if="!preview && !tooBig" class="btn btn-outline btn-sm" :disabled="busy" data-testid="item-preview-open" @click="open">
        {{ busy ? 'Loading…' : 'Preview' }}
      </button>
      <button v-else-if="preview" class="btn btn-outline btn-sm" data-testid="item-preview-close" @click="closePreview">Close preview</button>
      <button class="btn btn-outline btn-sm" :disabled="busy" data-testid="item-download" @click="download">Download</button>
    </div>
    <p v-if="tooBig && !preview" class="muted">File too large to preview here; download it to open.</p>

    <div v-if="preview" class="body" data-testid="item-preview" :data-kind="preview.kind">
      <template v-if="preview.kind === 'table'">
        <div class="view-toggle">
          <button class="btn btn-outline btn-sm" :class="{ on: !asChart }" data-testid="item-view-table" @click="showChart(false)">Table</button>
          <button class="btn btn-outline btn-sm" :class="{ on: asChart }" :disabled="!numericColumns.length" data-testid="item-view-chart" @click="showChart(true)">Chart</button>
        </div>
        <template v-if="asChart && chart">
          <div class="chart-settings" data-testid="chart-settings">
            <select v-model="chart.type" aria-label="Chart type" data-testid="chart-type"><option value="line">line</option><option value="bar">bars</option></select>
            <label>x <select v-model="chart.x" data-testid="chart-x"><option v-for="c in preview.columns" :key="c" :value="c">{{ c }}</option></select></label>
            <label v-for="c in numericColumns.filter((c) => c !== chart!.x)" :key="c" class="series">
              <input type="checkbox" :checked="chart.series.includes(c)" :data-testid="`chart-series-toggle-${c}`" @change="toggleSeries(c)" /> {{ c }}
            </label>
            <button v-if="canSaveView" class="btn btn-outline btn-sm" :disabled="!chart.series.length" data-testid="chart-save" @click="saveView()">Save as the item's view</button>
            <button v-if="canSaveView && item.state?.chart" class="link-btn" data-testid="chart-clear" @click="saveView(true)">back to table</button>
          </div>
          <TableChart v-if="chart.series.length" :columns="preview.columns" :rows="preview.rows" :chart="chart" />
          <p v-else class="muted">Pick at least one numeric column.</p>
        </template>
        <p v-if="!asChart" class="muted">
          {{ preview.total }} {{ preview.total === 1 ? 'row' : 'rows' }}<template v-if="preview.total > preview.rows.length"> · showing the first {{ preview.rows.length }}</template>
        </p>
        <div v-if="!asChart && preview.columns.length" class="scroll">
          <table>
            <thead><tr><th v-for="c in preview.columns" :key="c">{{ c }}</th></tr></thead>
            <tbody><tr v-for="(r, i) in preview.rows" :key="i"><td v-for="(_, j) in preview.columns" :key="j">{{ r[j] }}</td></tr></tbody>
          </table>
        </div>
      </template>
      <template v-else-if="preview.kind === 'text'">
        <pre class="scroll text">{{ preview.text }}</pre>
        <p v-if="preview.truncated" class="muted">Text cut; download the file to see all of it.</p>
      </template>
      <img v-else-if="preview.kind === 'image' && blobUrl" :src="blobUrl" :alt="item.title" class="media" />
      <iframe v-else-if="preview.kind === 'pdf' && blobUrl" :src="blobUrl" :title="item.title" class="frame" />
      <iframe v-else-if="preview.kind === 'html'" :srcdoc="preview.html" sandbox="" :title="item.title" class="frame" />
      <p v-else class="muted">No preview for {{ contentType || 'this format' }}; use Download.</p>
    </div>
  </div>
</template>

<style scoped>
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.body {
  margin-top: 6px;
}

.view-toggle,
.chart-settings {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
  font-size: 12px;
}

.view-toggle .on {
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.link-btn {
  border: 0;
  background: none;
  color: var(--color-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.scroll {
  max-height: 320px;
  overflow: auto;
}

.scroll table {
  border-collapse: collapse;
  font-size: 12px;
}

.scroll th,
.scroll td {
  padding: 2px 6px;
  border-bottom: 1px solid var(--color-border-subtle);
  text-align: left;
  white-space: nowrap;
}

.scroll th {
  position: sticky;
  top: 0;
  background: var(--color-surface);
}

.text {
  margin: 0;
  padding: 8px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--color-surface-sunken, var(--color-surface));
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
}

.media {
  max-width: 100%;
  border: 1px solid var(--color-border-subtle);
}

.frame {
  width: 100%;
  height: 360px;
  border: 1px solid var(--color-border-subtle);
  background: #fff;
}
</style>
