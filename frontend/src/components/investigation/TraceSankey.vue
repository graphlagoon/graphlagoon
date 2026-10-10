<script setup lang="ts">
/** Sankey of the money trace (T5): band width = traced value, one column per layer. Hand-rolled SVG. */
import { computed } from 'vue';
import { formatAmount } from '@/utils/edgeSemantics';
import { sankeyLayout, type TraceColumns, type TraceFlow } from '@/utils/traceView';

const props = defineProps<{
  flows: TraceFlow[];
  columns: TraceColumns;
  nameOf: (id: string) => string;
  allocation: string;
}>();

const W = 900;
const H = 340;
const NODE_W = 14;
/** Room right of the last column for its labels. */
const LABEL_ROOM = 150;
const layout = computed(() => sankeyLayout(props.flows, props.columns, { width: W - LABEL_ROOM, height: H, nodeWidth: NODE_W }));
const lastCol = computed(() => props.columns.labels.length - 1);

function fill(col: number): string {
  if (col === 0) return '#2563eb';
  return props.columns.exits && col === lastCol.value ? '#0d1b2a' : '#ea580c';
}
</script>

<template>
  <div class="sankey" data-testid="trace-sankey">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Sankey of the traced value">
      <path
        v-for="l in layout.links"
        :key="`${l.src}>${l.dst}`"
        class="band"
        :d="l.path"
        data-testid="sankey-band"
      >
        <title>{{ nameOf(l.src) }} → {{ nameOf(l.dst) }} · {{ formatAmount(l.value) }} · {{ l.edgeIds.length }} {{ l.edgeIds.length === 1 ? 'transaction' : 'transactions' }}</title>
      </path>
      <g v-for="n in layout.nodes" :key="n.id">
        <rect :x="n.x" :y="n.y" :width="NODE_W" :height="Math.max(n.h, 1)" :fill="fill(n.col)" data-testid="sankey-node" />
        <text :x="n.x + NODE_W + 6" :y="n.y + Math.max(n.h, 1) / 2" dominant-baseline="middle" class="label">
          {{ nameOf(n.id) }} · {{ formatAmount(n.value) }}
        </text>
      </g>
    </svg>
    <p class="caption">Band width = traced value ({{ allocation.toUpperCase() }}). Hover a band for its transactions.</p>
  </div>
</template>

<style scoped>
.sankey {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  padding: 16px 24px;
  background: var(--color-graph-bg);
}

svg {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.band {
  fill: rgba(20, 184, 166, 0.32);
}

.band:hover {
  fill: rgba(20, 184, 166, 0.55);
}

.label {
  font-size: 12px;
  fill: #1f2937;
  paint-order: stroke;
  stroke: #fafafa;
  stroke-width: 4px;
  stroke-linejoin: round;
}

.caption {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
