<script setup lang="ts">
/**
 * What one item version looks like once read (useItemContent): a table (or its
 * chart, 06 P5: the item's view `state.chart`, saved without a new version),
 * markdown through the escape-first renderer ("Raw" shows the source), text, a
 * raster image or PDF from a blob URL, HTML and SVG in a sandboxed iframe
 * (utils/htmlSandbox). `compact` fits the inspector; `full` fills the
 * full-screen viewer, with a row filter and image zoom.
 */
import { computed, nextTick, ref } from 'vue';
import { useInvestigationStore } from '@/stores/investigation';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import { renderMarkdown } from '@/utils/markdown';
import { sandboxHtml } from '@/utils/htmlSandbox';
import TableChart from '@/components/investigation/TableChart.vue';
import type { ItemPreview } from '@/utils/itemPreview';
import type { CaseItem, TableChartSpec } from '@/types/investigation';

const props = defineProps<{
  preview: ItemPreview;
  item: CaseItem;
  contentType: string;
  blobUrl: string | null;
  size: 'compact' | 'full';
}>();

const store = useInvestigationStore();
const toast = useToast();
const full = computed(() => props.size === 'full');
const isMarkdown = computed(() => props.contentType.startsWith('text/markdown'));
const raw = ref(false);
const sandboxed = computed(() => (props.preview.kind === 'html' ? sandboxHtml(props.preview.html) : null));

// --- a table: its rows, filtered in full size --------------------------------------
const tableOf = computed(() => (props.preview.kind === 'table' ? props.preview : null));
const filter = ref('');
const rowsShown = computed(() => {
  const t = tableOf.value;
  const q = filter.value.trim().toLowerCase();
  if (!t || !q) return t?.rows ?? [];
  return t.rows.filter((r) => r.some((cell) => cell !== null && cell !== undefined && String(cell).toLowerCase().includes(q)));
});

// --- a table as a chart -------------------------------------------------------------
const chart = ref<TableChartSpec | null>(null);
const asChart = ref(false);
const canSaveView = computed(() => !!store.current?.has_write_access && store.current.status !== 'closed' && props.item.kind === 'table');
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
if (tableOf.value && props.item.state?.chart) showChart(true);

// --- an image, zoomed and dragged in full size ----------------------------------------
const stage = ref<HTMLElement | null>(null);
const natural = ref<{ w: number; h: number } | null>(null);
/** null: fit the stage; else the scale of the natural size. */
const zoom = ref<number | null>(null);
const fitScale = computed(() => {
  const el = stage.value;
  const n = natural.value;
  if (!el || !n) return 1;
  return Math.min(el.clientWidth / n.w, el.clientHeight / n.h, 1);
});
const zoomLabel = computed(() => `${Math.round((zoom.value ?? fitScale.value) * 100)}%`);
const imageStyle = computed(() => (zoom.value === null || !natural.value ? {} : { width: `${natural.value.w * zoom.value}px`, maxWidth: 'none', maxHeight: 'none' }));

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement;
  natural.value = { w: img.naturalWidth, h: img.naturalHeight };
}
/** Zoom by `factor`, keeping the point under (x, y) of the stage where it is. */
async function zoomBy(factor: number, x?: number, y?: number) {
  const el = stage.value;
  if (!el || !natural.value) return;
  const before = zoom.value ?? fitScale.value;
  const next = Math.min(16, Math.max(0.05, before * factor));
  const px = x ?? el.clientWidth / 2;
  const py = y ?? el.clientHeight / 2;
  const left = el.scrollLeft;
  const top = el.scrollTop;
  zoom.value = next;
  await nextTick();
  el.scrollLeft = (left + px) * (next / before) - px;
  el.scrollTop = (top + py) * (next / before) - py;
}
function onWheel(e: WheelEvent) {
  if (!full.value) return; // the inspector scrolls past a compact image
  e.preventDefault();
  const rect = stage.value!.getBoundingClientRect();
  void zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
}
let drag: { x: number; y: number; left: number; top: number } | null = null;
function onPointerDown(e: PointerEvent) {
  if (zoom.value === null || !stage.value) return;
  drag = { x: e.clientX, y: e.clientY, left: stage.value.scrollLeft, top: stage.value.scrollTop };
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  if (!drag || !stage.value) return;
  stage.value.scrollLeft = drag.left - (e.clientX - drag.x);
  stage.value.scrollTop = drag.top - (e.clientY - drag.y);
}
function onPointerUp() {
  drag = null;
}
</script>

<template>
  <div class="preview-body" :class="size" data-testid="item-preview" :data-kind="preview.kind">
    <template v-if="preview.kind === 'table'">
      <div class="view-toggle">
        <button class="btn btn-outline btn-sm" :class="{ on: !asChart }" data-testid="item-view-table" @click="showChart(false)">Table</button>
        <button class="btn btn-outline btn-sm" :class="{ on: asChart }" :disabled="!numericColumns.length" data-testid="item-view-chart" @click="showChart(true)">Chart</button>
        <input v-if="full && !asChart" v-model="filter" class="form-control filter" placeholder="Filter rows…" data-testid="item-table-filter" />
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
      <template v-else>
        <p class="muted" data-testid="item-table-count">
          <template v-if="filter.trim()">{{ rowsShown.length }} of </template>{{ preview.total }} {{ preview.total === 1 ? 'row' : 'rows' }}<template v-if="preview.total > preview.rows.length"> · showing the first {{ preview.rows.length }}</template>
        </p>
        <div v-if="preview.columns.length" class="scroll grow">
          <table>
            <thead><tr><th v-for="c in preview.columns" :key="c">{{ c }}</th></tr></thead>
            <tbody><tr v-for="(r, i) in rowsShown" :key="i"><td v-for="(_, j) in preview.columns" :key="j">{{ r[j] }}</td></tr></tbody>
          </table>
        </div>
      </template>
    </template>

    <template v-else-if="preview.kind === 'text'">
      <template v-if="isMarkdown">
        <div class="view-toggle">
          <button class="btn btn-outline btn-sm" :class="{ on: !raw }" data-testid="item-view-rendered" @click="raw = false">Rendered</button>
          <button class="btn btn-outline btn-sm" :class="{ on: raw }" data-testid="item-view-raw" @click="raw = true">Raw</button>
        </div>
        <pre v-if="raw" class="scroll grow text">{{ preview.text }}</pre>
        <!-- v-html: escape-first renderer only (utils/markdown) -->
        <div v-else class="scroll grow" data-testid="item-markdown"><div class="case-markdown reading" v-html="renderMarkdown(preview.text)"></div></div>
      </template>
      <pre v-else class="scroll grow text">{{ preview.text }}</pre>
      <p v-if="preview.truncated" class="muted">Text cut; download the file to see all of it.</p>
    </template>

    <template v-else-if="preview.kind === 'image' && blobUrl">
      <div v-if="full" class="zoom-bar" data-testid="image-zoom">
        <button class="btn btn-outline btn-sm" :class="{ on: zoom === null }" data-testid="image-fit" @click="zoom = null">Fit</button>
        <button class="btn btn-outline btn-sm" :class="{ on: zoom === 1 }" data-testid="image-actual" @click="zoom = 1">100%</button>
        <button class="btn btn-outline btn-sm" aria-label="Zoom out" @click="zoomBy(1 / 1.25)">−</button>
        <button class="btn btn-outline btn-sm" aria-label="Zoom in" data-testid="image-zoom-in" @click="zoomBy(1.25)">+</button>
        <span class="muted" data-testid="image-zoom-level">{{ zoomLabel }}</span>
        <span class="muted">wheel to zoom · drag to move</span>
      </div>
      <div
        ref="stage"
        class="stage grow"
        :class="{ fit: zoom === null, panning: zoom !== null }"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <img :src="blobUrl" :alt="item.title" class="media" :style="imageStyle" draggable="false" data-testid="item-image" @load="onImageLoad" />
      </div>
    </template>
    <iframe v-else-if="preview.kind === 'pdf' && blobUrl" :src="blobUrl" :title="item.title" class="frame grow" />
    <iframe v-else-if="sandboxed" :srcdoc="sandboxed.srcdoc" :sandbox="sandboxed.sandbox" :title="item.title" class="frame grow" data-testid="item-html" />
    <p v-else class="muted">No preview for {{ contentType || 'this format' }}; use Download.</p>
  </div>
</template>

<style scoped>
.preview-body {
  margin-top: 6px;
}

.preview-body.full {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  margin-top: 0;
}

.full .grow {
  flex: 1;
  min-height: 0;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.view-toggle,
.chart-settings,
.zoom-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
  font-size: 12px;
}

.view-toggle .on,
.zoom-bar .on {
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.filter {
  width: 220px;
  margin-left: auto;
  padding: 2px 8px;
  font-size: 12px;
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

.full .scroll {
  max-height: none;
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

.full .text {
  font-size: 13px;
}

.full .reading {
  max-width: 860px;
  margin: 0 auto;
  padding: 8px 16px 24px;
  font-size: 14px;
  line-height: 1.6;
}

.media {
  max-width: 100%;
  border: 1px solid var(--color-border-subtle);
}

.full .stage {
  overflow: auto;
  background-color: #f4f4f5;
  background-image:
    linear-gradient(45deg, #e4e4e7 25%, transparent 25%),
    linear-gradient(-45deg, #e4e4e7 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #e4e4e7 75%),
    linear-gradient(-45deg, transparent 75%, #e4e4e7 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  border-radius: 4px;
}

.full .stage.fit {
  display: flex;
  align-items: center;
  justify-content: center;
}

.full .stage.fit .media {
  max-height: 100%;
  object-fit: contain;
}

.full .stage.panning {
  cursor: grab;
}

.full .stage .media {
  user-select: none;
}

.frame {
  width: 100%;
  height: 360px;
  border: 1px solid var(--color-border-subtle);
  background: #fff;
}

.full .frame {
  height: auto;
}
</style>
