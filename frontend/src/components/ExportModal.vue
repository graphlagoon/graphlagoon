<script setup lang="ts">
import { ref, computed } from 'vue';
import { X } from 'lucide-vue-next';

const props = defineProps<{
  visible: boolean;
  canvasWidth: number;
  canvasHeight: number;
}>();

const emit = defineEmits<{
  close: [];
  exportPng: [options: { scale: number; background: 'white' | 'transparent' }];
  exportJson: [];
}>();

const format = ref<'png' | 'json'>('png');
const scale = ref(2);
const background = ref<'white' | 'transparent'>('white');

const estimatedWidth = computed(() => props.canvasWidth * scale.value);
const estimatedHeight = computed(() => props.canvasHeight * scale.value);

const scaleOptions = [1, 2, 3, 4] as const;

function handleExport() {
  if (format.value === 'json') {
    emit('exportJson');
  } else {
    emit('exportPng', { scale: scale.value, background: background.value });
  }
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
      <div class="modal export-modal">
        <div class="modal-header">
          <h2>Export Graph</h2>
          <button class="modal-close" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Format</label>
            <div class="radio-group">
              <label class="radio-option">
                <input type="radio" v-model="format" value="png" />
                PNG
              </label>
              <label class="radio-option">
                <input type="radio" v-model="format" value="json" />
                JSON
              </label>
            </div>
          </div>

          <template v-if="format === 'png'">
            <div class="form-group">
              <label class="form-label">Resolution</label>
              <div class="scale-options">
                <button
                  v-for="s in scaleOptions"
                  :key="s"
                  type="button"
                  class="scale-btn"
                  :class="{ active: scale === s }"
                  @click="scale = s"
                >
                  {{ s }}x
                </button>
              </div>
              <span v-if="canvasWidth > 0" class="dimension-hint">
                {{ estimatedWidth }} &times; {{ estimatedHeight }} px
              </span>
            </div>

            <div class="form-group">
              <label class="form-label">Background</label>
              <div class="radio-group">
                <label class="radio-option">
                  <input type="radio" v-model="background" value="white" />
                  White
                </label>
                <label class="radio-option">
                  <input type="radio" v-model="background" value="transparent" />
                  Transparent
                </label>
              </div>
            </div>
          </template>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-outline" @click="emit('close')">Cancel</button>
          <button type="button" class="btn btn-primary" @click="handleExport">Export</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.export-modal {
  background: var(--card-background, #fff);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  min-width: 340px;
  max-width: 420px;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #dee2e6);
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--text-muted, #6c757d);
  padding: 0 4px;
  line-height: 1;
}

.modal-close:hover {
  color: var(--text-color, #2c3e50);
}

.modal-body {
  padding: 20px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted, #6c757d);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.radio-group {
  display: flex;
  gap: 16px;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 14px;
}

.radio-option input[type="radio"] {
  accent-color: var(--primary-color, #42b883);
}

.scale-options {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.scale-btn {
  padding: 6px 14px;
  border: 1px solid var(--border-color, #dee2e6);
  border-radius: 4px;
  background: var(--card-background, #fff);
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.15s;
}

.scale-btn:hover {
  border-color: var(--primary-color, #42b883);
  color: var(--primary-color, #42b883);
}

.scale-btn.active {
  background: var(--primary-color, #42b883);
  border-color: var(--primary-color, #42b883);
  color: #fff;
}

.dimension-hint {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #6c757d);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color, #dee2e6);
}
</style>
