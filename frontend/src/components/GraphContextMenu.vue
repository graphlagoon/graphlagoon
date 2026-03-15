<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref, watch, nextTick } from 'vue';
import { useContextMenu } from '@/composables/useContextMenu';

const { visible, x, y, target, hide, getVisibleActions } = useContextMenu();

const menuRef = ref<HTMLDivElement | null>(null);

const visibleActions = computed(() => getVisibleActions());

const adjustedX = ref(0);
const adjustedY = ref(0);

watch([visible, x, y], async () => {
  if (!visible.value) return;

  adjustedX.value = x.value;
  adjustedY.value = y.value;

  await nextTick();
  if (!menuRef.value) return;

  const rect = menuRef.value.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (adjustedX.value + rect.width > vw - 8) {
    adjustedX.value = vw - rect.width - 8;
  }
  if (adjustedY.value + rect.height > vh - 8) {
    adjustedY.value = vh - rect.height - 8;
  }
});

function onDocumentClick(event: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(event.target as HTMLElement)) {
    hide();
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    hide();
  }
}

function onScroll() {
  hide();
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('scroll', onScroll, true);
});

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('scroll', onScroll, true);
});

async function handleAction(actionId: string) {
  const action = visibleActions.value.find(a => a.id === actionId);
  if (!action || !target.value) return;

  if (action.disabled?.(target.value)) return;

  await action.handler(target.value);
  hide();
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible && target"
      ref="menuRef"
      class="context-menu"
      :style="{ left: adjustedX + 'px', top: adjustedY + 'px' }"
      data-testid="graph-context-menu"
    >
      <div class="context-menu-header">
        <span class="context-menu-type">{{ target.type }}</span>
        <span class="context-menu-id" :title="target.id">
          {{ target.label }}
        </span>
      </div>

      <div class="context-menu-divider"></div>

      <button
        v-for="action in visibleActions"
        :key="action.id"
        class="context-menu-item"
        :class="{ disabled: action.disabled?.(target) }"
        :disabled="action.disabled?.(target) ?? false"
        :data-testid="`context-menu-action-${action.id}`"
        @click="handleAction(action.id)"
      >
        <span v-if="action.icon" class="context-menu-icon">
          <component v-if="typeof action.icon !== 'string'" :is="action.icon" :size="14" />
          <span v-else>{{ action.icon }}</span>
        </span>
        <span class="context-menu-label">{{ action.label }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  min-width: 180px;
  max-width: 280px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 10001;
  padding: 4px 0;
  user-select: none;
}

.context-menu-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
}

.context-menu-type {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 1px 6px;
  background: var(--bg-secondary, #f0f0f0);
  border-radius: 3px;
  color: var(--text-muted, #666);
  letter-spacing: 0.5px;
}

.context-menu-id {
  font-size: 12px;
  color: var(--text-muted, #666);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

.context-menu-divider {
  height: 1px;
  background: var(--border-color, #eee);
  margin: 2px 0;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-color, #333);
  text-align: left;
  transition: background 0.1s;
}

.context-menu-item:hover:not(.disabled) {
  background: var(--bg-secondary, #f0f0f0);
}

.context-menu-item.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.context-menu-icon {
  width: 16px;
  text-align: center;
  font-size: 14px;
  flex-shrink: 0;
}

.context-menu-label {
  flex: 1;
}
</style>
