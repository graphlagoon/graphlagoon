<script setup lang="ts">
/**
 * A table seen as a chart (06 §2b AQ2): line or bars over the `x` column, one
 * series per numeric column (TPV and chargebacks by day, exposure by company).
 * Plain SVG, no chart library; rows keep the table's order. Cells that are not
 * numbers are gaps.
 */
import { computed } from 'vue';
import type { TableChartSpec } from '@/types/investigation';

const props = defineProps<{ columns: string[]; rows: unknown[][]; chart: TableChartSpec }>();

const W = 600;
const H = 240;
const PAD = { left: 56, right: 12, top: 12, bottom: 40 };
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4b5563'];

const xi = computed(() => props.columns.indexOf(props.chart.x));
const series = computed(() =>
  props.chart.series
    .map((name) => ({ name, i: props.columns.indexOf(name) }))
    .filter((s) => s.i >= 0)
    .map((s, k) => ({ ...s, color: COLORS[k % COLORS.length] })),
);
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const labels = computed(() => props.rows.map((r) => String(xi.value >= 0 ? r[xi.value] ?? '' : '')));
const values = computed(() => series.value.map((s) => props.rows.map((r) => num(r[s.i]))));
const domain = computed(() => {
  const all = values.value.flat().filter((v): v is number => v !== null);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  return { min, max: max === min ? min + 1 : max };
});
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;
const n = computed(() => Math.max(props.rows.length, 1));
const band = computed(() => plotW / n.value);
const xAt = (i: number) => PAD.left + band.value * (i + 0.5);
const yAt = (v: number) => PAD.top + plotH * (1 - (v - domain.value.min) / (domain.value.max - domain.value.min));
const ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((f) => domain.value.min + f * (domain.value.max - domain.value.min)));
/** At most ~10 x labels. */
const every = computed(() => Math.max(1, Math.ceil(n.value / 10)));
const fmt = (v: number) => new Intl.NumberFormat(undefined, { notation: Math.abs(v) >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(v);

/** Polyline segments, broken where a value is missing. */
const lines = computed(() =>
  values.value.map((vals) => {
    const parts: string[][] = [[]];
    vals.forEach((v, i) => (v === null ? parts.push([]) : parts[parts.length - 1].push(`${xAt(i)},${yAt(v)}`)));
    return parts.filter((p) => p.length).map((p) => p.join(' '));
  }),
);
const barW = computed(() => (band.value * 0.8) / Math.max(series.value.length, 1));
</script>

<template>
  <figure class="table-chart" data-testid="table-chart" :data-type="chart.type">
    <svg :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="`${chart.type} chart of ${chart.series.join(', ')} by ${chart.x}`">
      <g class="grid">
        <g v-for="t in ticks" :key="t">
          <line :x1="PAD.left" :x2="W - PAD.right" :y1="yAt(t)" :y2="yAt(t)" />
          <text :x="PAD.left - 6" :y="yAt(t) + 4" text-anchor="end">{{ fmt(t) }}</text>
        </g>
      </g>
      <g class="x-labels">
        <text v-for="(l, i) in labels" v-show="i % every === 0" :key="i" :x="xAt(i)" :y="H - PAD.bottom + 16" text-anchor="middle">{{ l.length > 12 ? `${l.slice(0, 11)}…` : l }}</text>
      </g>
      <template v-if="chart.type === 'bar'">
        <g v-for="(s, k) in series" :key="s.name" :fill="s.color" :data-testid="`chart-series-${s.name}`">
          <template v-for="(v, i) in values[k]" :key="i">
            <rect
              v-if="v !== null"
              :x="xAt(i) - (band * 0.8) / 2 + k * barW"
              :y="Math.min(yAt(v), yAt(0))"
              :width="Math.max(barW - 1, 1)"
              :height="Math.abs(yAt(0) - yAt(v))"
            ><title>{{ s.name }} · {{ labels[i] }}: {{ fmt(v) }}</title></rect>
          </template>
        </g>
      </template>
      <template v-else>
        <g v-for="(s, k) in series" :key="s.name" :data-testid="`chart-series-${s.name}`">
          <polyline v-for="(p, j) in lines[k]" :key="j" :points="p" fill="none" :stroke="s.color" stroke-width="2" />
          <template v-for="(v, i) in values[k]" :key="i">
            <circle v-if="v !== null" :cx="xAt(i)" :cy="yAt(v)" r="2.5" :fill="s.color"><title>{{ s.name }} · {{ labels[i] }}: {{ fmt(v) }}</title></circle>
          </template>
        </g>
      </template>
      <line class="axis" :x1="PAD.left" :x2="W - PAD.right" :y1="yAt(0)" :y2="yAt(0)" />
    </svg>
    <figcaption class="legend">
      <span v-for="s in series" :key="s.name"><i :style="{ background: s.color }"></i>{{ s.name }}</span>
      <span class="muted">by {{ chart.x }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.table-chart {
  margin: 0;
}

svg {
  width: 100%;
  height: auto;
  font-size: 10px;
}

.grid line {
  stroke: var(--border-color);
  stroke-width: 1;
}

.grid text,
.x-labels text {
  fill: var(--text-muted);
}

.axis {
  stroke: var(--text-muted);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
}

.legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  border-radius: 2px;
}

.muted {
  color: var(--text-muted);
}
</style>
