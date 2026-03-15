<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="close">
      <div class="modal-container">
        <div class="modal-header">
          <h2>Text Formatter Help</h2>
          <button class="close-btn" @click="close" title="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="modal-content">
          <!-- Slide navigation -->
          <div class="slide-nav">
            <button
              v-for="(slide, index) in slides"
              :key="index"
              :class="['slide-dot', { active: currentSlide === index }]"
              @click="currentSlide = index"
              :title="slide.title"
            />
          </div>

          <!-- Current slide content -->
          <div class="slide">
            <h3>{{ slides[currentSlide].title }}</h3>
            <p class="slide-description">{{ slides[currentSlide].description }}</p>

            <div class="examples">
              <div
                v-for="(example, idx) in slides[currentSlide].examples"
                :key="idx"
                class="example-item"
              >
                <div class="example-template">
                  <code>{{ example.template }}</code>
                </div>
                <div class="example-arrow">→</div>
                <div class="example-result">{{ example.result }}</div>
                <div v-if="example.note" class="example-note">{{ example.note }}</div>
              </div>
            </div>
          </div>

          <!-- Navigation buttons -->
          <div class="slide-controls">
            <button
              class="nav-btn"
              :disabled="currentSlide === 0"
              @click="currentSlide--"
            >
              ← Previous
            </button>
            <span class="slide-counter">{{ currentSlide + 1 }} / {{ slides.length }}</span>
            <button
              class="nav-btn"
              :disabled="currentSlide === slides.length - 1"
              @click="currentSlide++"
            >
              Next →
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const currentSlide = ref(0);

const slides = [
  {
    title: 'Basic Placeholders',
    description: 'Use curly braces to insert property values into your labels.',
    examples: [
      { template: '{node_id}', result: 'user_123', note: 'Node identifier' },
      { template: '{node_type}', result: 'Person', note: 'Node type/label' },
      { template: '{prop:name}', result: 'John Doe', note: 'Metadata property' },
      { template: '{prop:email}', result: 'john@example.com', note: 'Any metadata field' },
    ],
  },
  {
    title: 'Edge Placeholders',
    description: 'Special placeholders available for edge labels.',
    examples: [
      { template: '{relationship_type}', result: 'FOLLOWS', note: 'Edge type' },
      { template: '{src}', result: 'user_1', note: 'Source node ID' },
      { template: '{dst}', result: 'user_2', note: 'Destination node ID' },
      { template: '{src} → {dst}', result: 'user_1 → user_2', note: 'Combined format' },
    ],
  },
  {
    title: 'Text Modifiers',
    description: 'Apply transformations to property values using pipe syntax.',
    examples: [
      { template: '{prop:name|upper}', result: 'JOHN DOE', note: 'Uppercase' },
      { template: '{prop:name|lower}', result: 'john doe', note: 'Lowercase' },
      { template: '{prop:name|capitalize}', result: 'John doe', note: 'Capitalize first' },
      { template: '{prop:bio|truncate:15:...}', result: 'Software engin...', note: 'Truncate with ellipsis' },
    ],
  },
  {
    title: 'Number Formatting',
    description: 'Format numeric values with locale-aware formatting.',
    examples: [
      { template: '{prop:count|number}', result: '1,234,567', note: 'Locale number format' },
      { template: '{prop:price|currency:USD}', result: '$1,234.56', note: 'US Dollar' },
      { template: '{prop:price|currency:BRL}', result: 'R$ 1.234,56', note: 'Brazilian Real' },
      { template: '{prop:rate|percent}', result: '85.5%', note: 'Percentage (0.855 → 85.5%)' },
    ],
  },
  {
    title: 'Date Formatting',
    description: 'Format date/timestamp fields with custom patterns.',
    examples: [
      { template: '{date:prop:created|DD/MM/YYYY}', result: '25/01/2024', note: 'Day/Month/Year' },
      { template: '{date:prop:created|YYYY-MM-DD}', result: '2024-01-25', note: 'ISO format' },
      { template: '{date:prop:created|DD/MM HH:mm}', result: '25/01 14:30', note: 'With time' },
      { template: '{date:prop:updated|MM/YYYY}', result: '01/2024', note: 'Month/Year only' },
    ],
  },
  {
    title: 'Conditionals',
    description: 'Show different text based on property values.',
    examples: [
      { template: '{if:prop:active==true|Active|Inactive}', result: 'Active', note: 'Boolean check' },
      { template: '{if:prop:score>80|High|Low}', result: 'High', note: 'Numeric comparison' },
      { template: '{if:prop:role==admin|Admin|User}', result: 'Admin', note: 'String equality' },
      { template: '{if:prop:name|contains:john|Match|No match}', result: 'Match', note: 'String contains' },
    ],
  },
  {
    title: 'Date Conditionals',
    description: 'Create conditions based on date values.',
    examples: [
      { template: '{if:prop:date|daysAgo:<7|Recent|Old}', result: 'Recent', note: 'Within 7 days' },
      { template: '{if:prop:date|daysAgo:>30|Old|New}', result: 'Old', note: 'More than 30 days' },
      { template: '{if:prop:date|dateAfter:2024-01-01|New|Legacy}', result: 'New', note: 'After specific date' },
      { template: '{if:prop:date|dateBefore:2023-12-31|Archive|Current}', result: 'Archive', note: 'Before specific date' },
    ],
  },
  {
    title: 'Combining Elements',
    description: 'Mix placeholders, modifiers, and conditionals for complex labels.',
    examples: [
      { template: '{prop:name|upper} ({node_type})', result: 'JOHN DOE (Person)', note: 'Name with type' },
      { template: '{prop:name|truncate:10} - {prop:role|capitalize}', result: 'John Doe... - Admin', note: 'Multiple fields' },
      { template: '{if:prop:verified==true|✓|✗} {prop:email}', result: '✓ john@example.com', note: 'Status indicator' },
      { template: '[{prop:status|upper}] {prop:title|truncate:20}', result: '[ACTIVE] Meeting tomorrow...', note: 'Formatted status' },
    ],
  },
];

function close() {
  emit('update:modelValue', false);
  currentSlide.value = 0;
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal-container {
  background: var(--vt-c-bg, #1a1a1a);
  border-radius: 12px;
  width: 90%;
  max-width: 600px;
  max-height: 85vh;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--vt-c-divider, #333);
}

.modal-header h2 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--vt-c-text-1, #fff);
}

.close-btn {
  background: none;
  border: none;
  color: var(--vt-c-text-2, #888);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--vt-c-bg-soft, #2a2a2a);
  color: var(--vt-c-text-1, #fff);
}

.modal-content {
  padding: 20px;
}

.slide-nav {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 20px;
}

.slide-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--vt-c-divider, #333);
  border: none;
  cursor: pointer;
  transition: all 0.2s;
}

.slide-dot:hover {
  background: var(--vt-c-text-3, #666);
}

.slide-dot.active {
  background: var(--color-primary, #42b883);
  width: 24px;
  border-radius: 5px;
}

.slide h3 {
  margin: 0 0 8px 0;
  font-size: 1.1rem;
  color: var(--color-primary, #42b883);
}

.slide-description {
  margin: 0 0 20px 0;
  color: var(--vt-c-text-2, #888);
  font-size: 0.9rem;
}

.examples {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.example-item {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 12px;
  align-items: center;
  padding: 12px;
  background: var(--vt-c-bg-soft, #2a2a2a);
  border-radius: 8px;
}

.example-template {
  font-family: 'Fira Code', 'Consolas', monospace;
  font-size: 0.85rem;
}

.example-template code {
  background: var(--vt-c-bg-mute, #1a1a1a);
  padding: 4px 8px;
  border-radius: 4px;
  color: var(--color-primary, #42b883);
  word-break: break-all;
}

.example-arrow {
  color: var(--vt-c-text-3, #666);
  font-weight: bold;
}

.example-result {
  color: var(--vt-c-text-1, #fff);
  font-size: 0.9rem;
}

.example-note {
  grid-column: 1 / -1;
  color: var(--vt-c-text-3, #666);
  font-size: 0.8rem;
  font-style: italic;
  margin-top: -4px;
}

.slide-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--vt-c-divider, #333);
}

.nav-btn {
  background: var(--vt-c-bg-soft, #2a2a2a);
  border: 1px solid var(--vt-c-divider, #333);
  color: var(--vt-c-text-1, #fff);
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
}

.nav-btn:hover:not(:disabled) {
  background: var(--vt-c-bg-mute, #333);
  border-color: var(--color-primary, #42b883);
}

.nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.slide-counter {
  color: var(--vt-c-text-3, #666);
  font-size: 0.85rem;
}
</style>
