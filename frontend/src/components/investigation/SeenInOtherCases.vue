<script setup lang="ts">
/**
 * "Seen in N other cases" (06 P7): the cases the person reads where this entity
 * is on the graph or was annotated or decided on, with what each says about it.
 * Keyed entities have the same id in every case (`Account:4471-0`); other cases
 * the person cannot open never show. Answers are cached per entity for the screen.
 */
import { computed, ref, watch } from 'vue';
import { api } from '@/services/api';
import { STATUS_LABELS, caseNumber } from '@/utils/investigationStatus';
import type { EntityCase } from '@/types/investigation';

const props = defineProps<{ uid: string; currentId: string | null }>();

const cache = new Map<string, Promise<EntityCase[]>>();
const rows = ref<EntityCase[]>([]);
const open = ref(false);

watch(
  () => props.uid,
  async (uid) => {
    open.value = false;
    rows.value = [];
    try {
      if (!cache.has(uid)) cache.set(uid, api.getEntityCases(uid));
      const found = await cache.get(uid)!;
      if (uid === props.uid) rows.value = found;
    } catch {
      cache.delete(uid); // the chip stays hidden; the inspector works without it
    }
  },
  { immediate: true },
);

const others = computed(() => rows.value.filter((c) => c.investigation_id !== props.currentId));
const about = (c: EntityCase) =>
  [
    ...c.roles.map((r) => `role ${r}`),
    ...c.tags.map((t) => `tag ${t}`),
    ...c.groups.map((g) => `group ${g}`),
    ...c.tasks.map((t) => `task “${t}”`),
    ...c.decisions.map((d) => `decided “${d.outcome_label}”`),
  ].join(' · ');
</script>

<template>
  <div v-if="others.length" class="seen" data-testid="seen-in-other-cases">
    <button class="chip" :aria-expanded="open" data-testid="seen-chip" @click="open = !open">
      Seen in {{ others.length }} other {{ others.length === 1 ? 'case' : 'cases' }} {{ open ? '▴' : '▾' }}
    </button>
    <ul v-if="open" class="list">
      <li v-for="c in others" :key="c.investigation_id" :data-testid="`seen-case-${c.investigation_id}`">
        <RouterLink :to="`/investigations/${c.investigation_id}`">{{ c.title }} · {{ caseNumber(c.investigation_id) }}</RouterLink>
        <span class="muted">{{ c.case_type_label }} · {{ STATUS_LABELS[c.status as keyof typeof STATUS_LABELS] ?? c.status }}{{ c.present ? '' : ' · not on its graph' }}</span>
        <span v-if="about(c)" class="about">{{ about(c) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.seen {
  font-size: 12px;
}

.chip {
  padding: 2px 8px;
  border: 1px solid #f59e0b;
  border-radius: var(--radius-pill);
  background: #fffbeb;
  color: #92400e;
  font: inherit;
  cursor: pointer;
}

.list {
  margin: 6px 0 0;
  padding-left: 16px;
}

.list li {
  display: flex;
  flex-direction: column;
  margin-bottom: 4px;
}

.muted {
  color: var(--text-muted);
}

.about {
  color: var(--text-primary);
}
</style>
