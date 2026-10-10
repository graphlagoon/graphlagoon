import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/services/api';
import type { Investigation } from '@/types/investigation';

/**
 * The current case, app-wide (05 §2): the target of every "Adicionar ao caso"
 * button outside the case screen. The id is persisted in localStorage and
 * validated on load (404/403 clears it); the last five opened cases are kept
 * for the chip's quick switch.
 */
export const STORAGE_KEY = 'graphlagoon.currentCase';
export const RECENT_KEY = 'graphlagoon.recentCases';
export const MAX_RECENT = 5;

export interface RecentCase {
  id: string;
  title: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: the chip just forgets on reload */
  }
}

export const useCurrentCaseStore = defineStore('currentCase', () => {
  const stored = read<RecentCase | null>(STORAGE_KEY, null);
  const caseId = ref<string | null>(stored?.id ?? null);
  const title = ref<string>(stored?.title ?? '');
  /** The validated case; null until `ensureLoaded` resolves or when the stored id is gone. */
  const investigation = ref<Investigation | null>(null);
  const recent = ref<RecentCase[]>(read<RecentCase[]>(RECENT_KEY, []));
  const checked = ref(false);

  const hasCase = computed(() => caseId.value !== null);
  const shortId = computed(() => (caseId.value ? `#${caseId.value.slice(0, 4)}` : ''));
  /** Writable target: the case exists, is not decided and the person can edit it. */
  const canAdd = computed(
    () => !!investigation.value && investigation.value.has_write_access && investigation.value.status !== 'decided',
  );
  const recentCases = computed(() => recent.value.slice(0, MAX_RECENT));

  function remember(inv: RecentCase) {
    recent.value = [inv, ...recent.value.filter((r) => r.id !== inv.id)].slice(0, MAX_RECENT);
    write(RECENT_KEY, recent.value);
  }

  function setCurrentCase(inv: Pick<Investigation, 'id' | 'title'> | null) {
    if (!inv) {
      caseId.value = null;
      title.value = '';
      investigation.value = null;
      write(STORAGE_KEY, null);
      return;
    }
    caseId.value = inv.id;
    title.value = inv.title;
    investigation.value = 'status' in inv ? (inv as Investigation) : investigation.value?.id === inv.id ? investigation.value : null;
    write(STORAGE_KEY, { id: inv.id, title: inv.title });
    remember({ id: inv.id, title: inv.title });
    if (!investigation.value) void refresh();
  }

  /** Re-reads the case; 404/403 (deleted, unshared) clears the chip. */
  async function refresh(): Promise<Investigation | null> {
    const id = caseId.value;
    if (!id) return null;
    try {
      const inv = await api.getInvestigation(id);
      if (caseId.value !== id) return investigation.value;
      investigation.value = inv;
      title.value = inv.title;
      write(STORAGE_KEY, { id: inv.id, title: inv.title });
      remember({ id: inv.id, title: inv.title });
      return inv;
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 403 || status === 410) {
        setCurrentCase(null);
        recent.value = recent.value.filter((r) => r.id !== id);
        write(RECENT_KEY, recent.value);
      }
      return null;
    } finally {
      checked.value = true;
    }
  }

  /** Validates the stored id once per session (the chip calls it on mount). */
  async function ensureLoaded() {
    if (checked.value || !caseId.value) {
      checked.value = true;
      return investigation.value;
    }
    return refresh();
  }

  return { caseId, title, investigation, recent, recentCases, hasCase, shortId, canAdd, setCurrentCase, refresh, ensureLoaded };
});
