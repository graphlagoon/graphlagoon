<script setup lang="ts">
/**
 * The Look panel: how the graph is drawn, in one place — Style (colors, sizes,
 * icons, property visibility), Labels (templates and rules), Behaviors
 * (interaction, 3D/2D, lens) and Presets (the same look under a name).
 *
 * Shared by the exploration page (docked on the left, presets applied through
 * `?style=`) and the case (a floating panel over the canvas, presets applied to
 * the store and saved on the graph item through the footer slot). The three
 * sub-panels are the store-driven ones the exploration always had; this panel
 * only gives them one header and a tab row.
 */
import { computed } from 'vue';
import { X } from 'lucide-vue-next';
import type { LookTab } from '@/stores/toolbar';
import AestheticsPanel from './AestheticsPanel.vue';
import TextFormatPanel from './TextFormatPanel.vue';
import BehaviorPanel from './BehaviorPanel.vue';
import StylePresetList from './StylePresetList.vue';

const props = withDefaults(
  defineProps<{
    tab?: LookTab;
    /** How a preset is applied: `url` (`?style=`) on the exploration page, `store` in a case. */
    presetsApply: 'url' | 'store';
    /** Whose presets to list; null when the canvas has no context (a frozen item). */
    presetsContextId: string | null;
    /** Whether the person may write presets to that context. */
    canWritePresets?: boolean;
    /** A caption under the title: which look is on (a case names the item it came from). */
    caption?: string | null;
  }>(),
  { tab: 'style', canWritePresets: false, caption: null },
);

const emit = defineEmits<{
  close: [];
  'update:tab': [tab: LookTab];
  'open-menu-actions': [];
  /** A preset was applied to the store (`store` mode): the host may react (e.g. re-sync clusters). */
  applied: [name: string | null];
}>();

const TABS: { id: LookTab; label: string }[] = [
  { id: 'style', label: 'Style' },
  { id: 'labels', label: 'Labels' },
  { id: 'behaviors', label: 'Behaviors' },
  { id: 'presets', label: 'Presets' },
];

const active = computed(() => props.tab);
</script>

<template>
  <div class="look-panel" data-testid="look-panel">
    <div class="panel-header">
      <div>
        <h3>Look</h3>
        <p v-if="caption" class="caption" data-testid="look-caption">{{ caption }}</p>
      </div>
      <button class="btn-icon-only close-btn" aria-label="Close" data-testid="look-close" @click="emit('close')"><X :size="16" /></button>
    </div>

    <div class="tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="tab"
        role="tab"
        :class="{ active: active === t.id }"
        :aria-selected="active === t.id"
        :data-testid="`look-tab-${t.id}`"
        @click="emit('update:tab', t.id)"
      >
        {{ t.label }}
      </button>
    </div>

    <div class="tab-body">
      <AestheticsPanel v-if="active === 'style'" embedded @close="emit('close')" />
      <TextFormatPanel v-else-if="active === 'labels'" embedded @close="emit('close')" />
      <BehaviorPanel v-else-if="active === 'behaviors'" embedded @close="emit('close')" @open-menu-actions="emit('open-menu-actions')" />
      <StylePresetList
        v-else
        :apply="presetsApply"
        :context-id="presetsContextId"
        :can-write="canWritePresets"
        @applied="emit('applied', $event)"
      />
    </div>

    <div v-if="$slots.footer" class="footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<style scoped>
.look-panel {
  display: flex;
  flex-direction: column;
  width: 300px;
  min-height: 0;
  background: var(--card-background);
  border-right: 1px solid var(--border-color);
}

/* A host that gives the panel its own box (a floating case panel) sets `.look-panel.fill`. */
.look-panel.fill {
  width: auto;
  height: 100%;
  border-right: 0;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 16px 16px 8px;
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.caption {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-color);
}

.tab {
  padding: 6px 8px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
}

.tab.active {
  color: var(--color-primary, var(--primary-color));
  border-bottom-color: var(--color-primary, var(--primary-color));
  font-weight: 600;
}

.tab-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 16px;
}

.footer {
  padding: 10px 16px;
  border-top: 1px solid var(--border-color);
}
</style>
