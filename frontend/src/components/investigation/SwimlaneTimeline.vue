<script setup lang="ts">
/**
 * Swimlane timeline (T5, F3.5; generic in F4): a lane per entity, an arrow at each
 * dated edge and a band for how long the money sat in the account. With a trace
 * `result` the lanes follow its layers and the exits share one lane; without it
 * (the case timeline) the lanes are the entities with dated edges, busiest first.
 * Dragging selects a time window (a chip on the canvas); a click clears it.
 */
import { computed, ref } from 'vue';
import type { TraceResult } from '@/utils/trace';
import { traceColumns, type TraceFlow } from '@/utils/traceView';

const props = defineProps<{
  result?: TraceResult | null;
  /** Every traced flow (unfiltered); for the case timeline, every dated edge. */
  flows: TraceFlow[];
  nameOf: (id: string) => string;
  focus: [number, number] | null;
  /** Case timeline: how many lanes to show (busiest entities first). */
  maxLanes?: number;
}>();
const emit = defineEmits<{ 'update:focus': [value: [number, number] | null] }>();

const W = 900;
const LABEL_W = 110;
const RIGHT = 100;
const LANE_H = 26;
const TOP = 10;

const backward = computed(() => props.result?.method.direction === 'backward');
const cols = computed(() => (props.result ? traceColumns(props.result, props.flows, props.result.method.direction) : null));
const exitSet = computed(() => new Set(Object.keys(props.result?.exits ?? {})));
/** Accounts in column order, then one shared lane for the exits; or the busiest entities. */
const lanes = computed(() => {
  if (cols.value) return [...cols.value.columns.keys()].filter((id) => !exitSet.value.has(id));
  const count = new Map<string, number>();
  for (const f of props.flows) for (const id of [f.src, f.dst]) count.set(id, (count.get(id) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, props.maxLanes ?? 12).map(([id]) => id);
});
const exitLane = computed(() => (cols.value?.exits ? lanes.value.length : -1));
const laneCount = computed(() => lanes.value.length + (cols.value?.exits ? 1 : 0));
const height = computed(() => TOP + laneCount.value * LANE_H + 28);
const laneOf = (id: string) => (exitSet.value.has(id) ? exitLane.value : lanes.value.indexOf(id));
const laneY = (i: number) => TOP + i * LANE_H + LANE_H / 2;

const domain = computed<[number, number]>(() => {
  const ts = props.flows.map((f) => f.t);
  let [a, b] = ts.length ? [Math.min(...ts), Math.max(...ts)] : [0, 1];
  if (a === b) [a, b] = [a - 1_800_000, b + 1_800_000];
  const pad = (b - a) * 0.03;
  return [a - pad, b + pad];
});
const x = (t: number) => LABEL_W + ((t - domain.value[0]) / (domain.value[1] - domain.value[0])) * (W - LABEL_W - RIGHT);
const tAt = (px: number) => domain.value[0] + ((px - LABEL_W) / (W - LABEL_W - RIGHT)) * (domain.value[1] - domain.value[0]);

/** Real direction of a flow: a backward trace walked reversed edges. */
const real = (f: TraceFlow) => (backward.value ? { from: f.dst, to: f.src } : { from: f.src, to: f.dst });
const short = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

const laneSet = computed(() => new Set(lanes.value));
/** Flows whose ends both have a lane (the case timeline caps the lanes). */
const shown = computed(() => props.flows.filter((f) => (laneSet.value.has(f.src) || exitSet.value.has(f.src)) && (laneSet.value.has(f.dst) || exitSet.value.has(f.dst))));

const arrows = computed(() =>
  shown.value.map((f) => {
    const { from, to } = real(f);
    const y1 = laneY(laneOf(from));
    const y2 = laneY(laneOf(to));
    return {
      id: f.id,
      x: x(f.t),
      y1,
      // Stop short of the lane center so the arrowhead sits on it.
      y2: y2 + (y2 > y1 ? -3 : 3),
      label: `${short.format(f.value)}${exitSet.value.has(to) ? ` ${props.nameOf(to)}` : ''}`,
    };
  }),
);

/** Dwell: first traced arrival → last traced departure (to the end when the money never left). */
const bands = computed(() =>
  lanes.value.flatMap((id, i) => {
    const arrivals = shown.value.filter((f) => real(f).to === id).map((f) => f.t);
    if (!arrivals.length) return [];
    const departures = shown.value.filter((f) => real(f).from === id).map((f) => f.t);
    const end = departures.length ? Math.max(...departures) : domain.value[1];
    const start = Math.min(...arrivals);
    return end > start ? [{ id, x: x(start), w: x(end) - x(start), y: laneY(i) - 5 }] : [];
  }),
);

const STEPS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000, 604_800_000];
const ticks = computed(() => {
  const [a, b] = domain.value;
  const step = STEPS.find((s) => (b - a) / s <= 6) ?? STEPS[STEPS.length - 1];
  const long = b - a > 86_400_000;
  const out: { x: number; label: string }[] = [];
  for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
    const d = new Date(t);
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    out.push({ x: x(t), label: long ? `${d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${hm}` : hm });
  }
  return out;
});

// --- window selection ---
const svgRef = ref<SVGSVGElement | null>(null);
const drag = ref<{ a: number; b: number } | null>(null);

function svgX(e: PointerEvent): number | null {
  const r = svgRef.value?.getBoundingClientRect();
  if (!r || !r.width) return null;
  return Math.min(W - RIGHT, Math.max(LABEL_W, ((e.clientX - r.left) * W) / r.width));
}

function onDown(e: PointerEvent) {
  const px = svgX(e);
  if (px === null) return;
  drag.value = { a: px, b: px };
  (e.target as Element).setPointerCapture?.(e.pointerId);
}

function onMove(e: PointerEvent) {
  const px = svgX(e);
  if (drag.value && px !== null) drag.value = { ...drag.value, b: px };
}

function onUp() {
  const d = drag.value;
  drag.value = null;
  if (!d) return;
  if (Math.abs(d.b - d.a) < 4) emit('update:focus', null);
  else emit('update:focus', [tAt(Math.min(d.a, d.b)), tAt(Math.max(d.a, d.b))]);
}

const selection = computed(() => {
  if (drag.value) return { x: Math.min(drag.value.a, drag.value.b), w: Math.abs(drag.value.b - drag.value.a) };
  if (!props.focus) return null;
  const a = Math.max(LABEL_W, x(props.focus[0]));
  return { x: a, w: Math.max(0, Math.min(W - RIGHT, x(props.focus[1])) - a) };
});

const focusLabel = computed(() => {
  if (!props.focus) return '';
  const f = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${f(props.focus[0])} – ${f(props.focus[1])}`;
});
</script>

<template>
  <section class="swimlanes" data-testid="trace-swimlanes">
    <header>
      <strong>{{ result ? 'Swimlane timeline' : 'Timeline' }}</strong>
      <span class="muted">{{ result ? 'the light band in each account is how long the money sat there · ' : '' }}drag to pick a window</span>
      <span v-if="focus" class="focus" data-testid="swimlane-focus">
        window {{ focusLabel }}
        <button class="link-btn" data-testid="swimlane-clear" @click="emit('update:focus', null)">clear</button>
      </span>
    </header>
    <svg ref="svgRef" :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Swimlane timeline of the traced transfers">
      <defs>
        <marker id="swimlane-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" class="head" />
        </marker>
      </defs>
      <g v-for="(id, i) in lanes" :key="id">
        <line :x1="LABEL_W" :x2="W - RIGHT" :y1="laneY(i)" :y2="laneY(i)" class="lane" />
        <text x="0" :y="laneY(i)" dominant-baseline="middle" class="lane-label" data-testid="swimlane-lane">{{ nameOf(id) }}</text>
      </g>
      <g v-if="exitLane >= 0">
        <line :x1="LABEL_W" :x2="W - RIGHT" :y1="laneY(exitLane)" :y2="laneY(exitLane)" class="lane" />
        <text x="0" :y="laneY(exitLane)" dominant-baseline="middle" class="lane-label exit" data-testid="swimlane-lane">
          {{ backward ? 'Origins' : 'Exits' }}
        </text>
      </g>
      <rect v-for="b in bands" :key="`band-${b.id}`" :x="b.x" :y="b.y" :width="b.w" height="10" class="dwell" data-testid="swimlane-dwell" />
      <g v-for="a in arrows" :key="a.id" data-testid="swimlane-arrow">
        <line :x1="a.x" :x2="a.x" :y1="a.y1" :y2="a.y2" class="arrow" marker-end="url(#swimlane-arrow)" />
        <text :x="a.x + 3" :y="a.y2 - 2" class="arrow-label">{{ a.label }}</text>
      </g>
      <text v-for="t in ticks" :key="t.x" :x="t.x" :y="height - 6" text-anchor="middle" class="tick">{{ t.label }}</text>
      <rect v-if="selection" :x="selection.x" :y="TOP - 4" :width="selection.w" :height="laneCount * LANE_H + 8" class="selection" />
      <rect
        :x="LABEL_W"
        :y="0"
        :width="W - LABEL_W - RIGHT"
        :height="height"
        class="hit"
        data-testid="swimlane-hit"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
      />
    </svg>
  </section>
</template>

<style scoped>
.swimlanes {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
  background: var(--color-surface);
  font-size: 13px;
}

header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
}

.muted {
  color: var(--text-muted);
}

.focus {
  margin-left: auto;
  font-weight: 600;
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--color-primary);
  cursor: pointer;
}

svg {
  display: block;
  width: 100%;
  max-height: 220px;
  user-select: none;
}

.lane {
  stroke: #e9ecef;
}

.lane-label {
  font-size: 11px;
  fill: #374151;
}

.lane-label.exit {
  font-weight: 700;
}

.dwell {
  fill: #fed7aa;
}

.arrow {
  stroke: #0f766e;
  stroke-width: 1.5;
}

.head {
  fill: #0f766e;
}

.arrow-label {
  font-size: 11px;
  fill: #1f2937;
}

.tick {
  font-size: 11px;
  fill: #6c757d;
}

.selection {
  fill: rgba(20, 184, 166, 0.12);
  stroke: var(--color-primary);
  stroke-dasharray: 4 3;
}

.hit {
  fill: transparent;
  cursor: crosshair;
}
</style>
