<script setup lang="ts">
/**
 * A "?" next to a heading: a short explanation in a popover, with an example
 * when it helps. Click or Enter opens it; Esc, a click outside or the ? again
 * closes it (and scrolling the ? off screen). The popover is placed against the window (fixed), below the
 * ? or above it when there is no room, so a scrolling modal never clips it.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { HelpCircle } from 'lucide-vue-next';

const props = defineProps<{ title: string; testid?: string }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLElement | null>(null);
const popover = ref<HTMLElement | null>(null);
/** Window coordinates of the popover; null until measured (it renders hidden first). */
const pos = ref<{ left: number; top: number } | null>(null);

const GAP = 6;
const MARGIN = 8;
function place() {
  if (!button.value || !popover.value) return;
  const b = button.value.getBoundingClientRect();
  const p = popover.value.getBoundingClientRect();
  const left = Math.max(MARGIN, Math.min(b.left - MARGIN, window.innerWidth - p.width - MARGIN));
  const below = b.bottom + GAP;
  const fitsBelow = below + p.height <= window.innerHeight - MARGIN;
  const top = fitsBelow ? below : Math.max(MARGIN, b.top - GAP - p.height);
  pos.value = { left, top };
}
function close() {
  open.value = false;
}
/**
 * The page or a container scrolled under it: the popover follows the ? (focusing
 * the ? can scroll its container on the very click that opens it), and closes
 * once the ? is off screen. Its own scroll does not count.
 */
function onScroll(e: Event) {
  if (popover.value && popover.value.contains(e.target as Node)) return;
  const b = button.value?.getBoundingClientRect();
  if (!b || b.bottom < 0 || b.top > window.innerHeight) close();
  else place();
}

function onDocument(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false;
}
watch(open, async (on) => {
  if (on) {
    document.addEventListener('mousedown', onDocument);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    pos.value = null;
    await nextTick();
    place();
  } else {
    document.removeEventListener('mousedown', onDocument);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocument);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', close);
});
</script>

<template>
  <span ref="root" class="help-tip">
    <button
      ref="button"
      type="button"
      class="help-btn"
      :aria-label="`Help: ${props.title}`"
      :aria-expanded="open"
      :title="`Help: ${props.title}`"
      :data-testid="props.testid ? `help-${props.testid}` : undefined"
      @click="open = !open"
    >
      <HelpCircle :size="14" />
    </button>
    <span
      v-if="open"
      ref="popover"
      class="popover"
      :style="pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: 'hidden', left: '0px', top: '0px' }"
      data-escape-owner
      role="dialog" :aria-label="props.title" :data-testid="props.testid ? `help-${props.testid}-text` : undefined">
      <strong>{{ props.title }}</strong>
      <slot />
    </span>
  </span>
</template>

<style scoped>
.help-tip {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}

.help-btn {
  display: inline-flex;
  padding: 0 2px;
  border: 0;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.help-btn:hover,
.help-btn[aria-expanded='true'] {
  color: var(--color-primary);
}

.popover {
  position: fixed;
  z-index: 10002;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: min(340px, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--color-surface, #fff);
  box-shadow: 0 8px 24px rgb(0 0 0 / 15%);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
  color: var(--text-primary);
  white-space: normal;
}

.popover :deep(code) {
  font-size: 11px;
}

.popover :deep(ul) {
  margin: 0;
  padding-left: 16px;
}
</style>
