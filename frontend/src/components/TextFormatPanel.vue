<template>
  <div class="text-format-panel">
    <div class="panel-header">
      <h3>Labels</h3>
      <div class="header-actions">
        <button
          class="btn-icon-only btn-skill-ai"
          data-testid="label-skill-help"
          title="Ask an AI to write label templates"
          aria-label="Ask an AI to write label templates"
          @click="showSkill = true"
        >
          <Bot :size="16" />
        </button>
        <button class="btn-icon-only" @click="showHelp = true" title="Help"><HelpCircle :size="16" /></button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- Tabs (house pattern: MetricsPanel, ClusterProgramPanel) -->
    <div class="tabs">
      <button
        class="tab"
        :class="{ active: activeTab === 'labels' }"
        data-testid="labels-tab-labels"
        @click="activeTab = 'labels'"
      >
        Labels
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'tooltips' }"
        data-testid="labels-tab-tooltips"
        @click="activeTab = 'tooltips'"
      >
        Tooltips
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'rules' }"
        data-testid="labels-tab-rules"
        @click="activeTab = 'rules'"
      >
        Rules
        <span v-if="graphStore.textFormatRules.length > 0" class="tab-badge">{{ graphStore.textFormatRules.length }}</span>
      </button>
    </div>

    <!-- Default Templates -->
    <div v-if="activeTab === 'labels'" class="section">
      <div class="section-title">Default Templates</div>
      <p class="section-hint">
        Type <code>{</code> for placeholders and <code>|</code> for modifiers —
        every template field autocompletes.
      </p>

      <div class="default-template">
        <label>Node Label</label>
        <TemplateInput v-model="nodeDefaultTemplate" target="node" placeholder="{node_id|truncate:10:...}" />
        <TemplatePreviewInline :template="nodeDefaultTemplate" target="node" />
      </div>

      <div class="default-template">
        <label>Edge Label</label>
        <TemplateInput v-model="edgeDefaultTemplate" target="edge" placeholder="{relationship_type}" />
        <TemplatePreviewInline :template="edgeDefaultTemplate" target="edge" />
      </div>
    </div>

    <!-- Hover Tooltips -->
    <div v-if="activeTab === 'tooltips'" class="section">
      <div class="section-title">Hover Tooltips</div>
      <p class="section-hint">
        Leave empty to show the label. A custom rule whose surface includes
        tooltips overrides this for its types. Accents and emoji work here —
        the tooltip is HTML, not the canvas font.
      </p>

      <div class="default-template">
        <label>Node Tooltip</label>
        <TemplateInput
          v-model="nodeTooltipTemplate"
          target="node"
          multiline
          placeholder="empty = same as the label"
          data-testid="tooltip-template-node"
        />
        <TemplatePreviewInline
          :template="nodeTooltipTemplate"
          target="node"
          chrome="tooltip"
          :empty-fallback="{ template: nodeDefaultTemplate, badge: '= label' }"
        />
      </div>

      <div class="default-template">
        <label>Edge Tooltip</label>
        <TemplateInput
          v-model="edgeTooltipTemplate"
          target="edge"
          multiline
          placeholder="empty = same as the label"
          data-testid="tooltip-template-edge"
        />
        <TemplatePreviewInline
          :template="edgeTooltipTemplate"
          target="edge"
          chrome="tooltip"
          :empty-fallback="{ template: '{relationship_type}', badge: '= label' }"
        />
      </div>
    </div>

    <!-- Custom Rules -->
    <div v-if="activeTab === 'rules'" class="section">
      <div class="section-title">
        Custom Rules
        <button class="add-rule-btn" @click="startAddRule" title="Add Rule">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      <p class="section-hint">
        Rules override the default templates for chosen types. Each rule
        applies to labels, tooltips, or both.
      </p>

      <!-- Rule List -->
      <div v-if="graphStore.textFormatRules.length > 0" class="rules-list">
        <div
          v-for="rule in sortedRules"
          :key="rule.id"
          :class="['rule-item', { disabled: !rule.enabled }]"
        >
          <div class="rule-header">
            <input
              type="checkbox"
              :checked="rule.enabled"
              @change="graphStore.setTextFormatRuleEnabled(rule.id, !rule.enabled)"
              class="rule-checkbox"
            />
            <span class="rule-name">{{ rule.name }}</span>
            <span class="rule-priority" :title="'Priority: ' + rule.priority">{{ rule.priority }}</span>
            <span class="rule-target">{{ rule.target }}</span>
            <span
              v-if="rule.surface === 'tooltip' || rule.surface === 'both'"
              class="rule-target rule-surface"
              :title="rule.surface === 'both' ? 'Applies to labels and tooltips' : 'Applies to tooltips'"
            >{{ rule.surface }}</span>
            <button class="rule-action" @click="editRule(rule)" title="Edit">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              </svg>
            </button>
            <button class="rule-action delete" @click="deleteRule(rule.id)" title="Delete">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
          <div class="rule-template">
            <code>{{ rule.template }}</code>
          </div>
          <div v-if="rule.types.length > 0" class="rule-types">
            <span v-for="t in rule.types" :key="t" class="type-tag">{{ t }}</span>
          </div>
        </div>
      </div>

      <div v-else class="no-rules">
        No custom rules defined. Click + to add one.
      </div>
    </div>

    <!-- Rule editor (house pattern: list in the panel, edit in a modal) -->
    <LabelRuleEditorModal
      v-if="ruleModalOpen"
      :rule="editingRule"
      @close="ruleModalOpen = false"
    />

    <!-- Help Modal -->
    <TextFormatHelpModal v-model="showHelp" />

    <!-- AI skill helper modal -->
    <LabelTemplateSkillModal v-model="showSkill" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useGraphStore } from '@/stores/graph';
import type { TextFormatRule } from '@/types/graph';
import TextFormatHelpModal from './TextFormatHelpModal.vue';
import LabelTemplateSkillModal from './LabelTemplateSkillModal.vue';
import LabelRuleEditorModal from './LabelRuleEditorModal.vue';
import TemplateInput from './TemplateInput.vue';
import TemplatePreviewInline from './TemplatePreviewInline.vue';
import { X, HelpCircle, Bot } from 'lucide-vue-next';
import { useToast } from '@/composables/useToast';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const graphStore = useGraphStore();
const toast = useToast();

// Which tab is open. 'labels' first: defaults are the most-edited thing.
const activeTab = ref<'labels' | 'tooltips' | 'rules'>('labels');

// Help modal
const showHelp = ref(false);

// AI skill helper modal
const showSkill = ref(false);

// Default templates (synced with store)
const nodeDefaultTemplate = ref(graphStore.textFormatDefaults.nodeTemplate);
const edgeDefaultTemplate = ref(graphStore.textFormatDefaults.edgeTemplate);

// Hover tooltips. Empty = "show the label", which is the stock tooltip.
const nodeTooltipTemplate = ref(graphStore.textFormatDefaults.nodeTooltipTemplate ?? '');
const edgeTooltipTemplate = ref(graphStore.textFormatDefaults.edgeTooltipTemplate ?? '');

// Watch and update store (debounced — template changes trigger full graph redraw)
let _templateDebounce: ReturnType<typeof setTimeout> | null = null;
function debouncedStoreUpdate(update: () => void) {
  if (_templateDebounce) clearTimeout(_templateDebounce);
  _templateDebounce = setTimeout(update, 400);
}
onUnmounted(() => { if (_templateDebounce) clearTimeout(_templateDebounce); });

watch(nodeDefaultTemplate, (val) => {
  debouncedStoreUpdate(() => graphStore.updateTextFormatDefaults({ nodeTemplate: val }));
});

watch(edgeDefaultTemplate, (val) => {
  debouncedStoreUpdate(() => graphStore.updateTextFormatDefaults({ edgeTemplate: val }));
});

watch(nodeTooltipTemplate, (val) => {
  debouncedStoreUpdate(() => graphStore.updateTextFormatDefaults({ nodeTooltipTemplate: val }));
});

watch(edgeTooltipTemplate, (val) => {
  debouncedStoreUpdate(() => graphStore.updateTextFormatDefaults({ edgeTooltipTemplate: val }));
});

// Sync from store
watch(() => graphStore.textFormatDefaults, (val) => {
  nodeDefaultTemplate.value = val.nodeTemplate;
  edgeDefaultTemplate.value = val.edgeTemplate;
  nodeTooltipTemplate.value = val.nodeTooltipTemplate ?? '';
  edgeTooltipTemplate.value = val.edgeTooltipTemplate ?? '';
}, { deep: true });

// Rules sorted by priority
const sortedRules = computed(() => {
  return [...graphStore.textFormatRules].sort((a, b) => b.priority - a.priority);
});

// Rule editing happens in LabelRuleEditorModal (house pattern).
const ruleModalOpen = ref(false);
const editingRule = ref<TextFormatRule | null>(null);

function startAddRule() {
  editingRule.value = null;
  ruleModalOpen.value = true;
}

function editRule(rule: TextFormatRule) {
  editingRule.value = rule;
  ruleModalOpen.value = true;
}

function deleteRule(ruleId: string) {
  // Undo beats a confirmation for something the app can put back itself: the
  // rule is client-side state, and asking first taxes every deletion to
  // prevent the rare mistake this repairs for free.
  const index = graphStore.textFormatRules.findIndex((r) => r.id === ruleId);
  const rule = graphStore.textFormatRules[index];
  if (!rule) return;
  graphStore.removeTextFormatRule(ruleId);
  toast.undoable('Label rule deleted', () => graphStore.restoreTextFormatRule(rule, index));
}
</script>

<style scoped>
.text-format-panel {
  width: 280px;
  background: var(--card-background);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  padding: 16px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.panel-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.btn-skill-ai {
  color: #409eff;
}

.btn-skill-ai:hover {
  background-color: #ecf5ff;
  color: #3a8ee6;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

.close-btn {
  background: none;
  border: none;
  color: var(--vt-c-text-2, #888);
  cursor: pointer;
  display: flex;
  border-radius: 4px;
  font-size: 16px;
  padding: 2px 8px;
}

.close-btn:hover {
  color: var(--vt-c-text-1, #fff);
}

.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border-color, #ddd);
  padding-bottom: 8px;
}

.tab {
  flex: 1;
  white-space: nowrap;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
  color: var(--text-color, #333);
}

.tab:hover {
  background: var(--bg-secondary, #f5f5f5);
}

.tab.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.tab-badge {
  display: inline-block;
  min-width: 16px;
  padding: 0 4px;
  margin-left: 4px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.25);
  font-size: 10px;
  line-height: 16px;
}

.tab:not(.active) .tab-badge {
  background: var(--bg-secondary, #eee);
  color: var(--text-secondary, #888);
}

.section {
  margin-bottom: 20px;
}

.section-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--vt-c-text-2, #888);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.section-hint {
  font-size: 0.72rem;
  line-height: 1.4;
  color: var(--vt-c-text-2, #888);
  margin: -4px 0 10px;
}

.add-rule-btn {
  background: var(--color-primary, #42b883);
  border: none;
  color: white;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.add-rule-btn:hover {
  opacity: 0.9;
  transform: scale(1.05);
}

.default-template {
  margin-bottom: 12px;
}

.default-template label {
  display: block;
  font-size: 0.8rem;
  color: var(--vt-c-text-2, #888);
  margin-bottom: 4px;
}

.rules-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule-item {
  background: var(--vt-c-bg-soft, #2a2a2a);
  border-radius: 6px;
  padding: 10px;
}

.rule-item.disabled {
  opacity: 0.5;
}

.rule-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rule-checkbox {
  margin: 0;
}

.rule-name {
  flex: 1;
  font-weight: 500;
  color: var(--vt-c-text-1, #fff);
}

.rule-priority {
  font-size: 0.7rem;
  padding: 2px 6px;
  background: var(--color-primary, #42b883);
  border-radius: 4px;
  color: white;
  font-weight: 600;
  min-width: 20px;
  text-align: center;
}

.rule-target {
  font-size: 0.7rem;
  padding: 2px 6px;
  background: var(--vt-c-bg-mute, #333);
  border-radius: 4px;
  color: var(--vt-c-text-2, #888);
  text-transform: uppercase;
}

.rule-action {
  background: none;
  border: none;
  color: var(--vt-c-text-3, #666);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.rule-action:hover {
  background: var(--vt-c-bg-mute, #333);
  color: var(--vt-c-text-1, #fff);
}

.rule-action.delete:hover {
  color: #e74c3c;
}

.rule-template {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--vt-c-bg-mute, #333);
  border-radius: 4px;
}

.rule-template code {
  font-size: 0.8rem;
  color: var(--color-primary, #42b883);
  word-break: break-all;
}

.rule-types {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.type-tag {
  font-size: 0.7rem;
  padding: 2px 6px;
  background: var(--color-primary, #42b883);
  color: white;
  border-radius: 4px;
}

.no-rules {
  text-align: center;
  color: var(--vt-c-text-3, #666);
  font-size: 0.85rem;
  padding: 20px;
}

</style>
