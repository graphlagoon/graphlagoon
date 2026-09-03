<script setup lang="ts">
// Rendered by every details surface that drops empty values, so a shortened
// list is never mistaken for missing data — the same promise
// PropertyVisibilityHint makes for the property allowlist.
//
// Two deliberate differences from that component:
// - Presentational (no store access), because it serves the properties section
//   (which knows its `kind`) and the metrics section (which has none).
// - Reveal is local to the surface. The allowlist hint mutates the store
//   because the user is undoing a deliberate scoping; this toggle is a saved
//   global preference, and flipping it from here would dirty the exploration
//   just because someone peeked at one node. The permanent switch lives in
//   Style → Details Display.
defineProps<{ hidden: number; revealed: boolean }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <!-- Once revealed, `hidden` is 0 — the way back has to survive on the flag. -->
  <span
    v-if="hidden > 0 || revealed"
    class="empty-values-hint"
    data-testid="empty-values-hint"
  >
    <template v-if="!revealed">{{ hidden }} empty hidden · </template>
    <button
      type="button"
      class="reveal-btn"
      data-testid="empty-values-toggle"
      @click="$emit('toggle')"
    >
      {{ revealed ? 'Hide empty' : 'Show' }}
    </button>
  </span>
</template>

<style scoped>
.empty-values-hint {
  font-size: 11px;
  color: var(--text-muted, #888);
  white-space: nowrap;
}

.reveal-btn {
  background: none;
  border: none;
  padding: 0;
  font-size: 11px;
  color: var(--primary-color, #42b883);
  cursor: pointer;
  text-decoration: underline;
}
</style>
