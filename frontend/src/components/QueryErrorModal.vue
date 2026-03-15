<script setup lang="ts">
import { computed, ref } from 'vue';
import { AlertTriangle, ChevronDown, ChevronRight, X } from 'lucide-vue-next';

const props = defineProps<{
  error: {
    message: string;
    query?: string;
    code?: string;
    exceptionType?: string;
    traceback?: string[];
  } | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const isVisible = computed(() => props.error !== null);
const showTraceback = ref(false);

const hasDetailedInfo = computed(() => {
  return props.error?.code || props.error?.exceptionType || props.error?.traceback;
});

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

function copyFullError() {
  if (!props.error) return;
  const parts = [
    `Error: ${props.error.message}`,
    props.error.code ? `Code: ${props.error.code}` : '',
    props.error.exceptionType ? `Exception: ${props.error.exceptionType}` : '',
    props.error.query ? `\nQuery:\n${props.error.query}` : '',
    props.error.traceback ? `\nTraceback:\n${props.error.traceback.join('\n')}` : '',
  ].filter(Boolean);
  navigator.clipboard.writeText(parts.join('\n'));
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isVisible" class="modal-overlay" @click.self="emit('close')">
      <div class="modal-content">
        <div class="modal-header">
          <AlertTriangle :size="18" class="error-icon" />
          <h3>{{ error?.code === 'INTERNAL_SERVER_ERROR' ? 'Server Error' : 'Query Execution Error' }}</h3>
          <button class="close-btn btn-icon-only" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <div class="error-message">
            <p>{{ error?.message }}</p>
          </div>

          <!-- Error details (code and exception type) -->
          <div v-if="hasDetailedInfo" class="error-details">
            <div v-if="error?.code" class="detail-item">
              <span class="detail-label">Error Code:</span>
              <code class="detail-value">{{ error.code }}</code>
            </div>
            <div v-if="error?.exceptionType" class="detail-item">
              <span class="detail-label">Exception:</span>
              <code class="detail-value">{{ error.exceptionType }}</code>
            </div>
          </div>

          <!-- Query section -->
          <div v-if="error?.query" class="query-section">
            <div class="query-header">
              <span class="query-label">Query:</span>
              <button
                class="copy-btn"
                @click="copyToClipboard(error.query!)"
                title="Copy query"
              >
                Copy
              </button>
            </div>
            <pre class="query-code">{{ error.query }}</pre>
          </div>

          <!-- Traceback section (collapsible) -->
          <div v-if="error?.traceback && error.traceback.length > 0" class="traceback-section">
            <button
              class="traceback-toggle"
              @click="showTraceback = !showTraceback"
            >
              <ChevronDown v-if="showTraceback" :size="12" class="toggle-icon" /><ChevronRight v-else :size="12" class="toggle-icon" />
              <span>Stack Trace ({{ error.traceback.length }} lines)</span>
            </button>
            <div v-if="showTraceback" class="traceback-content">
              <div class="traceback-header">
                <button
                  class="copy-btn"
                  @click="copyToClipboard(error.traceback!.join('\n'))"
                  title="Copy traceback"
                >
                  Copy
                </button>
              </div>
              <pre class="traceback-code">{{ error.traceback.join('\n') }}</pre>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button v-if="hasDetailedInfo" class="copy-all-btn" @click="copyFullError">
            Copy Full Error
          </button>
          <button class="dismiss-btn" @click="emit('close')">
            Dismiss
          </button>
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

.modal-content {
  background: var(--card-background, white);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  max-width: 700px;
  width: 90%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #eee);
}

.error-icon {
  font-size: 24px;
  color: #e74c3c;
}

.modal-header h3 {
  margin: 0;
  flex: 1;
  font-size: 18px;
  color: var(--text-primary, #333);
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--text-muted, #666);
  padding: 0;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-primary, #333);
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.error-message {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 16px;
}

.error-message p {
  margin: 0;
  color: #991b1b;
  font-size: 14px;
  line-height: 1.5;
}

.error-details {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 6px;
}

.detail-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-label {
  font-size: 12px;
  color: var(--text-muted, #666);
}

.detail-value {
  font-size: 12px;
  padding: 2px 6px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.query-section {
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 16px;
}

.query-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-tertiary, #e8e8e8);
}

.query-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted, #666);
  text-transform: uppercase;
}

.copy-btn {
  padding: 4px 8px;
  font-size: 11px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
}

.copy-btn:hover {
  background: var(--bg-secondary, #f0f0f0);
}

.query-code {
  margin: 0;
  padding: 12px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary, #333);
  max-height: 200px;
}

.traceback-section {
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  overflow: hidden;
}

.traceback-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-secondary, #f5f5f5);
  border: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-muted, #666);
  text-align: left;
}

.traceback-toggle:hover {
  background: var(--bg-tertiary, #e8e8e8);
}

.toggle-icon {
  font-size: 10px;
}

.traceback-content {
  border-top: 1px solid var(--border-color, #ddd);
}

.traceback-header {
  display: flex;
  justify-content: flex-end;
  padding: 6px 12px;
  background: var(--bg-tertiary, #e8e8e8);
}

.traceback-code {
  margin: 0;
  padding: 12px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 11px;
  line-height: 1.4;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-muted, #666);
  max-height: 300px;
  background: var(--bg-secondary, #f9f9f9);
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border-color, #eee);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.copy-all-btn {
  padding: 8px 16px;
  background: var(--bg-secondary, #f0f0f0);
  color: var(--text-primary, #333);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.copy-all-btn:hover {
  background: var(--bg-tertiary, #e0e0e0);
}

.dismiss-btn {
  padding: 8px 20px;
  background: var(--primary-color, #42b883);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.dismiss-btn:hover {
  background: var(--primary-hover, #3aa876);
}
</style>
