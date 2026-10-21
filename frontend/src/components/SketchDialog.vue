<script setup lang="ts">
/**
 * Draw a node (optionally linked to the one right-clicked) or an edge between two selected
 * nodes (BYOD-2). Opened from the context menu through `useSketch`; where it goes (an
 * exploration's layer or the case's "Manual additions" item) is `useSketch`'s business.
 */
import { computed, ref, watch } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useSketch } from '@/composables/useSketch';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import HelpTip from '@/components/admin/HelpTip.vue';
import { guideUrl } from '@/utils/docsLinks';

const graph = useGraphStore();
const sketch = useSketch();
const toast = useToast();

const type = ref('');
const label = ref('');
const propsText = ref('');
const edgeType = ref('');
const incoming = ref(false);
const swapped = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const d = computed(() => sketch.dialog.value);
watch(d, (v) => {
  if (!v) return;
  type.value = '';
  label.value = '';
  propsText.value = '';
  edgeType.value = '';
  incoming.value = false;
  swapped.value = false;
  error.value = null;
});

const labelOf = (id: string | null) => {
  if (!id) return '';
  const n = graph.nodes.find((x) => x.node_id === id);
  const name = (n?.properties?.label ?? n?.properties?.name) as string | undefined;
  return `${n?.node_type ?? ''} ${name ?? id}`.trim();
};
const ends = computed(() => {
  const v = d.value;
  if (!v || v.mode !== 'edge') return null;
  return swapped.value ? { source: v.target!, target: v.source! } : { source: v.source!, target: v.target! };
});

/** `key = value` lines; a value that reads as a number is one. */
function parseProps(text: string): { props: Record<string, unknown>; error: string | null } {
  const props: Record<string, unknown> = {};
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    const at = line.indexOf('=');
    if (at <= 0) return { props, error: `Line ${i + 1}: write it as name = value.` };
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    props[key] = /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return { props, error: null };
}

const canSubmit = computed(() => {
  if (!d.value || busy.value) return false;
  return d.value.mode === 'node' ? !!type.value.trim() : !!edgeType.value.trim();
});

async function submit() {
  const v = d.value;
  if (!v || !canSubmit.value) return;
  error.value = null;
  busy.value = true;
  try {
    let failed: string | null;
    if (v.mode === 'node') {
      const parsed = parseProps(propsText.value);
      if (parsed.error) {
        error.value = parsed.error;
        return;
      }
      failed = await sketch.addNode({
        type: type.value.trim(),
        label: label.value.trim() || undefined,
        properties: parsed.props,
        linkTo: v.linkTo,
        edgeType: edgeType.value.trim() || undefined,
        incoming: incoming.value,
      });
    } else {
      failed = await sketch.addEdge(ends.value!.source, ends.value!.target, edgeType.value.trim());
    }
    if (failed) toast.error(`Drawn, but not saved: ${failed}`);
    else toast.success(v.mode === 'node' ? 'Node added' : 'Edge added');
    sketch.closeDialog();
  } catch (e) {
    error.value = getErrorMessage(e, 'Failed to draw it');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="d" class="modal-overlay" @click.self="sketch.closeDialog()">
      <form class="modal sketch" data-testid="sketch-dialog" @submit.prevent="submit">
        <div class="modal-header">
          <h2>{{ d.mode === 'node' ? (d.linkTo ? 'Add a linked node' : 'Add a node') : 'Connect two nodes' }}</h2>
          <button type="button" class="modal-close" aria-label="Close" @click="sketch.closeDialog()">&times;</button>
        </div>
        <p class="hint">
          {{ sketch.inCase.value ? 'It goes to the case’s “Manual additions” item, with you as author.' : 'It goes to your layer of this exploration; the context does not change.' }}
          <a :href="guideUrl('bring-your-own-data', 'drawn-by-hand')" target="_blank" rel="noopener">Guide</a>
        </p>

        <template v-if="d.mode === 'node'">
          <label>
            <span>Type
              <HelpTip title="Node type" testid="sketch-type">
                <span>Pick a type already on the canvas to reuse its color and filters, or write a new one (<code>Phone</code>, <code>Person</code>).</span>
              </HelpTip>
            </span>
            <input v-model="type" class="form-control" list="sketch-node-types" required data-testid="sketch-type" placeholder="Person, Account, Phone…" />
          </label>
          <datalist id="sketch-node-types"><option v-for="t in graph.nodeTypes" :key="t" :value="t" /></datalist>
          <label>Label
            <input v-model="label" class="form-control" data-testid="sketch-label" />
          </label>
          <label>
            <span>Other properties (one per line: name = value)
              <HelpTip title="Properties" testid="sketch-props">
                <span>One per line, as <code>name = value</code>. A value that reads as a number is stored as one.</span>
                <span>The label is shown on the canvas; the other properties appear in the side panel and the data table.</span>
              </HelpTip>
            </span>
            <textarea v-model="propsText" rows="3" class="form-control mono" data-testid="sketch-props" placeholder="phone = +1 415 555 0100"></textarea>
          </label>
          <template v-if="d.linkTo">
            <label>Edge type
              <input v-model="edgeType" class="form-control" list="sketch-edge-types" data-testid="sketch-edge-type" placeholder="related" />
            </label>
            <label class="inline">
              <input v-model="incoming" type="checkbox" /> The edge goes from <strong>{{ labelOf(d.linkTo) }}</strong> to the new node
            </label>
          </template>
        </template>

        <template v-else-if="ends">
          <p class="ends" data-testid="sketch-ends">
            <strong>{{ labelOf(ends.source) }}</strong> → <strong>{{ labelOf(ends.target) }}</strong>
            <button type="button" class="btn btn-sm btn-outline" data-testid="sketch-swap" @click="swapped = !swapped">Swap</button>
          </p>
          <label>Edge type
            <input v-model="edgeType" class="form-control" list="sketch-edge-types" required data-testid="sketch-edge-type" />
          </label>
        </template>
        <datalist id="sketch-edge-types"><option v-for="t in graph.edgeTypes" :key="t" :value="t" /></datalist>

        <p v-if="error" class="error-message">{{ error }}</p>
        <div class="actions">
          <button type="button" class="btn btn-outline" @click="sketch.closeDialog()">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="!canSubmit" data-testid="sketch-submit">
            {{ busy ? 'Saving…' : 'Add' }}
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.sketch {
  width: min(440px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sketch label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.sketch label.inline {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.hint {
  color: var(--text-muted);
  font-size: 12px;
  margin: 0;
}
.ends {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0;
}
.mono {
  font-family: var(--font-mono, monospace);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
